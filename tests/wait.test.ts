import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { registerWait } from "../scripts/wait.mjs";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

const MINUTE = 60000;

async function fixture(t: TestContext) {
  const home = await temporary("alliance-wait-");
  const store = new RoomStore(home);
  t.after(() => store.close());
  store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Wait",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  store.saveMember({
    id: "owner",
    roomId: "room",
    role: "hq",
    provider: "alliance-claude-hq",
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
  let now = Date.parse("2026-11-12T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const wakes = new Wakeups(store, () => now);
  const said: string[] = [];
  const rpc = async (method: string, input: unknown) => {
    if (method === "autonomy.list") return [];
    if (method === "rooms.list") return { members: store.members() };
    if (method === "wakeups.list") return wakes.list();
    if (method === "wakeups.add") return wakes.add(input);
    throw new Error(`Unexpected RPC ${method}`);
  };
  return {
    store,
    wakes,
    said,
    now: () => now,
    advance: (minutes: number) => {
      now += minutes * MINUTE;
    },
    wait: (request: { minutes?: string; at?: string }) =>
      registerWait(
        rpc,
        { roomId: "room", ownerId: "owner", reason: "Check the remote child", ...request },
        (line) => said.push(line),
      ),
  };
}

// Synthetic wait requests straddle the one-hour cache lifetime.
test("minute waits preserve short and long requests and report cache-aware scheduling", async (t) => {
  for (const [requested, expected, lines] of [
    [1, 1, 0],
    [45, 45, 0],
    [49, 49, 0],
    [50, 50, 0],
    [51, 51, 0],
    [52, 52, 0],
    [53, 53, 0],
    [54, 54, 0],
    [55, 55, 0],
    [56, 55, 1],
    [60, 55, 1],
    [74, 55, 1],
    [75, 55, 1],
    [76, 76, 1],
    [90, 90, 1],
    [120, 120, 1],
  ]) {
    await t.test(`${requested} minutes schedules ${expected} minutes`, async (t) => {
      const f = await fixture(t);
      const key = await f.wait({ minutes: String(requested) });
      const wake = f.store.wakeup(key);
      assert.equal(wake?.dueAt, f.now() + expected * MINUTE);
      assert.equal(wake?.delivery, "idle");
      assert.equal(wake?.untilDecision, true, "a time wait still ends at a decision");
      assert.equal(f.said.length, lines, "one notice for a normalized or long wait");
      assert(
        f.said.every((line) => !line.includes("\n")),
        "each notice is one line",
      );
    });
  }
});

test("repeating normalized waits in one turn preserves the first deadline and reminder key", async (t) => {
  const f = await fixture(t);
  const key = await f.wait({ minutes: "75" });
  const initial = f.store.wakeup(key);
  // Beyond time-wait coalescing: idempotency must come from the normalized request's key.
  f.advance(30);
  assert.equal(await f.wait({ minutes: "75" }), key);
  assert.equal(await f.wait({ minutes: "60" }), key);
  assert.deepEqual(f.store.wakeup(key), initial, "retries do not move the existing deadline");
  assert.equal(f.wakes.list().length, 1);
  f.store.updateMember("owner", { lastTurnId: "turn-2" });
  assert.notEqual(await f.wait({ minutes: "75" }), key, "a later turn can wait again");
  assert.equal(f.wakes.list().length, 2);
});

test("new minute waits leave existing scheduled reminders unchanged", async (t) => {
  const f = await fixture(t);
  const existing = f.wakes.add({
    key: "previous-release-wait",
    roomId: "room",
    ownerId: "owner",
    reason: "Check the remote child",
    trigger: { kind: "time", at: f.now() + 75 * MINUTE },
    untilDecision: true,
    delivery: "idle",
  });
  await f.wait({ minutes: "75" });
  assert.deepEqual(f.store.wakeup(existing.key), existing);
});

test("absolute waits and deferrals keep their requested deadlines and decision lifetime", async (t) => {
  const f = await fixture(t);
  const at = f.now() + 75 * MINUTE;
  const key = await f.wait({ at: new Date(at).toISOString() });
  assert.equal(f.store.wakeup(key)?.dueAt, at);
  assert.deepEqual(f.said, [], "absolute deadlines do not emit duration advice");
  f.advance(75);
  await f.wakes.tick();
  const pending = f.store.wakeup(key);
  assert.equal(pending?.state, "pending");
  assert(pending);
  const deferred = f.wakes.action(key, "owner", pending.revision, "defer", undefined, 75);
  assert.equal(deferred.dueAt, f.now() + 75 * MINUTE, "defer is not clamped");
  f.store.updateMember("owner", { decision: "accepted", decisionAt: new Date(f.now()).toISOString() });
  await f.wakes.tick();
  assert.equal(f.store.wakeup(key)?.state, "canceled", "a decision still ends a deferred time wait");
});
