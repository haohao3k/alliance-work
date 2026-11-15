import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { selectedClaudeLaunch } from "../server/claude-accounts.mjs";
import {
  currentClaudeAccount,
  jobBlocksClaudeSwitch,
  recordClaudeRuntime,
} from "../server/claude-runtime.mjs";
import { ClaudeSwitch } from "../server/claude-switch";
import { processIdentity } from "../server/jobs.mjs";
import type { JobRecord, MemberRecord } from "../server/store";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("claude-switch-");
  const save = async (roles = {}) =>
    writeFile(
      join(home, "claude-accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: ["5x", "20x"],
        defaultAccount: "20x",
        roles,
      }),
      { mode: 0o600 },
    );
  await save();
  const member = {
    id: "test-agent",
    provider: "alliance-claude-hq",
    role: "hq",
    roomId: randomUUID(),
  } as MemberRecord;
  const live = {
    id: member.id,
    title: "Kept history",
    status: "running",
    activeTurn: null,
    archivedAt: null,
    pendingPermissions: [],
    updatedAt: new Date().toISOString(),
  };
  const jobs: JobRecord[] = [];
  const api = { agents: { ref: () => ({ refresh: async () => ({ agent: live }) }) } } as unknown as PaseoApi;
  const service = new ClaudeSwitch(
    home,
    { members: () => [member], jobs: () => jobs },
    async () => "5x",
    async () => ({ account: "20x", credentials: null }),
  );
  let retired = 0;
  const retire = async () => {
    retired++;
    live.status = "closed";
    return true;
  };
  return { home, save, member, live, jobs, api, service, retire, retired: () => retired };
}

test("switch waits for the running turn, then retires idle runtime without sending a prompt or replacing history", async () => {
  const f = await fixture();
  assert.equal((await f.service.sweep(f.api, f.retire))[0].state, "pending");
  assert.equal(f.retired(), 0);
  f.live.status = "idle";
  const row = (await f.service.sweep(f.api, f.retire))[0];
  assert.equal(row.state, "ready");
  assert.equal(row.current, null);
  assert.equal(row.selected, "20x");
  assert.equal(f.retired(), 1);
  await f.service.sweep(f.api, f.retire);
  assert.equal(f.retired(), 1, "closed sessions must not be reopened or retired repeatedly");
});

test("role overrides, tracked jobs, pending permissions and unsupported daemons retain the old process", async () => {
  const f = await fixture();
  f.live.status = "idle";
  await f.save({ hq: "5x" });
  assert.equal((await f.service.sweep(f.api, f.retire))[0].state, "current");
  await f.save();
  assert.equal((await f.service.sweep(f.api))[0].state, "unsupported");
  f.jobs.push({
    ownerId: f.member.id,
    pid: process.pid,
    processIdentity: (await processIdentity(process.pid))!,
  } as JobRecord);
  assert.equal((await f.service.sweep(f.api, f.retire))[0].state, "pending");
  assert.equal(f.retired(), 0);
  f.jobs.length = 0;
  (f.live.pendingPermissions as unknown[]).push({ id: "approval" });
  await f.service.sweep(f.api, f.retire);
  assert.equal(f.retired(), 0);
});

test("automatic switching uses the room override before the host role account", async () => {
  const f = await fixture();
  await f.save({ hq: "5x" });
  await writeFile(
    join(f.home, "claude-project-accounts.json"),
    JSON.stringify({ version: 1, projects: { [f.member.roomId]: "20x" } }),
    { mode: 0o600 },
  );
  const waiting = (await f.service.sweep(f.api, f.retire))[0];
  assert.equal(waiting.selected, "20x");
  assert.equal(waiting.state, "pending");
  assert.equal(f.retired(), 0);
  f.live.status = "idle";
  assert.equal((await f.service.sweep(f.api, f.retire))[0].state, "ready");
  assert.equal(f.retired(), 1);
});

test("launch observations do not misreport PID reuse or persist credentials", async () => {
  const home = await temporary("claude-runtime-");
  await recordClaudeRuntime(home, "session", "20x", process.pid);
  assert.equal(await currentClaudeAccount(home, "session"), "20x");
  assert.equal(await currentClaudeAccount(home, "session", async () => "different-process"), null);
  assert.equal(await currentClaudeAccount(home, "session", async () => null), null);
  const receipt = JSON.parse(await readFile(join(home, "claude-runtimes/session.json"), "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["account", "identity", "pid"]);
});

test("old daemon capability blocks retirement before any native request is sent", async () => {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "no-connect" });
  const native = client as unknown as { retireIdleAgentRuntime(id: string, at: string): Promise<unknown> };
  await assert.rejects(
    native.retireIdleAgentRuntime("session", new Date().toISOString()),
    /no reload was attempted/,
  );
});

test("a switch back while idle is rechecked before releasing the current process", async () => {
  const f = await fixture();
  f.live.status = "idle";
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member], jobs: () => [] },
    async () => "5x",
    async () => ({ account: "5x", credentials: null }),
  );
  const row = (await service.sweep(f.api, f.retire))[0];
  assert.equal(row.state, "current");
  assert.equal(row.selected, "5x");
  assert.equal(f.retired(), 0);
});

test("locked credentials and failed native retirement never trigger an unsafe reload", async () => {
  const f = await fixture();
  f.live.status = "idle";
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member], jobs: () => [] },
    async () => "5x",
    async () => {
      throw new Error("locked");
    },
  );
  assert.equal((await service.sweep(f.api, f.retire))[0].state, "unknown");
  assert.equal(f.retired(), 0);
  assert.equal((await f.service.sweep(f.api, async () => false))[0].state, "pending");
});

test("idle HQ switches despite a running job belonging to a reporting peer", async () => {
  const f = await fixture();
  f.live.status = "idle";
  const peer = { id: "peer", parentId: f.member.id, provider: "alliance-codex-peer" } as MemberRecord;
  f.jobs.push({
    ownerId: peer.id,
    pid: process.pid,
    processIdentity: (await processIdentity(process.pid))!,
  } as JobRecord);
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member, peer], jobs: () => f.jobs },
    async () => "5x",
    async () => ({ account: "20x", credentials: null }),
  );
  assert.equal((await service.sweep(f.api, f.retire))[0].state, "ready");
  assert.equal(f.retired(), 1);
  assert.equal(await processIdentity(process.pid), f.jobs[0].processIdentity, "peer job stays alive");
});

test("switch now checkpoints and resumes the same running session once on its project account", async () => {
  const f = await fixture();
  await f.save({ hq: "5x" });
  await writeFile(
    join(f.home, "claude-project-accounts.json"),
    JSON.stringify({ version: 1, projects: { [f.member.roomId]: "20x" } }),
    { mode: 0o600 },
  );
  let current = "5x",
    stopped = 0,
    sent = 0;
  const live = { ...f.live, activeTurn: { turnId: "turn-1" } as { turnId: string } | null };
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: live }),
        timeline: { refetch: async () => ({ entries: ["original request and tool results"] }) },
        commands: async () => {
          current = "20x";
          live.status = "idle";
        },
        send: async () => {
          assert.equal(current, "20x");
          sent++;
        },
      }),
    },
  } as unknown as PaseoApi;
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member], jobs: () => [] },
    async () => current,
    (home, role, _store, roomId) =>
      selectedClaudeLaunch(home, role, { put: async () => {}, get: async () => "fixture-token" }, roomId),
  );
  const stop = async () => {
    stopped++;
    live.activeTurn = null;
    live.status = "idle";
  };
  const retire = async () => {
    assert.equal(live.activeTurn, null);
    live.status = "closed";
    return true;
  };
  assert.equal((await service.switchNow(api, f.member.id, "20x", retire, stop)).status, "current");
  await service.sweep(api, retire);
  assert.equal(stopped, 1);
  assert.equal(sent, 1);
  const checkpoint = JSON.parse(
    await readFile(join(f.home, "claude-switch-checkpoints", `${f.member.id}.json`), "utf8"),
  );
  assert.equal(checkpoint.phase, "complete");
  assert.equal(checkpoint.turnId, "turn-1");
  assert.deepEqual(checkpoint.timeline.entries, ["original request and tool results"]);
});

test("switch-now validates selected credentials and owned jobs before stopping a turn", async () => {
  const f = await fixture();
  let stopped = 0;
  await assert.rejects(
    f.service.switchNow(f.api, f.member.id, "5x", f.retire, async () => {
      stopped++;
    }),
    /selection changed/,
  );
  f.jobs.push({
    ownerId: f.member.id,
    pid: process.pid,
    processIdentity: (await processIdentity(process.pid))!,
  } as JobRecord);
  await assert.rejects(
    f.service.switchNow(f.api, f.member.id, "20x", f.retire, async () => {
      stopped++;
    }),
    /job/,
  );
  assert.equal(stopped, 0);
});

test("uncertain resume delivery is retained without sending a duplicate", async () => {
  const f = await fixture();
  let current = "5x",
    sent = 0;
  const live = { ...f.live, activeTurn: { turnId: "quota-turn" } as { turnId: string } | null };
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: live }),
        timeline: { refetch: async () => ({ entries: [] }) },
        commands: async () => {
          current = "20x";
          live.status = "idle";
        },
        send: async () => {
          sent++;
          throw new Error("connection lost after delivery");
        },
      }),
    },
  } as unknown as PaseoApi;
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member], jobs: () => [] },
    async () => current,
    async () => ({ account: "20x", credentials: null }),
  );
  const retire = async () => {
    live.status = "closed";
    return true;
  };
  await service.switchNow(api, f.member.id, "20x", retire, async () => {
    live.activeTurn = null;
    live.status = "idle";
  });
  const rows = await service.sweep(api, retire);
  assert.equal(sent, 1);
  assert.match(rows[0].reason!, /readback/);
});

test("quota-blocked idle sessions can switch 5x to 20x and back without new session IDs", async () => {
  const f = await fixture();
  f.live.status = "idle";
  let account = "20x",
    current = "5x";
  const service = new ClaudeSwitch(
    f.home,
    { members: () => [f.member], jobs: () => [] },
    async () => current,
    async () => ({ account, credentials: null }),
  );
  const retire = async (id: string) => {
    assert.equal(id, f.member.id);
    f.live.status = "closed";
    return true;
  };
  assert.equal((await service.sweep(f.api, retire))[0].state, "ready");
  current = "20x";
  account = "5x";
  f.live.status = "idle";
  await f.save({ hq: "5x" });
  assert.equal((await service.sweep(f.api, retire))[0].state, "ready");
});

test("tracked independent process survives switching, but real descendants and unknown ownership block", async () => {
  const home = await temporary("claude-job-ancestry-");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    const job = { pid: process.pid, processIdentity: await processIdentity(process.pid), state: "running" };
    assert.equal(
      await jobBlocksClaudeSwitch(home, "session", job),
      true,
      "missing runtime evidence fails closed",
    );
    await recordClaudeRuntime(home, "session", "5x", child.pid!);
    assert.equal(
      await jobBlocksClaudeSwitch(home, "session", job),
      false,
      "parent job is independent of runtime child",
    );
    await recordClaudeRuntime(home, "session", "5x", process.pid);
    assert.equal(
      await jobBlocksClaudeSwitch(home, "session", {
        pid: child.pid,
        processIdentity: await processIdentity(child.pid!),
        state: "running",
      }),
      true,
      "real process descendant must be protected",
    );
    assert.equal(await jobBlocksClaudeSwitch(home, "session", { ...job, state: "unknown" }), true);
  } finally {
    child.kill();
    await once(child, "exit");
  }
});
