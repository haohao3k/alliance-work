import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { processIdentity } from "../server/jobs.mjs";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("alliance-wakeups-");
  const store = new RoomStore(home);
  store.addRoom({
    id: "r",
    cwd: home,
    artifacts: home,
    title: "Room",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  for (const id of ["owner", "peer"])
    store.saveMember({
      id,
      roomId: "r",
      role: "lead",
      provider: "alliance-codex-lead",
      parentId: null,
      assignment: "assignment.md",
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
      lastTurnId: "turn-1",
    });
  let now = 1000000,
    status = "running",
    sends = 0,
    fail = false,
    archivedAt: string | null = null,
    permission = false;
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status, archivedAt, pendingPermissions: permission ? [{}] : [] } }),
        send: async () => {
          sends++;
          if (fail) throw new Error("lost acknowledgement");
        },
      }),
    },
  } as unknown as PaseoApi;
  const wake = new Wakeups(store, () => now);
  const add = (key: string, extra = {}) =>
    wake.add({
      key,
      roomId: "r",
      ownerId: "owner",
      reason: "Review durable evidence",
      trigger: { kind: "time", at: now },
      ...extra,
    });
  return {
    home,
    store,
    wake,
    api,
    add,
    sends: () => sends,
    idle: () => {
      status = "idle";
    },
    status: (value: string) => {
      status = value;
    },
    archive: () => {
      archivedAt = "now";
    },
    permission: (value: boolean) => {
      permission = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    fail: () => {
      fail = true;
    },
  };
}

test("wakeups survive restart, deduplicate and remain pending for busy owners", async () => {
  const f = await fixture();
  try {
    const a = f.add("one", { delivery: "idle" });
    assert.equal(f.add("one", { delivery: "idle" }).key, a.key);
    assert.throws(() => f.add("one", { reason: "different" }), /different/);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    assert.equal(f.wake.list()[0].state, "pending");
    f.store.close();
    const reopened = new RoomStore(f.home);
    try {
      const wake = new Wakeups(reopened, () => 1000000);
      assert.equal(wake.list()[0].state, "pending");
      f.idle();
      await wake.tick(f.api);
      assert.equal(f.sends(), 1);
      await wake.tick(f.api);
      assert.equal(f.sends(), 1);
    } finally {
      reopened.close();
    }
  } finally {
    /* store was closed before the restart */
  }
});

test("wakeups do not send to unknown, closed, archived or permission-blocked owners", async () => {
  const f = await fixture();
  try {
    f.add("held", { delivery: "idle" });
    for (const status of ["running", "initializing", "closed", "error", "unknown"]) {
      f.status(status);
      await f.wake.tick(f.api);
    }
    f.idle();
    f.permission(true);
    await f.wake.tick(f.api);
    f.permission(false);
    f.archive();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    const w = f.wake.list()[0];
    assert.throws(() => f.wake.action(w.key, "peer", w.revision, "cancel"), /owner/);
    f.wake.action(w.key, "owner", w.revision, "owner", "peer");
    assert.throws(() => f.wake.action(w.key, "owner", w.revision, "cancel"), /changed/);
  } finally {
    f.store.close();
  }
});

test("wakeups observe job exit and require explicit ownership reconciliation", async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    assert(child.pid);
    const identity = await processIdentity(child.pid);
    assert(identity);
    const job = {
      key: "job",
      roomId: "r",
      ownerId: "owner",
      title: "Test",
      pid: child.pid,
      processIdentity: identity,
      revision: 1,
      recordedAt: "now",
    };
    f.store.saveJob(job);
    f.add("exit", { trigger: { kind: "job", key: "job" } });
    await f.wake.tick();
    assert.equal(f.wake.list()[0].state, "scheduled");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    f.store.saveJob({ ...job, revision: 2, ownerId: "peer" }, 1);
    await f.wake.tick();
    assert.equal((await f.wake.take("owner")).length, 0);
    const w = f.wake.list()[0];
    f.wake.action(w.key, "owner", w.revision, "owner", "peer");
    const taken = await f.wake.take("peer");
    assert.equal(taken.length, 1);
    assert.equal(f.store.member("peer")?.decision, "open");
  } finally {
    child.kill();
    f.store.close();
  }
});

test("wakeups recover interrupted batch claims without replay and expire stale obligations", async () => {
  const f = await fixture();
  try {
    f.add("claim", { delivery: "idle" });
    f.add("expires", { expiresAt: 1000001 });
    await f.wake.tick();
    const w = f.wake.list().find((w) => w.key === "claim");
    assert(w);
    assert(f.store.claimWakeups([w], "message", 1000000));
    assert.equal(f.store.claimWakeups([w], "duplicate", 1000000), null);
    f.advance(2);
    f.idle();
    await Promise.all([f.wake.tick(f.api), f.wake.tick(f.api)]);
    assert.equal(f.wake.list()[0].state, "uncertain");
    assert.equal(f.wake.list()[1].state, "expired");
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("wakeups batch idle delivery and quarantine ambiguous sends across restart", async () => {
  const f = await fixture();
  try {
    f.add("one", { delivery: "idle" });
    f.add("two", { delivery: "idle" });
    f.idle();
    f.fail();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    assert(f.wake.list().every((w) => w.state === "uncertain"));
    await new Wakeups(f.store).tick(f.api);
    assert.equal(f.sends(), 1);
  } finally {
    f.store.close();
  }
});

test("wakeups pull needs acknowledgement and repeats skip missed intervals", async () => {
  const f = await fixture();
  try {
    f.add("repeat", { everyMs: 60000, maxRuns: 2 });
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    const taken = await f.wake.take("owner");
    assert.equal(taken.length, 1);
    assert.equal((await f.wake.take("owner")).length, 1);
    f.advance(3600000);
    f.wake.action("repeat", "owner", taken[0].revision, "ack");
    assert.equal((await f.wake.take("owner")).length, 0);
    f.advance(60000);
    const again = await f.wake.take("owner");
    f.wake.action("repeat", "owner", again[0].revision, "ack");
    assert.equal(f.wake.list()[0].state, "acknowledged");
    assert.equal(f.store.member("owner")?.decision, "open");
  } finally {
    f.store.close();
  }
});

test("wakeups bind turn generations and cancel accepted work without waking", async () => {
  const f = await fixture();
  try {
    f.add("turn", { trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" } });
    await f.wake.tick(f.api);
    assert.equal(f.wake.list()[0].state, "scheduled");
    f.store.updateMember("peer", { lastOutcome: "completed", resultPath: "result.json" });
    assert.equal((await f.wake.take("owner")).length, 1);
    f.store.updateMember("peer", { decision: "accepted" });
    await f.wake.tick(f.api);
    assert.equal(f.wake.list()[0].state, "canceled");
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("wakeups recheck accepted work after asynchronous owner readback", async () => {
  const f = await fixture();
  try {
    f.add("race", { delivery: "idle", trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" } });
    f.store.updateMember("peer", { lastOutcome: "completed", resultPath: "result.json" });
    f.idle();
    const ref = f.api.agents.ref("owner");
    const api = {
      agents: {
        ref: () => ({
          ...ref,
          refresh: async () => {
            f.store.updateMember("peer", { decision: "accepted" });
            return ref.refresh();
          },
        }),
      },
    } as unknown as PaseoApi;
    await f.wake.tick(api);
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("wakeups bound batches and enforce an owner cooldown", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 9; n++) f.add(`batch-${n}`, { delivery: "idle" });
    f.idle();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    assert.equal(f.wake.list().filter((w) => w.state === "delivered").length, 8);
    f.advance(59999);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    f.advance(1);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 2);
  } finally {
    f.store.close();
  }
});
