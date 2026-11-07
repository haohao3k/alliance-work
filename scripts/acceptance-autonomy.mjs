// Real-model, disposable-daemon acceptance. No production daemon or credentials are changed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runVerification } from "../server/evidence.mjs";
import { sourceIdentity } from "./capabilities.mjs";
import { activate } from "./maintenance.mjs";
import { paseo, requireIdle } from "./paseo.mjs";
import { projectRoot, roles } from "./profiles.mjs";

const output = resolve(process.argv[2] ?? "");
// AUTH is the Codex auth source for codex, or an owner-only credentials.env.json for claude.
const [auth, harness = "codex"] = process.argv.slice(3);
if (!process.argv[2] || !auth || !["codex", "claude"].includes(harness))
  throw new Error(
    "Usage: node scripts/acceptance-autonomy.mjs NEW_OUTPUT CODEX_AUTH_SOURCE|CLAUDE_CREDENTIALS [codex|claude]",
  );
// The fleet's Claude owners run Opus; Peers take the default Sonnet route.
const model = (role) =>
  harness === "codex" ? "gpt-6.1-sol" : role === "peer" ? "claude-sonnet-5-5" : "claude-opus-5-5";
await mkdir(output, { recursive: false, mode: 0o700 });
// Claude roles read their credential from their own home; the copies are removed at the end.
const credentials = roles.map((role) => join(output, "roles/claude", role, "credentials.env.json"));
const copyCredentials = async () => {
  for (const path of credentials) {
    await copyFile(auth, path);
    await chmod(path, 0o600);
  }
};
const home = join(output, "home"),
  paseoHome = join(output, "paseo"),
  cwd = join(output, "project");
await mkdir(cwd);
execFileSync("git", ["init", "-q", cwd]);
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const receipt = {
  startedAt: new Date().toISOString(),
  harness,
  model: { owner: model("lead"), peer: model("peer") },
  effort: "medium",
  events: [],
  agents: [],
  checks: {},
};
let client, api;
const cli = `${process.execPath} ${join(projectRoot, "scripts/cli.mjs")} --home ${home}`;
async function wait(label, predicate, ms = 360000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out: ${label}`);
}
const exists = async (path) => await readFile(path, "utf8").catch(() => "");
const rpc = (method, input = {}) => client.invokePluginRpc("alliance-work", method, input);
try {
  // Another installed daemon version (the fleet runs 0.11.2), started before activation adopts it.
  if (process.env.ALLIANCE_TEST_DAEMON_CLI) {
    await mkdir(paseoHome, { recursive: true });
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: { listen: `127.0.0.1:${port}`, relay: { enabled: false } },
        features: { webUi: { enabled: true } },
      }),
    );
    await writeFile(
      join(paseoHome, "alliance-instance.json"),
      JSON.stringify({ allianceHome: home, root: projectRoot }),
    );
    execFileSync(
      process.execPath,
      [process.env.ALLIANCE_TEST_DAEMON_CLI, "daemon", "start", "--home", paseoHome],
      { timeout: 30000 },
    );
  }
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom: harness === "codex" ? auth : undefined,
  });
  if (harness === "claude") await copyCredentials();
  receipt.sourceDigest = await sourceIdentity(projectRoot);
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "autonomy-acceptance",
    connectTimeoutMs: 10000,
  });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(cwd);
  const config = (role) => ({
    provider: `alliance-${harness}-${role}/${model(role)}`,
    // The default Peer route is Sol or Sonnet high; owners keep the cheaper medium.
    thinkingOptionId: role === "peer" ? "high" : "medium",
    modeId: harness === "claude" ? "bypassPermissions" : "full-access",
  });
  const owner = await workspace.agents.create({ title: "Autonomy E2E owner", config: config("lead") });
  receipt.agents.push(owner.id);
  await rpc("autonomy.start", { agentId: owner.id, autoArchive: false });
  await owner.run(
    `This is an end-to-end autonomy test in ${cwd}. Do not delegate. Run ${cli} autonomy checkpoint --phase waiting --reason 'Waiting for worker handback'. End this turn. On a later Alliance wakeup, inspect stage-1.txt, stage-2.txt, stage-3.txt. If all contain their respective stage number, write owner-reviewed.txt containing reviewed, then checkpoint review with reason 'Worker inspected'. Do not accept or archive yourself; test owner verifies the artifacts.`,
    { timeoutMs: 180000 },
  );
  const worker = await workspace.agents.create({
    title: "Autonomy E2E multi-turn worker",
    parent: owner.id,
    config: config("peer"),
  });
  receipt.agents.push(worker.id);
  const managed = (await rpc("autonomy.list")).find((m) => m.agentId === worker.id);
  assert.ok(managed, "native child is managed without an explicit start command");
  const roomId = (await rpc("rooms.list")).members.find((m) => m.id === worker.id).roomId;
  // Written only when the driver observes the condition: a worker that finds it earlier records the
  // prerequisite itself and so bypasses the gate under test.
  const evidence = join(cwd, "dependency-evidence.txt");
  const addObligation = (key, ownerId, assignment, nextAction) =>
    rpc("obligations.add", {
      key,
      roomId,
      ownerId,
      assignment,
      nextAction,
      authority: "Bounded disposable integration test; no external effects",
      closeWhen: "Generated artifacts independently verified by test driver",
      conditions: [{ id: "ready", requires: "Test dependency independently observed ready" }],
    });
  const action = async (key, extra) => {
    const o = (await rpc("obligations.list")).find((o) => o.key === key);
    return rpc("obligations.action", { key, ownerId: o.ownerId, revision: o.revision, evidence, ...extra });
  };
  const observe = (key) =>
    action(key, { action: "observe", conditionId: "ready", validUntil: Date.now() + 900000 });
  await addObligation(
    "stages",
    worker.id,
    join(cwd, "stages-brief.txt"),
    "Complete the next missing stage, then hand back",
  );
  await writeFile(
    join(cwd, "stages-brief.txt"),
    `Create one missing stage-N.txt per turn, N=1..3, with N and newline. Checkpoint active after 1/2, review after 3 using ${cli} autonomy checkpoint --phase PHASE --reason TEXT. Never delegate.`,
  );
  await rpc("autonomy.start", { agentId: worker.id, obligationKey: "stages" });
  await rpc("wakeups.add", {
    key: "stages-reminder",
    roomId,
    ownerId: worker.id,
    obligationKey: "stages",
    reason: "Dependency pending",
    trigger: { kind: "time", at: Date.now() },
    delivery: "pull",
    expiresAt: Date.now() + 30000,
  });
  console.log(JSON.stringify({ phase: "multi-turn-start", owner: owner.id, worker: worker.id }));
  // Exactly one external prompt. Later prompts must originate in the plugin scheduler.
  await worker.send(
    `This is a bounded multi-turn acceptance test. Work only in ${cwd}. Do not delegate. In EACH turn, create exactly one missing file among stage-1.txt, stage-2.txt, stage-3.txt, in that order, containing its stage number and a newline. Never create two stages in one turn. After stage 1 or 2, run ${cli} autonomy checkpoint --phase active --reason 'Continue with the next missing stage', then END the turn. The plugin will wake you. After stage 3, verify all three, run ${cli} autonomy checkpoint --phase review --reason 'Three stages verified; ready for owner', then end. Do not send your own handback notification or accept yourself.`,
  );
  await wait("first turn ended before reload", async () => {
    const state = (await rpc("autonomy.list")).find((m) => m.agentId === worker.id);
    return state?.outcome === "completed" && state.continuations === 0;
  });
  requireIdle(paseoHome);
  paseo(["plugin", "reload", "alliance-work"], paseoHome);
  receipt.checks.reload = { pass: true, afterStage: 1 };
  console.log(JSON.stringify({ phase: "plugin-reloaded-between-turns" }));
  await new Promise((r) => setTimeout(r, 35000));
  assert.equal(await exists(join(cwd, "stage-2.txt")), "", "Due reminder/reload cannot bypass prerequisite");
  assert.equal((await rpc("autonomy.list")).find((a) => a.agentId === worker.id).continuations, 0);
  assert.equal((await rpc("obligations.list")).find((o) => o.key === "stages").state, "open");
  receipt.checks.prerequisiteAfterReload = { pass: true, noContinuationBeforeObservation: true };
  await writeFile(evidence, "Test operator verified dependency readiness in the disposable environment.\n");
  await observe("stages");
  const observedAt = Date.now();
  // Two more worker turns, then the review reaches the owner two minutes after the last one ends.
  await wait("owner woke and reviewed three turns", () => exists(join(cwd, "owner-reviewed.txt")), 900000);
  const ownerReviewedMs = Date.now() - observedAt;
  const rooms = await rpc("rooms.list");
  const member = rooms.members.find((m) => m.id === worker.id);
  const auto = (await rpc("autonomy.list")).find((m) => m.agentId === worker.id);
  // A worker may checkpoint waiting on the unmet prerequisite in its first turn, as the contract
  // says; that costs one more continuation once the condition is observed.
  assert.ok([2, 3].includes(auto.continuations), `continuations ${auto.continuations}`);
  assert.equal(auto.phase, "review");
  assert.equal(member.decision, "open");
  assert.equal(member.archived, false);
  for (let n = 1; n <= 3; n++) assert.equal((await exists(join(cwd, `stage-${n}.txt`))).trim(), String(n));
  receipt.checks.continuation = { pass: true, automaticTurns: auto.continuations };
  receipt.checks.ownerWake = {
    pass: true,
    afterObservationMs: ownerReviewedMs,
    wakeups: rooms.wakeups.filter((w) => w.trigger.agentId === worker.id),
  };
  // No stale artifacts: verification is bound to actual generated candidate files.
  const proof = await runVerification({
    cwd,
    output: join(output, "proof"),
    scenario: "autonomous-three-turns",
    kind: "runtime",
    target: "disposable-native-paseo",
    command: [
      process.execPath,
      "-e",
      "const fs=require('fs'),a=require('assert/strict');for(let n=1;n<=3;n++)a.equal(fs.readFileSync('stage-'+n+'.txt','utf8').trim(),String(n));a.equal(fs.readFileSync('owner-reviewed.txt','utf8').trim(),'reviewed');",
    ],
  });
  await rpc("members.disposition", {
    agentId: worker.id,
    decision: "accepted",
    candidate: proof.report.candidate.digest,
    evidence: proof.path,
    actorId: null, // the test driver decides as the Human
  });
  await new Promise((r) => setTimeout(r, 35000));
  assert.ok(
    !(await worker.refresh()).agent.archivedAt,
    "Open obligation survives expired reminder and acceptance",
  );
  receipt.checks.openObligationBlocksArchive = { pass: true };
  await action("stages", { action: "fulfill" });
  await wait("plugin auto archive", async () => (await worker.refresh())?.agent.archivedAt);
  receipt.checks.archive = { pass: true, agentId: worker.id };
  // Native failed-turn test: an invalid model causes a real provider rejection. Claude Code refuses
  // an unknown model and completes a turn that ends on a provider error, so a Claude turn fails at
  // launch instead: the launcher refuses invalid role credential JSON. Restore configuration after
  // observing failure; only the plugin may send the retry prompt.
  const retry = await workspace.agents.create({ title: "Autonomy E2E retry", config: config("peer") });
  receipt.agents.push(retry.id);
  const failure =
    harness === "claude"
      ? {
          inject: () => writeFile(credentials[roles.indexOf("peer")], "{\n", { mode: 0o600 }),
          restore: copyCredentials,
        }
      : {
          inject: () => client.setAgentModel(retry.id, "alliance-e2e-invalid-model"),
          restore: () => client.setAgentModel(retry.id, model("peer")),
        };
  const retryBrief = join(cwd, "retry-brief.txt");
  await writeFile(
    retryBrief,
    `Write retry-recovered.txt containing recovered, then run ${cli} autonomy checkpoint --phase review --reason 'Recovered provider failure'. Do not delegate.`,
  );
  await addObligation("retry", retry.id, retryBrief, "Recover provider failure and verify artifact");
  await rpc("autonomy.start", {
    agentId: retry.id,
    maxRetries: 1,
    maxContinuations: 2,
    obligationKey: "retry",
  });
  await failure.inject();
  await retry
    .send(
      `After provider recovery, write retry-recovered.txt containing recovered in ${cwd}; then run ${cli} autonomy checkpoint --phase review --reason 'Recovered provider failure'. Do not delegate.`,
    )
    .catch(() => {});
  await wait(
    "native failed outcome",
    async () => (await rpc("rooms.list")).members.find((m) => m.id === retry.id)?.lastOutcome === "failed",
    90000,
  );
  await failure.restore();
  console.log(JSON.stringify({ phase: "failure-observed-provider-restored", agent: retry.id }));
  await new Promise((r) => setTimeout(r, 35000));
  assert.equal(
    (await rpc("autonomy.list")).find((a) => a.agentId === retry.id).retries,
    0,
    "Backoff alone cannot authorize retry",
  );
  assert.equal(await exists(join(cwd, "retry-recovered.txt")), "");
  await observe("retry");
  await wait("automatic retry recovered", () => exists(join(cwd, "retry-recovered.txt")));
  const recovered = await wait("retry turn completed with a review checkpoint", async () => {
    const state = (await rpc("autonomy.list")).find((m) => m.agentId === retry.id);
    return state?.phase === "review" && state.outcome === "completed" ? state : null;
  });
  assert.equal(recovered.retries, 1);
  receipt.checks.retry = { pass: true, agentId: retry.id, retries: recovered.retries };
  const successor = await workspace.agents.create({
    title: "Obligation handoff successor",
    config: config("peer"),
  });
  receipt.agents.push(successor.id);
  await writeFile(
    retryBrief,
    `You own the handed-off obligation. Read retry-recovered.txt, verify recovered, write successor-done.txt containing handed-off, then run ${cli} autonomy checkpoint --phase review --reason 'Handoff verified'. Do not delegate.`,
  );
  await action("retry", { action: "handoff", nextOwnerId: successor.id });
  requireIdle(paseoHome);
  paseo(["plugin", "reload", "alliance-work"], paseoHome);
  await wait("successor continues after handoff and reload", () => exists(join(cwd, "successor-done.txt")));
  const successorState = await wait("successor completed review", async () => {
    const s = (await rpc("autonomy.list")).find((a) => a.agentId === successor.id);
    return s?.phase === "review" && s.outcome === "completed" ? s : null;
  });
  assert.equal(successorState.retries, 1, "Handoff must preserve consumed retry budget");
  assert.equal(successorState.continuations, 1);
  assert.equal((await rpc("autonomy.list")).find((a) => a.agentId === retry.id).phase, "paused");
  assert.equal((await rpc("obligations.list")).find((o) => o.key === "retry").ownerId, successor.id);
  receipt.checks.handoff = {
    pass: true,
    reload: true,
    consumedRetries: successorState.retries,
    successor: successor.id,
  };
  await action("retry", { action: "fulfill" });
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (client) {
    receipt.autonomy = await rpc("autonomy.list").catch(() => []);
    receipt.rooms = await rpc("rooms.list").catch(() => null);
  }
  for (const id of receipt.agents) {
    try {
      if ((await api.agents.ref(id).refresh())?.agent.archivedAt) continue;
      await rpc("autonomy.checkpoint", { agentId: id, phase: "paused", reason: "Acceptance test cleanup" });
      await api.agents.ref(id).detach();
      await api.agents.ref(id).archive();
    } catch (error) {
      receipt.events.push({ cleanup: id, error: error.message });
    }
  }
  await api?.dispose();
  await client?.close();
  try {
    paseo(["daemon", "stop"], paseoHome);
  } catch (error) {
    receipt.events.push({ daemonCleanup: error.message });
  }
  if (harness === "claude") for (const path of credentials) await rm(path, { force: true });
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, pass: receipt.pass, checks: receipt.checks, error: receipt.error }));
}
