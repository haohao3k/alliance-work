import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy, providerNotice, quotaReset } from "../server/autonomy";
import { Lifecycle } from "../server/lifecycle";
import { Obligations } from "../server/obligations";
import { newTurn, RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

// Synthetic regression fixtures use invented agent IDs and fixed test clocks.
async function fixture() {
  const home = await temporary("alliance-autonomy-");
  const store = new RoomStore(home);
  store.addRoom({
    id: "room",
    cwd: home,
    title: "test",
    workspaceId: "w",
    mission: "test",
    artifacts: home,
    createdAt: new Date().toISOString(),
  });
  for (const id of ["owner", "worker"])
    store.saveMember({
      id,
      roomId: "room",
      role: id === "owner" ? "lead" : "peer",
      provider: "alliance-codex-peer",
      parentId: id === "worker" ? "owner" : null,
      assignment: "brief.md",
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      lastTurnId: null,
      launchKey: null,
      launchHash: null,
    });
  let now = 100000;
  let status = "idle",
    permissions: unknown[] = [],
    archived = false;
  let sends = 0,
    archives = 0,
    ambiguous = false,
    refusal: string | null = null;
  const prompts: string[] = [];
  let children: unknown[] = [];
  let onRefresh = () => {};
  const wakes = new Wakeups(store, () => now);
  const autonomy = new Autonomy(store, wakes, () => now);
  const lifecycle = new Lifecycle(store, wakes, autonomy, () => now);
  const api = {
    agents: {
      list: async () => ({ entries: children }),
      ref: () => ({
        refresh: async () => {
          onRefresh();
          return { agent: { status, archivedAt: archived ? "yes" : null, pendingPermissions: permissions } };
        },
        send: async (text: string) => {
          sends++;
          prompts.push(text);
          if (refusal) throw new Error(refusal);
          if (ambiguous) throw new Error("disconnected");
        },
        archive: async () => {
          archives++;
          archived = true;
          return { archivedAt: "yes" };
        },
      }),
    },
  } as unknown as PaseoApi;
  const end = (turn: string, outcome = "completed", error?: string) => {
    store.updateMember("worker", { lastTurnId: turn, lastOutcome: outcome, resultPath: "result.json" });
    autonomy.ended("worker", turn, outcome, error);
  };
  return {
    store,
    home,
    autonomy,
    lifecycle,
    wakes,
    api,
    // One scheduler round: continuation/review first, then the archive sweep.
    tick: async () => {
      await autonomy.tick(api);
      await lifecycle.sweep(api);
    },
    end,
    advance: (ms = 120000) => {
      now += ms;
    },
    now: () => now,
    status: (s: string) => {
      status = s;
    },
    children: (items: unknown[]) => {
      children = items;
    },
    onRefresh: (fn: () => void) => {
      onRefresh = fn;
    },
    permission: () => {
      permissions = [{}];
    },
    ambiguous: () => {
      ambiguous = true;
    },
    /** The daemon refuses the send before prompting (null: accept again). */
    refuse: (message: string | null) => {
      refusal = message;
    },
    counts: () => ({ sends, archives }),
    prompts: () => prompts,
  };
}

/** Records a member the way the session hook does. */
function seat(
  store: RoomStore,
  id: string,
  parentId: string | null,
  lastTurnId: string | null = null,
  role: "hq" | "lead" | "peer" = "peer",
  harness = "codex",
) {
  store.saveMember({
    id,
    roomId: "room",
    role,
    provider: `alliance-${harness}-${role}`,
    parentId,
    assignment: "brief.md",
    decision: "open",
    decisionEvidence: null,
    lastOutcome: null,
    resultPath: null,
    lastTurnId,
    launchKey: null,
    launchHash: null,
  });
}

test("continuation and review prompts name the current CLI and the agent's pending pull reminders", async () => {
  const f = await fixture();
  try {
    const cli = { command: "/opt/alliance/bin/alliance-work --home /srv/alliance", managed: true };
    f.autonomy.cli = f.wakes.cli = () => cli;
    f.autonomy.start("worker");
    f.wakes.add({
      key: "ci-result",
      roomId: "room",
      ownerId: "worker",
      reason: "Read the CI result",
      trigger: { kind: "time", at: f.now() },
      delivery: "pull",
    });
    await f.wakes.tick();
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.match(f.prompts()[0], /\[ci-result\] Read the CI result/, "pull is seen without polling");
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "review", "handback ready", "t2");
    f.end("t2");
    f.advance();
    await f.autonomy.tick(f.api);
    f.advance(); // past the review's grace
    await f.wakes.tick(f.api);
    assert.equal(f.prompts().length, 2, "one continuation, then one review wakeup for the owner");
    for (const prompt of f.prompts()) assert.ok(prompt.includes(cli.command), prompt);
  } finally {
    f.store.close();
  }
});

test("bound continuation and retry wait for prerequisites while unrelated work remains independent", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "gated",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "continue",
        closeWhen: "verified",
        conditions: [{ id: "ready", requires: "dependency verified" }],
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "gated" });
    f.end("t1", "failed");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 0);
    assert.equal(f.autonomy.get("worker")?.retries, 0);
    const evidence = join(f.home, "evidence.txt");
    await writeFile(evidence, "dependency verified");
    await ledger.action(
      {
        key: "gated",
        ownerId: "worker",
        revision: 1,
        action: "observe",
        conditionId: "ready",
        validUntil: 999999,
        evidence,
      },
      f.api,
    );
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    f.autonomy.started("worker", "t2");
    f.end("t2");
    for (let n = 0; n < 7; n++) f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1, "expired evidence blocks again");
    f.autonomy.start("owner");
    f.store.updateMember("owner", { lastTurnId: "independent", lastOutcome: "completed" });
    f.autonomy.ended("owner", "independent", "completed");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2, "unrelated task continues");
  } finally {
    f.store.close();
  }
});

test("accepted work cannot archive with open obligations even after reminder expiry", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "open",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "handoff",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker");
    f.autonomy.checkpoint("worker", "review", "ready");
    f.end("t1");
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "receipt" });
    f.wakes.add({
      key: "expired",
      roomId: "room",
      ownerId: "worker",
      obligationKey: "open",
      reason: "review",
      trigger: { kind: "time", at: 100000 },
      expiresAt: 110000,
    });
    f.advance();
    await f.wakes.tick();
    assert.equal(f.wakes.list()[0].state, "expired");
    await f.tick();
    assert.equal(f.counts().archives, 0);
    const evidence = join(f.home, "close.txt");
    await writeFile(evidence, "verified");
    await ledger.action({ key: "open", ownerId: "worker", revision: 1, action: "fulfill", evidence }, f.api);
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("obligation handoff moves managed continuation and budget atomically without replaying old owner", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "move",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "finish",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "move", maxContinuations: 3 });
    f.end("t1");
    f.advance();
    const evidence = join(f.home, "handoff.txt");
    await writeFile(evidence, "successor owns remaining work");
    await ledger.action(
      { key: "move", ownerId: "worker", revision: 1, action: "handoff", nextOwnerId: "owner", evidence },
      f.api,
    );
    assert.equal(f.autonomy.get("worker")?.phase, "paused");
    assert.equal(f.autonomy.get("worker")?.pausedBy, "handoff");
    f.autonomy.started("worker", "after-handoff");
    assert.equal(f.autonomy.get("worker")?.phase, "paused", "a handoff pause is not resumed by a new turn");
    assert.equal(f.autonomy.get("owner")?.obligationKey, "move");
    assert.equal(f.autonomy.get("owner")?.maxContinuations, 3);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(f.autonomy.get("owner")?.continuations, 1);
    assert.equal(f.autonomy.get("worker")?.continuations, 0);
    // An owned member that so far only hands back to its owner is a free successor too.
    seat(f.store, "sibling", "owner");
    f.autonomy.ensure("sibling");
    f.autonomy.started("owner", "o1");
    f.store.updateMember("owner", { lastTurnId: "o1", lastOutcome: "completed" });
    f.autonomy.ended("owner", "o1", "completed");
    await ledger.action(
      { key: "move", ownerId: "owner", revision: 2, action: "handoff", nextOwnerId: "sibling", evidence },
      f.api,
    );
    assert.equal(f.autonomy.get("sibling")?.obligationKey, "move");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2, "the successor continues the obligation");
  } finally {
    f.store.close();
  }
});

test("unfinished assignments continue across idle turns and review wakes the owner once", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "review", "Candidate ready");
    f.end("t2");
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.wakes.list().length, 1);
    assert.equal(f.wakes.list()[0].delivery, "idle");
    assert.equal(f.counts().archives, 0, "turn completion is not acceptance");
  } finally {
    f.store.close();
  }
});

test("failed turns retry with a bound, while cancellation and permission do not restart work", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    for (let n = 1; n <= 3; n++) {
      f.autonomy.started("worker", `t${n}`);
      f.end(`t${n}`, "failed");
      f.advance();
      await f.autonomy.tick(f.api);
    }
    assert.equal(f.counts().sends, 2);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked");
    f.autonomy.start("worker");
    f.autonomy.started("worker", "cancel");
    f.end("cancel", "canceled");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2);
    assert.equal(f.autonomy.get("worker")?.phase, "paused");
    f.autonomy.start("worker");
    f.autonomy.started("worker", "permission");
    f.end("permission", "failed");
    f.advance();
    f.permission();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2);
  } finally {
    f.store.close();
  }
});

test("a provider quota failure waits without using retries or duplicating runtime account notices", async () => {
  const f = await fixture();
  try {
    const retries = () => f.prompts().filter((p) => p.startsWith("Alliance retry")).length;
    f.autonomy.start("worker");
    f.autonomy.started("worker", "q1");
    f.end(
      "q1",
      "failed",
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h7m1s.",
    );
    for (let n = 0; n < 5; n++) {
      f.advance();
      await f.autonomy.tick(f.api);
    }
    assert.equal(retries(), 0, "no retry is spent before the quota resets");
    await f.wakes.tick(f.api);
    await f.wakes.tick(f.api);
    const notices = f.wakes.list().filter((w) => w.ownerId === "owner");
    assert.equal(notices.length, 0, "runtime owns account-scoped quota notices");
    f.advance(4 * 3600000);
    await f.autonomy.tick(f.api);
    assert.equal(retries(), 1);
    assert.equal(f.autonomy.get("worker")?.retries, 0, "a quota retry does not use the retry budget");
    // A stated reset time is honoured the same way.
    f.autonomy.started("worker", "q2");
    f.end("q2", "failed", "You've hit your usage limit. Upgrade or try again at Jan 2nd, 1970 6:06 PM.");
    const reset = Date.parse("Jan 2, 1970 6:06 PM") + 60000;
    f.advance(reset - 60000 - f.now());
    await f.autonomy.tick(f.api);
    assert.equal(retries(), 1);
    f.advance(60000);
    await f.autonomy.tick(f.api);
    assert.equal(retries(), 2);
    assert.equal(f.autonomy.get("worker")?.retries, 0);
  } finally {
    f.store.close();
  }
});

test("a provider quota that does not lift ends blocked after a few waits", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    // A billing quota never resets by itself and names no time.
    const billing = "You exceeded your current quota, please check your plan and billing details.";
    for (let n = 1; n <= 8 && f.autonomy.get("worker")?.phase !== "blocked"; n++) {
      f.autonomy.started("worker", `q${n}`);
      f.end(`q${n}`, "failed", billing);
      f.advance(31 * 60000);
      await f.autonomy.tick(f.api);
    }
    assert.equal(f.autonomy.get("worker")?.phase, "blocked", "a quota that does not lift needs a decision");
    assert.ok(f.prompts().length <= 3, `${f.prompts().length} retries`);
    assert.equal(f.wakes.list().filter((w) => w.key.startsWith("quota-")).length, 0);
  } finally {
    f.store.close();
  }
});

test("a short or unstated rate limit is retried within minutes and does not wake the owner", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker", { maxRetries: 5 });
    for (const [turn, error] of [
      ["r1", "Rate limit reached for gpt-x on tokens per min (TPM): Limit 30000. Please try again in 120ms."],
      ["r2", "Rate limit reached for gpt-x on requests per min. Please try again in 1.898s."],
      ["r3", "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit"],
    ]) {
      const sent = f.prompts().length;
      f.autonomy.started("worker", turn);
      f.end(turn, "failed", error);
      f.advance(2 * 60000);
      await f.autonomy.tick(f.api);
      assert.equal(f.prompts().length, sent + 1, `${turn} is retried within two minutes`);
    }
    assert.deepEqual(
      f.wakes.list().map((w) => w.key),
      [],
      "a brief limit is not news for the owner",
    );
  } finally {
    f.store.close();
  }
});

test("a failure after a review checkpoint in the same turn keeps the handback for review", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "review", "Report saved", "t1");
    f.end("t1", "failed");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 0, "finished work is not retried");
    assert.equal(f.autonomy.get("worker")?.phase, "review");
    assert.deepEqual(
      f.wakes.list().map((w) => [w.ownerId, w.trigger]),
      [["owner", { kind: "turn", agentId: "worker", turnId: "t1" }]],
    );
  } finally {
    f.store.close();
  }
});

test("a turn that ends without a checkpoint hands back when nothing else will wake the agent", async () => {
  const f = await fixture();
  try {
    seat(f.store, "helper", "worker", "h1");
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "waiting", "Waiting for the helper", "t1");
    f.end("t1");
    assert.equal(f.autonomy.get("worker")?.phase, "waiting", "a checkpoint in the turn decides");
    f.autonomy.started("worker", "t2");
    f.end("t2");
    assert.equal(f.autonomy.get("worker")?.phase, "waiting", "its running child will hand back to it");
    f.store.updateMember("helper", { lastOutcome: "completed" });
    f.wakes.add({
      key: "recheck",
      roomId: "room",
      ownerId: "worker",
      reason: "Recheck the helper",
      trigger: { kind: "time", at: f.now() + 3600000 },
      delivery: "idle",
    });
    f.autonomy.started("worker", "t3");
    f.end("t3");
    assert.equal(f.autonomy.get("worker")?.phase, "waiting", "its own reminder will wake it");
    const recheck = f.wakes.list()[0];
    f.wakes.action(recheck.key, "worker", recheck.revision, "cancel");
    // A child created in this turn hands back to it once its first turn runs.
    seat(f.store, "fresh", "worker");
    f.autonomy.start("fresh");
    f.autonomy.started("worker", "t4");
    f.end("t4");
    assert.equal(f.autonomy.get("worker")?.phase, "waiting", "the child it just created will hand back");
    // A child that never started, and a reminder for a child turn it already decided, wake nobody.
    f.advance(15 * 60000);
    f.wakes.add({
      key: "wait-helper",
      roomId: "room",
      ownerId: "worker",
      reason: "Review the helper",
      trigger: { kind: "turn", agentId: "helper", turnId: "h1" },
      delivery: "idle",
    });
    f.store.updateMember("helper", { decision: "accepted", decisionTurnId: "h1" });
    f.autonomy.started("worker", "t5");
    f.end("t5");
    assert.equal(
      f.autonomy.get("worker")?.phase,
      "review",
      "nothing else continues it: this is its handback",
    );
    f.advance();
    await f.autonomy.tick(f.api);
    f.advance();
    await f.wakes.tick(f.api);
    assert.equal(f.counts().sends, 1, "the owner is woken once; the worker is not continued");
    assert.match(f.prompts()[0], /^Alliance wakeups for owner owner/);
  } finally {
    f.store.close();
  }
});

test("an owned member without an assignment hands each turn back to its owner and is never prompted", async () => {
  const f = await fixture();
  try {
    await f.autonomy.tick(f.api); // the upgrade pass gives the owned worker a record
    assert.equal(f.autonomy.get("worker")?.phase, "waiting");
    const turn = async (id: string, outcome = "completed", error?: string) => {
      f.autonomy.started("worker", id);
      f.end(id, outcome, error);
      for (let n = 0; n < 3; n++) {
        f.advance();
        await f.autonomy.tick(f.api);
      }
    };
    await turn("t1");
    await turn("t2"); // the owner's rework
    await turn("t3", "failed", "stream disconnected before completion");
    assert.equal(f.counts().sends, 0, "neither continued nor retried");
    assert.equal(f.autonomy.get("worker")?.phase, "blocked", "a failed turn goes to the owner");
    assert.deepEqual(
      f.wakes.list().map((w) => [w.ownerId, w.trigger.kind === "turn" && w.trigger.turnId]),
      [
        ["owner", "t1"],
        ["owner", "t2"],
        ["owner", "t3"],
      ],
    );
    // Starting an assignment opts it in to continuation.
    f.autonomy.start("worker");
    await turn("t4");
    assert.equal(f.counts().sends, 1);
  } finally {
    f.store.close();
  }
});

test("prompts after a reopened handback or a quota retry do not repeat a reason that no longer applies", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "waiting", "Waiting for review", "t1");
    f.end("t1");
    f.autonomy.started("worker", "t2");
    f.end("t2");
    assert.equal(f.autonomy.get("worker")?.phase, "review", "its final message is the handback");
    f.autonomy.started("worker", "t3"); // the owner's rework
    f.end("t3");
    f.advance();
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t4");
    f.end("t4", "failed", "Individual quota reached. Resets in 1h.");
    f.advance(2 * 3600000);
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t5");
    f.end("t5");
    f.advance();
    await f.autonomy.tick(f.api);
    const [reworked, retry, continued] = f.prompts();
    assert.match(retry, /^Alliance retry/);
    assert.doesNotMatch(reworked, /final message is the handback/, "the rework is not a handback");
    assert.doesNotMatch(continued, /retry after/i, "the quota wait is over");
  } finally {
    f.store.close();
  }
});

test("uncertain delivery survives reload without replay; a new observed turn resolves it; a refused send is retried", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    // The daemon refused before prompting: nothing was delivered and no budget is spent.
    f.refuse("Agent not found: worker");
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.delivery, "none");
    assert.equal(f.autonomy.get("worker")?.continuations, 0);
    f.refuse(null);
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.delivery, "sent");
    f.autonomy.started("worker", "t2");
    f.end("t2");
    f.advance();
    f.ambiguous();
    await f.autonomy.tick(f.api);
    const restarted = new Autonomy(f.store, f.wakes, () => 999999);
    await restarted.tick(f.api);
    assert.equal(f.counts().sends, 3);
    assert.equal(restarted.get("worker")?.delivery, "uncertain");
    restarted.started("worker", "t3");
    assert.equal(restarted.get("worker")?.delivery, "none");
  } finally {
    f.store.close();
  }
});

test("only accepted idle work with no outstanding dependents is archived", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.autonomy.checkpoint("worker", "review", "ready");
    f.end("t1");
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "acceptance.json" });
    f.status("running");
    await f.tick();
    assert.equal(f.counts().archives, 0);
    f.status("idle");
    await f.tick();
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("reload continues retained work, ignores stale outcomes, and does not replay interrupted dispatch", async () => {
  const f = await fixture();
  f.autonomy.start("worker");
  f.autonomy.started("worker", "current");
  f.end("current");
  f.autonomy.ended("worker", "old", "failed");
  f.store.close();
  const store = new RoomStore(f.home);
  try {
    const recovered = new Autonomy(store, new Wakeups(store), () => 999999);
    await recovered.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(recovered.get("worker")?.retries, 0);
    const record = recovered.get("worker");
    assert.ok(record);
    store.saveAutonomy(
      { ...record, delivery: "dispatching", revision: record.revision + 1 },
      record.revision,
    );
    await new Autonomy(store, new Wakeups(store), () => 999999).tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(store.autonomous()[0].delivery, "uncertain");
  } finally {
    store.close();
  }
});

test("pause during native readback prevents send and native children prevent cascade archive", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    f.onRefresh(() => {
      f.autonomy.checkpoint("worker", "paused", "Operator paused");
    });
    await f.tick();
    assert.equal(f.counts().sends, 0);
    f.onRefresh(() => {});
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "acceptance.json" });
    await f.tick();
    assert.equal(f.counts().archives, 0, "paused work remains open even after acceptance");
    f.autonomy.checkpoint("worker", "review", "Ready");
    f.children([{ agent: { id: "unmanaged-native-child", status: "idle" } }]);
    await f.tick();
    assert.equal(f.counts().archives, 0, "all native children must be archived separately");
    f.children([]);
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("continuation exhaustion requests review; a new turn keeps the block until the agent lifts it, and an explicit blocker is kept", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker", { maxContinuations: 1 });
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t2");
    f.end("t2");
    f.advance();
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked");
    assert.equal(f.wakes.list().length, 1);
    // Paseo's finish notices and other prompts reach blocked agents too: a turn, completed or
    // failed, is no decision to go on.
    for (const [turn, outcome] of [
      ["t3", "completed"],
      ["t4", "failed"],
    ]) {
      f.autonomy.started("worker", turn);
      assert.equal(f.autonomy.get("worker")?.phase, "blocked");
      f.end(turn, outcome);
      f.advance();
      await f.autonomy.tick(f.api);
    }
    assert.equal(f.counts().sends, 1, "neither continued nor retried");
    f.autonomy.started("worker", "t5");
    f.autonomy.checkpoint("worker", "blocked", "Need external credentials", "t5");
    f.end("t5");
    assert.equal(f.autonomy.get("worker")?.reason, "Need external credentials");
    f.autonomy.started("worker", "t6");
    f.autonomy.checkpoint("worker", "active", "Credentials arrived", "t6");
    assert.equal(f.autonomy.get("worker")?.phase, "active", "the agent lifts its block itself");
  } finally {
    f.store.close();
  }
});

test("an exhausted run budget is renewed by autonomy start, not by an active checkpoint", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker", { maxContinuations: 1 });
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t2");
    f.end("t2");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked", "the budget is spent");
    f.autonomy.started("worker", "t3"); // its owner answered; it checkpoints active
    f.autonomy.checkpoint("worker", "active", "Owner answered; next step 2", "t3");
    f.end("t3");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked", "the spent budget blocks it again");
    assert.equal(f.counts().sends, 1);
    f.autonomy.start("worker"); // its owner renews the budget
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2, "continued again");
    assert.equal(f.autonomy.get("worker")?.phase, "active");
  } finally {
    f.store.close();
  }
});

test("a blocker or a wait recorded before a failure in the same turn stands: no retry, and the blocker reaches the owner", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "blocked", "Need the Human's API key", "t1");
    f.end("t1", "failed", "stream disconnected before completion");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked");
    assert.deepEqual(
      f.wakes.list().map((w) => [w.ownerId, w.trigger]),
      [["owner", { kind: "turn", agentId: "worker", turnId: "t1" }]],
    );
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "waiting", "Waiting on the build", "t2");
    f.end("t2", "failed", "stream disconnected before completion");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.phase, "waiting");
    assert.equal(f.counts().sends, 0, "neither is retried");
  } finally {
    f.store.close();
  }
});

test("an obligation handed off or fulfilled binds no longer: the agent starts again and its turns hand back", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    const evidence = join(f.home, "unbound.txt");
    await writeFile(evidence, "recorded");
    const obligation = (key: string) =>
      ledger.add(
        {
          key,
          roomId: "room",
          ownerId: "worker",
          assignment: "brief",
          authority: "test",
          nextAction: "finish",
          closeWhen: "verified",
        },
        f.api,
      );
    await obligation("move");
    f.autonomy.start("worker", { obligationKey: "move" });
    await ledger.action(
      { key: "move", ownerId: "worker", revision: 1, action: "handoff", nextOwnerId: "owner", evidence },
      f.api,
    );
    f.autonomy.start("worker");
    assert.equal(f.autonomy.get("worker")?.phase, "active", "a handoff pause can be started again");
    await obligation("fix");
    f.autonomy.start("worker", { obligationKey: "fix" });
    f.autonomy.started("worker", "t1");
    await ledger.action({ key: "fix", ownerId: "worker", revision: 1, action: "fulfill", evidence }, f.api);
    f.autonomy.checkpoint("worker", "waiting", "Fixed; waiting for review", "t1");
    f.end("t1");
    f.autonomy.started("worker", "t2");
    f.end("t2");
    assert.equal(f.autonomy.get("worker")?.phase, "review", "nothing else follows up its turn");
  } finally {
    f.store.close();
  }
});

test("an assignment bound to an obligation that is no longer open is not continued by its next turn", async () => {
  // synthetic host: Codex Lead 0000001b is bound to proj-cycle1-20261021, fulfilled at 13:32Z, and
  // sits in review. A message to it reopens the review; that turn ends without a checkpoint.
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    const evidence = join(f.home, "cycle1-operations-handback.md");
    await writeFile(evidence, "cycle1 handback");
    await ledger.add(
      {
        key: "proj-cycle1-20261021",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "HQ 0000001c",
        nextAction: "hand back cycle1",
        closeWhen: "HQ accepts the cycle1 handback",
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "proj-cycle1-20261021" });
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "review", "Final checked handback cycle1-operations-handback.md", "t1");
    f.end("t1");
    await ledger.action(
      { key: "proj-cycle1-20261021", ownerId: "worker", revision: 1, action: "fulfill", evidence },
      f.api,
    );
    f.autonomy.started("worker", "t2");
    f.end("t2");
    for (let n = 0; n < 4; n++) {
      f.advance();
      await f.autonomy.tick(f.api);
    }
    assert.deepEqual(
      f.prompts().filter((p) => p.startsWith("Alliance continue")),
      [],
      "its closed obligation still gates it",
    );
  } finally {
    f.store.close();
  }
});

test("wait keeps a handback or a pause it finds, and repeating wait --minutes in a turn adds nothing", async () => {
  const f = await fixture();
  try {
    f.advance(Date.now() - f.now()); // wait --minutes counts from the wall clock
    const { registerWait } = await import("../scripts/wait.mjs");
    // biome-ignore lint/suspicious/noExplicitAny: RPC inputs are validated by the plugin
    const rpc = async (method: string, input: any) => {
      if (method === "wakeups.add") return f.wakes.add(input);
      if (method === "wakeups.list") return f.wakes.list();
      if (method === "autonomy.list") return f.autonomy.list();
      if (method === "autonomy.checkpoint")
        return f.autonomy.checkpoint(input.agentId, input.phase, input.reason, input.turnId);
      throw new Error(`Unexpected RPC ${method}`);
    };
    const said: string[] = [];
    const wait = (reason: string) =>
      registerWait(
        rpc,
        { roomId: "room", ownerId: "worker", self: "worker", reason, minutes: "60" },
        (line) => said.push(line),
      );
    f.autonomy.start("worker");
    f.autonomy.started("worker", "t1");
    f.autonomy.checkpoint("worker", "review", "Result saved", "t1");
    const key = await wait("The owner's decision");
    await new Promise((done) => setTimeout(done, 5));
    assert.equal(await wait("The owner's decision"), key, "a repeated call is the same reminder");
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("worker")?.phase, "review", "the handback stands");
    assert.equal(f.wakes.list().filter((w) => w.ownerId === "owner").length, 1, "the owner is asked");
    // An operator's pause stands too; the reminder still wakes the agent.
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "paused", "Operator pause before an update");
    await wait("CI");
    assert.equal(f.autonomy.get("worker")?.phase, "paused");
    assert.equal(said.filter((line) => /stands/.test(line)).length, 3, "each kept state is reported");
  } finally {
    f.store.close();
  }
});

test("handing off an obligation keeps a Human's cancellation hold on the old owner", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "held",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "finish",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "held" });
    f.autonomy.started("worker", "t1");
    f.end("t1", "canceled");
    const evidence = join(f.home, "handoff-held.txt");
    await writeFile(evidence, "successor owns remaining work");
    await ledger.action(
      { key: "held", ownerId: "worker", revision: 1, action: "handoff", nextOwnerId: "owner", evidence },
      f.api,
    );
    assert.equal(f.autonomy.get("worker")?.pausedBy, "cancel");
  } finally {
    f.store.close();
  }
});

/** A pilot room on the synthetic host: HQ 00000019 owns Claude Lead 00000017. Times are UTC on `day`. */
async function pilot(day: string) {
  const f = await fixture();
  seat(f.store, "00000019", null, null, "hq", "claude");
  seat(f.store, "00000017", "00000019", null, "lead", "claude");
  f.autonomy.start("00000017");
  const at = (time: string) => f.advance(Date.parse(`${day}T${time}Z`) - f.now());
  return {
    ...f,
    at,
    /** Scheduler rounds every 15 s up to `time`. */
    rounds: async (time: string) => {
      while (f.now() + 15000 <= Date.parse(`${day}T${time}Z`)) {
        f.advance(15000);
        await f.autonomy.tick(f.api);
        await f.wakes.tick(f.api);
      }
      at(time);
    },
    /**
     * A turn of the Lead as the runtime hooks record it, from `start` to `end`; one that keeps the
     * phase it found leaves the Lead's handback standing.
     */
    turn: (turnId: string, start: string, end: string, checkpoint?: () => void) => {
      at(start);
      f.autonomy.started("00000017", turnId);
      if (!f.autonomy.carrying("00000017")) f.store.updateMember("00000017", newTurn(turnId));
      checkpoint?.();
      at(end);
      if (!f.autonomy.carrying("00000017"))
        f.store.updateMember("00000017", { lastOutcome: "completed", resultPath: `${turnId}.json` });
      f.autonomy.ended("00000017", turnId, "completed");
    },
    asksHq: () => f.prompts().filter((p) => p.startsWith("Alliance wakeups for owner 00000019")).length,
  };
}

test("a turn Claude Code starts by itself keeps the handback it found: its owner is asked, it is not continued", async () => {
  // synthetic host, 2026-10-22: the Lead checkpointed review in autonomous-turn-52 (04:06:00, ended
  // 04:06:14). Monitor events then started autonomous-turn-53, -55, -56 and -57 (ended 04:06:17,
  // 04:07:19, 04:07:53, 04:09:24; each about 3 s long). 0.1.18 reopened the review, continued the
  // Lead with its own handback text, and HQ never heard of it.
  const f = await pilot("2026-10-22");
  try {
    f.turn("autonomous-turn-52", "04:05:50", "04:06:14", () => {
      f.at("04:06:00");
      f.autonomy.checkpoint(
        "00000017",
        "review",
        "U3 runtime passed; handback written",
        "autonomous-turn-52",
      );
    });
    f.turn("autonomous-turn-53", "04:06:14", "04:06:17");
    await f.rounds("04:07:16");
    f.turn("autonomous-turn-55", "04:07:16", "04:07:19");
    await f.rounds("04:07:50");
    f.turn("autonomous-turn-56", "04:07:50", "04:07:53");
    await f.rounds("04:09:21");
    f.turn("autonomous-turn-57", "04:09:21", "04:09:24");
    await f.rounds("04:12:00");
    assert.equal(f.autonomy.get("00000017")?.phase, "review", "the handback stands");
    assert.deepEqual(
      f.prompts().filter((p) => p.startsWith("Alliance continue")),
      [],
      "the Lead is not continued",
    );
    assert.equal(f.asksHq(), 1, "HQ is asked about the handback once");
  } finally {
    f.store.close();
  }
});

test("a blocker asks its owner once while later turns leave it standing", async () => {
  // synthetic host, 2026-10-21: the Lead checkpointed blocked at 15:55:34 (foreground-turn-8, ended
  // 15:55:44) with this reason. A task-notification turn (autonomous-turn-9) and two turns started
  // by plugin wake batches (foreground-turn-10, -11) followed without a checkpoint, and HQ got a
  // review of the same blocker after each of them, until it asked for an urgent fix of the loop.
  const reason =
    "fixture: required test service is unavailable; owner action needed. See results/fixture/STATUS.md.";
  const f = await pilot("2026-10-21");
  try {
    f.turn("foreground-turn-8", "15:55:30", "15:55:44", () => {
      f.at("15:55:34");
      f.autonomy.checkpoint("00000017", "blocked", reason, "foreground-turn-8");
    });
    await f.rounds("15:58:46");
    f.turn("autonomous-turn-9", "15:58:46", "15:58:53");
    await f.rounds("16:00:37");
    f.turn("foreground-turn-10", "16:00:37", "16:02:44");
    await f.rounds("16:03:08");
    f.turn("foreground-turn-11", "16:03:08", "16:03:34");
    await f.rounds("16:06:30");
    assert.equal(f.autonomy.get("00000017")?.reason, reason, "the blocker stands");
    assert.equal(f.asksHq(), 1, "HQ is asked once");
  } finally {
    f.store.close();
  }
});

test("an assignment continued twice without a checkpoint hands its final message back instead of a third continuation", async () => {
  // primaryHost, 2026-10-21: active Sonnet peers were continued about every 30 s and each continuation
  // turn ended without a checkpoint (0000000f foreground-turn-2 to -21; 79 such turns that day).
  const f = await fixture();
  try {
    const continued = () => f.prompts().filter((p) => p.startsWith("Alliance continue"));
    f.autonomy.start("worker");
    f.autonomy.started("worker", "foreground-turn-1");
    f.end("foreground-turn-1");
    for (const turn of ["foreground-turn-2", "foreground-turn-3"]) {
      f.advance(30000);
      await f.autonomy.tick(f.api);
      // The continuation's message id comes back as the turn's prompt id.
      const prompt = /\[([0-9a-f-]{36})\]/.exec(continued().at(-1) ?? "")?.[1];
      f.autonomy.started("worker", turn);
      f.store.updateMember("worker", {
        lastTurnId: turn,
        lastOutcome: "completed",
        resultPath: `${turn}.json`,
      });
      f.autonomy.ended("worker", turn, "completed", undefined, prompt);
    }
    for (let n = 0; n < 3; n++) {
      f.advance(30000);
      await f.autonomy.tick(f.api);
    }
    assert.equal(continued().length, 2, "no third continuation");
    assert.equal(f.autonomy.get("worker")?.phase, "review");
    f.advance();
    await f.wakes.tick(f.api);
    assert.ok(
      f.prompts().some((p) => p.startsWith("Alliance wakeups for owner owner")),
      "its owner reviews the last turn",
    );
  } finally {
    f.store.close();
  }
});

test("a Pi usage limit that says when it resets is retried then, without using the retry budget", async () => {
  // i5, 2026-10-21: Pi peer 0000001a (proxy/gpt-6-astra) failed at 21:06:41 with this
  // text. 0.1.18 retried it after 40 s and 75 s and had spent its retry budget 2m09s later.
  const f = await fixture();
  try {
    f.advance(Date.parse("2026-10-21T21:06:41Z") - f.now());
    f.autonomy.start("worker");
    f.autonomy.started("worker", "11111111-1111-4111-8111-111111111111");
    f.end(
      "11111111-1111-4111-8111-111111111111",
      "failed",
      'proxy API error (503): {"message":"[upstream/gpt-6-astra] [429]: The usage limit has been reached (reset after 29m 43s)"} (stopReason=error, model=proxy/gpt-6-astra)',
    );
    const retries = () => f.prompts().filter((p) => p.startsWith("Alliance retry")).length;
    while (f.now() + 15000 <= Date.parse("2026-10-21T21:37:20Z")) {
      f.advance(15000);
      await f.autonomy.tick(f.api);
    }
    assert.equal(retries(), 0, "nothing before 21:37:24, the stated reset and a minute");
    f.advance(30000);
    await f.autonomy.tick(f.api);
    assert.equal(retries(), 1);
    assert.equal(f.autonomy.get("worker")?.retries, 0, "the retry budget is untouched");
  } finally {
    f.store.close();
  }
});

// Synthetic provider notices exercise parsing with fixed clocks and public CLI message formats.
const NOW = Date.parse("2026-11-13T01:00:00Z");
const MINUTE = 60000;

test("a Claude turn ending on a limit or sign-in notice is recognised as the provider's, not as an answer", () => {
  for (const notice of [
    "You've hit your 5-hour limit · resets 4:10am (Asia/Saigon)",
    "You've hit your weekly limit · resets 11am (Asia/Saigon)",
    "You've reached your Fable limit. Switch to another model to continue.",
    "Login expired · Please run /login",
    "Login reached its time limit · Please run /login",
    // zerosub (kapybara-org/zerosub@954d699 server/limits.ts): typographic apostrophe, legacy epoch, budgets.
    "You’ve hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)",
    "You’ve reached your Opus 5 limit",
    // A model the code has never heard of.
    "You've hit your Mythos limit · resets 9pm (Asia/Saigon)",
    "You've hit your Claude 5 limit · resets 9pm (Asia/Saigon)",
    "Claude AI usage limit reached|1792000000",
    "You've hit your org's monthly spend limit · contact your admin",
    "You're out of extra usage · resets Dec 1",
  ])
    assert.equal(providerNotice(`${notice}\n`), notice, notice);
  for (const answer of [
    "You've hit your GitHub API rate limit, so I stopped the sweep.",
    "I checked the usage limit page: You've hit your session limit is what Claude prints.",
    "The Claude AI usage limit reached|1792000000 line comes from the legacy CLI.",
    "Done. Not logged in · Please run /login is what the user saw.",
  ])
    assert.equal(providerNotice(answer), undefined, answer);
});

// Synthetic Codex quota notices with a fixed calendar boundary.
const CODEX_LIMIT =
  "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at ";

for (const [zone, reset] of [
  ["Asia/Ho_Chi_Minh", "2026-11-13T21:19:00Z"],
  ["UTC", "2026-11-14T04:19:00Z"],
  ["America/New_York", "2026-11-14T09:19:00Z"],
]) {
  test(`Codex dated and clock-only resets use the host timezone (${zone})`, () => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      const at = Date.parse(reset);
      for (const phrase of ["Nov 14th, 2026 4:19 AM.", "4:19 AM."])
        assert.equal(quotaReset(CODEX_LIMIT + phrase, at - 2 * 3600000), at + MINUTE, phrase);
      assert.equal(
        quotaReset(
          "You've hit your session limit · resets 4:19am (Asia/Ho_Chi_Minh)",
          Date.parse("2026-11-13T19:00:00Z"),
        ),
        Date.parse("2026-11-13T21:20:00Z"),
        "Claude retains its explicit timezone regardless of the host",
      );
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

test("a Codex clock just past stays in its reset minute, while a later notice waits for tomorrow", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Asia/Ho_Chi_Minh";
  try {
    const at = Date.parse("2026-11-13T21:19:00Z");
    assert.equal(quotaReset(`${CODEX_LIMIT}4:19 AM.`, at + 30000), at + 90000);
    assert.equal(quotaReset(`${CODEX_LIMIT}4:19 AM.`, at + 6 * MINUTE), at + 86400000 + MINUTE);
    assert.equal(
      quotaReset(`${CODEX_LIMIT}12:00 AM.`, Date.parse("2026-12-31T16:50:00Z")),
      Date.parse("2026-12-31T17:01:00Z"),
      "midnight rolls into the next year in the host timezone",
    );
    assert.equal(
      quotaReset(`${CODEX_LIMIT}12:00 PM.`, Date.parse("2026-11-14T04:00:00Z")),
      Date.parse("2026-11-14T05:01:00Z"),
    );
    assert.equal(
      quotaReset(`${CODEX_LIMIT}Nov 14th, 2026 4:19 AM.`, at + 6 * MINUTE),
      at + 7 * MINUTE,
      "an explicit past date does not roll to tomorrow",
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("archived members' quota receipts do not hold the active harness", async () => {
  const f = await fixture();
  try {
    for (const harness of ["codex", "claude"]) {
      seat(f.store, "worker", "owner", null, "peer", harness);
      seat(f.store, "live-limit", "owner", null, "peer", harness);
      seat(f.store, "archived-limit", "owner", null, "peer", harness);
      const live = { until: f.now() + 3600000, messageId: null };
      const archived = { until: f.now() + 86400000, messageId: null };
      f.store.updateMember("live-limit", { limited: live });
      f.store.updateMember("archived-limit", { limited: archived, archivedAt: new Date().toISOString() });
      assert.equal(f.store.heldUntil("worker", f.now()), live.until);
      f.store.updateMember("live-limit", { archivedAt: new Date().toISOString() });
      assert.equal(f.store.heldUntil("worker", f.now()), null);
      assert.deepEqual(f.store.member("archived-limit")?.limited, archived, "retain the historical receipt");
      f.store.updateMember("archived-limit", { archivedAt: undefined });
      assert.equal(f.store.heldUntil("worker", f.now()), archived.until, "reopened members count again");
    }
  } finally {
    f.store.close();
  }
});

test("a provider limit is waited out until its stated reset, or half an hour when it states none", () => {
  const wait = (error: string) => {
    const until = quotaReset(error, NOW);
    return until === null ? null : until - NOW;
  };
  // The reset is stated.
  const epoch = NOW / 1000 + 3 * 3600;
  assert.equal(wait(`Claude AI usage limit reached|${epoch}`), 3 * 3600000 + MINUTE);
  assert.equal(
    wait("You have exhausted your capacity on this model. Your quota will reset after 1h0m0s."),
    61 * MINUTE,
  );
  assert.equal(
    wait(
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h43m29s.",
    ),
    (4 * 60 + 43) * MINUTE + 29000 + MINUTE,
  );
  assert.equal(wait("The usage limit has been reached (reset after 29m 43s)"), 29 * MINUTE + 43000 + MINUTE);
  assert.equal(
    wait(
      "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 18th, 2026 6:06 PM.",
    ),
    MINUTE,
    "a reset already past is retried in a minute",
  );
  // No time is stated: a model or budget limit is retried after half an hour.
  for (const error of [
    "You've reached your Fable limit. Switch to another model to continue.",
    "You’ve reached your Opus 5 limit",
    "You've hit your Mythos limit",
    "You've hit your org's monthly spend limit · contact your admin",
    "You're out of extra usage",
    "Your workspace is out of credits",
  ])
    assert.equal(wait(error), 30 * MINUTE, error);
  // Not a limit of the account, or no limit at all.
  for (const error of [
    "Server is temporarily limiting requests (not your usage limit) · Rate limited",
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    "Login expired · Please run /login",
  ])
    assert.equal(wait(error), null, error);
});
