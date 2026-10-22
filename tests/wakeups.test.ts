import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { processIdentity } from "../server/jobs.mjs";
import { Obligations } from "../server/obligations";
import { RoomStore } from "../server/store";
import { WAKE_RETENTION_MS, Wakeups } from "../server/wakeups";
import type { WakeRecordValue } from "../shared/wakeups";
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
    refusal: string | null = null,
    permission = false,
    providerUnavailable = false;
  let failure: Error | null = null;
  const texts: string[] = [];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            status,
            archivedAt: null,
            pendingPermissions: permission ? [{}] : [],
            ...(providerUnavailable ? { providerUnavailable } : {}),
          },
        }),
        send: async (text: string) => {
          sends++;
          texts.push(text);
          if (refusal) throw new Error(refusal);
          if (failure) throw failure;
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
    texts: () => texts,
    idle: () => {
      status = "idle";
    },
    status: (value: string) => {
      status = value;
    },
    permission: (value: boolean) => {
      permission = value;
    },
    unavailable: (value: boolean) => {
      providerUnavailable = value;
    },
    /** The daemon answers the send with an explicit refusal (null: accept again). */
    refuse: (message: string | null) => {
      refusal = message;
    },
    advance: (ms: number) => {
      now += ms;
    },
    /** Sends fail without a refusal: the outcome is unknown (false: they succeed again). */
    fail: (value = true) => {
      fail = value;
    },
    /** Sends fail with this error (null: they succeed again). */
    failWith: (error: Error | null) => {
      failure = error;
    },
  };
}

test("unknown obligation prerequisites fail closed instead of becoming an ordinary due reminder", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.add("activation", { obligationKey: "not-recorded" }), /owner|obligation/i);
    assert.equal((await f.wake.take("owner")).length, 0);
  } finally {
    f.store.close();
  }
});

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

test("wakeups do not send to busy, failed, unknown or permission-blocked owners, and wake closed ones", async () => {
  const f = await fixture();
  try {
    f.add("held", { delivery: "idle" });
    for (const status of ["running", "initializing", "error", "unknown"]) {
      f.status(status);
      await f.wake.tick(f.api);
    }
    f.idle();
    f.permission(true);
    await f.wake.tick(f.api);
    f.permission(false);
    f.status("closed");
    f.unavailable(true);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0, "a closed session whose provider cannot load is not sent to");
    const w = f.wake.list()[0];
    assert.throws(() => f.wake.action(w.key, "peer", w.revision, "cancel"), /owner/);
    f.wake.action(w.key, "owner", w.revision, "owner", "peer");
    assert.throws(() => f.wake.action(w.key, "owner", w.revision, "cancel"), /changed/);
    // Paseo loads a closed session when it receives a prompt.
    f.unavailable(false);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    // A closed session that fails to load received nothing: its batch waits for the owner instead
    // of becoming uncertain, and is not tried again while the session stays closed.
    f.add("unloadable", { delivery: "idle" });
    f.failWith(new Error("Working directory does not exist: /gone/room"));
    for (let n = 0; n < 3; n++) {
      f.advance(60000);
      await f.wake.tick(f.api);
    }
    const unloadable = () => f.wake.list().find((w) => w.key === "unloadable");
    assert.equal(f.sends(), 2);
    assert.notEqual(unloadable()?.state, "uncertain");
    f.failWith(null);
    f.idle();
    await f.wake.tick(f.api);
    assert.equal(unloadable()?.state, "delivered");
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

test("wakeups batch idle delivery, retry refused sends and quarantine ambiguous sends across restart", async () => {
  const f = await fixture();
  try {
    f.add("one", { delivery: "idle" });
    f.add("two", { delivery: "idle" });
    f.idle();
    f.refuse("Agent owner references unavailable provider 'alliance-codex-lead'");
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    assert.deepEqual(
      f.wake.list().map((w) => w.state),
      ["scheduled", "scheduled"],
      "an explicit refusal delivered nothing, so the batch is retried",
    );
    f.refuse(null);
    f.fail();
    f.advance(60000);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 2);
    assert(f.wake.list().every((w) => w.state === "uncertain"));
    await new Wakeups(f.store).tick(f.api);
    assert.equal(f.sends(), 2);
  } finally {
    f.store.close();
  }
});

test("wakeups pull needs acknowledgement and repeats skip missed intervals", async () => {
  const f = await fixture();
  try {
    f.add("repeat", { delivery: "pull", everyMs: 60000, maxRuns: 2 });
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

test("a reminder wakes its idle owner unless pull is chosen; an older pull key re-adds unchanged", async () => {
  const f = await fixture();
  try {
    assert.equal(f.add("own").delivery, "idle");
    f.idle();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    // Keys added before idle became the default stored pull; the same command still names them.
    const legacy = f.add("legacy", { delivery: "pull" });
    assert.equal(f.add("legacy").inputHash, legacy.inputHash);
  } finally {
    f.store.close();
  }
});

test("a reminder added with a grace delay is not delivered before the delay ends", async () => {
  const f = await fixture();
  try {
    f.add("grace", { delivery: "idle", delayMs: 120000 });
    f.idle();
    await f.wake.tick(f.api);
    f.advance(119999);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    f.advance(1);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
  } finally {
    f.store.close();
  }
});

test("a pushed batch lists the owner's pending pull reminders without claiming them", async () => {
  const f = await fixture();
  try {
    f.add("read-later", { delivery: "pull", reason: "Compare the benchmark output" });
    f.add("now", { delivery: "idle" });
    f.idle();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1);
    assert.match(f.texts()[0], /read-later/);
    assert.equal(f.wake.list().find((w) => w.key === "read-later")?.state, "pending");
  } finally {
    f.store.close();
  }
});

test("take returns new reminders ahead of ones already read but not acknowledged", async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 8; n++) f.add(`read-${n}`, { delivery: "pull" });
    assert.equal((await f.wake.take("owner")).length, 8);
    f.add("new", { delivery: "pull" });
    assert.ok((await f.wake.take("owner")).some((w) => w.key === "new"));
  } finally {
    f.store.close();
  }
});

test("wakeups bind turn generations and cancel decided work without waking", async () => {
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
    // An owner that rejects the next turn on Paseo's own notice, within the grace, is not woken.
    f.store.updateMember("peer", { lastTurnId: "turn-2", decision: "open", decisionTurnId: undefined });
    f.add("review", {
      delivery: "idle",
      delayMs: 120000,
      trigger: { kind: "turn", agentId: "peer", turnId: "turn-2" },
    });
    f.store.updateMember("peer", { decision: "rejected", decisionTurnId: "turn-2" });
    f.idle();
    f.advance(120000);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    assert.equal(f.wake.list().find((w) => w.key === "review")?.state, "canceled");
  } finally {
    f.store.close();
  }
});

test("a review is acknowledged only after a decision or a newer turn, and is deferred at most three times", async () => {
  const f = await fixture();
  try {
    f.store.updateMember("peer", { parentId: "owner", lastOutcome: "completed", resultPath: "result.json" });
    f.add("review", { trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" } });
    let [w] = await f.wake.take("owner");
    assert.throws(() => f.wake.action(w.key, "owner", w.revision, "ack"), /decide/i);
    for (let n = 0; n < 3; n++) {
      w = f.wake.action(w.key, "owner", w.revision, "defer", undefined, 30);
      assert.equal((await f.wake.take("owner")).length, 0, "a deferred review waits");
      f.advance(30 * 60000);
      [w] = await f.wake.take("owner");
      assert.equal(w?.key, "review");
    }
    assert.throws(() => f.wake.action(w.key, "owner", w.revision, "defer", undefined, 30), /cancel/);
    f.store.updateMember("peer", { decision: "rejected", decisionTurnId: "turn-1" });
    assert.equal(f.wake.action(w.key, "owner", w.revision, "ack").state, "acknowledged");
    // Rework: the child's newer turn releases the review of the older one.
    f.store.updateMember("peer", { lastTurnId: "turn-2", decision: "open", decisionTurnId: undefined });
    f.add("rework", { trigger: { kind: "turn", agentId: "peer", turnId: "turn-2" } });
    [w] = await f.wake.take("owner");
    f.store.updateMember("peer", { lastTurnId: "turn-3" });
    assert.equal(f.wake.action(w.key, "owner", w.revision, "ack").state, "acknowledged");
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

test("cross-room handback targets the explicit owner and is held after ownership changes until restored", async () => {
  const f = await fixture();
  try {
    f.store.addRoom({ ...f.store.room("r"), id: "hq-room", cwd: `${f.home}/hq` });
    const owner = f.store.member("owner");
    assert(owner);
    f.store.saveMember({ ...owner, id: "hq", roomId: "hq-room" });
    f.store.updateMember("peer", {
      ownership: { ownerId: "hq", revision: 1, evidence: "handoff", at: "now" },
    });
    const w = f.add("cross-room", {
      ownerId: "hq",
      delivery: "idle",
      trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" },
    });
    f.store.updateMember("peer", { lastOutcome: "completed", resultPath: "result.json" });
    await f.wake.tick(f.api);
    assert.equal(f.wake.list()[0].state, "pending");
    f.store.updateMember("peer", {
      ownership: { ownerId: "owner", revision: 2, evidence: "next", at: "later" },
    });
    f.idle();
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
    assert.equal((await f.wake.take("hq")).length, 0);
    assert.equal(f.wake.list()[0].key, w.key);
    assert.throws(() => f.add("unrelated", { ownerId: "hq" }), /owner/i);
    f.store.updateMember("peer", {
      ownership: { ownerId: "hq", revision: 3, evidence: "back", at: "later" },
    });
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 1, "the hold ends once the owner is responsible again");
  } finally {
    f.store.close();
  }
});

test("finished wakeups leave after retention, keeping a current undecided turn reminder and freeing the cap", async () => {
  const f = await fixture();
  try {
    f.store.updateMember("peer", { lastOutcome: "completed", resultPath: "result.json" });
    f.add("done-time");
    f.add("review-turn", { trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" } });
    for (const key of ["done-time", "review-turn"]) {
      await f.wake.take("owner");
      const w = f.wake.list().find((v) => v.key === key);
      assert.ok(w);
      await f.wake.action(key, "owner", w.revision, "ack");
    }
    await f.wake.tick();
    assert.equal(f.wake.list().length, 2, "recent finished records stay for audit");
    f.advance(WAKE_RETENTION_MS + 1);
    await f.wake.tick();
    assert.deepEqual(
      f.wake.list().map((w) => w.key),
      ["review-turn"],
      "the reminder for the still-undecided turn keeps its key so it is not sent again",
    );
    f.store.updateMember("peer", { decision: "accepted" });
    await f.wake.tick();
    assert.equal(f.wake.list().length, 1, "an accepted turn keeps its reminder key while it is current");
    f.store.updateMember("peer", { lastTurnId: "turn-2" });
    await f.wake.tick();
    assert.equal(f.wake.list().length, 0);
    for (let n = 0; n < 1000; n++) {
      f.add(`bulk-${n}`, { trigger: { kind: "time", at: 2_000_000_000 } });
    }
    assert.throws(
      () => f.add("one-too-many", { trigger: { kind: "time", at: 2_000_000_000 } }),
      /Active wakeup limit/,
    );
  } finally {
    f.store.close();
  }
});

test("finished reminders linked to an open obligation are kept for its handoff", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 1000000);
    await ledger.add(
      {
        key: "duty",
        roomId: "r",
        ownerId: "owner",
        assignment: "brief",
        authority: "test",
        nextAction: "finish",
        closeWhen: "verified",
      },
      f.api,
    );
    f.add("duty-reminder", { obligationKey: "duty" });
    await f.wake.take("owner");
    const w = f.wake.list()[0];
    await f.wake.action(w.key, "owner", w.revision, "ack");
    f.advance(WAKE_RETENTION_MS + 1);
    await f.wake.tick();
    assert.equal(f.wake.list().length, 1);
  } finally {
    f.store.close();
  }
});

test("a send to a closed owner that timed out while Paseo may still load it is not sent again", async () => {
  const f = await fixture();
  try {
    f.status("closed");
    f.add("slow-load", { delivery: "idle" });
    f.failWith(
      Object.assign(new Error("Timeout waiting for message (60000ms)"), {
        name: "DaemonConnectionError",
        code: "DAEMON_REQUEST_TIMEOUT",
      }),
    );
    await f.wake.tick(f.api);
    f.failWith(null);
    f.idle(); // the prompt arrived after all and its turn ended
    for (let n = 0; n < 3; n++) {
      f.advance(61000);
      await f.wake.tick(f.api);
    }
    assert.equal(f.sends(), 1);
    assert.equal(f.wake.list()[0].state, "uncertain");
  } finally {
    f.store.close();
  }
});

test("a provider that cannot be steered refusing a batch received nothing: the batch is sent again", async () => {
  const f = await fixture();
  try {
    f.add("steer", { delivery: "idle" });
    f.idle();
    // AGY on Paseo 0.11 started a turn between the readback and the send.
    f.refuse("Provider does not support prompt.steer");
    await f.wake.tick(f.api);
    assert.equal(f.wake.list()[0].state, "scheduled");
    f.refuse(null);
    f.advance(60000);
    await f.wake.tick(f.api);
    assert.equal(f.wake.list()[0].state, "delivered");
  } finally {
    f.store.close();
  }
});

test("an ack sent after the decision already closed the review succeeds without changing it", async () => {
  const f = await fixture();
  try {
    f.store.updateMember("peer", { parentId: "owner", lastOutcome: "completed", resultPath: "result.json" });
    f.add("review", { delivery: "idle", trigger: { kind: "turn", agentId: "peer", turnId: "turn-1" } });
    f.idle();
    await f.wake.tick(f.api);
    const delivered = f.wake.list()[0];
    assert.equal(delivered.state, "delivered");
    f.store.updateMember("peer", { decision: "accepted", decisionTurnId: "turn-1" });
    await f.wake.tick(f.api); // the next round closes the decided review
    const closed = f.wake.list()[0];
    assert.equal(f.wake.action("review", "owner", delivered.revision, "ack").state, "canceled");
    assert.equal(f.wake.list()[0].revision, closed.revision);
    assert.throws(() => f.wake.action("review", "peer", delivered.revision, "ack"), /changed/);
  } finally {
    f.store.close();
  }
});

/** A host's store as 0.1.18 left it, with these members idle in one room, and its prompts. */
async function legacyHost(members: [string, string][]) {
  const home = await temporary("alliance-legacy-pull-");
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
  for (const [id, role] of members)
    store.saveMember({
      id,
      roomId: "r",
      role: role as "lead",
      provider: `alliance-claude-${role}`,
      parentId: null,
      assignment: "assignment.md",
      lastOutcome: "completed",
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  const sent: { id: string; text: string }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: "idle", archivedAt: null, pendingPermissions: [] } }),
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    },
  } as unknown as PaseoApi;
  /** A reminder as 0.1.18 stored it when the command named no delivery. */
  const pull = (
    w: Pick<WakeRecordValue, "key" | "ownerId" | "trigger" | "state" | "createdAt" | "updatedAt" | "dueAt"> &
      Partial<WakeRecordValue>,
  ) =>
    store.saveWakeup({
      roomId: "r",
      reason: `Reminder ${w.key}`,
      delivery: "pull",
      maxRuns: 1,
      expiresAt: w.createdAt + 30 * 86400000,
      inputHash: "stored by 0.1.18",
      revision: 2,
      note: null,
      runs: 0,
      messageId: null,
      lastSentAt: null,
      ...w,
    });
  return { store, api, sent, pull };
}

test("the first 0.1.19 load makes reminders older releases stored pull wake their owner once; stale ones end, obligation ones stay pull", async () => {
  const at = Date.parse;
  let now = at("2026-10-22T05:00:00Z");
  // ryzen, 2026-10-22: Lead 42f1272c, idle since 17:00:54Z, had job reminders pending since
  // 19:06Z and a health check due 20:00Z, stored pull by 0.1.18, so nothing ever woke it. Lead
  // 7a062e96 still had its v0.1.10 adoption reminder from 10-15.
  const ryzen = await legacyHost([
    ["42f1272c", "lead"],
    ["7a062e96", "lead"],
  ]);
  // The full run's controller has exited.
  ryzen.store.saveJob({
    key: "run-20261020-full-st",
    roomId: "r",
    ownerId: "42f1272c",
    title: "Full run controller",
    pid: 2147483646,
    processIdentity: "Tue Oct 21 16:10:02 2026 S",
    recordedAt: "2026-10-21T16:10:02Z",
    revision: 2,
  });
  ryzen.pull({
    key: "run-20261020-full-st",
    ownerId: "42f1272c",
    trigger: { kind: "job", key: "run-20261020-full-st" },
    jobIdentity: "Tue Oct 21 16:10:02 2026 S",
    jobRevision: 2,
    state: "pending",
    createdAt: at("2026-10-21T16:10:02Z"),
    dueAt: at("2026-10-21T16:10:02Z"),
    updatedAt: at("2026-10-21T19:07:43Z"),
  });
  ryzen.pull({
    key: "run-health-20261021T20",
    ownerId: "42f1272c",
    trigger: { kind: "time", at: at("2026-10-21T20:00:00Z") },
    state: "pending",
    createdAt: at("2026-10-21T17:00:40Z"),
    dueAt: at("2026-10-21T20:00:00Z"),
    updatedAt: at("2026-10-21T20:00:06Z"),
  });
  ryzen.pull({
    key: "alliance-v010-adoption",
    ownerId: "7a062e96",
    trigger: { kind: "time", at: at("2026-10-15T16:54:00Z") },
    state: "pending",
    createdAt: at("2026-10-15T16:54:00Z"),
    dueAt: at("2026-10-15T16:54:00Z"),
    updatedAt: at("2026-10-15T16:54:00Z"),
  });
  // Mac mini: HQ fbbeb8af's reminder for its open obligation, pending since 13:32Z.
  const macmini = await legacyHost([["fbbeb8af", "hq"]]);
  macmini.store.saveObligation({
    key: "proj-output-20261021",
    roomId: "r",
    ownerId: "fbbeb8af",
    assignment: "assignment.md",
    authority: "The Human's P1 decisions",
    nextAction: "Review the build output",
    closeWhen: "The Human decided P1",
    conditions: [],
    revision: 1,
    inputHash: "stored by 0.1.18",
    createdAt: at("2026-10-21T13:32:00Z"),
    updatedAt: at("2026-10-21T13:32:00Z"),
    state: "open",
    observations: [],
    receipt: null,
  });
  macmini.pull({
    key: "proj-output-review",
    ownerId: "fbbeb8af",
    obligationKey: "proj-output-20261021",
    trigger: { kind: "time", at: at("2026-10-21T13:32:00Z") },
    state: "pending",
    createdAt: at("2026-10-21T13:32:00Z"),
    dueAt: at("2026-10-21T13:32:00Z"),
    updatedAt: at("2026-10-21T13:32:30Z"),
  });
  try {
    for (const host of [ryzen, macmini]) {
      const wake = new Wakeups(host.store, () => now); // the first 0.1.19 load
      for (let round = 0; round < 3; round++, now += 60000) await wake.tick(host.api);
    }
    assert.deepEqual(
      ryzen.sent.map((s) => s.id),
      ["42f1272c"],
      "the idle owner is woken once, its reminders in one batch",
    );
    assert.match(ryzen.sent[0].text, /run-20261020-full-st[\s\S]*run-health/);
    const state = (store: RoomStore, key: string) => {
      const w = store.wakeups().find((w) => w.key === key);
      return [w?.delivery, w?.state];
    };
    assert.deepEqual(state(ryzen.store, "run-health-20261021T20"), ["idle", "delivered"]);
    assert.deepEqual(state(ryzen.store, "alliance-v010-adoption"), ["pull", "canceled"]);
    assert.deepEqual(macmini.sent, [], "an obligation reminder is never pushed");
    assert.deepEqual(state(macmini.store, "proj-output-review"), ["pull", "pending"]);
    // Only once: a later load leaves a reminder the agent now asks to be pull.
    const again = new Wakeups(ryzen.store, () => now);
    again.add({
      key: "read-later",
      roomId: "r",
      ownerId: "42f1272c",
      reason: "Compare the health results",
      trigger: { kind: "time", at: now },
      delivery: "pull",
    });
    const reloaded = new Wakeups(ryzen.store, () => now);
    await reloaded.tick(ryzen.api);
    assert.deepEqual(state(ryzen.store, "read-later"), ["pull", "pending"]);
    assert.equal(ryzen.sent.length, 1);
  } finally {
    ryzen.store.close();
    macmini.store.close();
  }
});
