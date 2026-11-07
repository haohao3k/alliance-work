// Real Codex + disposable Paseo 0.12: a maintenance turn preserves a handback until native steer changes its work.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { candidateSnapshot, runVerification } from "../server/evidence.mjs";
import { sourceIdentity } from "./capabilities.mjs";
import { activate } from "./maintenance.mjs";
import { paseo } from "./paseo.mjs";
import { projectRoot } from "./profiles.mjs";

const [outputArg, authArg] = process.argv.slice(2);
if (!outputArg || !authArg)
  throw new Error("Usage: node scripts/acceptance-steering.mjs NEW_OUTPUT CODEX_AUTH_SOURCE");
const output = resolve(outputArg);
const authFrom = resolve(authArg);
const home = join(output, "home");
const paseoHome = join(output, "paseo");
const cwd = join(output, "project");
await mkdir(output, { mode: 0o700 });
await mkdir(cwd);
// Paseo probes installed providers before role launch. Isolate that outer process too.
const environmentHome = join(output, "environment");
for (const [name, directory] of Object.entries({
  HOME: "os-home",
  XDG_CONFIG_HOME: "config",
  XDG_CACHE_HOME: "cache",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  CODEX_HOME: "codex",
  CLAUDE_CONFIG_DIR: "claude",
  PI_CODING_AGENT_DIR: "pi",
})) {
  const path = join(environmentHome, directory);
  await mkdir(path, { recursive: true, mode: 0o700 });
  process.env[name] = path;
}
for (const name of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "PASEO_AGENT_ID",
  "ALLIANCE_HOME",
  "ALLIANCE_WORKSPACE_CWD",
  "ALLIANCE_CONTEXT",
])
  delete process.env[name];
execFileSync("git", ["init", "-q", cwd]);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const receipt = {
  startedAt: new Date().toISOString(),
  sourceDigest: await sourceIdentity(projectRoot),
  classification: "Real-model native Paseo steering with isolated role homes",
  checks: {},
};
let client, api, peer;
const rpc = (method, input = {}) => client.invokePluginRpc("alliance-work", method, input);
const member = async () => (await rpc("rooms.list")).members.find((row) => row.id === peer.id);
const autonomy = async () => (await rpc("autonomy.list")).find((row) => row.agentId === peer.id);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const cli = `${shellQuote(process.execPath)} ${shellQuote(join(projectRoot, "scripts/cli.mjs"))} --home ${shellQuote(home)}`;
const text = async (path) => readFile(path, "utf8").catch(() => "");
async function wait(label, predicate, ms = 240000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await predicate();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
async function reminder(key, reason) {
  const current = await member();
  return rpc("wakeups.add", {
    key,
    roomId: current.roomId,
    ownerId: peer.id,
    reason,
    delivery: "idle",
    trigger: { kind: "time", at: Date.now() },
  });
}
try {
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom,
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "steering-acceptance",
    connectTimeoutMs: 10000,
  });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(cwd);
  peer = await workspace.agents.create({
    title: "Disposable same-turn steering regression",
    config: {
      provider: "alliance-codex-peer/gpt-6.1-sol",
      thinkingOptionId: "high",
      modeId: "full-access",
    },
  });
  receipt.agentId = peer.id;
  await rpc("autonomy.start", { agentId: peer.id, autoArchive: false, maxRetries: 0 });
  await peer.run(
    `Bounded regression test in ${cwd}. Do not delegate. Write candidate.txt containing exactly v1. Run ${cli} autonomy checkpoint --phase review --reason 'Initial v1 candidate'. End the turn. Later reminders are maintenance: follow their specific instructions, do not change candidate.txt or checkpoint unless a new explicit rework prompt instructs you.`,
    { timeoutMs: 240000 },
  );
  const initial = await wait("initial handback", async () => {
    const row = await member();
    return row.lastTurnId && row.resultPath && (await autonomy()).phase === "review" ? row : null;
  });
  assert.equal((await text(join(cwd, "candidate.txt"))).trim(), "v1");
  const proof = await runVerification({
    cwd,
    output: join(output, "initial-proof"),
    scenario: "initial candidate",
    kind: "test",
    command: [
      process.execPath,
      "-e",
      "require('assert/strict').equal(require('fs').readFileSync('candidate.txt','utf8').trim(),'v1')",
    ],
  });
  const accept = () =>
    rpc("members.disposition", {
      agentId: peer.id,
      decision: "accepted",
      candidate: proof.report.candidate.digest,
      evidence: proof.path,
      actorId: null,
    });
  await accept();
  await reminder(
    "maintenance-only",
    `Maintenance regression: read ${cli} wakeups take --owner ${peer.id}, then acknowledge maintenance-only using ${cli} wakeups ack --key maintenance-only --owner ${peer.id} --revision N with its current revision, then end with MAINTENANCE_ONLY. Do not edit any project file, checkpoint, or send a separate handback.`,
  );
  await wait("maintenance turn finishes", async () => {
    const state = await autonomy();
    const native = (await peer.refresh())?.agent;
    return state.turnId !== initial.lastTurnId && state.outcome === "completed" && native.status === "idle";
  });
  const maintained = await member();
  assert.equal(maintained.lastTurnId, initial.lastTurnId);
  assert.equal(maintained.resultPath, initial.resultPath);
  assert.equal(maintained.decision, "accepted");
  receipt.checks.maintenancePreserves = { pass: true, handback: maintained.lastTurnId };
  console.log(JSON.stringify({ phase: "maintenance-preserved" }));

  const gate = join(output, "gate.mjs");
  const entered = join(output, "gate-entered");
  const release = join(output, "gate-release");
  await writeFile(
    gate,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(entered)}, "entered");`,
      "const deadline = Date.now() + 90000;",
      `while (!existsSync(${JSON.stringify(release)})) {`,
      '  if (Date.now() > deadline) throw new Error("test gate timeout");',
      "  await new Promise(done => setTimeout(done, 200));",
      "}",
    ].join("\n"),
  );
  await reminder(
    "maintenance-steered",
    `Bounded native steering test: run ${shellQuote(process.execPath)} ${shellQuote(gate)} in the foreground and let it finish. This temporary 90-second maximum test gate is intentional; do not background it. Then read ${cli} wakeups take --owner ${peer.id}, then acknowledge it using ${cli} wakeups ack --key maintenance-steered --owner ${peer.id} --revision N with its current revision and end. Do not checkpoint or edit project files unless a new explicit rework prompt arrives.`,
  );
  await wait("real model enters maintenance tool", () => text(entered));
  const active = (await peer.refresh()).agent.activeTurn;
  assert.ok(active?.turnId, "native maintenance turn is active");
  assert.ok(Number.isFinite(Date.parse(active.startedAt)), "native turn has a generation boundary");
  const beforeSteer = await autonomy();
  assert.equal(beforeSteer.turnId, active.turnId);
  assert.equal(beforeSteer.wakeTurnId, active.turnId);
  assert.notEqual(beforeSteer.checkpointTurnId, active.turnId);
  const carried = await member();
  assert.equal(carried.lastTurnId, initial.lastTurnId);
  assert.equal(carried.resultPath, initial.resultPath);
  assert.equal(carried.decision, "accepted");
  const steerId = randomUUID();
  await peer.send(
    "Explicit owner rework, replacing the previous candidate: after the test gate returns, change candidate.txt to exactly v2. Acknowledge the pending reminder if needed, then end with REVISED_V2. For this regression test do NOT call autonomy checkpoint, wait, start, or resume; the plugin must detect this accepted steer by native identity without a model checkpoint. Do not delegate.",
    { messageId: steerId, activeTurnBehavior: "steer" },
  );
  const steered = await peer.timeline.refetch({ direction: "tail", limit: 100 });
  const prompt = steered.entries.find(
    ({ item }) =>
      item.type === "user_message" && (item.clientMessageId === steerId || item.messageId === steerId),
  );
  assert.equal(prompt?.turnId, active.turnId, "native steer stays in the same turn");
  assert.equal((await peer.refresh()).agent.activeTurn?.turnId, active.turnId);
  assert.equal((await candidateSnapshot(cwd)).digest, proof.report.candidate.digest);
  await assert.rejects(accept(), /mid-turn|started a new turn/i);
  receipt.checks.staleAcceptRefused = { pass: true, turnId: active.turnId, messageId: steerId };
  await writeFile(release, "release");
  const revised = await wait("new handback replaces the old one", async () => {
    const row = await member();
    const state = await autonomy();
    const native = (await peer.refresh())?.agent;
    return native.status === "idle" && state.outcome === "completed" && row.lastTurnId === active.turnId
      ? row
      : null;
  });
  assert.equal((await text(join(cwd, "candidate.txt"))).trim(), "v2");
  assert.equal(revised.decision, "open");
  assert.notEqual(revised.resultPath, initial.resultPath);
  assert.match(await text(revised.resultPath), /REVISED_V2/);
  const ended = await autonomy();
  assert.equal(ended.workPromptId, steerId);
  assert.notEqual(ended.checkpointTurnId, active.turnId);
  assert.equal(ended.phase, "review");
  const entries = [];
  let cursor;
  let epoch;
  let complete = false;
  for (let i = 0; i < 20; i++) {
    const page = await peer.timeline.refetch({
      direction: cursor ? "before" : "tail",
      cursor,
      limit: 100,
      projection: "canonical",
    });
    assert.ok(!page.error && !page.gap && !page.staleCursor, "complete native trace available");
    if (epoch !== undefined) assert.ok(page.epoch === epoch && !page.reset, "trace generation stayed stable");
    epoch = page.epoch;
    entries.push(
      ...page.entries.filter(
        (entry) =>
          entry.turnId === active.turnId && Date.parse(entry.timestamp) >= Date.parse(active.startedAt),
      ),
    );
    if (
      !page.hasOlder ||
      page.entries.some((entry) => Date.parse(entry.timestamp) < Date.parse(active.startedAt))
    ) {
      complete = true;
      break;
    }
    assert.ok(page.startCursor && (!cursor || page.startCursor.seq < cursor.seq));
    cursor = page.startCursor;
  }
  assert.ok(complete, "entire native turn fits the readback bound");
  const forbidden = entries.filter(
    (entry) =>
      entry.item.type === "tool_call" &&
      /autonomy\s+(checkpoint|start|resume)|(?:alliance-work|cli\.mjs)[^\n]*\bwait\b/.test(
        JSON.stringify(entry.item),
      ),
  );
  assert.equal(forbidden.length, 0, "the model did not repair the regression with a checkpoint");
  await writeFile(join(output, "steered-timeline.json"), JSON.stringify({ entries }, null, 2), {
    mode: 0o600,
  });
  receipt.checks.revisedHandback = {
    pass: true,
    previousTurn: initial.lastTurnId,
    newTurn: revised.lastTurnId,
    decision: revised.decision,
    withoutCheckpoint: true,
  };
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  if (peer) {
    await rpc("autonomy.checkpoint", {
      agentId: peer.id,
      phase: "paused",
      reason: "Disposable steering test cleanup",
    }).catch(() => undefined);
    await peer.detach().catch(() => undefined);
    await peer.archive().catch(() => undefined);
  }
  for (const dispose of [() => api?.dispose(), () => client?.close()]) {
    try {
      await dispose();
    } catch (error) {
      receipt.cleanupError = error.message;
      receipt.pass = false;
      process.exitCode = 1;
    }
  }
  try {
    paseo(["daemon", "stop"], paseoHome);
    receipt.daemonStopped = true;
  } catch (error) {
    receipt.daemonStopped = false;
    receipt.cleanupError = error.message;
    receipt.pass = false;
    process.exitCode = 1;
  }
  receipt.sourceDigestAfter = await sourceIdentity(projectRoot);
  if (receipt.sourceDigestAfter !== receipt.sourceDigest) {
    receipt.pass = false;
    receipt.error = "Source changed during acceptance";
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt));
}
