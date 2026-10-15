import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { activate, installation } from "../scripts/maintenance.mjs";
import { instanceState, paseo, requireIdle, verifyRuntime } from "../scripts/paseo.mjs";
import { loadManifest, projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

test("native Paseo switches release roots and restores the previous plugin after failed activation", {
  skip: process.env.ALLIANCE_NATIVE_PASEO_TESTS !== "1",
  timeout: 120000,
}, async (t) => {
  const dir = await temporary("alliance-paseo-maintenance-");
  const home = join(dir, "home"),
    paseoHome = join(dir, "paseo");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  t.after(async () => {
    const state = await instanceState(paseoHome);
    if (state?.localDaemon === "running") {
      requireIdle(paseoHome);
      paseo(["daemon", "stop"], paseoHome);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const options = {
    home,
    paseoHome,
    port,
    binDir: join(dir, "bin"),
    isolatedRoot: join(dir, "roles"),
    authFrom: undefined,
  };
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
  await activate(options);
  // Exercise native hooks, not just the runtime class: opening an Alliance profile is enough.
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "alliance-room-test",
    connectTimeoutMs: 10000,
  });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const cwd = join(dir, "auto-room");
    await mkdir(cwd);
    execFileSync("git", ["init", "-q", cwd]);
    await writeFile(join(cwd, "result.txt"), "candidate");
    const before = (await client.invokePluginRpc("alliance-work", "rooms.list", {})) as {
      rooms: { id: string; cwd: string }[];
    };
    const workspace = await api.workspaces.open(cwd);
    // Native create_agent and the native UI must hit the policy gate, not only the Alliance RPC.
    const flexibleLead = await workspace.agents.create({
      config: { provider: "alliance-codex-lead/gpt-6.1-sol", thinkingOptionId: "xhigh" },
    });
    const flexibleSnapshot = (await flexibleLead.refresh())?.agent;
    assert.equal(flexibleSnapshot?.model, "gpt-6.1-sol");
    assert.equal(flexibleSnapshot?.thinkingOptionId, "xhigh");
    await flexibleLead.detach();
    await flexibleLead.archive();
    await assert.rejects(
      workspace.agents.create({
        config: { provider: "alliance-codex-peer/gpt-6.1-sol", thinkingOptionId: "xhigh" },
      }),
      /No allowed/,
    );
    const policyRooms = (await client.invokePluginRpc("alliance-work", "rooms.list", {})) as {
      rooms: { id: string; cwd: string }[];
    };
    const policyRoomId = policyRooms.rooms.find((room) => room.cwd === cwd)?.id;
    assert(policyRoomId);
    const savedPolicy = (await client.invokePluginRpc("alliance-work", "models.read", {
      roomId: policyRoomId,
    })) as { policy: { leadEffort: string }; revision: number };
    await client.invokePluginRpc("alliance-work", "models.save", {
      roomId: policyRoomId,
      revision: savedPolicy.revision,
      policy: { ...savedPolicy.policy, leadEffort: "high" },
    });
    const created = await workspace.agents.create({
      title: "Room lifecycle test",
      config: { provider: "alliance-codex-hq/gpt-6.1-sol" },
    });
    await created.detach();
    assert.equal(requireIdle(paseoHome).agents, 1, "Idle readback must include detached native sessions");
    const after = (await client.invokePluginRpc("alliance-work", "rooms.list", {})) as {
      rooms: { id: string; cwd: string }[];
      members: { id: string; assignment: string }[];
    };
    assert.equal(after.rooms.length, before.rooms.length + 1);
    assert(after.members.some((member) => member.id === created.id));
    await client.invokePluginRpc("alliance-work", "jobs.track", {
      key: "native-controller",
      roomId: policyRoomId,
      ownerId: created.id,
      pid: process.pid,
      title: "Native fixture controller",
    });
    const tracked = (await client.invokePluginRpc("alliance-work", "rooms.list", {})) as {
      jobs: { state: string; ownerId: string; ownerStatus: string }[];
    };
    assert.equal(tracked.jobs[0].state, "running");
    assert.equal(tracked.jobs[0].ownerId, created.id);
    assert.equal(tracked.jobs[0].ownerStatus, "available");
    const wakeRoomId = after.rooms.find((room) => room.cwd === cwd)?.id;
    assert(wakeRoomId);
    await client.invokePluginRpc("alliance-work", "wakeups.add", {
      key: "native-wakeup",
      roomId: wakeRoomId,
      ownerId: created.id,
      reason: "Inspect test evidence",
      trigger: { kind: "time", at: Date.now() },
    });
    const taken = (await client.invokePluginRpc("alliance-work", "wakeups.take", {
      ownerId: created.id,
    })) as { key: string; revision: number; state: string }[];
    assert.equal(taken[0].state, "delivered");
    await client.invokePluginRpc("alliance-work", "wakeups.action", {
      key: taken[0].key,
      ownerId: created.id,
      revision: taken[0].revision,
      action: "ack",
    });
    const nativeAssignment = after.members.find((member) => member.id === created.id)?.assignment;
    assert(nativeAssignment);
    assert((await readFile(nativeAssignment, "utf8")).includes(created.id));
    await writeFile(
      join(cwd, "verify.mjs"),
      `
      import assert from 'node:assert/strict';
      import {readFile} from 'node:fs/promises';
      const {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);
      await check('readback', async()=>assert.equal(await readFile('result.txt','utf8'),'candidate'));
    `,
    );
    await writeFile(
      join(cwd, "features.json"),
      JSON.stringify({
        version: 1,
        features: [
          {
            id: "artifact",
            title: "Candidate artifact",
            entryPoint: "result.txt",
            preconditions: "Candidate ready",
            behaviors: [{ id: "readback", expect: "Candidate bytes read back correctly" }],
          },
        ],
        scenarios: [
          {
            id: "readback",
            command: ["$NODE", "verify.mjs"],
            assertions: [{ id: "readback", behavior: "readback" }],
          },
        ],
      }),
    );
    const proof = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(projectRoot, "scripts/cli.mjs"),
          "verify",
          "--project",
          cwd,
          "--output",
          join(dir, "native-proof"),
          "--map",
          "features.json",
        ],
        { encoding: "utf8", timeout: 30000 },
      ),
    );
    assert.equal(proof.coverage.covered, 1);
    assert.equal(proof.coverage.total, 1);
    const disposition = {
      agentId: created.id,
      decision: "accepted",
      candidate: proof.candidate,
      evidence: proof.report,
    };
    assert.deepEqual(
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            join(projectRoot, "scripts/cli.mjs"),
            "accept",
            "--home",
            home,
            "--agent",
            created.id,
            "--report",
            proof.report,
          ],
          { encoding: "utf8", timeout: 30000 },
        ),
      ),
      { saved: true },
    );
    await writeFile(join(cwd, "result.txt"), "changed candidate");
    await assert.rejects(
      client.invokePluginRpc("alliance-work", "members.disposition", disposition),
      /changed|stale/,
    );
    const again = (await client.invokePluginRpc("alliance-work", "rooms.create", { cwd })) as { id: string };
    assert.equal(again.id, after.rooms.find((room) => room.cwd === cwd)?.id);
    const final = (await client.invokePluginRpc("alliance-work", "rooms.list", {})) as { rooms: unknown[] };
    assert.equal(final.rooms.length, after.rooms.length);
    await created.archive();
    const allowedLead = await workspace.agents.create({
      config: { provider: "alliance-codex-lead/gpt-6-astra" },
    });
    assert.equal((await allowedLead.refresh())?.agent.thinkingOptionId, "high");
    await allowedLead.detach();
    await allowedLead.archive();
  } finally {
    await api.dispose();
    await client.close();
  }
  const candidate = join(dir, "release candidate");
  await cp(projectRoot, candidate, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", "dist"].includes(relative(projectRoot, path).split("/")[0]),
  });
  await symlink(join(projectRoot, "node_modules"), join(candidate, "node_modules"), "dir");
  const room = join(home, "rooms/preserved/assignment.md");
  await mkdir(join(home, "rooms/preserved"), { recursive: true });
  await writeFile(room, "Keep this assignment through release switches.");
  const auth = join((await loadManifest(home)).profiles["codex-lead"].home, "auth.json");
  await writeFile(auth, "private fixture", { mode: 0o600 });
  await activate({ ...options, root: candidate });
  const current = await installation(home);
  assert.equal(current.root, candidate);
  assert.equal(current.previous.root, projectRoot);
  await verifyRuntime(paseoHome, candidate);
  const retained = JSON.parse(
    execFileSync(process.execPath, [join(candidate, "scripts/cli.mjs"), "wakeups", "list", "--home", home], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  assert.equal(retained.find((w: { key: string }) => w.key === "native-wakeup")?.state, "acknowledged");

  const broken = join(dir, "broken release");
  await cp(candidate, broken, {
    recursive: true,
    filter: (path) => relative(candidate, path) !== "node_modules",
  });
  await symlink(join(projectRoot, "node_modules"), join(broken, "node_modules"), "dir");
  await writeFile(join(broken, "index.server.ts"), 'throw new Error("activation fixture"); export {};\n');
  await assert.rejects(activate({ ...options, root: broken }), /Managed files restored/);
  assert.equal((await installation(home)).root, candidate);
  await verifyRuntime(paseoHome, candidate);
  assert.equal(await readFile(auth, "utf8"), "private fixture");
  assert.equal(await readFile(room, "utf8"), "Keep this assignment through release switches.");
});
