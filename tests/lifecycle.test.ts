import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy } from "../server/autonomy";
import { authorizeDecision, Lifecycle, REMINDERS_PER_SCAN, STALE_DECISION_MS } from "../server/lifecycle";
import { type MemberRecord, RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import type { RoleName } from "../shared/contracts";
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
        send: async () => {
          sent.push(id);
        },
      }),
    },
  } as unknown as PaseoApi;
  const wakes = new Wakeups(store, () => now);
  const autonomy = new Autonomy(store, wakes, () => now);
  const lifecycle = new Lifecycle(store, wakes, autonomy, () => now);
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

test("running work, pending wakeups and permissions hold an accepted agent open", async () => {
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

test("plugin reminders never resume an owner the Human cancelled; they wait for pull", async () => {
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
