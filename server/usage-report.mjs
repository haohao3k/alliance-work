import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createZstdDecompress } from "node:zlib";
import { collectExtra } from "./usage-extra.mjs";
import { collectFriction } from "./usage-friction.mjs";
import { collectWakeMarkers } from "./usage-markers.mjs";

/**
 * Read-only token/cache/cost report over the local Claude Code, Codex, agy and Pi logs of this host.
 *
 * Reads usage counters, model, timestamp and ids only. A log line is parsed in memory to reach those
 * fields; no message text, tool data, prompt, title, cwd or credential is copied into a record, the
 * report or any file. Nothing is written and nothing leaves the host.
 *
 * Definitions follow the lane-05 evidence (DEFINITIONS.md):
 *   Claude  input_tokens excludes cache; input side = input + cache_creation + cache_read. One API
 *           response repeats on several JSONL lines, so records are keyed by (message.id, requestId)
 *           for the whole host and the copy with the largest output_tokens (the finished one) is kept.
 *   Codex   input_tokens already includes cached_input_tokens. One record per `token_usage_record`
 *           response_id (compaction calls included). Cumulative `total_token_usage` is never summed.
 *   cache hit = cache_read / input side, for both providers.
 */

export const ROLES = ["hq", "supervisor", "lead", "peer", "lens"];
const DAY_MS = 86_400_000;
const MAX_WALK_DEPTH = 7;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "file-history",
  "plugins",
  "cache",
  "caches",
  "downloads",
  "shell-snapshots",
  "session-env",
  "backups",
  "paste-cache",
  "telemetry",
  "statsig",
  "todos",
  "ide",
  "image-cache",
  "debug",
  "skills",
  "state",
  "worktrees",
  "vendor_imports",
  "packages",
  "tmp",
  ".venv",
  "venv",
  ".local",
  ".npm",
  ".gemini",
  ".cargo",
  ".rustup",
  "go",
  ".pnpm-store",
  "Library",
]);
const bundledPricing = join(dirname(fileURLToPath(import.meta.url)), "usage-pricing.json");

const count = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const parseTime = (value) => {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------- role attribution
/** Paseo agent records: provider `alliance-<harness>-<role>` plus the native session id. Only these three
 * fields are read; the record also holds titles and connection details that are never copied. */
export async function agentRoles(paseoHomes) {
  const bySession = new Map();
  let agents = 0;
  for (const paseoHome of paseoHomes) {
    const directory = join(paseoHome, "agents");
    for (const group of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!group.isDirectory()) continue;
      for (const name of await readdir(join(directory, group.name)).catch(() => [])) {
        if (!name.endsWith(".json")) continue;
        let record;
        try {
          record = JSON.parse(await readFile(join(directory, group.name, name), "utf8"));
        } catch {
          continue;
        }
        const match = /^alliance-[a-z0-9]+-(hq|supervisor|lead|peer|lens)$/.exec(String(record?.provider));
        if (!match) continue;
        agents++;
        for (const session of [record.persistence?.sessionId, record.runtimeInfo?.sessionId])
          if (typeof session === "string" && session) bySession.set(session, match[1]);
      }
    }
  }
  return { bySession, agents };
}

/** Role of a session file by profile directory: manifest homes first, then the default layout. */
export async function profileRoles(home) {
  const homes = [];
  try {
    const manifest = JSON.parse(await readFile(join(home, "profiles.json"), "utf8"));
    for (const profile of Object.values(manifest.profiles ?? {}))
      if (ROLES.includes(profile?.role) && typeof profile.home === "string")
        homes.push([profile.home.endsWith(sep) ? profile.home : profile.home + sep, profile.role]);
  } catch {}
  return (path) => {
    for (const [prefix, role] of homes) if (path.startsWith(prefix)) return role;
    const match = /\/\.(?:claude|codex|pi|agy)-alliance-work\/(hq|supervisor|lead|peer|lens)\//.exec(path);
    return match ? match[1] : null;
  };
}

function attribute(roles, sessions, pathRole) {
  for (const session of sessions) {
    const role = session && roles.bySession.get(session);
    if (role) return { role, how: "agent" };
  }
  return pathRole ? { role: pathRole, how: "path" } : { role: null, how: "none" };
}

// ---------------------------------------------------------------- discovery
async function walk(base, visit) {
  const queue = [[base, 0]];
  while (queue.length) {
    const [directory, depth] = queue.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (await visit(directory, entries)) continue;
    if (depth >= MAX_WALK_DEPTH) continue;
    for (const entry of entries)
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRS.has(entry.name))
        queue.push([join(directory, entry.name), depth + 1]);
  }
}
async function topLevel(userHome, prefix) {
  const names = await readdir(userHome, { withFileTypes: true }).catch(() => []);
  return names
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(prefix))
    .map((entry) => join(userHome, entry.name))
    .sort();
}
async function recentFiles(paths, since) {
  const out = [];
  for (const path of new Set(paths)) {
    try {
      const info = await stat(path);
      if (info.isFile() && info.mtimeMs >= since) out.push({ path, mtime: info.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
}
async function jsonlIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);
}
async function subdirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function claudeFiles(userHome, since) {
  const found = [];
  const seen = new Set();
  for (const base of await topLevel(userHome, ".claude")) {
    await walk(base, (directory, entries) => {
      if (!entries.some((entry) => entry.name === "projects" && entry.isDirectory())) return false;
      const projects = join(directory, "projects");
      if (!seen.has(projects)) {
        seen.add(projects);
        found.push(projects);
      }
      return false;
    });
  }
  const paths = [];
  for (const projects of found)
    for (const project of await subdirectories(projects)) {
      const directory = join(projects, project);
      for (const name of await jsonlIn(directory)) paths.push(join(directory, name));
      for (const session of await subdirectories(directory)) {
        const nested = join(directory, session);
        for (const name of await jsonlIn(nested)) paths.push(join(nested, name));
        for (const name of await jsonlIn(join(nested, "subagents")))
          paths.push(join(nested, "subagents", name));
      }
    }
  return { configDirs: found.length, files: await recentFiles(paths, since) };
}

async function codexFiles(userHome, since) {
  const homes = new Set();
  for (const base of await topLevel(userHome, ".codex"))
    await walk(base, (directory, entries) => {
      if (!entries.some((e) => e.isDirectory() && (e.name === "sessions" || e.name === "archived_sessions")))
        return false;
      homes.add(directory);
      return true; // a Codex home is not searched further
    });
  const paths = [];
  for (const home of homes)
    for (const sub of ["sessions", "archived_sessions"]) {
      const stack = [join(home, sub)];
      while (stack.length) {
        const directory = stack.pop();
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const path = join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path);
          else if (entry.isFile() && /\.jsonl(\.zst)?$/.test(entry.name)) paths.push(path);
        }
      }
    }
  return { homes: homes.size, files: await recentFiles(paths, since) };
}

/** Lines split on LF only: readline also splits on U+2028/U+2029, which JSON text may contain, and
 * would cut a record in two. Returns null when the file type cannot be read on this Node. */
function lines(path) {
  let input = createReadStream(path);
  if (path.endsWith(".zst")) {
    if (typeof createZstdDecompress !== "function") return null;
    input = input.pipe(createZstdDecompress());
    input.on("error", () => {});
  }
  return (async function* () {
    let rest = Buffer.alloc(0);
    for await (const chunk of input) {
      let start = 0;
      let end = chunk.indexOf(10, start);
      while (end !== -1) {
        yield (
          start === 0 && rest.length
            ? Buffer.concat([rest, chunk.subarray(0, end)])
            : chunk.subarray(start, end)
        ).toString("utf8");
        rest = Buffer.alloc(0);
        start = end + 1;
        end = chunk.indexOf(10, start);
      }
      rest = Buffer.concat([rest, chunk.subarray(start)]);
    }
    if (rest.length) yield rest.toString("utf8");
  })();
}

// ---------------------------------------------------------------- Claude
async function collectClaude({ files }, window, roles, pathRole, stats) {
  const best = new Map();
  for (const { path } of files) {
    const reader = lines(path);
    if (!reader) continue;
    const pathSession = /\/subagents\//.test(path)
      ? basename(dirname(dirname(path)))
      : basename(path, ".jsonl");
    try {
      for await (const line of reader) {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          stats.badLines++;
          continue;
        }
        const message = entry?.message;
        const usage = message?.usage;
        if (entry?.type !== "assistant" || !isObject(message) || !isObject(usage)) continue;
        const time = parseTime(entry.timestamp);
        if (time === null || time >= window.until) continue;
        if (message.model === "<synthetic>") {
          stats.synthetic++;
          continue;
        }
        const input = count(usage.input_tokens);
        const cacheWrite = count(usage.cache_creation_input_tokens);
        const cacheRead = count(usage.cache_read_input_tokens);
        const output = count(usage.output_tokens);
        const split = usage.cache_creation;
        const known =
          isObject(split) && ("ephemeral_5m_input_tokens" in split || "ephemeral_1h_input_tokens" in split);
        const hour = known ? count(split.ephemeral_1h_input_tokens) : 0;
        const record = {
          provider: "claude",
          sessionId: typeof entry.sessionId === "string" ? entry.sessionId : pathSession,
          chain: `${entry.sessionId ?? pathSession}\0${/\/subagents\//.test(path) ? basename(path) : "main"}`,
          subagent: /\/subagents\//.test(path),
          turnId: entry.turnId,
          promptId: entry.promptId,
          parentId: entry.parentUuid,
          time,
          model: typeof message.model === "string" ? message.model : null,
          uncached: input,
          cacheRead,
          cacheWrite,
          cacheWrite1h: Math.min(hour, cacheWrite),
          fiveMinuteOnly: known && hour === 0 && count(split.ephemeral_5m_input_tokens) > 0,
          inputTotal: input + cacheWrite + cacheRead,
          output,
          reasoning: 0,
          compaction: false,
          folded: 0,
          ...attribute(roles, [entry.sessionId, pathSession], pathRole(path)),
        };
        const key = `${message.id ?? entry.uuid}\u0000${entry.requestId ?? ""}`;
        const prior = best.get(key);
        if (!prior) best.set(key, record);
        else {
          stats.folded++;
          record.folded = prior.folded + 1;
          // A streaming duplicate in a subagent file must not move a main response into that chain.
          const topology = prior.subagent && !record.subagent ? record : prior;
          const chosen = output > prior.output ? record : prior;
          Object.assign(chosen, {
            chain: topology.chain,
            subagent: topology.subagent,
            sessionId: topology.sessionId,
          });
          chosen.folded = record.folded;
          best.set(key, chosen);
        }
      }
    } catch {
      stats.unreadable++;
    }
  }
  const records = [...best.values()];
  classifyClaudeGaps(records);
  return records.filter((record) => record.time >= window.since);
}

export function classifyClaudeGaps(records) {
  const previous = new Map();
  records.sort((a, b) => a.time - b.time);
  for (const record of records) {
    record.cold = false;
    record.rebuildTokens = 0;
    const prev = previous.get(record.chain);
    const gap = prev ? Math.max(0, record.time - prev.time) : null;
    record.gap = record.subagent
      ? "subagent"
      : gap === null
        ? "first"
        : gap < 5 * 60000
          ? "<5m"
          : gap < 55 * 60000
            ? "5–55m"
            : gap <= 75 * 60000
              ? "55–75m"
              : ">75m";
    if (
      prev &&
      !record.subagent &&
      prev.model === record.model &&
      record.inputTotal >= 0.7 * prev.inputTotal
    ) {
      const lost = Math.min(
        record.uncached + record.cacheWrite,
        Math.max(0, prev.inputTotal - record.cacheRead),
      );
      const broken = lost >= 5000 && lost >= 0.3 * prev.inputTotal;
      record.cold = broken && gap >= (prev.fiveMinuteOnly ? 5 : 55) * 60000;
      if (record.cold) record.rebuildTokens = lost;
    }
    previous.set(record.chain, record);
  }
}

// ---------------------------------------------------------------- Codex
const codexUsage = (value) =>
  isObject(value)
    ? {
        input: count(value.input_tokens),
        cached: count(value.cached_input_tokens),
        write: count(value.cache_write_input_tokens),
        output: count(value.output_tokens),
        reasoning: count(value.reasoning_output_tokens),
        total: count(value.total_tokens),
      }
    : null;
const sameCodexUsage = (a, b) => a && b && Object.keys(a).every((key) => a[key] === b[key]);

async function collectCodex({ files }, window, roles, pathRole, stats) {
  const seen = new Map();
  for (const { path } of files) {
    const reader = lines(path);
    if (!reader) {
      stats.unreadable++;
      continue;
    }
    let meta = {};
    let model = null;
    const compactions = new Set();
    const byRecord = [];
    const byCount = [];
    let previousTotal = null;
    try {
      for await (const line of reader) {
        const head = line.slice(0, 300);
        if (
          !head.includes('"token_usage_record"') &&
          !head.includes('"token_count"') &&
          !head.includes('"session_meta"') &&
          !head.includes('"turn_context"') &&
          !head.includes('"compacted"')
        )
          continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          stats.badLines++;
          continue;
        }
        const payload = entry?.payload;
        if (!isObject(payload)) continue;
        if (entry.type === "session_meta") {
          const spawn = payload.source?.subagent?.thread_spawn;
          meta = {
            thread: payload.id,
            session: payload.session_id ?? payload.id,
            parent: payload.parent_thread_id ?? spawn?.parent_thread_id,
          };
        } else if (entry.type === "turn_context") {
          if (typeof payload.model === "string") model = payload.model;
        } else if (entry.type === "compacted") {
          if (payload.compaction_response_id) compactions.add(payload.compaction_response_id);
          if (payload.latest_token_usage_record?.response_id)
            compactions.add(payload.latest_token_usage_record.response_id);
        } else if (entry.type === "token_usage_record") {
          const usage = codexUsage(payload.usage);
          if (usage) byRecord.push({ time: entry.timestamp, id: payload.response_id, model, usage });
        } else if (entry.type === "event_msg" && payload.type === "token_count" && isObject(payload.info)) {
          const total = codexUsage(payload.info.total_token_usage);
          const last = codexUsage(payload.info.last_token_usage);
          if (!last) continue;
          if (total && previousTotal && sameCodexUsage(total, previousTotal)) {
            stats.repeated++;
            continue; // the same event written twice
          }
          previousTotal = total;
          byCount.push({ time: entry.timestamp, id: undefined, model, usage: last });
        }
      }
    } catch {
      stats.unreadable++;
    }
    const usable = byRecord.length ? byRecord : byCount;
    const fileRole = pathRole(path);
    const sessions = [meta.thread, meta.session, meta.parent, /([0-9a-f-]{36})\.jsonl/.exec(path)?.[1]];
    for (const item of usable) {
      const time = parseTime(item.time);
      if (time === null || time < window.since || time >= window.until) continue;
      const { usage } = item;
      const key =
        item.id ??
        `${meta.session}\u0000${item.time}\u0000${usage.input}\u0000${usage.output}\u0000${usage.total}`;
      const prior = seen.get(key);
      if (prior) {
        prior.folded++;
        stats.folded++;
        continue;
      }
      seen.set(key, {
        provider: "codex",
        sessionId: meta.session,
        turnId: item.turnId,
        time,
        model: item.model,
        uncached: Math.max(usage.input - usage.cached, 0),
        cacheRead: usage.cached,
        cacheWrite: usage.write,
        cacheWrite1h: 0,
        inputTotal: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        compaction: Boolean(item.id && compactions.has(item.id)),
        folded: 0,
        ...attribute(roles, sessions, fileRole),
      });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- pricing
export async function loadPricing({ file, home } = {}) {
  const table = JSON.parse(await readFile(bundledPricing, "utf8"));
  const overrides = [];
  for (const candidate of [home && join(home, "usage-pricing.json"), file]) {
    if (!candidate) continue;
    let extra;
    try {
      extra = JSON.parse(await readFile(candidate, "utf8"));
    } catch (error) {
      if (candidate === file)
        throw new Error(`Cannot read pricing file ${candidate}: ${error.code ?? "invalid JSON"}`);
      continue;
    }
    for (const family of ["anthropic", "openai", "google"])
      if (isObject(extra[family])) table[family] = { ...table[family], ...extra[family] };
    overrides.push(candidate);
  }
  return { table, fetched: table._fetched ?? null, overrides };
}

const familyOf = { claude: "anthropic", codex: "openai", agy: "google" };
/** Exact model id after dropping a context suffix `[1m]`, a date `-20261001` or `-latest`; never guesses
 * the nearest model, so an unknown model is reported as unpriced instead of mispriced. */
export function modelRates(table, provider, model, priceFamily) {
  const family = table[priceFamily ?? familyOf[provider]];
  if (!family || typeof model !== "string") return null;
  const id = model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-(\d{8}|latest)$/, "");
  const rates =
    family[id] ?? (provider === "agy" ? family[id.replace(/-(low|medium|high|xhigh|max)$/, "")] : undefined);
  return isObject(rates) && !id.startsWith("_") ? rates : null;
}

const perToken = (rate, tokens) => ((typeof rate === "number" ? rate : 0) * tokens) / 1_000_000;
/** USD at list prices for one record, or null when the model has no price. */
export function recordCost(table, record) {
  let rates = modelRates(table, record.provider, record.model, record.priceFamily);
  if (!rates) return null;
  if (isObject(rates._long_ctx) && record.inputTotal > 272_000) rates = { ...rates, ...rates._long_ctx };
  if (record.provider === "claude" || record.priceFamily === "anthropic") {
    const hour = record.cacheWrite1h;
    const fiveMinutes = record.cacheWrite - hour; // writes without a TTL split are billed as 5m
    return (
      perToken(rates.input, record.uncached) +
      perToken(rates.cache_read, record.cacheRead) +
      perToken(rates.cache_write_5m, fiveMinutes) +
      perToken(rates.cache_write_1h, hour) +
      perToken(rates.output, record.output)
    );
  }
  return (
    perToken(rates.input, record.uncached) +
    perToken(rates.cache_read, record.cacheRead) +
    perToken(rates.cache_write ?? rates.input, record.cacheWrite) +
    perToken(rates.output, record.output)
  );
}

// ---------------------------------------------------------------- aggregation
const emptyGroup = () => ({
  requests: 0,
  inputTotal: 0,
  uncached: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  compactionRequests: 0,
  cost: 0,
  unpricedRequests: 0,
  coldWakes: 0,
  rebuildTokens: 0,
  rebuildUsd: 0,
  unpricedRebuildWakes: 0,
});
function add(group, record, cost) {
  group.requests++;
  if (record.cold) {
    group.coldWakes++;
    group.rebuildTokens += record.rebuildTokens;
    if (record.rebuildUsd === null) group.unpricedRebuildWakes++;
    else group.rebuildUsd += record.rebuildUsd ?? 0;
  }
  group.inputTotal += record.inputTotal;
  group.uncached += record.uncached;
  group.cacheRead += record.cacheRead;
  group.cacheWrite += record.cacheWrite;
  group.output += record.output;
  group.reasoning += record.reasoning;
  if (record.compaction) group.compactionRequests++;
  if (cost === null) group.unpricedRequests++;
  else group.cost += cost;
}
const rounded = (value) => Math.round(value * 1e6) / 1e6;
function present(group) {
  return {
    requests: group.requests,
    tokens: {
      total: group.inputTotal + group.output,
      input_side: group.inputTotal,
      input_uncached: group.uncached,
      cache_read: group.cacheRead,
      cache_write: group.cacheWrite,
      output: group.output,
      reasoning: group.reasoning,
    },
    cache_hit: group.inputTotal ? group.cacheRead / group.inputTotal : null,
    compaction_requests: group.compactionRequests,
    cold_wakes: group.coldWakes,
    rebuild_tokens: group.rebuildTokens,
    rebuild_usd: rounded(group.rebuildUsd),
    unpriced_rebuild_wakes: group.unpricedRebuildWakes,
    est_cost_usd: rounded(group.cost),
    unpriced_requests: group.unpricedRequests,
  };
}
function dayOf(time, tzHours) {
  return new Date(time + tzHours * 3_600_000).toISOString().slice(0, 10);
}

export const DIMENSIONS = ["provider", "role", "model", "day", "gap"];

export function summarize(records, { by = ["provider", "role"], tz = 0, includeOther = false, pricing }) {
  const groups = new Map();
  const totals = emptyGroup();
  const other = emptyGroup();
  const unpriced = new Map();
  const attribution = {};
  for (const record of records) {
    const cost = recordCost(pricing.table, record);
    if (record.cold) {
      const rates = modelRates(pricing.table, record.provider, record.model, record.priceFamily);
      record.rebuildUsd =
        typeof rates?.cache_write_1h === "number" && typeof rates?.cache_read === "number"
          ? perToken(Math.max(0, rates.cache_write_1h - rates.cache_read), record.rebuildTokens)
          : null;
    }
    if (!attribution[record.provider])
      attribution[record.provider] = { agent: emptyGroup(), path: emptyGroup(), none: emptyGroup() };
    add(attribution[record.provider][record.how], record, cost);
    if (cost === null) {
      const key = `${record.provider}\u0000${record.model}`;
      const entry = unpriced.get(key) ?? { provider: record.provider, model: record.model, ...emptyGroup() };
      add(entry, record, cost);
      unpriced.set(key, entry);
    }
    if (!record.role) {
      add(other, record, cost);
      if (!includeOther) continue;
    }
    add(totals, record, cost);
    const labels = {
      provider: record.provider,
      role: record.role ?? "(non-alliance)",
      model: record.model ?? "(unknown)",
      day: dayOf(record.time, tz),
      gap: record.gap ?? "unknown",
    };
    const key = by.map((dimension) => labels[dimension]);
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? {
      labels: Object.fromEntries(by.map((d, i) => [d, key[i]])),
      ...emptyGroup(),
    };
    add(group, record, cost);
    groups.set(id, group);
  }
  const order = (a, b) => {
    for (const dimension of by) {
      const left = a.labels[dimension];
      const right = b.labels[dimension];
      if (left !== right) {
        if (dimension === "gap") {
          const gaps = ["first", "<5m", "5–55m", "55–75m", ">75m", "subagent", "unknown"];
          return gaps.indexOf(left) - gaps.indexOf(right);
        }
        if (dimension === "role")
          return ROLES.indexOf(left) - ROLES.indexOf(right) || (left < right ? -1 : 1);
        return left < right ? -1 : 1;
      }
    }
    return 0;
  };
  return {
    groups: [...groups.values()].sort(order).map((group) => ({ ...group.labels, ...present(group) })),
    totals: present(totals),
    nonAlliance: present(other),
    includesNonAlliance: includeOther,
    unpricedModels: [...unpriced.values()]
      .sort((a, b) => b.requests - a.requests)
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        requests: entry.requests,
        tokens: entry.inputTotal + entry.output,
      })),
    attribution: Object.fromEntries(
      Object.entries(attribution).map(([provider, slots]) => [
        provider,
        Object.fromEntries(
          Object.entries(slots).map(([how, group]) => [
            how,
            { requests: group.requests, tokens: group.inputTotal + group.output },
          ]),
        ),
      ]),
    ),
  };
}

// ---------------------------------------------------------------- entry point
/**
 * @param {{userHome:string, home:string, paseoHomes?:string[], since:number, until:number,
 *   by?:string[], tz?:number, includeOther?:boolean, pricingFile?:string, now?:number, wakeMarkersFile?:string}} options
 */
export async function usageReport(options) {
  const { userHome, home, since, until } = options;
  if (!(since < until)) throw new Error("--since must be earlier than --until");
  const window = { since, until };
  let paseoHomes = options.paseoHomes;
  if (!paseoHomes?.length) {
    const installed = await readFile(join(home, "installation.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    paseoHomes = [typeof installed?.paseoHome === "string" ? installed.paseoHome : join(userHome, ".paseo")];
  }
  const roles = await agentRoles(paseoHomes);
  const pathRole = await profileRoles(home);
  const pricing = await loadPricing({ file: options.pricingFile, home });
  const prefilter = since - DAY_MS; // a log may be appended long after its first line; keep one day of slack
  const newStats = () => ({ badLines: 0, synthetic: 0, folded: 0, repeated: 0, unreadable: 0 });
  const claude = await claudeFiles(userHome, prefilter);
  const codex = await codexFiles(userHome, prefilter);
  const claudeStats = newStats();
  const codexStats = newStats();
  const extra = await collectExtra({
    userHome,
    window,
    pathRole,
    attribute: (sessions, role) => attribute(roles, sessions, role),
    walk,
    topLevel,
    recentFiles,
    lines,
  });
  const records = [
    ...(await collectClaude(claude, window, roles, pathRole, claudeStats)),
    ...(await collectCodex(codex, window, roles, pathRole, codexStats)),
    ...extra.records,
  ];
  const summary = summarize(records, { ...options, pricing });
  const friction = await collectFriction(options);
  const wakeMarkers = await collectWakeMarkers({
    file: options.wakeMarkersFile ?? join(home, "wake-markers.jsonl"),
    since,
    until,
  });
  return {
    schema: "alliance-usage/1",
    host: hostname(),
    basis:
      "Estimated cost at public API list prices for the tokens counted: a conversion, not an invoice or a subscription charge.",
    window: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    group_by: options.by ?? ["provider", "role"],
    ...summary,
    friction,
    wakeMarkers,
    pricing: {
      fetched: pricing.fetched,
      file: bundledPricing,
      overrides: pricing.overrides,
      modeled:
        "standard tier list prices; cache write TTL split for Claude; no batch, fast-mode, regional or long-context surcharge except where the table lists one",
    },
    coverage: {
      role_source:
        "agent = Paseo agent record of this host maps the session to a role; path = session file sits in an Alliance profile directory; none = not attributable (excluded unless --include-other)",
      paseo_homes: paseoHomes,
      agents_with_role: roles.agents,
      claude: {
        config_dirs: claude.configDirs,
        files_read: claude.files.length,
        duplicate_lines_folded: claudeStats.folded,
        synthetic_skipped: claudeStats.synthetic,
        bad_lines: claudeStats.badLines,
        unreadable_files: claudeStats.unreadable,
      },
      codex: {
        homes: codex.homes,
        files_read: codex.files.length,
        duplicate_records_folded: codexStats.folded,
        repeated_events_skipped: codexStats.repeated,
        bad_lines: codexStats.badLines,
        unreadable_files: codexStats.unreadable,
      },
      agy: extra.agy,
      pi: extra.pi,
      cold_wakes: {
        basis:
          "Claude main-chain cache-loss estimate; deduplicated requests, same model, no context shrink below 70% of prior input. Cold after 55m, or 5m only with a known 5m-only write. Loss >=5000 tokens and >=30% of prior input; cost uses 1h-write minus cache-read prices. Other harnesses and subagents are not classified.",
      },
    },
  };
}

export function parseWindow({ days, since, until, now = Date.now() }) {
  const parse = (text, name) => {
    const time = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
    if (!Number.isFinite(time)) throw new Error(`${name} must be a date YYYY-MM-DD or an ISO time`);
    return time;
  };
  const end = until === undefined ? now : parse(until, "--until");
  if (since !== undefined) return { since: parse(since, "--since"), until: end };
  const span = days === undefined ? 7 : Number(days);
  if (!(span > 0) || span > 3650) throw new Error("--days must be a positive number of days");
  return { since: end - span * DAY_MS, until: end };
}

// ---------------------------------------------------------------- text
const grouped = (value) => Math.round(value).toLocaleString("en-US");
const percent = (value) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const dollars = (value, partial) => `${partial ? "≥" : ""}$${value.toFixed(2)}`;

export function renderText(report) {
  const dimensions = report.group_by;
  const header = [
    ...dimensions,
    "requests",
    "input-side",
    "cache read",
    "cache write",
    "output",
    "cache hit",
    "est. USD",
    "cold wakes",
    "rebuild tokens",
    "rebuild USD",
  ];
  const row = (labels, group) => [
    ...labels,
    grouped(group.requests),
    grouped(group.tokens.input_side),
    grouped(group.tokens.cache_read),
    grouped(group.tokens.cache_write),
    grouped(group.tokens.output),
    percent(group.cache_hit),
    dollars(group.est_cost_usd, group.unpriced_requests > 0),
    grouped(group.cold_wakes),
    grouped(group.rebuild_tokens),
    dollars(group.rebuild_usd, group.unpriced_rebuild_wakes > 0),
  ];
  const rows = [
    ...report.groups.map((group) =>
      row(
        dimensions.map((d) => group[d]),
        group,
      ),
    ),
    row(["total", ...dimensions.slice(1).map(() => "")], report.totals),
  ];
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((r) => String(r[i]).length)));
  const format = (cells) =>
    cells
      .map((cell, i) =>
        i < dimensions.length ? String(cell).padEnd(widths[i]) : String(cell).padStart(widths[i]),
      )
      .join("  ");
  const out = [
    `Token usage on ${report.host}, ${report.window.since} .. ${report.window.until}`,
    "Cost is an estimate at public API list prices for these tokens: a conversion, not an invoice.",
    "",
    format(header),
    format(widths.map((w) => "-".repeat(w))),
    ...rows.map(format),
    "",
    "input-side = Claude input+cache read+cache write, Codex input (already includes cached). cache hit = cache read / input-side.",
  ];
  const other = report.nonAlliance;
  if (other.requests)
    out.push(
      report.includesNonAlliance
        ? `Includes ${grouped(other.requests)} requests not tied to an Alliance role (${grouped(other.tokens.total)} tokens).`
        : `Excluded: ${grouped(other.requests)} requests (${grouped(other.tokens.total)} tokens, ${dollars(other.est_cost_usd, other.unpriced_requests > 0)}) not tied to an Alliance role; add --include-other to count them.`,
    );
  if (report.unpricedModels.length)
    out.push(
      `No price for: ${report.unpricedModels.map((m) => `${m.model ?? "?"} (${m.provider}, ${grouped(m.requests)} req)`).join(", ")}. Their cost is missing from est. USD (shown with ≥); see usage-pricing.json.`,
    );
  const roleCoverage = Object.entries(report.attribution)
    .map(([provider, slots]) => {
      const total = Object.values(slots).reduce((sum, slot) => sum + slot.requests, 0);
      const known = slots.agent.requests + slots.path.requests;
      return `${provider} ${percent(total ? known / total : null)} of ${grouped(total)} requests (agent record ${grouped(slots.agent.requests)}, profile path ${grouped(slots.path.requests)})`;
    })
    .join("; ");
  out.push(`Role coverage: ${roleCoverage || "no requests in the window"}.`);
  out.push(
    `agy coverage: ${report.coverage.agy.databases_read} databases read, ${report.coverage.agy.unreadable_files} unavailable, ${report.coverage.agy.missing_timestamps} calls skipped without timestamps, ${report.coverage.agy.bad_records} bad records.`,
  );
  if (report.coverage.agy.unreadable_files)
    out.push(
      `${report.coverage.agy.sqlite_snapshot} Reasons: ${Object.entries(report.coverage.agy.snapshot_failures)
        .map(([reason, n]) => `${reason}=${n}`)
        .join(", ")}.`,
    );
  out.push(
    `Pi coverage: ${report.coverage.pi.files_read} files read, ${report.coverage.pi.unreadable_files} unavailable, ${report.coverage.pi.bad_records} bad records. Compaction/branch usage without an explicit model is unpriced.`,
  );
  if (report.wakeMarkers.available) {
    out.push(`Wake sources: ${report.wakeMarkers.basis}`);
    for (const g of report.wakeMarkers.by_source)
      out.push(`  ${g.provider} ${g.source}: ${grouped(g.turns)} turns`);
  }
  out.push(`Cold wakes: ${report.coverage.cold_wakes.basis}`);
  if (report.friction.available) {
    out.push(
      "",
      `Weekly friction (retained records; snapshot ${report.friction.snapshot_at}):`,
      report.friction.basis,
    );
    for (const [key, basis] of Object.entries(report.friction.metric_basis)) out.push(`  ${key}: ${basis}`);
    out.push(
      `Review coverage: ${report.friction.coverage.oldest_retained_review_at ?? "unavailable"} .. ${report.friction.coverage.newest_retained_review_at ?? "unavailable"}; terminal wakeups retained 7 days. Missing tables: ${report.friction.coverage.missing_tables.join(", ") || "none"}.`,
    );
    for (const week of report.friction.weeks)
      out.push(
        `${week.week}: review.wait n=${week["review.wait"].samples ?? "unavailable"} p50=${week["review.wait"].p50_ms ?? "-"}ms p90=${week["review.wait"].p90_ms ?? "-"}ms; review.superseded=${week["review.superseded"] ?? "unavailable"}; review.reject=${week["review.reject"] ?? "unavailable"}; review.defer=${week["review.defer"] ?? "unavailable"}; human.waiting=${week["human.waiting"] ?? "unavailable"}`,
      );
  } else
    out.push(
      `Weekly friction unavailable: ${report.friction.coverage.store_unavailable_reason}; ${report.friction.sqlite_snapshot}`,
    );
  out.push(
    `Prices fetched ${report.pricing.fetched}; update: put overriding prices in <alliance home>/usage-pricing.json or pass --pricing FILE (same layout as the bundled table).`,
  );
  return out.join("\n");
}
