import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Obligations } from "../server/obligations";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("alliance-obligations-");
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
  for (const id of ["lead", "successor"])
    store.saveMember({
      id,
      roomId: "r",
      role: "lead",
      provider: "alliance-codex-lead",
      parentId: null,
      assignment: "brief",
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  const unavailable = new Set<string>();
  let sends = 0,
    now = 1000000;
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: { status: "running", archivedAt: unavailable.has(id) ? "now" : null },
        }),
        send: async () => {
          sends++;
        },
      }),
    },
  } as unknown as PaseoApi;
  const ledger = new Obligations(store, () => now);
  const wake = new Wakeups(store, () => now);
  const evidence = join(home, "readback.md");
  await writeFile(
    evidence,
    "Observed candidate/runtime in the authorized environment; scope and limits recorded.",
  );
  const input = {
    key: "activate",
    roomId: "r",
    ownerId: "lead",
    assignment: "brief.md",
    authority: "Human: activate only at safe boundary",
    nextAction: "Verify loaded policy",
    closeWhen: "Loaded version and behavior verified",
    conditions: [{ id: "loaded", requires: "v0.1.11 actually loaded, not merely staged" }],
  };
  const action = (extra: Record<string, unknown>) =>
    ledger.action(
      { key: input.key, ownerId: "lead", revision: store.obligations()[0].revision, evidence, ...extra },
      api,
    );
  const remind = (key = "notice", extra = {}) =>
    wake.add({
      key,
      roomId: "r",
      ownerId: "lead",
      obligationKey: input.key,
      reason: "Verify adoption after activation",
      trigger: { kind: "time", at: now },
      ...extra,
    });
  return {
    home,
    store,
    ledger,
    wake,
    api,
    input,
    evidence,
    action,
    remind,
    unavailable,
    advance: (ms: number) => {
      now += ms;
    },
    sends: () => sends,
  };
}

test("due activation waits for evidence; observation expires; notification ack and expiry never fulfill work", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    f.remind();
    f.remind("expires", { expiresAt: 1000001 });
    assert.equal((await f.wake.take("lead")).length, 0);
    await assert.rejects(f.action({ action: "fulfill" }), /Unmet/);
    f.advance(2);
    await f.action({ action: "observe", conditionId: "loaded", validUntil: 1000100 });
    const [w] = await f.wake.take("lead");
    assert.equal(w.key, "notice");
    f.wake.action(w.key, w.ownerId, w.revision, "ack");
    assert.equal(f.store.obligations()[0].state, "open");
    assert.equal(f.wake.list().find((w) => w.key === "expires")?.state, "expired");
    f.advance(100);
    f.remind("next");
    assert.equal((await f.wake.take("lead")).length, 0);
    await assert.rejects(
      f.action({ action: "observe", conditionId: "loaded", validUntil: 1000100 }),
      /future/,
    );
    await f.action({ action: "observe", conditionId: "loaded", validUntil: 1001000 });
    await f.action({ action: "fulfill" });
    assert.equal(f.store.obligations()[0].state, "fulfilled");
    assert.equal(f.store.member("lead")?.decision, "open", "Ledger closure is not product acceptance");
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("stable obligations survive sessions, restart, archived owners and stale handoff writers", async () => {
  const f = await fixture();
  await f.ledger.add(f.input, f.api);
  assert.equal((await f.ledger.add(f.input, f.api)).revision, 1);
  await assert.rejects(f.ledger.add({ ...f.input, nextAction: "different" }, f.api), /different/);
  f.remind();
  f.store.updateMember("lead", { lastTurnId: "later-turn", lastOutcome: "completed", decision: "accepted" });
  f.unavailable.add("lead");
  await assert.rejects(f.action({ action: "handoff", nextOwnerId: "lead" }), /unavailable/);
  await f.action({ action: "handoff", nextOwnerId: "successor" });
  assert.equal(f.wake.list()[0].ownerId, "successor");
  await assert.rejects(f.action({ action: "cancel", revision: 1 }), /changed/);
  f.store.close();
  const reopened = new RoomStore(f.home);
  try {
    const ledger = new Obligations(reopened, () => 1000000);
    assert.equal(ledger.list("successor")[0].blockedOn.length, 1);
    assert.equal(ledger.list("lead").length, 0);
    assert.equal(reopened.obligations()[0].assignment, f.input.assignment);
    assert.equal(reopened.obligations()[0].authority, f.input.authority);
    assert.equal(reopened.obligationHistory("activate").length, 2);
    assert.equal(reopened.obligationHistory("activate")[0].ownerId, "lead");
    assert.equal(f.sends(), 0);
  } finally {
    reopened.close();
  }
});

test("handoff transfers an exact tracked job and all its pending reminders in one transaction", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    f.store.saveJob({
      key: "scan",
      roomId: "r",
      ownerId: "lead",
      pid: 123,
      processIdentity: "boot:123",
      title: "Scan",
      recordedAt: "now",
      revision: 1,
    });
    f.remind("a", { trigger: { kind: "job", key: "scan" } });
    f.remind("b", { trigger: { kind: "job", key: "scan" } });
    await f.action({ action: "handoff", nextOwnerId: "successor" });
    assert.equal(f.store.jobs()[0].ownerId, "successor");
    assert.equal(f.store.jobs()[0].processIdentity, "boot:123");
    assert(f.wake.list().every((w) => w.ownerId === "successor" && w.jobRevision === 2));
    assert.equal(f.ledger.list("successor")[0].blockedOn.length, 1);
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("shared job or ambiguous delivery rolls back owner, history and reminders together", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    f.store.saveJob({
      key: "scan",
      roomId: "r",
      ownerId: "lead",
      pid: 123,
      processIdentity: "boot:123",
      title: "Scan",
      recordedAt: "now",
      revision: 1,
    });
    f.remind("linked", { trigger: { kind: "job", key: "scan" } });
    const external = f.remind("other", { obligationKey: undefined, trigger: { kind: "job", key: "scan" } });
    await assert.rejects(f.action({ action: "handoff", nextOwnerId: "successor" }), /Shared/);
    assert.equal(f.store.obligations()[0].revision, 1);
    assert.equal(f.store.obligationHistory("activate").length, 1);
    assert.equal(f.store.jobs()[0].ownerId, "lead");
    f.wake.action(external.key, external.ownerId, external.revision, "cancel");
    const w = f.wake.list()[0];
    f.store.saveWakeup({ ...w, state: "uncertain", revision: w.revision + 1 }, w.revision);
    await assert.rejects(f.action({ action: "handoff", nextOwnerId: "successor" }), /ambiguous/);
    assert.equal(f.store.obligations()[0].ownerId, "lead");
    assert.equal(f.store.obligationHistory("activate").length, 1);
  } finally {
    f.store.close();
  }
});

test("Human decision, local-only acceptance and unrelated work remain legitimate", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    f.remind();
    await f.action({ action: "handoff", nextOwnerId: null });
    assert.equal(f.ledger.list(null)[0].blockedOn[0], "Human owns the next decision");
    assert.equal(f.wake.list()[0].state, "canceled");
    assert.equal(f.store.obligations()[0].state, "open");
    const local = await f.ledger.add(
      { ...f.input, key: "local", conditions: [], closeWhen: "Local snapshot tested; no publish authorized" },
      f.api,
    );
    await f.ledger.action(
      { key: "local", ownerId: "lead", revision: local.revision, action: "fulfill", evidence: f.evidence },
      f.api,
    );
    assert.equal(f.store.obligations().find((o) => o.key === "local")?.state, "fulfilled");
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("reconciliation invalidates observations and stale concurrent writes cannot erase newer conditions", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    await f.action({ action: "observe", conditionId: "loaded", validUntil: 2000000 });
    assert.equal(f.ledger.list()[0].blockedOn.length, 0);
    const results = await Promise.allSettled([
      f.action({
        action: "reconcile",
        nextAction: "Inspect changed runtime",
        conditions: [{ id: "loaded", requires: "New candidate actually loaded" }],
      }),
      f.action({ action: "fulfill" }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const current = f.store.obligations()[0];
    if (current.state === "open") {
      assert.equal(current.observations.length, 0);
      assert.equal(f.ledger.list()[0].blockedOn.length, 1);
    }
    assert.equal(f.store.obligationHistory("activate").length, 3);
  } finally {
    f.store.close();
  }
});

test("obligation reminders cannot enable idle sends or independently move their owner", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    assert.throws(() => f.remind("interrupt", { delivery: "idle" }), /pull/);
    const w = f.remind();
    assert.throws(() => f.wake.action(w.key, w.ownerId, w.revision, "owner", "successor"), /obligation/);
    await f.wake.tick(f.api);
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});

test("notification expiry does not orphan a tracked job through successor and Human handoffs", async () => {
  const f = await fixture();
  try {
    await f.ledger.add(f.input, f.api);
    f.store.saveJob({
      key: "scan",
      roomId: "r",
      ownerId: "lead",
      pid: 123,
      processIdentity: "boot:123",
      title: "Scan",
      recordedAt: "now",
      revision: 1,
    });
    f.remind("expired-job", { trigger: { kind: "job", key: "scan" }, expiresAt: 1000001 });
    f.advance(2);
    await f.wake.tick();
    await f.action({ action: "handoff", nextOwnerId: "successor" });
    assert.equal(f.store.jobs()[0].ownerId, "successor");
    await f.action({ action: "handoff", ownerId: "successor", nextOwnerId: null });
    assert.equal(f.store.jobs()[0].ownerId, "successor");
    await f.action({ action: "handoff", ownerId: null, nextOwnerId: "lead" });
    assert.equal(f.store.jobs()[0].ownerId, "lead");
    assert.equal(f.store.jobs()[0].revision, 3);
    assert.equal(f.wake.list()[0].state, "expired");
    assert.equal(f.wake.list()[0].revision, 2, "Historical notification receipt stays intact");
  } finally {
    f.store.close();
  }
});

test("a handoff receipt reconciles a pulled notification without a separate acknowledgement ceremony", async () => {
  const f = await fixture();
  try {
    await f.ledger.add({ ...f.input, conditions: [] }, f.api);
    f.remind();
    assert.equal((await f.wake.take("lead")).length, 1);
    await f.action({ action: "handoff", nextOwnerId: "successor" });
    assert.equal(f.store.obligations()[0].ownerId, "successor");
    assert.equal(f.store.obligations()[0].state, "open");
    assert.equal(f.wake.list()[0].state, "acknowledged");
    assert.equal(f.wake.list()[0].ownerId, "lead");
    assert.equal((await f.wake.take("successor")).length, 0);
    assert.equal(f.sends(), 0);
  } finally {
    f.store.close();
  }
});
