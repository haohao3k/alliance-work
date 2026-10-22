// Real-model, disposable-daemon acceptance for decision-driven lifecycle (0.1.16).
// No production daemon or credentials are changed.
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
import { paseo } from "./paseo.mjs";
import { projectRoot, roles } from "./profiles.mjs";

const output = resolve(process.argv[2] ?? "");
// AUTH is the Codex auth source for codex, or an owner-only credentials.env.json for claude.
const [auth, harness = "codex"] = process.argv.slice(3);
if (!process.argv[2] || !auth || !["codex", "claude"].includes(harness))
  throw new Error(
    "Usage: node scripts/acceptance-lifecycle.mjs NEW_OUTPUT CODEX_AUTH_SOURCE|CLAUDE_CREDENTIALS [codex|claude]",
  );
// The fleet's Claude owners run Opus; Peers take the default Sonnet route.
const model = (role) =>
  harness === "codex" ? "gpt-6.1-sol" : role === "peer" ? "claude-sonnet-5-5" : "claude-opus-5-5";
await mkdir(output, { recursive: false, mode: 0o700 });
// Claude roles read their credential from their own home; the copies are removed at the end.
const credentials = roles.map((role) => join(output, "roles/claude", role, "credentials.env.json"));
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
  agents: [],
  checks: {},
};
let client, api;
const cli = `${process.execPath} ${join(projectRoot, "scripts/cli.mjs")} --home ${home}`;
const log = (phase, extra = {}) => console.log(JSON.stringify({ phase, ...extra }));
async function wait(label, predicate, ms = 420000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out: ${label}`);
}
const exists = async (path) => await readFile(path, "utf8").catch(() => "");
const rpc = (method, input = {}) => client.invokePluginRpc("alliance-work", method, input);
const member = async (id) => (await rpc("rooms.list")).members.find((m) => m.id === id);
const managed = async (id) => (await rpc("autonomy.list")).find((a) => a.agentId === id);
const archived = async (id) => (await api.agents.ref(id).refresh())?.agent.archivedAt;
const proof = (scenario, kind = "test") =>
  runVerification({
    cwd,
    output: join(output, `proof-${scenario}`),
    scenario,
    kind,
    target: "disposable-native-paseo",
    command: [process.execPath, "-e", "require('fs').readdirSync('.')"],
  });
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
  if (harness === "claude")
    for (const path of credentials) {
      await copyFile(auth, path);
      await chmod(path, 0o600);
    }
  receipt.sourceDigest = await sourceIdentity(projectRoot);
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "lifecycle-acceptance",
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

  // A. A real Peer cannot accept itself; its real Lead accepts it and the plugin archives it.
  const lead = await workspace.agents.create({ title: "Lifecycle E2E lead", config: config("lead") });
  receipt.agents.push(lead.id);
  await lead.run(
    `End-to-end lifecycle test in ${cwd}. Do nothing now and end this turn. Later you will receive an Alliance wakeup asking you to review a Peer. When it arrives: read ${cwd}/peer-result.txt; if it contains done, run ${cli} verify --scenario peer-result --kind test --output ${output}/lead-proof -- ${process.execPath} -e "require('assert').match(require('fs').readFileSync('peer-result.txt','utf8'),/done/)" from ${cwd}; then run ${cli} accept --agent PEER_ID --report REPORT_PATH using the Peer ID from the wakeup and the report path the verify command printed; write the accept command's output to ${cwd}/owner-accepted.txt. Do not accept anything else and do not create agents.`,
    { timeoutMs: 180000 },
  );
  const peer = await workspace.agents.create({
    title: "Lifecycle E2E peer",
    parent: lead.id,
    config: config("peer"),
  });
  receipt.agents.push(peer.id);
  assert.ok(await managed(peer.id), "native child is enrolled automatically");
  await peer.send(
    `Bounded lifecycle test in ${cwd}. Do not delegate. 1) Write peer-result.txt containing done. 2) From ${cwd} run ${cli} verify --scenario self --kind test --output ${output}/peer-proof -- ${process.execPath} -e "require('fs').readFileSync('peer-result.txt')" and note the report path it prints. 3) Try to accept your own work: ${cli} accept --agent "$PASEO_AGENT_ID" --report REPORT_PATH, and write that command's complete stdout and stderr into self-accept.txt (it is expected to be refused). 4) Run ${cli} autonomy checkpoint --phase review --reason 'peer-result ready for owner'. Then end the turn.`,
  );
  const refused = await wait("self acceptance attempted", async () => {
    const text = await exists(join(cwd, "self-accept.txt"));
    return text.trim() ? text : null;
  });
  assert.match(refused, /cannot decide on its own work/, "a real Peer session is refused self-acceptance");
  receipt.checks.selfAcceptRefused = { pass: true };
  log("self-accept-refused");
  await wait("lead woke and accepted the peer", () => exists(join(cwd, "owner-accepted.txt")), 600000);
  const decided = await wait("peer decision recorded", async () => {
    const m = await member(peer.id);
    return m?.decision === "accepted" ? m : null;
  });
  assert.equal(decided.decisionBy, lead.id, "the deciding agent is the real Lead's PASEO_AGENT_ID");
  assert.equal(decided.decisionScope, "technical");
  await wait("accepted peer archived by the plugin", () => archived(peer.id), 180000);
  receipt.checks.ownerAcceptArchives = { pass: true, peer: peer.id, decisionBy: decided.decisionBy };
  log("peer-archived-after-owner-acceptance");

  // B. A cancelled turn pauses; the next turn sent to the agent resumes autonomy.
  const slow = await workspace.agents.create({
    title: "Lifecycle E2E cancel/resume",
    parent: lead.id,
    config: config("peer"),
  });
  receipt.agents.push(slow.id);
  await slow.send(
    `In ${cwd} run the shell command sleep 240 and only afterwards write slow.txt. Do not delegate.`,
  );
  await wait("slow turn running", async () => (await slow.refresh())?.agent.status === "running", 120000);
  await new Promise((r) => setTimeout(r, 8000));
  await client.cancelAgent(slow.id);
  const paused = await wait("cancellation recorded", async () => {
    const a = await managed(slow.id);
    return a?.phase === "paused" && a.outcome === "canceled" ? a : null;
  });
  assert.equal(paused.pausedBy, "cancel");
  await slow.send(
    `Change of plan: do not sleep. Write resumed.txt containing resumed in ${cwd}, then run ${cli} autonomy checkpoint --phase review --reason 'resumed after cancel'. End the turn.`,
  );
  const resumed = await wait("resumed turn reached review", async () => {
    const a = await managed(slow.id);
    return a?.phase === "review" && a.outcome === "completed" ? a : null;
  });
  assert.equal((await exists(join(cwd, "resumed.txt"))).trim(), "resumed");
  assert.equal(resumed.pausedBy, undefined);
  receipt.checks.cancelThenResume = { pass: true, agent: slow.id };
  log("cancel-resume");
  // The Human closes it; the Human's decision is final.
  const slowProof = await proof("slow-human");
  await rpc("members.disposition", {
    agentId: slow.id,
    decision: "accepted",
    candidate: slowProof.report.candidate.digest,
    evidence: slowProof.path,
    actorId: null,
  });
  await wait("human-accepted peer archived", () => archived(slow.id), 180000);

  // C. Coordinating roles: a child cannot accept its owner; technical acceptance does not close
  // a Lead; product acceptance by its owner does. Seats without turns cost no model calls.
  const sup = await workspace.agents.create({
    title: "Lifecycle E2E supervisor",
    config: config("supervisor"),
  });
  const lead2 = await workspace.agents.create({
    title: "Lifecycle E2E lead 2",
    parent: sup.id,
    config: config("lead"),
  });
  receipt.agents.push(sup.id, lead2.id);
  const technical = await proof("lead2-technical");
  await assert.rejects(
    rpc("members.disposition", {
      agentId: sup.id,
      decision: "accepted",
      candidate: technical.report.candidate.digest,
      evidence: technical.path,
      actorId: lead2.id,
    }),
    /owner chain/,
  );
  await rpc("members.disposition", {
    agentId: lead2.id,
    decision: "accepted",
    candidate: technical.report.candidate.digest,
    evidence: technical.path,
    actorId: sup.id,
  });
  await new Promise((r) => setTimeout(r, 35000));
  assert.ok(!(await archived(lead2.id)), "technical acceptance does not close a Lead");
  const held = await member(lead2.id);
  assert.equal(held.lifecycle.state, "held");
  assert.match(held.lifecycle.blockers.join("\n"), /product acceptance/);
  const runtime = await proof("lead2-runtime", "runtime");
  await rpc("members.disposition", {
    agentId: lead2.id,
    decision: "accepted",
    candidate: runtime.report.candidate.digest,
    evidence: runtime.path,
    actorId: sup.id,
    product: {
      outcome: "Lead outcome",
      journey: "Fixture journey observed",
      reviewer: sup.id,
      remaining: [],
    },
  });
  await wait("product-accepted lead archived", () => archived(lead2.id), 180000);
  receipt.checks.coordinatingScope = { pass: true, lead: lead2.id };
  log("lead-needs-product");
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (client) receipt.rooms = await rpc("rooms.list").catch(() => null);
  for (const id of receipt.agents) {
    try {
      if ((await api.agents.ref(id).refresh())?.agent.archivedAt) continue;
      await rpc("autonomy.checkpoint", {
        agentId: id,
        phase: "paused",
        reason: "Acceptance test cleanup",
      }).catch(() => undefined);
      await api.agents.ref(id).detach();
      await api.agents.ref(id).archive();
    } catch (error) {
      receipt.checks[`cleanup-${id}`] = error.message;
    }
  }
  await api?.dispose();
  await client?.close();
  try {
    paseo(["daemon", "stop"], paseoHome);
  } catch {}
  if (harness === "claude") for (const path of credentials) await rm(path, { force: true });
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, pass: receipt.pass, checks: receipt.checks, error: receipt.error }));
}
