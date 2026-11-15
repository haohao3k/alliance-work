import assert from "node:assert/strict";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { activate } from "../scripts/maintenance.mjs";
import { instanceState, paseo } from "../scripts/paseo.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { taskMaintenanceCommand } from "../scripts/task-maintenance-cli.mjs";
import { temporary } from "./temp";

test("native maintenance checkpoints a running provider, survives worker restart, and resumes the same session once", {
  skip: process.env.ALLIANCE_NATIVE_PASEO_TESTS !== "1",
  timeout: 180000,
}, async (t) => {
  const directory = await temporary("alliance-native-hold-");
  const home = join(directory, "alliance");
  const paseoHome = join(directory, "paseo");
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const address = socket.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  let client: DaemonClient | undefined;
  const taskIds: string[] = [];
  t.after(async () => {
    if (client) {
      for (const id of taskIds) await client.cancelAgent(id).catch(() => undefined);
      await client.close();
    }
    if ((await instanceState(paseoHome))?.localDaemon === "running") paseo(["daemon", "stop"], paseoHome);
  });
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(directory, "bin"),
    isolatedRoot: join(directory, "profiles"),
    authFrom: undefined,
  });
  const fixture = join(directory, "provider");
  await mkdir(fixture);
  await writeFile(
    join(fixture, "icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>',
  );
  await cp(join(projectRoot, "server/agy-native"), join(fixture, "server/agy-native"), { recursive: true });
  await symlink(join(projectRoot, "node_modules"), join(fixture, "node_modules"), "dir");
  const executable = join(fixture, "agy.mjs");
  await writeFile(
    executable,
    `
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('1.1.15'); process.exit(0); }
if (process.argv.includes('models')) { console.log('fixture-model\\tFixture model'); process.exit(0); }
const index = process.argv.indexOf('--conversation');
const id = index >= 0 ? process.argv[index + 1] : randomUUID();
console.log(JSON.stringify({ event: 'init', conversation_id: id, init: { model: 'fixture-model' } }));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const text = JSON.parse(line).message.content;
  const marker = text.substring(text.indexOf('[Alliance maintenance')).split(']')[0];
  if (text.includes('[Alliance maintenance') && marker.includes(' hold ')) {
    const checkpoint = /checkpoint to ([^:]+): unfinished/.exec(text)?.[1];
    if (checkpoint) writeFileSync(checkpoint, 'Unfinished deterministic fixture work; preserve this conversation and resume.');
    console.log(JSON.stringify({ event: 'result', result: { conversation_id: id, status: 'SUCCESS', response: 'Checkpoint saved; waiting for maintenance resume.' } }));
  } else {
    console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: id, step_index: 0, state: 'ACTIVE', step_type: 'PLAN', text_delta: 'Deterministic fixture work is running.' } }));
  }
}
`,
  );
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ name: "hold-fixture", version: "1.0.0", type: "module" }),
  );
  await writeFile(
    join(fixture, "paseo-plugin.json"),
    JSON.stringify({ id: "hold-fixture", requirements: { paseo: ">=0.15.4" } }),
  );
  await writeFile(
    join(fixture, "index.server.ts"),
    `
import { createAntigravityProvider } from './server/agy-native/provider.ts';
export default function contribute(server) {
  server.registerProvider({ ...createAntigravityProvider(), id: 'hold-fixture', label: 'Maintenance fixture', command: ${JSON.stringify([process.execPath, executable])} });
  return () => {};
}
`,
  );
  paseo(["plugin", "install", fixture, "--id", "hold-fixture"], paseoHome);
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "native-hold-observer",
    connectTimeoutMs: 10000,
  });
  await client.connect();
  const api = createPaseoApi(client);
  const workspace = await api.workspaces.open(directory);
  const active = await workspace.agents.create({
    config: { provider: "hold-fixture/fixture-model" },
    title: "Running maintenance fixture",
  });
  const idle = await workspace.agents.create({
    config: { provider: "hold-fixture/fixture-model" },
    title: "Idle fixture must stay idle",
  });
  taskIds.push(active.id, idle.id);
  await client.sendAgentMessage(active.id, "Start deterministic work and keep running until checkpointed.");
  const before = (await client.fetchAgent(active.id))?.agent;
  assert.ok(before?.activeTurn);
  const beforeDaemon = await client.getDaemonStatus({ timeout: 15000 });
  const proofPath = join(directory, "restart-proof.json");
  const update = join(directory, "update.mjs");
  await writeFile(
    update,
    `
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { DaemonClient } from ${JSON.stringify(join(projectRoot, "node_modules/@getpaseo/client/dist/daemon-client.js"))};
execFileSync(process.execPath, [${JSON.stringify(join(projectRoot, "node_modules/@getpaseo/cli/bin/paseo"))}, 'restart', '--home', ${JSON.stringify(paseoHome)}, '--json', '--timeout', '60'], { timeout: 90000 });
const client = new DaemonClient({ url: ${JSON.stringify(`ws://127.0.0.1:${port}/ws`)}, clientId: 'native-hold-after-restart', connectTimeoutMs: 10000 });
try {
  await client.connect();
  const daemon = await client.getDaemonStatus({ timeout: 15000 });
  const hold = await client.invokePluginRpc('alliance-work', 'maintenance.status', {});
  assert.equal(hold.durablePause, true);
  assert.ok(hold.hold && hold.hold.phase === 'updating');
  assert.equal(hold.hold.targets.length, 1);
  await writeFile(${JSON.stringify(proofPath)}, JSON.stringify({ daemon, hold }));
} finally { await client.close(); }
`,
  );
  const ledger = await taskMaintenanceCommand(home, "run", {
    key: "native-restart-proof",
    reason: "Verify deterministic hold and resume across official worker restart",
    timeoutMs: 1000,
    interrupt: true,
    command: [process.execPath, update],
  });
  assert.ok(ledger);
  assert.equal(ledger.phase, "complete");
  assert.deepEqual(
    ledger.targets.map((target: { id: string }) => target.id),
    [active.id],
  );
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  assert.equal(proof.daemon.serverId, beforeDaemon.serverId);
  assert.notEqual(proof.daemon.pid, beforeDaemon.pid, "the official worker really restarted");
  await client.close();
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "native-hold-final-readback",
    connectTimeoutMs: 10000,
  });
  await client.connect();
  let after = (await client.fetchAgent(active.id))?.agent;
  const executionDeadline = Date.now() + 10000;
  while (!after?.activeTurn && Date.now() < executionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = (await client.fetchAgent(active.id))?.agent;
  }
  assert.ok(after);
  assert.equal(after.id, before.id);
  assert.equal(after.provider, before.provider);
  assert.equal(after.model, before.model);
  assert.equal(after.persistence?.sessionId, before.persistence?.sessionId);
  assert.ok(after.activeTurn, "the retained session is doing work after resume");
  const target = ledger.targets[0];
  assert.ok(target);
  const timeline = await client.fetchAgentTimeline(active.id, {
    direction: "tail",
    limit: 100,
    projection: "canonical",
  });
  const resumed = timeline.entries.filter(
    ({ item }) =>
      item.type === "user_message" &&
      (item.clientMessageId === target.resume.messageId || item.messageId === target.resume.messageId),
  );
  assert.equal(resumed.length, 1, "the actual native canonical timeline retains one resume UUID");
  const stillIdle = (await client.fetchAgent(idle.id))?.agent;
  assert.ok(stillIdle);
  assert.equal(stillIdle.activeTurn ?? null, null);
  assert.ok(["idle", "closed"].includes(stillIdle.status));
  await taskMaintenanceCommand(home, "resume", {});
  const repeated = await client.fetchAgentTimeline(active.id, {
    direction: "tail",
    limit: 100,
    projection: "canonical",
  });
  assert.equal(
    repeated.entries.filter(
      ({ item }) =>
        item.type === "user_message" &&
        (item.clientMessageId === target.resume.messageId || item.messageId === target.resume.messageId),
    ).length,
    1,
  );
  const status = z
    .object({ hold: z.object({ phase: z.string() }) })
    .parse(await client.invokePluginRpc("alliance-work", "maintenance.status", {}));
  assert.equal(status.hold.phase, "complete");
});
