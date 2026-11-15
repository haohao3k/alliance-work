import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { readUsageDatabase, sqliteSnapshotBasis } from "./usage-sqlite.mjs";

const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);
const timeOf = (v) => (typeof v === "number" ? v : Date.parse(v));
const family = (provider, model) => {
  if (provider === "agy")
    return model?.startsWith("claude-") ? "anthropic" : model?.startsWith("gemini-") ? "google" : null;
  return (
    {
      anthropic: "anthropic",
      google: "google",
      "google-vertex": "google",
      "google-antigravity": "google",
      openai: "openai",
      "openai-codex": "openai",
    }[provider] ?? null
  );
};

// Flat protobuf decoder. Only verified counter/model/time fields are traversed; other byte fields
// (including prompts) remain opaque. Reject malformed/truncated records rather than partial sums.
function fields(bytes) {
  if (!(bytes instanceof Uint8Array)) return new Map();
  let i = 0;
  const integer = () => {
    let value = 0;
    for (let shift = 0; shift < 56; shift += 7) {
      if (i >= bytes.length) throw new Error("truncated protobuf");
      const b = bytes[i++];
      value += (b & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) throw new Error("oversized protobuf integer");
      if (!(b & 128)) return value;
    }
    throw new Error("oversized protobuf integer");
  };
  const out = new Map();
  while (i < bytes.length) {
    const tag = integer();
    const key = Math.floor(tag / 8);
    if (!key) throw new Error("invalid protobuf tag");
    const wire = tag % 8;
    if (wire === 0) out.set(key, integer());
    else if ([1, 2, 5].includes(wire)) {
      const length = wire === 2 ? integer() : wire === 1 ? 8 : 4;
      if (i + length > bytes.length) throw new Error("truncated protobuf field");
      out.set(key, bytes.subarray(i, i + length));
      i += length;
    } else throw new Error("unsupported protobuf wire type");
  }
  return out;
}
function protoTime(bytes) {
  const f = fields(bytes);
  return typeof f.get(1) === "number" ? f.get(1) * 1000 + count(f.get(2)) / 1e6 : null;
}
function counters(bytes) {
  const f = fields(bytes);
  return {
    uncached: count(f.get(2)),
    output: count(f.get(3)),
    cacheWrite: count(f.get(4)),
    cacheRead: count(f.get(5)),
    reasoning: count(f.get(9)),
  };
}
const usageKey = (u) => [u.uncached, u.output, u.cacheRead, u.cacheWrite].join(":");

export async function collectExtra(ctx) {
  const { userHome, window, pathRole, attribute, walk, topLevel, recentFiles, lines } = ctx;
  const agyStats = {
    sqlite_snapshot: sqliteSnapshotBasis,
    snapshot_failures: {},
    databases_read: 0,
    duplicate_records_folded: 0,
    missing_timestamps: 0,
    bad_records: 0,
    unreadable_files: 0,
  };
  const piStats = { files_read: 0, duplicate_records_folded: 0, bad_records: 0, unreadable_files: 0 };
  const records = [];
  const roots = [join(userHome, ".gemini/antigravity-cli/conversations")];
  for (const base of await topLevel(userHome, ".agy"))
    await walk(base, (directory, entries) => {
      if (entries.some((e) => e.isDirectory() && e.name === "os-home"))
        roots.push(join(directory, "os-home/.gemini/antigravity-cli/conversations"));
      return false;
    });
  const paths = [];
  for (const root of new Set(roots))
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => []))
      if (entry.isFile() && entry.name.endsWith(".db")) paths.push(join(root, entry.name));
  const seen = new Set();
  // Include WAL-backed updates even when the base database's mtime did not change.
  for (const { path } of await recentFiles(paths, 0)) {
    let db;
    const sessionId = basename(path, ".db");
    try {
      db = await readUsageDatabase(path);
      db.exec("BEGIN");
      const times = [];
      try {
        for (const row of db
          .prepare("SELECT metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx")
          .iterate()) {
          try {
            const f = fields(row.metadata);
            if (f.has(9))
              times.push({
                key: usageKey(counters(f.get(9))),
                time: protoTime(f.get(8)) ?? protoTime(f.get(1)),
              });
          } catch {
            agyStats.bad_records++;
          }
        }
      } catch {
        /* Older schemas still carry timestamps in gen_metadata. */
      }
      let cursor = 0;
      for (const row of db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx").iterate()) {
        try {
          const f = fields(fields(row.data).get(1));
          if (!f.has(4)) continue;
          const u = counters(f.get(4));
          const model = f.get(19) instanceof Uint8Array ? Buffer.from(f.get(19)).toString("utf8") : null;
          let time = protoTime(fields(f.get(9)).get(4));
          const key = usageKey(u);
          for (let j = cursor; j < Math.min(cursor + 3, times.length); j++)
            if (times[j].key === key) {
              time = times[j].time ?? time;
              cursor = j + 1;
              break;
            }
          if (time === null || !Number.isFinite(time)) {
            agyStats.missing_timestamps++;
            continue;
          }
          if (time < window.since || time >= window.until) continue;
          const id = `${sessionId}\0${row.idx}`;
          if (seen.has(id)) {
            agyStats.duplicate_records_folded++;
            continue;
          }
          seen.add(id);
          records.push({
            provider: "agy",
            priceFamily: family("agy", model),
            sessionId,
            time,
            model,
            ...u,
            cacheWrite1h: 0,
            inputTotal: u.uncached + u.cacheRead + u.cacheWrite,
            compaction: false,
            folded: 0,
            ...attribute([sessionId], pathRole(path)),
          });
        } catch {
          agyStats.bad_records++;
        }
      }
      agyStats.databases_read++;
    } catch (error) {
      agyStats.unreadable_files++;
      const reason = error.code?.startsWith("USAGE_SQLITE_") ? error.message : "unreadable";
      agyStats.snapshot_failures[reason] = (agyStats.snapshot_failures[reason] ?? 0) + 1;
    } finally {
      db?.close();
    }
  }
  const piPaths = [];
  for (const base of await topLevel(userHome, ".pi"))
    await walk(base, (directory, entries) => {
      for (const e of entries)
        if (
          e.isFile() &&
          e.name.endsWith(".jsonl") &&
          /\/(?:sessions|archived_sessions)(?:\/|$)/.test(directory)
        )
          piPaths.push(join(directory, e.name));
      return false;
    });
  const piSeen = new Set();
  for (const { path } of await recentFiles(piPaths, window.since - 86400000)) {
    let sessionId = null;
    try {
      for await (const line of lines(path)) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          piStats.bad_records++;
          continue;
        }
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          piStats.bad_records++;
          continue;
        }
        if (entry.type === "session") {
          sessionId = entry.id;
          continue;
        }
        const message =
          entry.type === "message" && entry.message?.role === "assistant" ? entry.message : null;
        const special = ["usage", "compaction", "branch_summary"].includes(entry.type);
        const usage = message?.usage ?? (special ? entry.usage : null);
        if (!usage || !sessionId) continue;
        const time = timeOf(entry.timestamp ?? message?.timestamp);
        if (!Number.isFinite(time) || time < window.since || time >= window.until) continue;
        // Forks retain the original entry ID and time. Session IDs change; a new session must not
        // charge copied history again. Pi entry IDs are short, so include time/model/counters.
        const model = message?.model ?? entry.model ?? null;
        const provider = message?.provider ?? entry.provider;
        const u = {
          uncached: count(usage.input),
          cacheRead: count(usage.cacheRead),
          cacheWrite: count(usage.cacheWrite),
          output: count(usage.output),
          reasoning: count(usage.reasoning),
        };
        const id = JSON.stringify([entry.id ?? sessionId, time, model, provider, ...Object.values(u)]);
        if (piSeen.has(id)) {
          piStats.duplicate_records_folded++;
          continue;
        }
        piSeen.add(id);
        records.push({
          provider: "pi",
          priceFamily: family(provider, model),
          sessionId,
          time,
          model,
          ...u,
          cacheWrite1h: Math.min(count(usage.cacheWrite1h), u.cacheWrite),
          inputTotal: u.uncached + u.cacheRead + u.cacheWrite,
          compaction: entry.type === "compaction",
          folded: 0,
          ...attribute([sessionId], pathRole(path)),
        });
      }
      piStats.files_read++;
    } catch {
      piStats.unreadable_files++;
    }
  }
  return { records, agy: agyStats, pi: piStats };
}
