// Uses a dedicated Alliance login and a disposable daemon/workspace only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { setAgyAuthSource } from "./agy-auth.mjs";
import { activate } from "./maintenance.mjs";
import { paseo, requireIdle } from "./paseo.mjs";
import { projectRoot } from "./profiles.mjs";

const [outputArgument, authSource] = process.argv.slice(2);
if (!outputArgument || !authSource)
  throw new Error("Usage: acceptance-agy.mjs NEW_OUTPUT ALLIANCE_TOKEN_PATH");
const output = resolve(outputArgument),
  home = join(output, "home"),
  paseoHome = join(output, "paseo"),
  cwd = join(output, "project");
await mkdir(output, { mode: 0o700 });
await mkdir(cwd);
await setAgyAuthSource(home, resolve(authSource));
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
let client, api;
const agents = [],
  receipt = { startedAt: new Date().toISOString(), checks: {}, agents: [], error: null };
try {
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
  await activate({ home, paseoHome, port, binDir: join(output, "bin"), isolatedRoot: join(output, "roles") });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "agy-acceptance",
    connectTimeoutMs: 10000,
  });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(cwd);
  for (const role of ["lead", "peer"]) {
    const agent = await workspace.agents.create({
      title: `AGY ${role} qualification`,
      config: {
        // AGY runs only Gemini: the owner default and the Peer's first room route are both Argon medium.
        provider: `alliance-agy-${role}/gemini-4-argon-medium`,
        thinkingOptionId: "medium",
        modeId: "full-access",
      },
    });
    agents.push(agent);
    receipt.agents.push(agent.id);
  }
  receipt.checks.twoSessions = true;
  await writeFile(join(output, "progress.json"), JSON.stringify(receipt, null, 2));
  const [owner, peer] = agents;
  console.log(JSON.stringify({ phase: "sessions-open", owner: owner.id, peer: peer.id }));
  const prompt = `Bounded native coordination qualification in ${cwd}. Your native agent ID is ${owner.id}; an existing isolated AGY peer is ${peer.id}. Use the native Paseo list_agents tool, then send_agent_prompt to ask that peer to write agy-peer-proof.txt containing AGY-PEER-VERIFIED and send you one handback through send_agent_prompt. Do not create another agent, write the peer file yourself, or use shell/HTTP/CLI as substitutes for MCP tools. End this turn after dispatch. When the peer's handback arrives, read its file, write agy-owner-reviewed.txt containing AGY-OWNER-VERIFIED, and end without messaging it back. If the native MCP tools are absent or denied, state the exact failure and stop. This synthetic task is explicitly authorized; do not run other work.`;
  const result = await owner.run(prompt, { timeoutMs: 180000 });
  await writeFile(join(output, "owner-turn.json"), JSON.stringify(result, null, 2));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const reviewed = await readFile(join(cwd, "agy-owner-reviewed.txt"), "utf8").catch(() => "");
    if (reviewed.includes("AGY-OWNER-VERIFIED")) break;
    await new Promise((done) => setTimeout(done, 1000));
  }
  assert.match(await readFile(join(cwd, "agy-peer-proof.txt"), "utf8"), /AGY-PEER-VERIFIED/);
  assert.match(await readFile(join(cwd, "agy-owner-reviewed.txt"), "utf8"), /AGY-OWNER-VERIFIED/);
  receipt.checks.handback = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  for (const agent of agents) {
    await agent.detach().catch(() => {});
    await agent.archive().catch(() => {});
  }
  api?.dispose();
  await client?.close();
  try {
    requireIdle(paseoHome);
    paseo(["daemon", "stop"], paseoHome);
  } catch (error) {
    receipt.cleanupError = error.message;
    process.exitCode = 1;
  }
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
}
