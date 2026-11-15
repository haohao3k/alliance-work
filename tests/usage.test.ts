import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { loadPricing, modelRates, recordCost, renderText, usageReport } from "../server/usage-report.mjs";
import { readUsageDatabase } from "../server/usage-sqlite.mjs";
import { temporary } from "./temp";

const since = Date.parse("2026-11-05T00:00:00Z");
const until = Date.parse("2026-11-06T00:00:00Z");
const sqliteSnapshots = typeof DatabaseSync.prototype.deserialize === "function";

test("Hydrogen usage prices native effort IDs at its published Standard API rates", async () => {
  const { table } = await loadPricing();
  for (const id of ["gemini-4-hydrogen", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-high"])
    assert.deepEqual(modelRates(table, "agy", id), { input: 1.5, cache_read: 0.075, output: 7.5 });
  assert.equal(modelRates(table, "agy", "gemini-4-hydrogen-unlisted"), null);
  assert.equal(
    recordCost(table, {
      provider: "agy",
      model: "gemini-4-hydrogen-medium",
      uncached: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      output: 1_000_000,
    }),
    9.075,
  );
});
const at = (hour: number, minute = 0) =>
  `2026-11-05T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
const TEXT = [
  "SENTINEL_PROMPT_TEXT",
  "SENTINEL_REPLY_TEXT",
  "SENTINEL_TOOL_OUTPUT",
  "SENTINEL_BEARER_abc123",
];

async function put(path: string, lines: unknown[], raw = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.map((line) => (raw ? line : JSON.stringify(line))).join("\n")}\n`);
}
function claude(session: string, id: string, request: string, timestamp: string, usage: object, extra = {}) {
  return {
    type: "assistant",
    timestamp,
    sessionId: session,
    requestId: request,
    cwd: "/SENTINEL/work/dir",
    message: {
      id,
      model: "claude-test-1",
      role: "assistant",
      content: [{ type: "text", text: `${TEXT[1]} mentions "usage" and assistant and a line separator` }],
      usage,
      ...extra,
    },
  };
}
const split = (five: number, hour: number) => ({
  ephemeral_5m_input_tokens: five,
  ephemeral_1h_input_tokens: hour,
});
const codexRecord = (
  id: string,
  timestamp: string,
  input: number,
  cached: number,
  output: number,
  reasoning = 0,
) => ({
  timestamp,
  type: "token_usage_record",
  payload: {
    response_id: id,
    usage: {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output,
    },
  },
});
const codexCount = (timestamp: string, last: [number, number, number], total: [number, number, number]) => {
  const shape = ([input, cached, output]: [number, number, number]) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: shape(last), total_token_usage: shape(total) },
    },
  };
};
const meta = (id: string, extra = {}) => ({
  timestamp: at(1),
  type: "session_meta",
  payload: { id, session_id: id, cwd: "/SENTINEL/work/dir", instructions: TEXT[0], ...extra },
});
const turn = (model: string) => ({
  timestamp: at(1),
  type: "turn_context",
  payload: { model, summary: TEXT[2] },
});

async function fixture() {
  const userHome = await temporary("alliance-usage-home-");
  const home = join(userHome, ".alliance-work");
  const paseo = join(userHome, ".paseo");
  const peer = join(userHome, ".claude-alliance-work/peer/projects/-proj");
  // Peer, by profile directory: a streamed message repeated on several lines (partial, final, final),
  // the final copy again in a subagent file of a resumed session, and unrelated lines.
  const base = { input_tokens: 3, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000 };
  await put(join(peer, "sessA.jsonl"), [
    claude("sessA", "msg_1", "req_1", at(1), { ...base, output_tokens: 8, cache_creation: split(600, 400) }),
    { type: "user", timestamp: at(1), message: { role: "user", content: TEXT[0] } },
    claude("sessA", "msg_1", "req_1", at(1), {
      ...base,
      output_tokens: 264,
      cache_creation: split(600, 400),
    }),
    claude("sessA", "msg_1", "req_1", at(1), {
      ...base,
      output_tokens: 264,
      cache_creation: split(600, 400),
    }),
    claude("sessA", "msg_2", "req_2", at(2), {
      input_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 2000,
      output_tokens: 100,
    }),
    claude("sessA", "msg_s", "req_s", at(3), { input_tokens: 0, output_tokens: 0 }, { model: "<synthetic>" }),
    claude("sessA", "msg_old", "req_old", "2026-11-04T23:59:59.000Z", {
      input_tokens: 99,
      output_tokens: 99,
    }),
    claude("sessA", "msg_end", "req_end", "2026-11-06T00:00:00.000Z", {
      input_tokens: 99,
      output_tokens: 99,
    }),
  ]);
  await put(join(peer, "sessA/subagents/agent-x.jsonl"), [
    claude("sessA", "msg_1", "req_1", at(1), {
      ...base,
      output_tokens: 264,
      cache_creation: split(600, 400),
    }),
    claude("sessA", "msg_3", "req_3", at(4), {
      input_tokens: 1,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 400,
      output_tokens: 10,
    }),
  ]);
  // Lead, by Paseo agent record, in a directory that is not an Alliance profile. The record also
  // carries a connection credential that must never be read into the report.
  await put(join(userHome, ".claude/projects/-other/sessL.jsonl"), [
    claude("sessL", "msg_l1", "req_l1", at(5), { input_tokens: 2, output_tokens: 10 }),
    claude(
      "sessL",
      "msg_l2",
      "req_l2",
      at(6),
      { input_tokens: 1, output_tokens: 1 },
      { model: "mystery-model" },
    ),
  ]);
  await put(join(userHome, ".claude/projects/-personal/personal.jsonl"), [
    claude("personal", "msg_p", "req_p", at(7), { input_tokens: 7, output_tokens: 7 }),
  ]);
  await put(join(paseo, "agents/group/agent-lead.json"), [
    {
      id: "agent-lead",
      provider: "alliance-claude-lead",
      title: TEXT[0],
      persistence: {
        sessionId: "sessL",
        metadata: { mcpServers: { x: { headers: { Authorization: `Bearer ${TEXT[3]}` } } } },
      },
    },
  ]);
  await put(join(paseo, "agents/group/agent-peer-codex.json"), [
    { id: "agent-peer", provider: "alliance-codex-peer", persistence: { sessionId: "thread-peer" } },
  ]);
  await put(join(paseo, "agents/group/not-alliance.json"), [
    { id: "agent-x", provider: "claude", persistence: { sessionId: "personal" } },
  ]);
  // Codex lead, by profile directory: per-response records, one is a compaction call, cumulative
  // totals that omit it, a repeated event, and the same responses again in an archived copy.
  const lead = join(userHome, ".codex-alliance-work/lead");
  const leadLines = [
    meta("thread-lead"),
    turn("gpt-test-1"),
    codexRecord("resp_1", at(1), 1000, 800, 50, 20),
    codexCount(at(1), [1000, 800, 50], [1000, 800, 50]),
    codexRecord("resp_2", at(2), 2000, 1500, 100),
    { timestamp: at(2), type: "compacted", payload: { compaction_response_id: "resp_2", message: TEXT[2] } },
    codexCount(at(2), [2000, 1500, 100], [1000, 800, 50]),
    codexCount(at(2), [2000, 1500, 100], [1000, 800, 50]),
  ];
  await put(join(lead, "sessions/2026/11/05/rollout-2026-11-05T01-00-00-thread-lead.jsonl"), leadLines);
  await put(join(lead, "archived_sessions/rollout-2026-11-05T01-00-00-thread-lead.jsonl"), leadLines);
  // A spawned subagent thread outside any profile directory takes its parent's role from the agent record.
  await put(join(userHome, ".codex/sessions/2026/11/05/rollout-2026-11-05T03-00-00-thread-child.jsonl"), [
    meta("thread-child", { source: { subagent: { thread_spawn: { parent_thread_id: "thread-peer" } } } }),
    turn("gpt-test-1"),
    codexRecord("resp_c", at(3), 100, 0, 10),
  ]);
  // Older Codex files without token_usage_record: per-response last_token_usage, not the totals.
  const hq = join(userHome, ".codex-alliance-work/hq");
  await put(join(hq, "sessions/2026/11/05/rollout-2026-11-05T04-00-00-thread-hq.jsonl"), [
    meta("thread-hq"),
    turn("gpt-test-1"),
    codexCount(at(4), [500, 100, 5], [500, 100, 5]),
    codexCount(at(4, 1), [600, 200, 6], [1100, 300, 11]),
    codexCount(at(4, 1), [600, 200, 6], [1100, 300, 11]),
  ]);
  if (typeof zstdCompressSync === "function") {
    const path = join(hq, "archived_sessions/rollout-2026-11-05T05-00-00-thread-zst.jsonl.zst");
    await mkdir(dirname(path), { recursive: true });
    const body = [meta("thread-zst"), turn("gpt-test-1"), codexRecord("resp_z", at(5), 10, 0, 1)];
    await writeFile(
      path,
      zstdCompressSync(Buffer.from(`${body.map((line) => JSON.stringify(line)).join("\n")}\n`)),
    );
  }
  const pricing = join(userHome, "prices.json");
  await writeFile(
    pricing,
    JSON.stringify({
      anthropic: {
        "claude-test-1": { input: 10, cache_write_5m: 20, cache_write_1h: 30, cache_read: 1, output: 100 },
      },
      openai: { "gpt-test-1": { input: 10, cache_read: 1, output: 100 } },
    }),
  );
  return { userHome, home, paseo, pricing };
}

async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await stat(path);
    out.push(
      `${path} ${info.size} ${info.mtimeMs} ${
        info.isFile()
          ? createHash("sha256")
              .update(await readFile(path))
              .digest("hex")
          : "directory"
      }`,
    );
  }
  return out.sort();
}
const run = (f: Awaited<ReturnType<typeof fixture>>, extra: object = {}) =>
  usageReport({
    userHome: f.userHome,
    home: f.home,
    paseoHomes: [f.paseo],
    since,
    until,
    pricingFile: f.pricing,
    ...extra,
  });
const find = (report: Awaited<ReturnType<typeof run>>, filter: Record<string, string>) =>
  report.groups.find((g: Record<string, unknown>) => Object.entries(filter).every(([k, v]) => g[k] === v));

function assertUnavailableFriction(report: Awaited<ReturnType<typeof run>>) {
  assert.equal(report.friction.available, false);
  assert.deepEqual(report.friction.weeks, []);
  const reason = report.friction.coverage.store_unavailable_reason;
  assert.ok(reason);
  assert.match(reason, /^USAGE_SQLITE_NODE_UNSUPPORTED:/);
  assert.ok(reason.includes(process.version));
  assert.ok(renderText(report).includes(reason));
}

test("Claude lines repeating one response count once, with the finished copy, and cache hit uses the input side", async () => {
  const f = await fixture();
  const report = await run(f, { by: ["provider", "role"] });
  const peer = find(report, { provider: "claude", role: "peer" });
  // msg_1 (3 + 1000 + 9000 in, 264 out; seen on 4 lines in 2 files), msg_2 and the subagent's msg_3.
  assert.equal(peer?.requests, 3);
  assert.deepEqual(peer?.tokens, {
    total: 12509 + 374,
    input_side: 12509,
    input_uncached: 9,
    cache_read: 11400,
    cache_write: 1100,
    output: 374,
    reasoning: 0,
  });
  assert.equal(peer?.cache_hit, 11400 / 12509);
  assert.equal(report.coverage.claude.duplicate_lines_folded, 3);
  assert.equal(report.coverage.claude.synthetic_skipped, 1);
  // 5m/1h split, writes without a split billed as 5m: hand-computed at 10/20/30/1/100 per 1M.
  assert.equal(peer?.est_cost_usd, (59430 + 12050 + 3410) / 1e6);
});

test("Codex counts each response once, includes compaction calls and ignores cumulative totals", async () => {
  const f = await fixture();
  const report = await run(f);
  const lead = find(report, { provider: "codex", role: "lead" });
  assert.equal(lead?.requests, 2);
  assert.deepEqual(lead?.tokens, {
    total: 3150,
    input_side: 3000,
    input_uncached: 700,
    cache_read: 2300,
    cache_write: 0,
    output: 150,
    reasoning: 20,
  });
  assert.equal(lead?.compaction_requests, 1);
  assert.equal(lead?.cache_hit, 2300 / 3000);
  assert.equal(lead?.est_cost_usd, (7800 + 16500) / 1e6);
  const hq = find(report, { provider: "codex", role: "hq" });
  // Per-response events (500 + 600), never the running total (1100); the repeated event once; plus the .zst file.
  assert.equal(hq?.requests, typeof zstdCompressSync === "function" ? 3 : 2);
  assert.equal(hq?.tokens.input_side, 1100 + (typeof zstdCompressSync === "function" ? 10 : 0));
});

test("roles come from the agent record or the profile directory; the rest is reported, not guessed", async () => {
  const f = await fixture();
  const report = await run(f);
  assert.equal(find(report, { provider: "claude", role: "lead" })?.requests, 2);
  assert.equal(find(report, { provider: "codex", role: "peer" })?.requests, 1);
  assert.equal(report.nonAlliance.requests, 1);
  assert.equal(report.totals.requests, 3 + 2 + 2 + 1 + (typeof zstdCompressSync === "function" ? 3 : 2));
  assert.deepEqual(report.attribution.claude.none, { requests: 1, tokens: 14 });
  assert.equal(report.attribution.claude.agent.requests, 2);
  const withOther = await run(f, { includeOther: true, by: ["role"] });
  assert.equal(find(withOther, { role: "(non-alliance)" })?.requests, 1);
  assert.equal(withOther.totals.requests, report.totals.requests + 1);
});

test("a model without a listed price is reported unpriced instead of guessed", async () => {
  const f = await fixture();
  const report = await run(f);
  assert.deepEqual(report.unpricedModels, [
    { provider: "claude", model: "mystery-model", requests: 1, tokens: 2 },
  ]);
  const lead = find(report, { provider: "claude", role: "lead" });
  assert.equal(lead?.unpriced_requests, 1);
  assert.equal(lead?.est_cost_usd, (2 * 10 + 10 * 100) / 1e6);
  assert.match(renderText(report), /≥\$/);
  const table = { anthropic: { "claude-opus-5-5": { input: 4, cache_read: 0.2, output: 20 } } };
  const cost = (model: string) =>
    recordCost(table, {
      provider: "claude",
      model,
      uncached: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: 0,
      inputTotal: 1_000_000,
    });
  assert.equal(cost("claude-opus-5-5[1m]"), 4);
  assert.equal(cost("claude-opus-5-5-20261001"), 4);
  assert.equal(cost("claude-opus-5-6"), null);
});

test("output carries counters only: no conversation text, paths, ids or credentials", async () => {
  const f = await fixture();
  const report = await run(f, { by: ["provider", "role", "model", "day"], includeOther: true });
  const everything = JSON.stringify(report) + renderText(report);
  for (const text of [
    ...TEXT,
    "SENTINEL",
    "sessA",
    "sessL",
    "thread-",
    "agent-lead",
    "msg_",
    "req_",
    "resp_",
  ])
    assert.ok(!everything.includes(text), `output must not contain ${text}`);
  const allowed = new Set([
    "provider",
    "role",
    "model",
    "day",
    "requests",
    "tokens",
    "cache_hit",
    "compaction_requests",
    "est_cost_usd",
    "unpriced_requests",
    "cold_wakes",
    "rebuild_tokens",
    "rebuild_usd",
    "unpriced_rebuild_wakes",
  ]);
  for (const group of report.groups) for (const key of Object.keys(group)) assert.ok(allowed.has(key), key);
  assert.deepEqual(Object.keys(report.groups[0].tokens).sort(), [
    "cache_read",
    "cache_write",
    "input_side",
    "input_uncached",
    "output",
    "reasoning",
    "total",
  ]);
});

test("reading changes nothing and a missing Alliance home is not created", async () => {
  const f = await fixture();
  const before = await snapshot(f.userHome);
  await run(f);
  await run(f, { includeOther: true, by: ["day"] });
  assert.deepEqual(await snapshot(f.userHome), before);
  await assert.rejects(stat(f.home));
});

test("the window is half-open on record time, not file time", async () => {
  const f = await fixture();
  // msg_end is stamped exactly at `until`: out of [since, until), in of a window starting there.
  const edge = await run(f, { since: until, until: until + 3_600_000 });
  assert.equal(edge.totals.requests, 1);
  const none = await run(f, { since: until + 1000, until: until + 3_600_000 });
  assert.equal(none.totals.requests, 0);
  assert.equal(none.totals.cache_hit, null);
  const day = await run(f, {
    since: Date.parse("2026-11-04T00:00:00Z"),
    until: Date.parse("2026-11-05T00:00:00Z"),
  });
  // msg_old is stamped 23:59:59 on the 4th inside a file whose other records are on the 5th.
  assert.equal(day.totals.requests, 1);
});

test("the usage command prints JSON from explicit locations and rejects bad options", async () => {
  const f = await fixture();
  const root = join(import.meta.dirname, "..");
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, "scripts/cli.mjs"), "usage", ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
  const ok = cli(
    "--json",
    "--home",
    f.home,
    "--user-home",
    f.userHome,
    "--paseo-home",
    f.paseo,
    "--since",
    "2026-11-05",
    "--until",
    "2026-11-06",
    "--pricing",
    f.pricing,
  );
  assert.equal(ok.status, sqliteSnapshots ? 0 : 2, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  if (!sqliteSnapshots) assertUnavailableFriction(parsed);
  assert.equal(parsed.totals.requests, 3 + 2 + 2 + 1 + (typeof zstdCompressSync === "function" ? 3 : 2));
  assert.match(parsed.basis, /not an invoice/);
  assert.deepEqual(await readFile(f.pricing, "utf8").then((t) => Object.keys(JSON.parse(t))), [
    "anthropic",
    "openai",
  ]);
  const bad = cli("--by", "session", "--home", f.home, "--user-home", f.userHome);
  assert.notEqual(bad.status, 0);
  assert.equal(cli("--wat").status === 0, false);
  await assert.rejects(stat(f.home));
});

test("the bundled price table is complete enough to price what it lists", async () => {
  const table = JSON.parse(await readFile(join(import.meta.dirname, "../server/usage-pricing.json"), "utf8"));
  assert.match(table._fetched, /^\d{4}-\d{2}-\d{2}$/);
  for (const [family, models] of Object.entries<Record<string, Record<string, unknown>>>({
    anthropic: table.anthropic,
    openai: table.openai,
  })) {
    for (const [model, rates] of Object.entries(models)) {
      if (model.startsWith("_")) continue;
      for (const key of family === "anthropic"
        ? ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"]
        : ["input", "cache_read", "output"])
        assert.equal(typeof rates[key], "number", `${family}/${model}.${key}`);
    }
  }
});

async function measurementFixture() {
  const userHome = await temporary("usage-measure-");
  const home = join(userHome, "alliance");
  const paseo = join(userHome, "paseo");
  const pricing = join(userHome, "prices.json");
  await writeFile(
    pricing,
    JSON.stringify({
      anthropic: {
        "claude-test-1": { input: 10, cache_write_5m: 20, cache_write_1h: 30, cache_read: 1, output: 100 },
      },
      google: { "gemini-test": { input: 10, cache_read: 1, output: 100 } },
    }),
  );
  return { userHome, home, paseo, pricing };
}

test("cold wakes follow deduplicated main chains, known TTL and the previous request across the window edge", async () => {
  const f = await measurementFixture();
  const root = join(f.userHome, ".claude-alliance-work/peer/projects/p");
  const cases = [
    ["cold", at(0), at(1, 10), 19000, 1000, split(0, 20000)],
    ["warm", at(0), at(0, 40), 19000, 1000, split(0, 20000)],
    ["shrink", at(0), at(1, 10), 1000, 0, split(0, 20000)],
    ["short", at(0), at(0, 6), 20000, 0, split(20000, 0)],
    ["unknown", at(0), at(0, 6), 20000, 0, undefined],
    ["edge", "2026-11-04T23:30:00Z", at(0, 40), 20000, 0, split(0, 20000)],
    ["sub/subagents/agent-x", at(0), at(1, 10), 20000, 0, split(0, 20000)],
  ] as const;
  for (const [session, previous, next, write, read, ttl] of cases) {
    const rows = [
      claude(session, `${session}-a`, `${session}-a`, previous, {
        input_tokens: 0,
        cache_creation_input_tokens: 20000,
        cache_creation: ttl,
        output_tokens: 1,
      }),
      claude(session, `${session}-b`, `${session}-b`, next, {
        input_tokens: 0,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: read,
        output_tokens: 1,
      }),
    ];
    await put(join(root, `${session}.jsonl`), rows);
    if (session === "cold") await put(join(root, "copied.jsonl"), rows);
  }
  const report = await run(f, { by: ["gap"] });
  assert.equal(report.totals.cold_wakes, 3);
  assert.equal(report.totals.rebuild_tokens, 59000);
  assert.equal(report.totals.rebuild_usd, (59000 * 29) / 1e6);
  assert.equal(find(report, { gap: "55–75m" })?.cold_wakes, 2);
  assert.equal(find(report, { gap: "5–55m" })?.cold_wakes, 1);
  assert.equal(report.coverage.claude.duplicate_lines_folded, 2);
  assert.match(renderText(report), /cold wakes/);
});

const varint = (value: number): Buffer => {
  const out = [];
  do {
    out.push((value % 128) | (value >= 128 ? 128 : 0));
    value = Math.floor(value / 128);
  } while (value);
  return Buffer.from(out);
};
const proto = (fields: [number, number | Buffer | string][]): Buffer =>
  Buffer.concat(
    fields.map(([key, value]) => {
      if (typeof value === "number") return Buffer.concat([varint(key * 8), varint(value)]);
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      return Buffer.concat([varint(key * 8 + 2), varint(bytes.length), bytes]);
    }),
  );

test("agy reads per-call protobuf counters once and skips calls without an attributable time", async () => {
  const f = await measurementFixture();
  const path = join(
    f.userHome,
    ".agy-alliance-work/lead/os-home/.gemini/antigravity-cli/conversations/session.db",
  );
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE gen_metadata(idx INTEGER, data BLOB)");
  const usage = proto([
    [2, 100],
    [3, 50],
    [4, 10],
    [5, 900],
    [9, 20],
    [10, 30],
  ]);
  const row = proto([
    [
      1,
      proto([
        [19, "gemini-test"],
        [4, usage],
        [9, proto([[4, proto([[1, since / 1000 + 3600]])]])],
      ]),
    ],
  ]);
  db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(1, row);
  db.prepare("INSERT INTO gen_metadata VALUES (?,?)").run(
    2,
    proto([
      [
        1,
        proto([
          [19, "gemini-test"],
          [4, usage],
        ]),
      ],
    ]),
  );
  db.close();
  const before = await snapshot(f.userHome);
  const report = await run(f);
  const agy = find(report, { provider: "agy", role: "lead" });
  if (sqliteSnapshots) {
    assert.equal(agy?.requests, 1);
    assert.equal(agy?.tokens.input_side, 1010);
    assert.equal(agy?.tokens.reasoning, 20);
    assert.equal(agy?.est_cost_usd, (1000 + 100 + 900 + 5000) / 1e6);
    assert.equal(report.coverage.agy.missing_timestamps, 1);
  } else {
    assert.equal(agy, undefined, "unavailable SQLite usage must not appear as a measured group");
    assert.equal(report.coverage.agy.databases_read, 0);
    assert.equal(report.coverage.agy.unreadable_files, 1);
    const failures = Object.entries(report.coverage.agy.snapshot_failures);
    assert.equal(failures.length, 1);
    assert.match(failures[0][0], /^USAGE_SQLITE_NODE_UNSUPPORTED:/);
    assert.ok(failures[0][0].includes(process.version));
    assert.equal(failures[0][1], 1);
  }
  assert.deepEqual(await snapshot(f.userHome), before);
});

test("Pi includes billed assistant, compaction and usage entries, folding archived or forked copies", async () => {
  const f = await measurementFixture();
  const base = join(f.userHome, ".pi-alliance-work/peer/sessions/p");
  const usage = { input: 100, cacheRead: 900, cacheWrite: 10, output: 50, reasoning: 20, totalTokens: 1060 };
  const rows = [
    { type: "session", id: "pi-session", timestamp: at(0) },
    { type: "model_change", id: "model", provider: "google", modelId: "gemini-test" },
    {
      type: "message",
      id: "pi-msg",
      timestamp: at(1),
      message: { role: "assistant", provider: "google", model: "gemini-test", usage, content: TEXT[0] },
    },
    {
      type: "compaction",
      id: "compact",
      timestamp: at(2),
      provider: "google",
      model: "gemini-test",
      usage,
      summary: TEXT[2],
    },
    {
      type: "usage",
      id: "warm",
      timestamp: at(3),
      provider: "google",
      model: "gemini-test",
      usage,
      note: TEXT[1],
    },
  ];
  await put(join(base, "session.jsonl"), rows);
  await put(join(base, "copy.jsonl"), rows);
  await put(join(base, "fork.jsonl"), [{ ...rows[0], id: "forked-session" }, ...rows.slice(1)]);
  const report = await run(f);
  const pi = find(report, { provider: "pi", role: "peer" });
  assert.equal(pi?.requests, 3);
  assert.equal(pi?.tokens.input_side, 3030);
  assert.equal(pi?.compaction_requests, 1);
  assert.equal(pi?.est_cost_usd, (3 * (1000 + 100 + 900 + 5000)) / 1e6);
  for (const sentinel of TEXT) assert.ok(!JSON.stringify(report).includes(sentinel));
});

test("friction joins each handback to its first disposition and exposes snapshot limits without source writes", async () => {
  const f = await measurementFixture();
  await mkdir(f.home, { recursive: true });
  const db = new DatabaseSync(join(f.home, "rooms.sqlite"));
  for (const table of ["rooms", "wakeups", "members", "autonomy", "obligations"])
    db.exec(`CREATE TABLE ${table}(data TEXT)`);
  const insert = (table: string, data: object) =>
    db.prepare(`INSERT INTO ${table} VALUES (?)`).run(JSON.stringify(data));
  insert("rooms", { id: "room", artifacts: join(f.home, "rooms/r") });
  insert("wakeups", {
    key: "review-a",
    trigger: { kind: "turn", agentId: "child", turnId: "t1" },
    createdAt: since + 3600000,
    updatedAt: since + 4200000,
    state: "canceled",
    note: "Turn superseded or decided",
    defers: 2,
  });
  insert("wakeups", {
    key: "review-b",
    trigger: { kind: "turn", agentId: "child", turnId: "t2" },
    createdAt: since + 7200000,
    updatedAt: since + 7500000,
    state: "canceled",
    note: "Turn superseded or decided",
  });
  insert("members", {
    id: "orphan",
    roomId: "room",
    parentId: null,
    decision: "open",
    lastOutcome: "completed",
    resultPath: "receipt",
    lastTurnId: "old",
    lastTurnEndedAt: since - 3 * 86400000,
  });
  db.close();
  await put(join(f.home, "rooms/r/dispositions/first.json"), [
    { agentId: "child", decision: "rejected", at: at(1, 5), candidate: TEXT[0] },
  ]);
  const before = await snapshot(f.userHome);
  const report = await run(f, { now: until - 1 });
  if (sqliteSnapshots) {
    const week = report.friction.weeks[0];
    assert.equal(week["review.wait"].samples, 1);
    assert.equal(week["review.wait"].p50_ms, 300000);
    assert.equal(week["review.superseded"], 1);
    assert.equal(week["review.reject"], 1);
    assert.equal(week["review.defer"], 2);
    assert.equal(week["human.waiting"], 1);
  } else assertUnavailableFriction(report);
  assert.match(report.friction.basis, /snapshot/);
  assert.deepEqual(await snapshot(f.userHome), before);
  assert.ok(!JSON.stringify(report).includes(TEXT[0]));
});

test("wake source counts use exact marker episodes, refine unknown, and never label native plain as Human", async () => {
  const f = await measurementFixture();
  await mkdir(f.home, { recursive: true });
  const episode = {
    agentId: "private-agent",
    provider: "alliance-claude-peer",
    turnId: "private-turn",
    time: since + 3600000,
  };
  await put(join(f.home, "wake-markers.jsonl"), [
    { ...episode, source: "unknown" },
    { ...episode, source: "alliance.wakeup", promptId: "private-prompt" },
    { ...episode, source: "unknown" },
    { ...episode, turnId: "other-turn", time: since + 7200000, source: "native.plain" },
    { ...episode, turnId: "future-turn", time: until, source: "alliance.retry" },
  ]);
  const before = await snapshot(f.userHome);
  const report = await run(f);
  assert.equal(report.wakeMarkers.turns, 2);
  assert.deepEqual(report.wakeMarkers.by_source, [
    { provider: "claude", source: "alliance.wakeup", turns: 1 },
    { provider: "claude", source: "native.plain", turns: 1 },
  ]);
  assert.match(report.wakeMarkers.basis, /not joined/);
  assert.ok(!JSON.stringify(report).includes("private-"));
  assert.deepEqual(await snapshot(f.userHome), before);
});

test("unknown Pi compaction model remains unpriced; catalog prices never come from transcript cost", async () => {
  const f = await measurementFixture();
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 999999 } };
  await put(join(f.userHome, ".pi/agent/sessions/p/session.jsonl"), [
    { type: "session", id: "native-pi", timestamp: at(0) },
    { type: "model_change", provider: "google", modelId: "gemini-test" },
    { type: "compaction", id: "costly", timestamp: at(1), usage },
  ]);
  const report = await run(f, { includeOther: true });
  assert.equal(report.totals.requests, 1);
  assert.equal(report.totals.compaction_requests, 1);
  assert.equal(report.totals.unpriced_requests, 1);
  assert.equal(report.totals.est_cost_usd, 0);
});

test("reporting an open WAL store reads committed rows without changing database or sidecar bytes", async () => {
  const f = await measurementFixture();
  await mkdir(f.home, { recursive: true });
  const db = new DatabaseSync(join(f.home, "rooms.sqlite"));
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE rooms(data TEXT); CREATE TABLE members(data TEXT); CREATE TABLE wakeups(data TEXT); CREATE TABLE autonomy(data TEXT); CREATE TABLE obligations(data TEXT)",
    );
    db.prepare("INSERT INTO wakeups VALUES (?)").run(
      JSON.stringify({ key: "wal-only", trigger: { kind: "time" }, updatedAt: since + 1, defers: 2 }),
    );
    const before = await snapshot(f.userHome);
    const report = await run(f, { now: until - 1 });
    if (sqliteSnapshots) assert.equal(report.friction.weeks[0]["review.defer"], 2);
    else assertUnavailableFriction(report);
    assert.deepEqual(await snapshot(f.userHome), before);
  } finally {
    db.close();
  }
});

test("memory SQLite snapshots ignore uncommitted frames and remain usable after rollback and checkpoint", async () => {
  const f = await measurementFixture();
  const path = join(f.userHome, "commits.db");
  const db = new DatabaseSync(path);
  const rows = async () => {
    const copy = await readUsageDatabase(path);
    try {
      return copy.prepare("SELECT COUNT(*) AS n FROM sample").get()?.n;
    } finally {
      copy.close();
    }
  };
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA cache_size=1; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(data BLOB); INSERT INTO sample VALUES (zeroblob(4096)); BEGIN IMMEDIATE",
    );
    for (let i = 0; i < 50; i++) db.exec("INSERT INTO sample VALUES (zeroblob(4096))");
    const before = await snapshot(f.userHome);
    if (!sqliteSnapshots) {
      await assert.rejects(readUsageDatabase(path), { code: "USAGE_SQLITE_NODE_UNSUPPORTED" });
      assert.deepEqual(await snapshot(f.userHome), before);
      return;
    }
    assert.equal(await rows(), 1);
    assert.deepEqual(await snapshot(f.userHome), before);
    db.exec("ROLLBACK; PRAGMA wal_checkpoint(TRUNCATE)");
    assert.equal(await rows(), 1);
    db.exec("INSERT INTO sample VALUES (zeroblob(4096))");
    assert.equal(await rows(), 2);
  } finally {
    db.close();
  }
});

test("WAL snapshots need no SHM and reject corrupt or truncated frames instead of silently losing usage", async () => {
  const f = await measurementFixture();
  const source = join(f.userHome, "source.db");
  const target = join(f.userHome, "copy.db");
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample(n INTEGER); INSERT INTO sample VALUES (7)");
    const base = await readFile(source);
    const wal = await readFile(`${source}-wal`);
    await writeFile(target, base);
    await writeFile(`${target}-wal`, wal);
    const before = await snapshot(f.userHome);
    if (!sqliteSnapshots) {
      await assert.rejects(readUsageDatabase(target), { code: "USAGE_SQLITE_NODE_UNSUPPORTED" });
      assert.deepEqual(await snapshot(f.userHome), before);
      await assert.rejects(stat(`${target}-shm`));
      return;
    }
    const copy = await readUsageDatabase(target);
    try {
      assert.equal(copy.prepare("SELECT n FROM sample").get()?.n, 7);
    } finally {
      copy.close();
    }
    assert.deepEqual(await snapshot(f.userHome), before);
    await assert.rejects(stat(`${target}-shm`));
    const bad = Buffer.from(wal);
    bad[bad.length - 1] ^= 1;
    await writeFile(`${target}-wal`, bad);
    await assert.rejects(readUsageDatabase(target), { code: "USAGE_SQLITE_CORRUPT_WAL" });
    await writeFile(`${target}-wal`, wal.subarray(0, wal.length - 1));
    await assert.rejects(readUsageDatabase(target), { code: "USAGE_SQLITE_TRUNCATED_WAL" });
    await writeFile(`${target}-wal`, wal);
    const retried = await readUsageDatabase(target);
    try {
      assert.equal(retried.prepare("SELECT n FROM sample").get()?.n, 7);
    } finally {
      retried.close();
    }
  } finally {
    db.close();
  }
});

test("old Node reports SQLite coverage unavailable without opening or creating a source database", async () => {
  const f = await measurementFixture();
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "deserialize");
  if (descriptor)
    Object.defineProperty(DatabaseSync.prototype, "deserialize", { ...descriptor, value: undefined });
  try {
    const before = await snapshot(f.userHome);
    const report = await run(f);
    assert.equal(report.friction.available, false);
    assert.match(report.friction.coverage.store_unavailable_reason ?? "", /^USAGE_SQLITE_NODE_UNSUPPORTED:/);
    assert.match(renderText(report), /NODE_UNSUPPORTED/);
    assert.deepEqual(await snapshot(f.userHome), before);
  } finally {
    if (descriptor) Object.defineProperty(DatabaseSync.prototype, "deserialize", descriptor);
  }
});

test("usage reads a recycled WAL's committed prefix without replaying stale checkpoint frames", async () => {
  const f = await measurementFixture();
  const path = join(f.userHome, "recycled.db");
  const db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(n INTEGER, data BLOB)",
    );
    for (let i = 0; i < 20; i++) db.exec(`INSERT INTO sample VALUES (${i}, zeroblob(4096))`);
    db.exec("PRAGMA wal_checkpoint(RESTART); UPDATE sample SET n=100 WHERE n=0");
    const wal = await readFile(`${path}-wal`);
    const pageSize = wal.readUInt32BE(8);
    let stale = false;
    for (let offset = 32; offset + 24 + pageSize <= wal.length; offset += 24 + pageSize)
      if (!wal.subarray(offset + 8, offset + 16).equals(wal.subarray(16, 24))) stale = true;
    assert.ok(stale, "real SQLite reset retains old-epoch tail frames");
    const expected = db.prepare("SELECT COUNT(*) n, SUM(n) total FROM sample").get();
    const before = await snapshot(f.userHome);
    if (!sqliteSnapshots) {
      await assert.rejects(readUsageDatabase(path), { code: "USAGE_SQLITE_NODE_UNSUPPORTED" });
      assert.deepEqual(await snapshot(f.userHome), before);
      return;
    }
    const copy = await readUsageDatabase(path);
    try {
      assert.deepEqual(copy.prepare("SELECT COUNT(*) n, SUM(n) total FROM sample").get(), expected);
    } finally {
      copy.close();
    }
    assert.deepEqual(await snapshot(f.userHome), before);
  } finally {
    db.close();
  }
});

test("unsupported Node reports unavailable SQLite sections with its version, never zero measurements", async () => {
  const f = await measurementFixture();
  const path = join(
    f.userHome,
    ".agy-alliance-work/lead/os-home/.gemini/antigravity-cli/conversations/session.db",
  );
  await mkdir(dirname(path), { recursive: true });
  new DatabaseSync(path).close();
  const descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "deserialize");
  if (descriptor)
    Object.defineProperty(DatabaseSync.prototype, "deserialize", { ...descriptor, value: undefined });
  try {
    const report = await run(f);
    assert.equal(report.friction.available, false);
    assert.deepEqual(report.friction.weeks, []);
    const reason = report.friction.coverage.store_unavailable_reason;
    assert.ok(reason);
    assert.ok(reason.includes(process.version));
    assert.match(reason, /deserialize.*24\.16/);
    assert.ok(Object.keys(report.coverage.agy.snapshot_failures).some((s) => s.includes(process.version)));
    assert.ok(renderText(report).includes(reason));
  } finally {
    if (descriptor) Object.defineProperty(DatabaseSync.prototype, "deserialize", descriptor);
  }
});

test("usage CLI prints partial JSON and exits 2 when Node cannot read SQLite snapshots", async () => {
  const f = await measurementFixture();
  const preload =
    "data:text/javascript," +
    encodeURIComponent(
      "import { DatabaseSync } from 'node:sqlite'; Object.defineProperty(DatabaseSync.prototype, 'deserialize', {value: undefined});",
    );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      preload,
      "scripts/cli.mjs",
      "usage",
      "--home",
      f.home,
      "--user-home",
      f.userHome,
      "--paseo-home",
      f.paseo,
      "--json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.friction.available, false);
  assert.ok(report.friction.coverage.store_unavailable_reason.includes(process.version));
  assert.ok(report.coverage.claude);
  assert.ok(report.coverage.codex);
});
