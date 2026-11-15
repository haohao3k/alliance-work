import assert from "node:assert/strict";
import { test } from "node:test";
import { Autonomy, quotaReset } from "../server/autonomy";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

const observedEnd = Date.parse("2026-11-12T06:29:29.950Z");

async function fixture(now: number) {
  const home = await temporary("alliance-quota-deadline-");
  const store = new RoomStore(home);
  store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Delayed quota receipt",
    mission: "",
    workspaceId: "w",
    createdAt: new Date(observedEnd).toISOString(),
  });
  store.saveMember({
    id: "worker",
    provider: "alliance-agy-hq",
    role: "hq",
    parentId: null,
    roomId: "room",
    assignment: "brief.md",
    decision: "open",
    decisionEvidence: null,
    lastOutcome: null,
    resultPath: null,
    launchKey: null,
    launchHash: null,
  });
  const autonomy = new Autonomy(store, new Wakeups(store, () => now), () => now);
  autonomy.start("worker");
  autonomy.started("worker", "turn");
  return { store, autonomy };
}

for (const [kind, message] of [
  ["relative", "Quota exhausted. Resets in 1h."],
  ["absolute", "You've hit your usage limit. Try again at 2026-11-12T08:00:00Z."],
])
  for (const expired of [false, true])
    test(`a recovered ${kind} quota keeps its original ${expired ? "expired" : "future"} deadline`, async (t) => {
      const reset = quotaReset(message, observedEnd);
      assert.ok(reset);
      const wallNow = expired ? reset + 2 * 3600000 : observedEnd + 15 * 60000;
      const f = await fixture(wallNow);
      t.after(() => f.store.close());
      f.autonomy.ended("worker", "turn", "failed", message, undefined, observedEnd);
      const state = f.autonomy.get("worker");
      assert.ok(state);
      assert.equal(state.dueAt, reset, "recovering history must not grant a new quota window");
      assert.equal(state.dueAt <= wallNow, expired);
      assert.equal(state.updatedAt, wallNow, "audit/update timestamps remain current");
      assert.equal(state.quotaRetry, true);
      assert.equal(state.retries, 0);
    });

for (const phase of ["blocked", "review"] as const)
  test(`recovering an expired quota does not resume standing ${phase} work`, async (t) => {
    const wallNow = observedEnd + 2 * 86400000;
    const f = await fixture(wallNow);
    t.after(() => f.store.close());
    f.autonomy.checkpoint("worker", phase, "Await the owner's decision", "turn");
    f.autonomy.ended("worker", "turn", "failed", "Quota exhausted. Resets in 1h.", undefined, observedEnd);
    const state = f.autonomy.get("worker");
    assert.ok(state);
    assert.equal(state.phase, phase);
    assert.equal(state.quotaRetry, undefined);
    assert.equal(state.updatedAt, wallNow);
  });
