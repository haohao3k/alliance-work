import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy } from "../server/autonomy";
import { authorizeDecision, Lifecycle, REMINDERS_PER_SCAN, STALE_DECISION_MS } from "../server/lifecycle";
import { type MemberRecord, newTurn, RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import type { RoleName } from "../shared/contracts";
import type { WakeRecordValue } from "../shared/wakeups";
import { temporary } from "./temp";

type Agent = { status: string; archived: boolean; permissions: number; parent?: string };

/** Room with Human → supervisor → lead → peer, plus a sibling peer, on a fake native runtime. */
async function fleet() {
  const home = await temporary("alliance-lifecycle-");
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
  const shape: [string, RoleName, string | null][] = [
    ["sup", "supervisor", null],
    ["lead", "lead", "sup"],
    ["peer", "peer", "lead"],
    ["sibling", "peer", "lead"],
  ];
  const agents = new Map<string, Agent>();
  for (const [id, role, parentId] of shape) {
    store.saveMember({
      id,
      roomId: "room",
      role,
      provider: `alliance-codex-${role}`,
      parentId,
      assignment: "brief.md",
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      lastTurnId: null,
      launchKey: null,
      launchHash: null,
    });
    agents.set(id, { status: "idle", archived: false, permissions: 0, parent: parentId ?? undefined });
  }
  let now = 1_000_000;
  let onRefresh: (id: string) => void = () => {};
  const archived: string[] = [];
  const sent: string[] = [];
  const texts: { id: string; text: string }[] = [];
  const api = {
    agents: {
      list: async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
        entries: [...agents.entries()]
          .filter(([, a]) => !a.archived && a.parent === filter.labels["paseo.parent-agent-id"])
          .map(([id, a]) => ({ agent: { id, status: a.status } })),
      }),
      ref: (id: string) => ({
        refresh: async () => {
          onRefresh(id);
          const a = agents.get(id);
          if (!a) return null;
          return {
            agent: {
              status: a.status,
              archivedAt: a.archived ? "archived" : null,
              pendingPermissions: Array.from({ length: a.permissions }, () => ({})),
            },
          };
        },
        archive: async () => {
          const a = agents.get(id);
          if (a) a.archived = true;
          archived.push(id);
          return { archivedAt: "archived" };
        },
        send: async (text: string) => {
          sent.push(id);
          texts.push({ id, text });
        },
      }),
    },
  } as unknown as PaseoApi;
  const wakes = new Wakeups(store, () => now);
  const autonomy = new Autonomy(store, wakes, () => now);
  const lifecycle = new Lifecycle(store, wakes, autonomy, () => now);
  /**
   * A native turn as the runtime's hooks record it: started, then ended. One that keeps the phase
   * it found leaves the member's handback standing unless it ends as new work.
   */
  const begin = (id: string, turnId: string, a = autonomy) => {
    a.started(id, turnId);
    if (!a.carrying(id)) store.updateMember(id, newTurn(turnId));
  };
  const finish = (id: string, turnId: string, outcome = "completed", a = autonomy, error?: string) => {
    const carried = a.carrying(id);
    const result = { lastOutcome: outcome, resultPath: join(home, `${turnId}.json`), lastTurnEndedAt: now };
    if (!carried) store.updateMember(id, result);
    a.ended(id, turnId, outcome, error);
    if (carried && !a.carrying(id)) store.updateMember(id, { ...newTurn(turnId), ...result });
  };
  /** `alliance-work wait` run by `self` in its session, against the RPCs the plugin serves. */
  const wait = async (
    self: string,
    request: { reason: string; agent?: string; minutes?: string },
    say: (line: string) => void = () => {},
  ) => {
    const { registerWait } = await import("../scripts/wait.mjs");
    // biome-ignore lint/suspicious/noExplicitAny: RPC inputs are validated by the plugin
    const rpc = async (method: string, input: any) => {
      if (method === "wakeups.add") return wakes.add(input);
      if (method === "wakeups.list") return wakes.list();
      if (method === "autonomy.list") return autonomy.list();
      if (method === "autonomy.checkpoint")
        return autonomy.checkpoint(input.agentId, input.phase, input.reason, input.turnId);
      if (method === "rooms.list") return { members: store.members() };
      throw new Error(`Unexpected RPC ${method}`);
    };
    return registerWait(rpc, { roomId: "room", ownerId: self, self, ...request }, say);
  };
  /** Record a completed turn and an acceptance the way the runtime does. */
  const accept = (id: string, by: string | null, scope: "technical" | "product" = "technical") => {
    authorizeDecision(store, id, by);
    store.updateMember(id, {
      lastTurnId: `${id}-t`,
      lastOutcome: "completed",
      decision: "accepted",
      decisionEvidence: join(home, `${id}-disposition.json`),
      decisionBy: by,
      decisionAt: new Date(now).toISOString(),
      decisionScope: scope,
    });
  };
  return {
    store,
    home,
    agents,
    api,
    wakes,
    autonomy,
    lifecycle,
    accept,
    archived,
    sent,
    texts,
    begin,
    finish,
    wait,
    now: () => now,
    /** The first lines of the prompts this agent received. */
    heads: (id: string) => texts.filter((t) => t.id === id).map((t) => t.text.split("\n", 1)[0]),
    sweep: () => lifecycle.sweep(api),
    onRefresh: (fn: (id: string) => void) => {
      onRefresh = fn;
    },
    advance: (ms: number) => {
      now += ms;
    },
    member: (id: string) => store.member(id) as MemberRecord,
  };
}

test("only the responsible owner chain or the Human may decide; an agent never accepts itself", async () => {
  const f = await fleet();
  try {
    assert.throws(() => authorizeDecision(f.store, "peer", "peer"), /own work/);
    assert.throws(() => authorizeDecision(f.store, "peer", "sibling"), /owner chain/);
    assert.throws(
      () => authorizeDecision(f.store, "lead", "peer"),
      /owner chain/,
      "a child cannot accept its owner",
    );
    assert.throws(() => authorizeDecision(f.store, "peer", "nobody"), /Unknown deciding agent/);
    authorizeDecision(f.store, "peer", "lead");
    authorizeDecision(f.store, "peer", "sup");
    authorizeDecision(f.store, "peer", null);
    authorizeDecision(f.store, "sup", null);
    assert.throws(() => authorizeDecision(f.store, "sup", "lead"), /owner chain/);
  } finally {
    f.store.close();
  }
});

test("an accepted peer is archived; a lead needs product acceptance from its owner or the Human", async () => {
  const f = await fleet();
  try {
    f.accept("peer", "lead");
    f.accept("sibling", "lead");
    await f.sweep();
    assert.deepEqual(f.archived.sort(), ["peer", "sibling"]);

    f.accept("lead", "sup", "technical");
    await f.sweep();
    assert.ok(!f.archived.includes("lead"), "a technical PASS does not prove the Human's outcome");
    const view = await f.lifecycle.describe(
      f.member("lead"),
      { status: "idle", archived: false, permissions: 0 },
      new Map(),
    );
    assert.equal(view.state, "held");
    assert.match(view.blockers.join("\n"), /product acceptance/);

    f.accept("lead", "sup", "product");
    await f.sweep();
    assert.ok(f.archived.includes("lead"));

    f.accept("sup", null, "technical");
    await f.sweep();
    assert.ok(f.archived.includes("sup"), "the Human's decision is final for any role");
  } finally {
    f.store.close();
  }
});

test("legacy acceptances without autonomy records archive by role and recorded product scope", async () => {
  const f = await fleet();
  try {
    // Decisions recorded by v0.1.15: no decisionBy/decisionScope, only the disposition file.
    for (const [id, product] of [
      ["peer", false],
      ["sibling", true],
    ] as const) {
      const path = join(f.home, `${id}.json`);
      await writeFile(
        path,
        JSON.stringify({ agentId: id, decision: "accepted", ...(product ? { product: {} } : {}) }),
      );
      f.store.updateMember(id, {
        lastTurnId: "t",
        lastOutcome: "completed",
        decision: "accepted",
        decisionEvidence: path,
      });
    }
    const leadEvidence = join(f.home, "lead.json");
    await writeFile(leadEvidence, JSON.stringify({ agentId: "lead", decision: "accepted" }));
    f.store.updateMember("lead", {
      lastTurnId: "t",
      lastOutcome: "completed",
      decision: "accepted",
      decisionEvidence: leadEvidence,
    });
    await f.sweep();
    await f.sweep();
    assert.deepEqual(f.archived.sort(), ["peer", "sibling"]);
    assert.equal(f.member("lead").decisionScope, "technical");
    await writeFile(
      leadEvidence,
      JSON.stringify({ agentId: "lead", decision: "accepted", product: { outcome: "x" } }),
    );
    await f.sweep();
    assert.ok(!f.archived.includes("lead"), "a scope read once is not re-derived from a changed file");
  } finally {
    f.store.close();
  }
});

test("a resumed turn lifts a cancellation pause; only acceptance after the pause closes it", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer");
    f.autonomy.started("peer", "t1");
    f.store.updateMember("peer", { lastTurnId: "t1", lastOutcome: "canceled" });
    f.autonomy.ended("peer", "t1", "canceled");
    assert.equal(f.autonomy.get("peer")?.pausedBy, "cancel");
    f.autonomy.started("peer", "t2");
    assert.equal(f.autonomy.get("peer")?.phase, "active", "sending work after a cancel resumes it");

    f.accept("peer", "lead");
    f.advance(1000);
    f.autonomy.ended("peer", "t2", "canceled");
    await f.sweep();
    assert.ok(!f.archived.includes("peer"), "acceptance before the cancel does not cover it");
    f.advance(1000);
    f.accept("peer", "lead");
    await f.sweep();
    assert.ok(f.archived.includes("peer"));

    f.autonomy.start("sibling");
    f.autonomy.checkpoint("sibling", "paused", "Keep for follow-up");
    f.advance(1000);
    f.accept("sibling", "lead");
    await f.sweep();
    assert.ok(!f.archived.includes("sibling"), "a deliberate checkpoint pause holds even after acceptance");
    f.autonomy.started("sibling", "t3");
    assert.equal(f.autonomy.get("sibling")?.phase, "paused", "only cancellations resume on a new turn");
  } finally {
    f.store.close();
  }
});

test("records from before pause provenance treat the canceled reason as a cancellation", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer");
    const r = f.autonomy.get("peer");
    assert.ok(r);
    f.store.saveAutonomy(
      { ...r, phase: "paused", reason: "Turn canceled; explicit resume required", revision: r.revision + 1 },
      r.revision,
    );
    f.autonomy.started("peer", "t9");
    assert.equal(f.autonomy.get("peer")?.phase, "active");
  } finally {
    f.store.close();
  }
});

test("archived unaccepted children stop blocking a parent; live unaccepted children still block", async () => {
  const f = await fleet();
  try {
    f.accept("lead", "sup", "product");
    f.accept("peer", "lead");
    await f.sweep();
    assert.deepEqual(f.archived, ["peer"]);
    assert.ok(!f.archived.includes("lead"), "sibling is alive and not accepted");
    const held = await f.lifecycle.describe(
      f.member("lead"),
      { status: "idle", archived: false, permissions: 0 },
      new Map(),
    );
    assert.match(held.blockers.join("\n"), /child sibling/);
    (f.agents.get("sibling") as Agent).archived = true;
    await f.sweep();
    assert.ok(f.archived.includes("lead"), "an abandoned child archived natively is resolved");
  } finally {
    f.store.close();
  }
});

test("running work, pending wakeups and permissions hold an accepted agent open; a closed one is at rest", async () => {
  const f = await fleet();
  try {
    f.accept("peer", "lead");
    (f.agents.get("peer") as Agent).status = "running";
    await f.sweep();
    (f.agents.get("peer") as Agent).status = "idle";
    (f.agents.get("peer") as Agent).permissions = 1;
    await f.sweep();
    (f.agents.get("peer") as Agent).permissions = 0;
    f.wakes.add({
      key: "own-reminder",
      roomId: "room",
      ownerId: "peer",
      reason: "check job",
      trigger: { kind: "time", at: 1_000_000 },
    });
    await f.sweep();
    assert.deepEqual(f.archived, []);
    await f.wakes.take("peer");
    const w = f.wakes.list()[0];
    await f.wakes.action(w.key, "peer", w.revision, "ack");
    await f.sweep();
    assert.deepEqual(f.archived, ["peer"]);
    // Paseo reports every session closed after a daemon restart; that is not running work.
    f.accept("sibling", "lead");
    (f.agents.get("sibling") as Agent).status = "closed";
    await f.sweep();
    assert.deepEqual(f.archived, ["peer", "sibling"]);
  } finally {
    f.store.close();
  }
});

test("a completed handback left undecided for 48h wakes its owner once; Human-owned work is not prompted", async () => {
  const f = await fleet();
  try {
    f.store.updateMember("peer", { lastTurnId: "p1", lastOutcome: "completed", lastTurnEndedAt: 1_000_000 });
    f.store.updateMember("sup", { lastTurnId: "s1", lastOutcome: "completed", lastTurnEndedAt: 1_000_000 });
    await f.sweep();
    assert.equal(f.wakes.list().length, 0);
    f.advance(STALE_DECISION_MS);
    await f.sweep();
    let reminders = f.wakes.list();
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].ownerId, "lead");
    assert.equal(reminders[0].delivery, "idle");
    f.advance(20 * 60000);
    await f.sweep();
    assert.equal(f.wakes.list().length, 1, "one reminder per undecided turn");
    f.store.updateMember("peer", { lastTurnId: "p2", lastOutcome: "completed", lastTurnEndedAt: 1_000_000 });
    f.advance(20 * 60000);
    await f.sweep();
    reminders = f.wakes.list();
    assert.equal(reminders.length, 2, "a new undecided turn gets its own reminder");
    assert.ok(
      reminders.every((w) => w.ownerId === "lead"),
      "the Human-owned supervisor is never prompted",
    );
  } finally {
    f.store.close();
  }
});

test("owned members get an assignment; a recent handback wakes the nearest live owner, an older one the 48h reminder", async () => {
  const f = await fleet();
  try {
    // The lead was archived before deciding; its children's handbacks go up to the supervisor.
    f.store.updateMember("lead", { archivedAt: "archived" });
    (f.agents.get("lead") as Agent).archived = true;
    const handback = (id: string, endedAt: number) =>
      f.store.updateMember(id, {
        lastTurnId: `${id}-t`,
        lastOutcome: "completed",
        resultPath: "r.json",
        lastTurnEndedAt: endedAt,
      });
    handback("peer", 1_000_000);
    handback("sibling", 1_000_000 - STALE_DECISION_MS);
    handback("sup", 1_000_000);
    await f.autonomy.tick(f.api);
    const phase = (id: string) => f.autonomy.get(id)?.phase;
    assert.equal(phase("peer"), "review", "a recent undecided handback is put up for review");
    assert.equal(phase("sibling"), "waiting", "an older one is left to the 48h reminder");
    assert.equal(phase("sup"), undefined, "Human-owned work gets no assignment");
    assert.equal(phase("lead"), undefined, "an archived member is left alone");
    f.advance(120000);
    await f.autonomy.tick(f.api);
    await f.wakes.tick(f.api);
    await f.sweep();
    f.advance(60000);
    await f.autonomy.tick(f.api);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["sup", "sup"], "one review and one 48h reminder, both to the supervisor");
    assert.deepEqual(
      f.wakes.list().map((w) => [w.ownerId, w.trigger.kind === "turn" && w.trigger.agentId]),
      [
        ["sup", "peer"],
        ["sup", "sibling"],
      ],
    );
  } finally {
    f.store.close();
  }
});

test("a review sent over 48 hours ago and still undecided is asked again once", async () => {
  const f = await fleet();
  try {
    f.store.updateMember("peer", {
      lastTurnId: "p1",
      lastOutcome: "completed",
      resultPath: "r.json",
      lastTurnEndedAt: 1_000_000 - 3600000,
    });
    f.wakes.add({
      key: "review-peer",
      roomId: "room",
      ownerId: "lead",
      reason: "Review peer",
      trigger: { kind: "turn", agentId: "peer", turnId: "p1" },
      delivery: "idle",
    });
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead"]);
    (f.agents.get("peer") as Agent).status = "closed"; // the daemon restarted since
    const stale = () => f.wakes.list().filter((w) => w.key.startsWith("stale-decision-"));
    f.advance(STALE_DECISION_MS - 3600000);
    await f.sweep();
    assert.equal(stale().length, 0, "a review sent less than 48h ago still stands");
    f.advance(70 * 60000);
    await f.sweep();
    assert.equal(stale().length, 1, "the unsettled review is asked again");
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead", "lead"]);
    f.advance(10 * 60000);
    await f.sweep();
    assert.equal(stale().length, 1, "once per turn and owner");
  } finally {
    f.store.close();
  }
});

test("members recorded before turn end times start their stale clock at the first scan", async () => {
  const f = await fleet();
  try {
    f.store.updateMember("peer", { lastTurnId: "old", lastOutcome: "completed" });
    f.advance(30 * 86400000);
    await f.sweep();
    assert.equal(f.wakes.list().length, 0, "no burst of reminders for old work on upgrade");
    const since = f.member("peer").staleSince ?? 0;
    assert.ok(since > 1_000_000 + 30 * 86400000 - 1, "baselines start now, spread over a day");
    f.advance(since - (1_000_000 + 30 * 86400000) + STALE_DECISION_MS);
    await f.sweep();
    assert.equal(f.wakes.list().length, 1);
  } finally {
    f.store.close();
  }
});

test("a decision recorded against an older turn, or kept open, does not archive", async () => {
  const f = await fleet();
  try {
    f.accept("peer", "lead");
    f.store.updateMember("peer", { decisionTurnId: "peer-t", lastTurnId: "peer-t2" });
    f.accept("sibling", "lead");
    f.store.updateMember("sibling", { keep: { by: "lead", at: "now" } });
    await f.sweep();
    assert.deepEqual(f.archived, []);
    const view = await f.lifecycle.describe(
      f.member("peer"),
      { status: "idle", archived: false, permissions: 0 },
      new Map(),
    );
    assert.match(view.blockers.join("\n"), /newer turn/);
    f.store.updateMember("sibling", { keep: undefined });
    await f.sweep();
    assert.deepEqual(f.archived, ["sibling"]);
  } finally {
    f.store.close();
  }
});

test("an agent restored after an earlier auto-archive stays open until new work or a new decision", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer");
    f.accept("peer", "lead");
    f.autonomy.markArchived("peer"); // archived by 0.1.15, then restored natively by the Human
    await f.sweep();
    assert.deepEqual(f.archived, []);
    f.autonomy.started("peer", "peer-t2");
    f.store.updateMember("peer", { lastOutcome: "completed" });
    f.accept("peer", "lead");
    f.store.updateMember("peer", { lastTurnId: "peer-t2", decisionTurnId: "peer-t2" });
    await f.sweep();
    assert.deepEqual(f.archived, ["peer"]);
  } finally {
    f.store.close();
  }
});

test("a pause recorded while the sweep reads children wins over the archive", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("lead");
    f.accept("lead", "sup", "product");
    for (const child of ["peer", "sibling"]) (f.agents.get(child) as Agent).archived = true;
    f.onRefresh((id) => {
      if (id === "peer") f.autonomy.checkpoint("lead", "paused", "Human keeps the lead");
    });
    await f.sweep();
    assert.ok(!f.archived.includes("lead"));
  } finally {
    f.store.close();
  }
});

test("a natively deleted child no longer holds its parent; a non-member native parent may decide", async () => {
  const f = await fleet();
  try {
    f.accept("lead", "sup", "product");
    f.accept("peer", "lead");
    f.agents.delete("sibling");
    await f.sweep();
    await f.sweep();
    assert.ok(f.archived.includes("lead"), "deleted child is resolved");
    assert.ok(f.member("sibling").archivedAt);
    f.store.updateMember("sup", { parentId: "plain-paseo-agent" });
    authorizeDecision(f.store, "sup", "plain-paseo-agent");
    assert.throws(() => authorizeDecision(f.store, "sup", "stranger"), /Unknown deciding agent/);
  } finally {
    f.store.close();
  }
});

test("restarting an assignment keeps an earlier auto-archive opt-out", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer", { autoArchive: false });
    f.autonomy.checkpoint("peer", "paused", "hold");
    f.autonomy.start("peer", { autoArchive: undefined });
    assert.equal(f.autonomy.get("peer")?.autoArchive, false);
    assert.equal(f.autonomy.get("peer")?.pausedBy, undefined, "leaving a pause clears its provenance");
  } finally {
    f.store.close();
  }
});

test("plugin reminders never resume an owner the Human cancelled or that paused itself; a cancelled one waits for pull", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("lead");
    f.autonomy.started("lead", "lead-t1");
    f.autonomy.ended("lead", "lead-t1", "canceled");
    f.store.updateMember("peer", { lastTurnId: "p1", lastOutcome: "completed", resultPath: "r.json" });
    f.wakes.add({
      key: "review-peer",
      roomId: "room",
      ownerId: "lead",
      reason: "review",
      trigger: { kind: "turn", agentId: "peer", turnId: "p1" },
      delivery: "idle",
    });
    await f.wakes.tick(f.api);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, []);
    assert.equal(f.autonomy.get("lead")?.phase, "paused");
    f.autonomy.started("lead", "lead-t2"); // the Human resumes the lead
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead"]);
    // An owner that paused itself still hears of its children's handbacks; the turn that reads
    // them keeps the pause.
    f.autonomy.checkpoint("lead", "paused", "Waiting for the Human");
    f.store.updateMember("sibling", { lastTurnId: "s1", lastOutcome: "completed", resultPath: "r.json" });
    f.wakes.add({
      key: "review-sibling",
      roomId: "room",
      ownerId: "lead",
      reason: "review",
      trigger: { kind: "turn", agentId: "sibling", turnId: "s1" },
      delivery: "idle",
    });
    f.advance(60000);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead", "lead"]);
    f.autonomy.started("lead", "lead-t3");
    assert.equal(f.autonomy.get("lead")?.phase, "paused");
  } finally {
    f.store.close();
  }
});

test("an archived owner's reminders end, its reviews too: none moves up the chain", async () => {
  const f = await fleet();
  try {
    f.store.updateMember("peer", { lastTurnId: "p1", lastOutcome: "completed", resultPath: "r.json" });
    const add = (key: string, trigger: WakeRecordValue["trigger"]) =>
      f.wakes.add({ key, roomId: "room", ownerId: "lead", reason: key, trigger, delivery: "idle" });
    add("review-peer", { kind: "turn", agentId: "peer", turnId: "p1" });
    add("lead-timer", { kind: "time", at: 1_000_000 });
    (f.agents.get("lead") as Agent).archived = true; // archived natively; seen at delivery
    await f.wakes.tick(f.api);
    await f.wakes.tick(f.api);
    const state = (key: string) => f.wakes.list().find((w) => w.key === key)?.state;
    assert.equal(state("lead-timer"), "canceled");
    assert.equal(state("review-peer"), "canceled");
    assert.deepEqual(
      f.wakes.list().filter((w) => w.ownerId !== "lead"),
      [],
      "nothing is moved to the supervisor",
    );
    assert.deepEqual(f.sent, [], "the archived owner is never sent");
  } finally {
    f.store.close();
  }
});

test("an archive seen by the assignment sweep also ends the agent's pull reminders", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer");
    f.wakes.add({
      key: "peer-check",
      roomId: "room",
      ownerId: "peer",
      reason: "Check the build",
      trigger: { kind: "time", at: 1_000_000 },
      delivery: "pull",
    });
    (f.agents.get("peer") as Agent).archived = true; // the archive event was missed
    await f.autonomy.tick(f.api);
    await f.wakes.tick(f.api);
    assert.ok(f.member("peer").archivedAt);
    assert.equal(f.wakes.list()[0].state, "canceled");
  } finally {
    f.store.close();
  }
});

test("stale reminders skip turns with an open review, follow the current owner and are capped per scan", async () => {
  const f = await fleet();
  try {
    for (let n = 0; n < REMINDERS_PER_SCAN + 3; n++) {
      const id = `extra-${n}`;
      f.store.saveMember({
        id,
        roomId: "room",
        role: "peer",
        provider: "alliance-codex-peer",
        parentId: "lead",
        assignment: "a",
        decision: "open",
        decisionEvidence: null,
        lastOutcome: "completed",
        resultPath: "r.json",
        lastTurnId: `${id}-t`,
        lastTurnEndedAt: 1_000_000,
        launchKey: null,
        launchHash: null,
      });
      f.agents.set(id, { status: "idle", archived: false, permissions: 0, parent: "lead" });
    }
    f.wakes.add({
      key: "auto-review-extra-0",
      roomId: "room",
      ownerId: "lead",
      reason: "review",
      trigger: { kind: "turn", agentId: "extra-0", turnId: "extra-0-t" },
      delivery: "idle",
    });
    f.advance(STALE_DECISION_MS);
    await f.sweep();
    const stale = () => f.wakes.list().filter((w) => w.key.startsWith("stale-decision-"));
    assert.equal(stale().length, REMINDERS_PER_SCAN, "bounded per scan");
    assert.ok(!stale().some((w) => w.trigger.kind === "turn" && w.trigger.agentId === "extra-0"));
    f.advance(10 * 60000);
    await f.sweep();
    assert.equal(stale().length, REMINDERS_PER_SCAN + 2, "the rest follow on the next scan");
    const before = stale().length;
    f.store.updateMember("extra-6", { parentId: "sup" });
    f.advance(10 * 60000);
    await f.sweep();
    assert.ok(
      stale().length === before + 1 && stale().some((w) => w.ownerId === "sup"),
      "a new owner gets its own reminder",
    );
  } finally {
    f.store.close();
  }
});

test("a 0.1.15 cancel record whose agent kept working does not hold reminders", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("lead");
    const r = f.autonomy.get("lead");
    assert.ok(r);
    // 0.1.15 kept the cancel reason after later turns replaced the outcome.
    f.store.saveAutonomy(
      {
        ...r,
        phase: "paused",
        reason: "Turn canceled; explicit resume required",
        outcome: "completed",
        revision: r.revision + 1,
      },
      r.revision,
    );
    f.store.updateMember("peer", { lastTurnId: "p1", lastOutcome: "completed", resultPath: "r.json" });
    f.wakes.add({
      key: "review",
      roomId: "room",
      ownerId: "lead",
      reason: "review",
      trigger: { kind: "turn", agentId: "peer", turnId: "p1" },
      delivery: "idle",
    });
    await f.wakes.tick(f.api);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead"]);
  } finally {
    f.store.close();
  }
});

test("new work reported by Paseo after a decision holds the archive even if its turn hook was lost", async () => {
  const f = await fleet();
  try {
    f.accept("peer", "lead");
    const decided = Date.parse(f.member("peer").decisionAt ?? "");
    const real = f.api.agents.ref;
    (f.api.agents as { ref: unknown }).ref = (id: string) => {
      const handle = real(id);
      return {
        ...handle,
        refresh: async () => {
          const state = await handle.refresh();
          return (
            state && { agent: { ...state.agent, lastUserMessageAt: new Date(decided + 1000).toISOString() } }
          );
        },
      };
    };
    await f.sweep();
    assert.deepEqual(f.archived, []);
  } finally {
    f.store.close();
  }
});

test("a decision recorded after an earlier archive releases a restored agent", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer");
    f.autonomy.markArchived("peer");
    f.advance(1000);
    f.accept("peer", "lead");
    await f.sweep();
    assert.deepEqual(f.archived, ["peer"]);
  } finally {
    f.store.close();
  }
});

test("leaving a pause by archive clears its provenance; restarts keep recorded budgets", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("peer", { maxContinuations: 60, maxRetries: 4 });
    f.autonomy.checkpoint("peer", "paused", "hold");
    f.autonomy.markArchived("peer");
    assert.equal(f.autonomy.get("peer")?.pausedBy, undefined);
    assert.equal(f.autonomy.get("peer")?.pausedAt, undefined);
    f.autonomy.start("sibling", { maxContinuations: 60, maxRetries: 4 });
    f.autonomy.checkpoint("sibling", "paused", "hold");
    f.autonomy.start("sibling", {});
    assert.equal(f.autonomy.get("sibling")?.maxContinuations, 60);
    assert.equal(f.autonomy.get("sibling")?.maxRetries, 4);
  } finally {
    f.store.close();
  }
});

test("legacy stale baselines differ per member and a former owner's reminder is cancelled", async () => {
  const f = await fleet();
  try {
    for (const id of ["peer", "sibling"])
      f.store.updateMember(id, { lastTurnId: `${id}-old`, lastOutcome: "completed" });
    await f.sweep();
    const a = f.member("peer").staleSince ?? 0,
      b = f.member("sibling").staleSince ?? 0;
    assert.notEqual(a, b, "baselines are spread, not identical");
    assert.ok(a >= 1_000_000 && b >= 1_000_000);
    f.advance(Math.max(a, b) - 1_000_000 + STALE_DECISION_MS);
    await f.sweep();
    const old = f.wakes.list().find((w) => w.trigger.kind === "turn" && w.trigger.agentId === "peer");
    assert.equal(old?.ownerId, "lead");
    f.store.updateMember("peer", { parentId: "sup" });
    f.advance(10 * 60000);
    await f.sweep();
    assert.equal(f.wakes.list().find((w) => w.key === old?.key)?.state, "canceled");
  } finally {
    f.store.close();
  }
});

test("a blocked lead woken by its child's review keeps its block and is not continued, also across a plugin reload", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("lead");
    f.begin("lead", "l1");
    f.autonomy.checkpoint("lead", "blocked", "Needs the Human's decision D10", "l1");
    f.finish("lead", "l1");
    f.autonomy.start("peer");
    f.begin("peer", "p1");
    f.autonomy.checkpoint("peer", "review", "Report saved", "p1");
    f.finish("peer", "p1");
    await f.autonomy.tick(f.api);
    f.advance(120000); // past the review's grace
    await f.wakes.tick(f.api);
    assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
    // The batch starts the lead's turn; the plugin reloaded in between.
    const reloaded = new Autonomy(f.store, f.wakes, f.now);
    f.begin("lead", "l2", reloaded);
    assert.equal(reloaded.get("lead")?.phase, "blocked");
    assert.equal(reloaded.get("lead")?.reason, "Needs the Human's decision D10");
    f.finish("lead", "l2", "completed", reloaded);
    for (let n = 0; n < 4; n++) {
      f.advance(60000);
      await reloaded.tick(f.api);
      await f.wakes.tick(f.api);
    }
    assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"], "never continued");
    assert.equal(reloaded.get("lead")?.phase, "blocked");
  } finally {
    f.store.close();
  }
});

test("a coordinator's turn that only reads a wake batch is not its handback; a turn it is sent otherwise is", async () => {
  const f = await fleet();
  try {
    await f.autonomy.tick(f.api); // the owned lead gets a handback-only record
    assert.equal(f.autonomy.get("lead")?.handbackOnly, true);
    f.advance(10 * 60000); // its never-run children no longer count as just created
    f.autonomy.start("peer");
    f.begin("peer", "p1");
    f.autonomy.checkpoint("peer", "review", "Report saved", "p1");
    f.finish("peer", "p1");
    await f.autonomy.tick(f.api);
    f.advance(120000);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
    const asksSup = () => f.wakes.list().filter((w) => w.ownerId === "sup").length;
    f.begin("lead", "l1");
    f.finish("lead", "l1");
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("lead")?.phase, "waiting", "reading the review was not its handback");
    assert.equal(asksSup(), 0);
    f.begin("lead", "l2"); // the Human's own message
    f.finish("lead", "l2");
    await f.autonomy.tick(f.api);
    assert.equal(f.autonomy.get("lead")?.phase, "review");
    assert.equal(asksSup(), 1);
  } finally {
    f.store.close();
  }
});

/** A waiting lead's own reminder is pushed at `at`, and the turn that batch starts ends as given. */
async function batchTurnEnds(at: number, outcome: string, error?: string) {
  const f = await fleet();
  f.advance(at - 5 * 60000 - f.now());
  f.autonomy.start("lead");
  f.begin("lead", "l1");
  // What `alliance-work wait --minutes 5` records: an idle time reminder, then waiting.
  f.wakes.add({
    key: "wait-l1",
    roomId: "room",
    ownerId: "lead",
    reason: "Check the release build",
    trigger: { kind: "time", at: f.now() + 5 * 60000 },
    delivery: "idle",
  });
  f.autonomy.checkpoint("lead", "waiting", "Waiting on wait-l1: Check the release build", "l1");
  f.finish("lead", "l1");
  f.advance(5 * 60000);
  await f.wakes.tick(f.api);
  assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
  f.begin("lead", "l2"); // the batch's turn ends at once
  f.finish("lead", "l2", outcome, f.autonomy, error);
  return {
    ...f,
    rounds: async (n: number, ms: number) => {
      for (let i = 0; i < n; i++) {
        f.advance(ms);
        await f.autonomy.tick(f.api);
        await f.wakes.tick(f.api);
      }
    },
    retries: () => f.heads("lead").filter((head) => head.startsWith("Alliance retry")).length,
  };
}

test("a waiting lead whose wake batch's turn fails with a provider error is retried within minutes", async () => {
  const f = await batchTurnEnds(1_000_000 + 5 * 60000, "failed", "stream disconnected before completion");
  try {
    await f.rounds(4, 60000);
    assert.equal(f.retries(), 1, "retried within minutes");
    assert.deepEqual(f.heads("sup"), [], "a brief failure is not news for its owner");
  } finally {
    f.store.close();
  }
});

test("a waiting lead whose wake batch's turn ends on a provider limit keeps waiting and is not retried", async () => {
  // ryzen, 2026-10-21: the plugin pushed a review to Lead 5e3d3284 at 14:17:20Z; that turn
  // (foreground-turn-10) completed at 14:17:21Z on this notice, which the runtime reports as a
  // failure with that text. Wakeups sends such a batch again after the reset.
  const f = await batchTurnEnds(
    Date.parse("2026-10-21T14:17:21Z"),
    "failed",
    "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)",
  );
  try {
    await f.rounds(30, 60000); // to 14:47Z
    assert.equal(f.retries(), 0, "the batch, not a retry, wakes it again");
    assert.equal(f.autonomy.get("lead")?.phase, "waiting");
  } finally {
    f.store.close();
  }
});

test("a handback-only coordinator whose wake batch's turn fails goes to its owner as blocked within minutes", async () => {
  const f = await fleet();
  try {
    await f.autonomy.tick(f.api); // the owned lead gets a handback-only record
    f.advance(10 * 60000);
    f.autonomy.start("peer");
    f.begin("peer", "p1");
    f.autonomy.checkpoint("peer", "review", "Report saved", "p1");
    f.finish("peer", "p1");
    await f.autonomy.tick(f.api);
    f.advance(120000);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
    f.begin("lead", "l1");
    f.finish("lead", "l1", "failed", f.autonomy, "stream disconnected before completion");
    for (let n = 0; n < 4; n++) {
      f.advance(60000);
      await f.autonomy.tick(f.api);
      await f.wakes.tick(f.api);
    }
    assert.equal(f.autonomy.get("lead")?.phase, "blocked");
    assert.deepEqual(f.heads("sup"), ["Alliance wakeups for owner sup:"], "its owner hears within minutes");
    assert.equal(f.heads("lead").length, 1, "it is never retried");
  } finally {
    f.store.close();
  }
});

for (const [phase, via] of [
  ["blocked", "its wake batch"],
  ["review", "its wake batch"],
  ["blocked", "Paseo's finish notice"],
] as const)
  test(`wait in a lead's turn started by ${via} keeps the ${phase} that turn found, and its owner is asked about it`, async () => {
    const f = await fleet();
    try {
      f.autonomy.start("lead");
      f.autonomy.start("peer");
      f.begin("lead", "l1");
      const why = phase === "blocked" ? "Needs the Human's decision D10" : "Release notes ready";
      f.autonomy.checkpoint("lead", phase, why, "l1");
      f.finish("lead", "l1");
      (f.agents.get("sup") as Agent).status = "running"; // busy, so the lead's review waits
      f.begin("peer", "p1");
      f.autonomy.checkpoint("peer", "review", "Report saved", "p1");
      f.finish("peer", "p1");
      await f.autonomy.tick(f.api);
      if (via === "its wake batch") {
        f.advance(120000);
        await f.wakes.tick(f.api);
        assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
      }
      // That turn sends the peer rework and waits for it.
      f.begin("lead", "l2");
      f.begin("peer", "p2");
      const said: string[] = [];
      await f.wait("lead", { reason: "Rework of the report", agent: "peer" }, (line) => said.push(line));
      f.finish("lead", "l2");
      (f.agents.get("sup") as Agent).status = "idle";
      for (let n = 0; n < 4; n++) {
        f.advance(60000);
        await f.autonomy.tick(f.api);
        await f.wakes.tick(f.api);
      }
      assert.equal(f.autonomy.get("lead")?.phase, phase, "wait did not replace it");
      assert.equal(said.length, 1, "and said so");
      assert.deepEqual(
        f.heads("sup"),
        ["Alliance wakeups for owner sup:"],
        "the supervisor is asked about it",
      );
    } finally {
      f.store.close();
    }
  });

test("a review about an archived child closes, is never moved or pushed, and acking it is a no-op", async () => {
  const f = await fleet();
  try {
    const review = (key: string, agentId: string, turnId: string) => {
      f.store.updateMember(agentId, { lastTurnId: turnId, lastOutcome: "completed", resultPath: "r.json" });
      f.wakes.add({
        key,
        roomId: "room",
        ownerId: "lead",
        reason: key,
        trigger: { kind: "turn", agentId, turnId },
        delivery: "idle",
      });
    };
    review("review-sibling", "sibling", "s1");
    await f.wakes.tick(f.api);
    assert.deepEqual(f.sent, ["lead"]);
    const delivered = f.wakes.list()[0];
    // 0.1.18 recorded an archive on the assignment only.
    f.autonomy.start("sibling");
    f.autonomy.markArchived("sibling");
    f.advance(60000);
    await f.wakes.tick(f.api);
    assert.equal(f.wakes.list()[0].state, "canceled");
    assert.doesNotThrow(() => f.wakes.action(delivered.key, "lead", delivered.revision, "ack"));
    // The lead was archived too before deciding on the peer, which Paseo had already archived.
    review("review-peer", "peer", "p1");
    f.autonomy.start("peer");
    f.autonomy.markArchived("peer");
    f.store.updateMember("lead", { archivedAt: "archived" });
    await f.wakes.tick(f.api);
    await f.wakes.tick(f.api);
    assert.equal(f.wakes.list().find((w) => w.key === "review-peer")?.state, "canceled");
    assert.deepEqual(
      f.wakes.list().filter((w) => w.ownerId === "sup"),
      [],
      "nothing is moved up to the supervisor",
    );
    assert.deepEqual(f.sent, ["lead"]);
  } finally {
    f.store.close();
  }
});

test("the first pass records members Paseo archived while no release ran, so their reminders end", async () => {
  const f = await fleet();
  try {
    // Archived natively under 0.1.18, which recorded nothing for members without an assignment.
    f.wakes.add({
      key: "sup-check",
      roomId: "room",
      ownerId: "sup",
      reason: "Check the release",
      trigger: { kind: "time", at: 1_000_000 },
      delivery: "pull",
    });
    for (const id of ["sup", "sibling"]) (f.agents.get(id) as Agent).archived = true;
    await f.autonomy.tick(f.api);
    await f.wakes.tick(f.api);
    assert.ok(f.member("sup").archivedAt && f.member("sibling").archivedAt);
    assert.equal(f.wakes.list()[0].state, "canceled");
    assert.equal(f.autonomy.get("sibling"), undefined, "no record is made for an archived member");
  } finally {
    f.store.close();
  }
});

test("an owner's own pull reminder on its child's turn holds back neither the child's review nor the 48h reminder", async () => {
  const f = await fleet();
  try {
    const watch = (key: string, agentId: string, turnId: string) =>
      f.wakes.add({
        key,
        roomId: "room",
        ownerId: "lead",
        reason: "Read the report later",
        trigger: { kind: "turn", agentId, turnId },
        delivery: "pull",
      });
    f.autonomy.start("peer");
    f.begin("peer", "p1");
    watch("lead-watch-p1", "peer", "p1");
    f.autonomy.checkpoint("peer", "review", "Report saved", "p1");
    f.finish("peer", "p1");
    await f.autonomy.tick(f.api);
    f.advance(120000);
    await f.wakes.tick(f.api);
    assert.deepEqual(f.heads("lead"), ["Alliance wakeups for owner lead:"]);
    // A handback with no assignment record is asked for after 48 hours, pull item or not.
    f.store.updateMember("sibling", {
      lastTurnId: "s1",
      lastOutcome: "completed",
      resultPath: "r.json",
      lastTurnEndedAt: f.now(),
    });
    watch("lead-watch-s1", "sibling", "s1");
    f.advance(STALE_DECISION_MS);
    await f.sweep();
    const stale = f.wakes
      .list()
      .filter(
        (w) =>
          w.key.startsWith("stale-decision-") && w.trigger.kind === "turn" && w.trigger.agentId === "sibling",
      );
    assert.deepEqual(
      stale.map((w) => w.ownerId),
      ["lead"],
    );
  } finally {
    f.store.close();
  }
});

test("a child whose turn end was lost stops holding back its owner's handback once Paseo shows it at rest", async () => {
  const f = await fleet();
  try {
    f.store.updateMember("peer", { lastTurnId: "p1", lastOutcome: null }); // the daemon died mid-turn
    (f.agents.get("peer") as Agent).status = "closed";
    f.store.updateMember("lead", {
      lastTurnId: "l1",
      lastOutcome: "completed",
      resultPath: "l1.json",
      lastTurnEndedAt: f.now(),
    });
    const round = async () => {
      await f.autonomy.tick(f.api);
      await f.sweep();
      await f.wakes.tick(f.api);
    };
    await round();
    f.advance(STALE_DECISION_MS + 60000);
    await round();
    assert.deepEqual(f.heads("sup"), ["Alliance wakeups for owner sup:"], "the lead's handback reaches sup");
  } finally {
    f.store.close();
  }
});

test("an owner's wait on a child whose turn end was lost stops holding back the 48h reminder", async () => {
  const f = await fleet();
  try {
    f.autonomy.start("lead");
    f.autonomy.start("peer");
    f.begin("lead", "l1");
    f.begin("peer", "p1");
    await f.wait("lead", { reason: "The peer's report", agent: "peer" });
    f.finish("lead", "l1");
    // The daemon died mid-turn: Paseo shows the peer closed; its turn end never reached the plugin.
    (f.agents.get("peer") as Agent).status = "closed";
    const round = async () => {
      await f.autonomy.tick(f.api);
      await f.sweep();
      await f.wakes.tick(f.api);
    };
    for (let n = 0; n < 2; n++) {
      f.advance(5 * 60000);
      await round();
    }
    f.advance(STALE_DECISION_MS);
    await round();
    assert.deepEqual(f.heads("sup"), ["Alliance wakeups for owner sup:"], "the waiting lead reaches sup");
  } finally {
    f.store.close();
  }
});
