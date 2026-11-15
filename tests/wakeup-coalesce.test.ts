import assert from "node:assert/strict";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

const MIN = 60000;
const HOUR = 60 * MIN;

/** Real store and reminders; only the native agent's idle time and the send are controlled here. */
async function fixture() {
  const home = await temporary("alliance-wake-coalesce-");
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
  for (const id of ["owner", "child"])
    store.saveMember({
      id,
      roomId: "r",
      role: "lead",
      provider: "alliance-codex-lead",
      parentId: id === "child" ? "owner" : null,
      assignment: "assignment.md",
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
      lastTurnId: "turn-1",
    });
  store.saveJob({
    key: "build",
    roomId: "r",
    ownerId: "owner",
    title: "Build",
    pid: 1,
    processIdentity: "build-run",
    revision: 1,
    recordedAt: "now",
  });
  let now = 10 * HOUR;
  let activeAgo: number | null = null;
  const texts: string[] = [];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            status: "idle",
            archivedAt: null,
            pendingPermissions: [],
            ...(activeAgo === null ? {} : { updatedAt: new Date(now - activeAgo).toISOString() }),
          },
        }),
        send: async (text: string) => {
          texts.push(text);
        },
      }),
    },
  } as unknown as PaseoApi;
  const wake = new Wakeups(store, () => now);
  return {
    store,
    wake,
    api,
    texts,
    add: (key: string, extra: Record<string, unknown> = {}) =>
      wake.add({
        key,
        roomId: "r",
        ownerId: "owner",
        reason: key,
        trigger: { kind: "time", at: now },
        delivery: "idle",
        ...extra,
      }),
    advance: (ms: number) => {
      now += ms;
    },
    /** The owner's last activity Paseo reports was this long ago (null: Paseo reports none). */
    idleFor: (ms: number | null) => {
      activeAgo = ms;
    },
    keysIn: (text: string) => [...text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]),
  };
}

test("one owner is not reminded twice of the same job, child turn or time", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const job = (key: string) => f.add(key, { trigger: { kind: "job", key: "build" } });
  assert.equal(job("job-a").key, job("job-b").key, "same job");
  const turn = (key: string) => f.add(key, { trigger: { kind: "turn", agentId: "child", turnId: "turn-1" } });
  assert.equal(turn("turn-a").key, turn("turn-b").key, "same child turn");
  const wait = (key: string, minutes: number) =>
    f.add(key, { untilDecision: true, trigger: { kind: "time", at: 10 * HOUR + minutes * MIN } });
  const first = wait("wait-a", 45);
  assert.equal(wait("wait-b", 48).key, first.key, "a reworded wait for about the same time");
  assert.notEqual(wait("wait-c", 90).key, first.key, "a wait for another time is another wait");
  assert.equal(f.wake.list().length, 4);
  // Nothing the owner asked is lost: both reasons reach the one reminder, once each.
  assert.match(f.store.wakeup(first.key)?.reason ?? "", /wait-a[\s\S]*wait-b/);
  wait("wait-b", 48);
  assert.equal(
    f.store.wakeup(first.key)?.reason.split("wait-b").length,
    2,
    "repeating a command adds nothing",
  );
  // The owner shortened the wait: it is woken no later than it last asked.
  const sooner = wait("wait-d", 42);
  assert.equal(sooner.key, first.key);
  assert.equal(f.store.wakeup(first.key)?.dueAt, 10 * HOUR + 42 * MIN);
  // Only waits not yet sent merge: after delivery the owner may legitimately wait again.
  f.advance(46 * MIN);
  await f.wake.tick(f.api);
  assert.equal(f.store.wakeup(first.key)?.state, "delivered");
  assert.notEqual(wait("wait-e", 91).key, first.key);
  assert.equal(f.texts.length, 1);
});

test("a cold owner receives a short quota notice before reset", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.idleFor(2 * HOUR);
  f.add("quota-1", { expiresAt: 10 * HOUR + HOUR });
  await f.wake.tick(f.api);
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 1);
  assert.equal(f.store.wakeup("quota-1")?.state, "delivered");
});

test("a notice about a limit that lasts hours is sent at once: the owner may need to reassign", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.idleFor(2 * HOUR);
  f.add("quota-long", { expiresAt: 10 * HOUR + 5 * HOUR });
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 1);
});

test("a sent notice lapses with the limit without sending it twice", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.idleFor(2 * HOUR);
  f.add("quota-short", { expiresAt: 10 * HOUR + HOUR });
  await f.wake.tick(f.api);
  f.advance(HOUR + MIN);
  f.idleFor(3 * HOUR);
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 1);
  assert.equal(f.store.wakeup("quota-short")?.state, "expired");
});

test("a warm session, or one whose idle time is unknown, gets its notice at once", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.idleFor(10 * MIN);
  f.add("quota-warm", { expiresAt: 10 * HOUR + HOUR });
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 1);
  f.idleFor(null);
  f.advance(2 * MIN);
  f.add("quota-unknown", { expiresAt: 10 * HOUR + HOUR });
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 2, "without a reading the notice is sent as before");
});

test("owner mail, handbacks, errors and plain reminders still wake a cold session at once", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.idleFor(3 * HOUR);
  f.store.updateMember("child", { lastOutcome: "completed", resultPath: "result.json" });
  const cases: [string, Record<string, unknown>][] = [
    ["auto-review-1", { trigger: { kind: "turn", agentId: "child", turnId: "turn-1" } }],
    ["wake-failed-1", {}],
    ["silent-1", {}],
    ["stale-decision-1", { trigger: { kind: "turn", agentId: "child", turnId: "turn-1" } }],
    ["from-the-human", {}],
  ];
  for (const [key, extra] of cases) {
    f.add(key, extra);
    await f.wake.tick(f.api);
    assert.ok(
      f.texts.length > 0 && f.keysIn(f.texts.at(-1) ?? "").includes(key),
      `${key} is sent immediately`,
    );
    f.texts.length = 0;
    f.advance(2 * MIN);
  }
});

test("the one wakeup of merged waits names every reason, within the reminder's length limit", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const wait = (reason: string, minutes: number) =>
    f.add(`wait-${reason.slice(0, 8)}`, {
      reason,
      untilDecision: true,
      trigger: { kind: "time", at: 10 * HOUR + minutes * MIN },
    });
  wait("check job X", 60);
  wait("check child Y", 65);
  f.advance(61 * MIN);
  await f.wake.tick(f.api);
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0], /check job X[\s\S]*check child Y/);
  const long = "z".repeat(1500);
  wait(`long-a ${long}`, 200);
  const merged = wait(`long-b ${long}`, 205);
  assert.ok(merged.reason.length <= 2000, "joined reasons stay valid for older releases");
  assert.ok(merged.reason.includes("long-a"));
});
