import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy } from "../server/autonomy";
import { announceAccountLimit, quotaNotice } from "../server/claude-limit";
import { Lifecycle } from "../server/lifecycle";
import { type MemberRecord, RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

const HOUR = 3600000;
async function fixture() {
  const home = await temporary("alliance-quota-notice-");
  const store = new RoomStore(home);
  for (const id of ["room", "parent-room"])
    store.addRoom({
      id,
      cwd: `${home}/${id}`,
      artifacts: home,
      title: id,
      mission: "",
      workspaceId: id,
      createdAt: "now",
    });
  let now = 10 * HOUR;
  const wakes = new Wakeups(store, () => now);
  const lifecycle = new Lifecycle(store, wakes, new Autonomy(store, wakes, () => now), () => now);
  const sent: { id: string; text: string }[] = [];
  const live = new Map<string, string>();
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: {
            status: live.get(id) ?? "idle",
            archivedAt: null,
            pendingPermissions: [],
            updatedAt: new Date(now - 2 * HOUR).toISOString(),
          },
        }),
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    },
  } as unknown as PaseoApi;
  function member(id: string, harness: string, patch: Partial<MemberRecord> = {}) {
    store.saveMember({
      id,
      roomId: "room",
      role: "peer",
      provider: `alliance-${harness}-peer`,
      parentId: null,
      assignment: `${home}/assignment.md`,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
      ...patch,
    });
  }
  const get = (id: string) => {
    const value = store.member(id);
    assert.ok(value);
    return value;
  };
  const limited = (id: string) =>
    store.updateMember(id, {
      limited: { until: now + HOUR, messageId: null },
      lastOutcome: "failed",
      lastTurnEndedAt: now,
    });
  const announce = (id: string) => announceAccountLimit(store, wakes, home, id, now);
  return {
    home,
    get,
    store,
    wakes,
    lifecycle,
    api,
    sent,
    live,
    member,
    limited,
    announce,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

for (const harness of ["codex", "claude", "pi", "agy"])
  test(`${harness} quota reaches a different-harness HQ even when its owner is Human`, async (t) => {
    const f = await fixture();
    t.after(() => f.store.close());
    f.member("worker", harness);
    f.member("hq", harness === "codex" ? "claude" : "codex", { role: "hq" });
    f.limited("worker");
    await f.announce("worker");
    await f.wakes.tick(f.api);
    assert.deepEqual(
      f.sent.map((s) => s.id),
      ["hq"],
    );
    assert.equal(f.wakes.list()[0].state, "delivered");
    assert.match(f.sent[0].text, new RegExp(harness));
    assert.match(f.sent[0].text, new RegExp(new Date(f.now() + HOUR).toISOString().replaceAll(".", "\\.")));
  });

test("the nearest runnable different-harness owner gets a notice across room boundaries", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex", { parentId: "held" });
  f.member("held", "codex", { role: "lead", parentId: "near" });
  f.member("near", "claude", { roomId: "parent-room", role: "lead", parentId: "far" });
  f.member("far", "pi", { role: "supervisor" });
  f.limited("worker");
  await f.announce("worker");
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["near"],
  );
});

test("a recipient depleted after scheduling is rerouted before its notice expires", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex", { parentId: "owner" });
  f.member("hq", "claude", { role: "hq" });
  f.member("owner", "pi", { role: "lead" });
  f.limited("worker");
  await f.announce("worker");
  f.limited("hq");
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["owner"],
  );
  assert.equal(f.wakes.list().filter((w) => w.lastSentAt !== null).length, 1);
});

test("quota with no runnable recipient immediately appears in lifecycle needsHuman", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex");
  f.limited("worker");
  await f.announce("worker");
  const view = await f.lifecycle.describe(
    f.get("worker"),
    { status: "error", archived: false, permissions: 0 },
    new Map(),
  );
  assert.ok(view.needsHuman);
  assert.match(view.needsHuman.reason, /codex/);
  assert.match(view.needsHuman.reason, /assignment\.md/);
  assert.equal(f.wakes.list().length, 0);
});

test("a native unavailable HQ falls back to its runnable owner rather than losing the notice", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex", { parentId: "owner" });
  f.member("hq", "claude", { role: "hq" });
  f.live.set("hq", "error");
  f.member("owner", "pi", { role: "lead" });
  f.limited("worker");
  await f.announce("worker");
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["owner"],
  );
});

test("notices list recent successful host harnesses, a policy route and a quoted replacement command", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex", { assignment: `${f.home}/owner's brief.md`, parentId: "owner" });
  f.member("owner", "claude", { role: "lead", lastOutcome: "completed", lastTurnEndedAt: f.now() - 1000 });
  f.member("old", "agy", { lastOutcome: "completed", lastTurnEndedAt: f.now() - HOUR - 1 });
  f.member("failed", "pi", { lastOutcome: "failed", lastTurnEndedAt: f.now() - 1000 });
  const autonomy = new Autonomy(f.store, f.wakes, f.now);
  autonomy.start("worker");
  autonomy.checkpoint("worker", "blocked", "Build succeeded; waiting for review");
  f.limited("worker");
  await f.announce("worker");
  await f.announce("worker");
  const notice = f.wakes.list();
  assert.equal(notice.length, 1);
  assert.match(notice[0].reason, /successful.*1h.*claude/i);
  assert.match(notice[0].reason, /claude-sonnet-5-5/);
  assert.match(notice[0].reason, /paseo agent run/);
  assert.match(notice[0].reason, /owner.*brief\.md/);
  assert.match(notice[0].reason, /Build succeeded; waiting for review/);
  const projection = quotaNotice(f.store, "worker", f.now());
  assert.ok(projection?.command);
  const args = execFileSync("/bin/sh", ["-c", `set -- ${projection.command}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  }).split("\0");
  assert.ok(
    args.some((value) => value.includes(`${f.home}/owner's brief.md`) && value.includes("Build succeeded")),
  );
  assert.equal(args[args.indexOf("--provider") + 1], "alliance-claude-peer/claude-sonnet-5-5");
  assert.equal(f.store.member("worker")?.provider, "alliance-codex-peer");
  assert.equal(f.store.member("worker")?.limited?.until, f.now() + HOUR);
});

test("a pending notice with no native recipient is visible to Human, then delivers when an owner recovers", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex");
  f.member("hq", "claude", { role: "hq" });
  f.limited("worker");
  await f.announce("worker");
  f.live.set("hq", "error");
  await f.wakes.tick(f.api);
  assert.equal(f.sent.length, 0);
  const states = new Map([["hq", { status: "error", archived: false, permissions: 0 }]]);
  const view = await f.lifecycle.describe(
    f.get("worker"),
    { status: "error", archived: false, permissions: 0 },
    states,
  );
  assert.ok(view.needsHuman);
  f.live.set("hq", "idle");
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["hq"],
  );
  f.advance(HOUR);
  await f.wakes.tick(f.api);
  assert.equal(f.wakes.list()[0].state, "expired");
});

test("later account attribution and repeated outcome callbacks cannot duplicate a quota notice", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "claude");
  f.member("hq", "codex", { role: "hq" });
  f.limited("worker");
  await f.announce("worker");
  f.store.updateMember("worker", {
    limited: { ...{ until: f.now() + HOUR, messageId: null }, account: "5x" },
  });
  f.advance(1000);
  await f.announce("worker");
  assert.equal(f.wakes.list().length, 1);
});

test("a delivered notice whose receiving turn also hits quota reaches another authority before reset", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex", { parentId: "owner" });
  f.member("hq", "claude", { role: "hq" });
  f.member("owner", "pi", { role: "lead" });
  f.limited("worker");
  await f.announce("worker");
  await f.wakes.tick(f.api);
  const first = f.wakes.list()[0];
  f.store.updateMember("hq", { limited: { until: f.now() + HOUR, messageId: first.messageId } });
  await f.wakes.tick(f.api);
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["hq", "owner"],
  );
});

test("a recipient appearing after a Human-only quota report receives the pending advice", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex");
  f.limited("worker");
  await f.announce("worker");
  f.member("hq", "claude", { role: "hq" });
  const states = new Map([["hq", { status: "idle", archived: false, permissions: 0 }]]);
  const before = await f.lifecycle.describe(
    f.get("worker"),
    { status: "error", archived: false, permissions: 0 },
    states,
  );
  assert.ok(before.needsHuman, "advice stays visible until it is queued for the newly available owner");
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((s) => s.id),
    ["hq"],
  );
  const after = await f.lifecycle.describe(
    f.get("worker"),
    { status: "error", archived: false, permissions: 0 },
    states,
  );
  assert.equal(after.needsHuman, undefined);
});

test("quota attention preserves rejection and acceptance blockers", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("rejected", "codex", { decision: "rejected" });
  f.limited("rejected");
  f.member("accepted", "codex", { decision: "accepted", decisionBy: null });
  f.limited("accepted");
  const live = { status: "error", archived: false, permissions: 0 };
  const rejected = await f.lifecycle.describe(f.get("rejected"), live, new Map());
  assert.equal(rejected.state, "rejected");
  assert.match(rejected.blockers.join(" "), /rejected/);
  assert.ok(rejected.needsHuman);
  const accepted = await f.lifecycle.describe(f.get("accepted"), live, new Map());
  assert.equal(accepted.state, "held");
  assert.ok(accepted.blockers.includes("acceptance has no recorded evidence"));
  assert.ok(accepted.needsHuman);
});

test("a successful turn stays useful evidence after that member later fails", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "codex");
  f.member("hq", "claude", { role: "hq" });
  f.limited("worker");
  f.member("recent", "claude", {
    lastOutcome: "failed",
    lastTurnEndedAt: f.now(),
    lastSuccessfulTurn: {
      endedAt: f.now() - 1000,
      provider: "alliance-claude-peer",
      model: "claude-sonnet-5-5",
    },
  });
  const notice = quotaNotice(f.store, "worker", f.now());
  assert.ok(notice);
  assert.match(notice.reason, /1h: claude/);
  assert.ok(notice.command);
  f.advance(HOUR);
  const stale = quotaNotice(f.store, "worker", f.now() - 1);
  assert.ok(stale);
  assert.equal(stale.command, null);
});

test("named Claude reporters share one account/reset notice and keep the other account's HQ runnable", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("worker", "claude", { claudeAccounts: ["20x"] });
  f.member("second", "claude", { claudeAccounts: ["20x"] });
  f.member("hq", "claude", { role: "hq", claudeAccounts: ["5x"] });
  f.member("free", "claude", { claudeAccounts: ["5x"] });
  for (const id of ["worker", "second"])
    f.store.updateMember(id, { limited: { until: f.now() + HOUR, messageId: null, account: "20x" } });
  await f.announce("worker");
  await f.announce("second");
  await f.wakes.tick(f.api);
  const notices = f.wakes.list();
  assert.equal(notices.length, 1);
  assert.deepEqual(
    f.sent.map((item) => item.id),
    ["hq"],
  );
  assert.equal(f.store.heldUntil("hq", f.now()), null);
  for (const id of ["worker", "second"]) assert.ok(notices[0].reason.includes(id));
  assert.ok(notices[0].reason.includes("alliance-work accounts select"));
  assert.equal(f.store.member("worker")?.limited?.account, "20x");
  assert.equal(f.store.member("second")?.limited?.account, "20x");
});

test("an alternate-account HQ appearing later receives deduplicated account advice", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  for (const id of ["worker", "second"]) {
    f.member(id, "claude", { claudeAccounts: ["20x"] });
    f.store.updateMember(id, { limited: { until: f.now() + HOUR, messageId: null, account: "20x" } });
    await f.announce(id);
  }
  assert.equal(f.wakes.list().length, 0);
  f.member("hq", "claude", { role: "hq", claudeAccounts: ["5x"] });
  await f.wakes.tick(f.api);
  assert.deepEqual(
    f.sent.map((item) => item.id),
    ["hq"],
  );
  assert.equal(f.wakes.list().length, 1);
  assert.match(f.sent[0].text, /alliance-work accounts select/);
});

test("shared account advice can reach an owner of another reporter's room", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("first", "claude", { claudeAccounts: ["20x"] });
  f.member("second", "claude", { roomId: "parent-room", claudeAccounts: ["20x"] });
  f.member("hq", "claude", { roomId: "parent-room", role: "hq", claudeAccounts: ["5x"] });
  for (const id of ["first", "second"])
    f.store.updateMember(id, { limited: { until: f.now() + HOUR, messageId: null, account: "20x" } });
  await f.announce("first");
  await f.announce("second");
  await f.wakes.tick(f.api);
  assert.equal(f.wakes.list().length, 1);
  assert.deepEqual(
    f.sent.map((item) => item.id),
    ["hq"],
  );
});

test("different Claude accounts and reset windows keep separate notices", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  f.member("hq", "codex", { role: "hq" });
  for (const [id, account] of [
    ["first", "20x"],
    ["second", "5x"],
  ]) {
    f.member(id, "claude", { claudeAccounts: [account] });
    f.store.updateMember(id, { limited: { until: f.now() + HOUR, messageId: null, account } });
    await f.announce(id);
  }
  f.store.updateMember("first", { limited: { until: f.now() + 2 * HOUR, messageId: null, account: "20x" } });
  await f.announce("first");
  await f.announce("first");
  assert.equal(f.wakes.list().length, 3);
  assert.equal(new Set(f.wakes.list().map((item) => item.key)).size, 3);
});
