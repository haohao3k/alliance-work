// Native model-selection acceptance without sending prompts or starting paid model turns.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { sourceIdentity } from "./capabilities.mjs";
import { activate } from "./maintenance.mjs";
import { paseo } from "./paseo.mjs";
import { projectRoot } from "./profiles.mjs";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !process.argv[3])
  throw new Error("Usage: node scripts/acceptance-models.mjs NEW_OUTPUT CODEX_AUTH_SOURCE");
await mkdir(output, { recursive: false, mode: 0o700 });
const home = join(output, "home"),
  paseoHome = join(output, "paseo"),
  cwd = join(output, "project");
await mkdir(cwd);
execFileSync("git", ["init", "-q", cwd]);
const listener = createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const receipt = { startedAt: new Date().toISOString(), agents: [], checks: [], events: [] };
let client, api;
try {
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom: process.argv[3],
  });
  receipt.sourceDigest = await sourceIdentity(projectRoot);
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "model-selection-acceptance",
    connectTimeoutMs: 10000,
  });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(cwd);
  async function probe(harness, role, model, expected) {
    const agent = await client.createAgent({
      provider: `alliance-${harness}-${role}`,
      cwd,
      workspaceId: workspace.id,
      ...(model ? { model, thinkingOptionId: "high" } : {}),
      title: `Model selection ${harness} ${role}`,
    });
    receipt.agents.push(agent.id);
    assert.equal(agent.model, expected);
    assert.ok(!agent.activeTurn, "Creating a probe must not start a paid model turn");
    receipt.checks.push({
      harness,
      role,
      requested: model ?? null,
      selected: agent.model,
      effort: agent.thinkingOptionId,
    });
    await api.agents.ref(agent.id).archive();
  }
  for (const harness of ["codex", "claude"]) {
    for (const role of ["hq", "supervisor", "lead", "peer", "lens"])
      await probe(harness, role, undefined, harness === "codex" ? "gpt-6.1-sol" : "claude-sonnet-5-5");
    const premium = harness === "codex" ? "gpt-6-astra" : "claude-opus-5-5";
    await probe(harness, "lead", premium, premium);
  }
  receipt.pass = true;
} catch (error) {
  receipt.pass = false;
  receipt.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const id of receipt.agents) {
    try {
      if ((await api.agents.ref(id).refresh())?.agent.archivedAt) continue;
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
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, pass: receipt.pass, checks: receipt.checks, error: receipt.error }));
}
