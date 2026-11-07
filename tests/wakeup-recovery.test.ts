import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy } from "../server/autonomy";
import { AllianceRuntime } from "../server/runtime";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

/** Real hooks and durable state; native readback/send are controlled here, not a model run. */
async function fixture(
  phase: "review" | "blocked" = "review",
  maxRetries = 2,
  key = "check-build",
  repeat = false,
) {
  const home = await temporary("alliance-wake-recovery-");
  const store = new RoomStore(home);
  store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Recovery",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  for (const [id, role, parentId] of [
    ["supervisor", "supervisor", null],
    ["lead", "lead", "supervisor"],
  ] as const)
    store.saveMember({
      id,
      role,
      parentId,
      provider: `alliance-codex-${role}`,
      roomId: "room",
      assignment: "brief.md",
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      launchKey: null,
      launchHash: null,
    });
  let now = Date.now();
  let wakes = new Wakeups(store, () => now);
  const autonomy = new Autonomy(store, wakes, () => now);
  const runtime = new AllianceRuntime(home);
  runtime.store = store;
  runtime.autonomy = autonomy;
  const agent = {
    id: "lead",
    provider: "alliance-codex-lead",
    cwd: home,
    workspaceId: "w",
    parentAgentId: "supervisor",
    title: null,
  };
  const sent: { id: string; text: string; messageId: string }[] = [];
  let status = "idle";
  let ambiguous = false;
  let duringSend: (() => Promise<void>) | undefined;
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: { status: id === "lead" ? status : "idle", archivedAt: null, pendingPermissions: [] },
        }),
        send: async (text: string, options: { messageId: string }) => {
          sent.push({ id, text, messageId: options.messageId });
          await duringSend?.();
          if (ambiguous) throw new Error("connection lost before send acknowledgement");
        },
      }),
    },
  } as unknown as PaseoApi;
  autonomy.start("lead", { maxRetries });
  await runtime.startTurn(agent, "handback");
  autonomy.checkpoint("lead", phase, "Original handback", "handback");
  await runtime.endTurn(agent, "handback", { kind: "completed" }, [
    { type: "assistant_message", text: "Checked result ready." },
  ]);
  store.updateMember("lead", {
    decision: "accepted",
    decisionTurnId: "handback",
    decisionEvidence: "accepted.json",
    decisionAt: new Date(now).toISOString(),
  });
  const original = store.member("lead");
  wakes.add({
    key,
    roomId: "room",
    ownerId: "lead",
    reason: "Check the build",
    trigger: { kind: "time", at: now },
    ...(repeat ? { everyMs: 60000, maxRuns: 3 } : {}),
  });
  let turn = 0;
  const fail = async (options: { checkpoint?: boolean; canceled?: boolean; messageId?: string } = {}) => {
    const prompt = sent.findLast((s) => s.id === "lead");
    assert.ok(prompt);
    const id = `wake-${++turn}`;
    status = "running";
    await runtime.startTurn(agent, id);
    if (options.checkpoint) autonomy.checkpoint("lead", "review", "New handback", id);
    await runtime.endTurn(
      agent,
      id,
      options.canceled
        ? { kind: "canceled", reason: "Human canceled" }
        : { kind: "failed", error: { message: "stream disconnected before completion" } },
      [{ type: "user_message", text: prompt.text, clientMessageId: options.messageId ?? prompt.messageId }],
    );
    status = options.canceled ? "idle" : "error";
  };
  return {
    store,
    autonomy,
    original,
    api,
    sent,
    fail,
    wakes: () => wakes,
    reminder: () => wakes.list().find((w) => w.key === key),
    advance: (ms = 60000) => {
      now += ms;
    },
    status: (next: string) => {
      status = next;
    },
    ambiguous: () => {
      ambiguous = true;
    },
    duringSend: (callback: () => Promise<void>) => {
      duringSend = callback;
    },
    reloadWakes: () => {
      wakes = new Wakeups(store, () => now);
    },
  };
}

for (const phase of ["review", "blocked"] as const)
  test(`a failed wake retries its reminders while preserving the ${phase} handback and its decision`, async () => {
    const f = await fixture(phase);
    try {
      await f.wakes().tick(f.api);
      await f.fail();
      f.reloadWakes();
      f.advance();
      await f.wakes().tick(f.api);
      assert.equal(
        f.sent.filter((s) => s.id === "lead").length,
        2,
        "the failed reminder is retried, including from native error state",
      );
      assert.equal(f.autonomy.get("lead")?.phase, phase);
      assert.equal(f.autonomy.get("lead")?.retries, 0, "the previous assignment's budget is unchanged");
      for (const field of [
        "lastTurnId",
        "lastOutcome",
        "resultPath",
        "decision",
        "decisionTurnId",
        "decisionEvidence",
      ] as const)
        assert.equal(
          f.store.member("lead")?.[field],
          f.original?.[field],
          `${field} still belongs to the original handback`,
        );
      assert.equal(f.reminder()?.runs, 1, "a failed attempt does not consume a periodic run");
    } finally {
      f.store.close();
    }
  });

test("failed reminder recovery uses the owner's retry limit and escalates once after exhaustion", async () => {
  const f = await fixture("review", 1);
  try {
    await f.wakes().tick(f.api);
    await f.fail();
    f.advance();
    await f.wakes().tick(f.api);
    await f.fail();
    for (let n = 0; n < 5; n++) {
      f.advance();
      await f.wakes().tick(f.api);
    }
    assert.equal(f.sent.filter((s) => s.id === "lead").length, 2, "one retry, no unbounded resend");
    assert.equal(f.sent.filter((s) => s.id === "supervisor").length, 1, "its owner is asked once");
    assert.match(f.reminder()?.note ?? "", /failed.*1 retr/i);
    assert.equal(f.reminder()?.state, "delivered", "the unresolved task remains readable for reconciliation");
    assert.equal(f.store.member("lead")?.decision, "accepted");
  } finally {
    f.store.close();
  }
});

test("a failed turn before native send acknowledges is still recovered once", async () => {
  const f = await fixture();
  try {
    let first = true;
    f.duringSend(async () => {
      if (first) {
        first = false;
        await f.fail();
      }
    });
    await f.wakes().tick(f.api);
    f.advance();
    await f.wakes().tick(f.api);
    assert.equal(f.sent.filter((s) => s.id === "lead").length, 2);
  } finally {
    f.store.close();
  }
});

test("canceled reminders and a decided child's turn are never retried", async () => {
  const f = await fixture();
  try {
    f.store.saveMember({
      id: "peer",
      role: "peer",
      parentId: "lead",
      provider: "alliance-codex-peer",
      roomId: "room",
      assignment: "peer.md",
      decision: "open",
      decisionEvidence: null,
      lastTurnId: "peer-1",
      lastOutcome: "completed",
      resultPath: "peer-result.json",
      launchKey: null,
      launchHash: null,
    });
    f.wakes().add({
      key: "peer-review",
      roomId: "room",
      ownerId: "lead",
      reason: "Review peer",
      trigger: { kind: "turn", agentId: "peer", turnId: "peer-1" },
    });
    await f.wakes().tick(f.api);
    await f.fail();
    const w = f.reminder();
    assert.ok(w);
    f.wakes().action(w.key, w.ownerId, w.revision, "cancel");
    f.store.updateMember("peer", { decision: "rejected", decisionTurnId: "peer-1" });
    f.advance();
    await f.wakes().tick(f.api);
    assert.equal(f.sent.length, 1);
    assert.ok(
      f
        .wakes()
        .list()
        .every((w) => w.state === "canceled"),
    );
  } finally {
    f.store.close();
  }
});

test("an explicit pause holds failed reminder recovery until the owner resumes", async () => {
  const f = await fixture();
  try {
    await f.wakes().tick(f.api);
    await f.fail();
    f.autonomy.checkpoint("lead", "paused", "Human requested a pause");
    f.advance();
    await f.wakes().tick(f.api);
    assert.equal(f.sent.length, 1);
    f.autonomy.start("lead");
    await f.wakes().tick(f.api);
    assert.equal(f.sent.length, 2);
  } finally {
    f.store.close();
  }
});

test("failure notices exhaust locally instead of generating an escalation loop", async () => {
  const f = await fixture("review", 0, "wake-failed-earlier-batch");
  try {
    await f.wakes().tick(f.api);
    await f.fail();
    for (let n = 0; n < 5; n++) {
      f.advance();
      await f.wakes().tick(f.api);
    }
    assert.equal(f.sent.length, 1);
    assert.match(f.reminder()?.note ?? "", /failed.*0 retr/i);
    assert.equal(f.wakes().list().length, 1);
  } finally {
    f.store.close();
  }
});

for (const action of ["ack", "defer"] as const)
  test(`an owner's ${action} settles the failed occurrence before its next scheduled delivery`, async () => {
    const f = await fixture("review", 2, "periodic-build-check", true);
    try {
      await f.wakes().tick(f.api);
      await f.fail();
      const w = f.reminder();
      assert.ok(w);
      f.wakes().action(w.key, w.ownerId, w.revision, action, undefined, 1);
      f.status("idle");
      for (let n = 0; n < 4; n++) {
        f.advance();
        await f.wakes().tick(f.api);
      }
      assert.equal(
        f.sent.length,
        2,
        "only the next occurrence is delivered; the old failure cannot replay it",
      );
    } finally {
      f.store.close();
    }
  });

for (const guard of ["canceled", "checkpoint", "different-prompt", "acknowledged", "uncertain"] as const)
  test(`failed reminder recovery does not bypass ${guard}`, async () => {
    const f = await fixture();
    try {
      if (guard === "uncertain") f.ambiguous();
      await f.wakes().tick(f.api);
      if (guard === "acknowledged") {
        const w = f.reminder();
        assert.ok(w);
        f.wakes().action(w.key, w.ownerId, w.revision, "ack");
      }
      await f.fail({
        canceled: guard === "canceled",
        checkpoint: guard === "checkpoint",
        messageId: guard === "different-prompt" ? "not-the-batch" : undefined,
      });
      f.status("idle");
      for (let n = 0; n < 5; n++) {
        f.advance();
        await f.wakes().tick(f.api);
      }
      assert.equal(f.sent.filter((s) => s.id === "lead").length, 1);
    } finally {
      f.store.close();
    }
  });
