import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { AllianceRuntime, type SchedulerClient } from "../server/runtime";
import { temporary } from "./temp";

/** A retained end receipt whose provider history cannot currently be reconstructed. */
async function fixture(t: TestContext) {
  const now = Date.parse("2026-11-14T10:00:00Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const home = await temporary("alliance-idle-readback-");
  await writeFile(join(home, "profiles.json"), JSON.stringify({ home, root: home, profiles: {} }));
  const native = {
    status: "idle",
    archivedAt: null as string | null,
    updatedAt: new Date(now - 60000).toISOString(),
    lastActivityAt: new Date(now - 60000).toISOString(),
    lastUserMessageAt: new Date(now - 60000).toISOString(),
    activeTurn: null,
    pendingPermissions: [],
  };
  let resumes = 0;
  let historyAvailable = false;
  let untagged: AgentTimelineItem | undefined;
  let duringRefresh: (() => void) | undefined;
  let nextRead: (() => unknown) | undefined;
  const api = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: () => ({
        refresh: async () => {
          duringRefresh?.();
          return { agent: { ...native } };
        },
        timeline: {
          refetch: async () => {
            // The real daemon loads a collected provider runtime before returning history.
            resumes++;
            if (nextRead) return nextRead();
            if (untagged)
              return {
                epoch: "history",
                hasOlder: false,
                entries: [{ timestamp: new Date(now - 1000).toISOString(), item: untagged }],
              };
            return historyAvailable
              ? {
                  epoch: "history",
                  hasOlder: false,
                  entries: [
                    {
                      turnId: "turn",
                      timestamp: new Date(now - 1000).toISOString(),
                      item: { type: "assistant_message", text: "Completed work" },
                    },
                  ],
                }
              : { error: "retained history unavailable", entries: [] };
          },
        },
      }),
    },
    close: async () => {},
  } as unknown as SchedulerClient;
  const runtime = await new AllianceRuntime(home, async (_home, seen) => {
    seen({ version: "0.15.4", agentMessageProvenance: true });
    return api;
  }).ready();
  t.after(() => runtime.close());
  runtime.store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    workspaceId: "w",
    title: "Retained handback",
    mission: "",
    createdAt: new Date(now).toISOString(),
  });
  const agent = {
    id: "hq",
    provider: "alliance-agy-hq",
    cwd: home,
    workspaceId: "w",
    parentAgentId: null,
    title: null,
  };
  runtime.store.saveMember({
    id: agent.id,
    provider: agent.provider,
    parentId: null,
    role: "hq",
    roomId: "room",
    assignment: "brief.md",
    decision: "open",
    decisionEvidence: null,
    lastTurnId: "turn",
    lastOutcome: null,
    resultPath: null,
    turnStartedAt: now - 60000,
    launchKey: null,
    launchHash: null,
    turnReadbackPending: {
      id: "receipt",
      agent,
      turnId: "turn",
      startedAt: now - 60000,
      endedAt: now,
      outcome: { kind: "completed" },
      error: "Native turn history unavailable",
    },
  });
  runtime.autonomy.start(agent.id);
  let first = true;
  return {
    runtime,
    agent,
    api,
    native,
    resumes: () => resumes,
    recover: () => {
      historyAvailable = true;
    },
    untagged: (item: AgentTimelineItem) => {
      untagged = item;
    },
    onRefresh: (callback: () => void) => {
      duringRefresh = callback;
    },
    onRead: (callback: () => unknown) => {
      nextRead = callback;
    },
    round: async () => {
      if (!first) t.mock.timers.tick(15000);
      first = false;
      await runtime.startWakeups();
    },
  };
}

test("unchanged idle metadata does not repeatedly resume a runtime for an unreadable handback", async (t) => {
  const f = await fixture(t);
  await f.round();
  assert.equal(f.resumes(), 1);
  for (let round = 0; round < 12; round++) await f.round();
  assert.equal(f.resumes(), 1, "quiet polling must leave the collected runtime asleep");
  assert.ok(f.runtime.store.member("hq")?.turnReadbackPending, "unverified custody is retained");
  assert.equal(f.runtime.store.member("hq")?.lastOutcome, null);
});

for (const field of ["updatedAt", "lastActivityAt", "status"] as const)
  test(`changed native ${field} retries a retained handback without losing its result`, async (t) => {
    const f = await fixture(t);
    await f.round();
    f.recover();
    f.native[field] = field === "status" ? "error" : new Date(Date.now()).toISOString();
    await f.round();
    assert.equal(f.resumes(), 2);
    const member = f.runtime.store.member("hq");
    assert.ok(member?.resultPath);
    assert.equal(member.turnReadbackPending, undefined);
    assert.equal(member.lastOutcome, "completed");
    assert.match(await readFile(member.resultPath, "utf8"), /Completed work/);
  });

test("collector-only closed and idle transitions do not reopen unchanged history", async (t) => {
  const f = await fixture(t);
  f.native.status = "closed";
  await f.round();
  for (const status of ["idle", "closed", "idle", "closed"]) {
    f.native.status = status;
    await f.round();
  }
  assert.equal(f.resumes(), 1);
});

test("a stalled idle receipt remains visible without reopening its provider", async (t) => {
  const f = await fixture(t);
  await f.round();
  t.mock.timers.setTime(Date.now() + 2 * 3600000);
  await f.round();
  assert.equal(f.resumes(), 1);
  assert.match(f.runtime.wakeupHealth.error ?? "", /hq.*pending.*without progress/i);
  assert.match(f.runtime.wakeupHealth.error ?? "", /retained history unavailable/i);
});

test("unavailable metadata cannot authorize an idle history read and is visible", async (t) => {
  const f = await fixture(t);
  f.native.updatedAt = "";
  await f.round();
  assert.equal(f.resumes(), 0);
  assert.match(f.runtime.wakeupHealth.error ?? "", /metadata.*unavailable/i);
});

test("a new retained turn generation is read even when native metadata has not changed", async (t) => {
  const f = await fixture(t);
  await f.round();
  const member = f.runtime.store.member("hq");
  assert.ok(member?.turnReadbackPending);
  assert.equal(typeof member.turnStartedAt, "number");
  const startedAt = Number(member.turnStartedAt) + 1;
  f.runtime.store.updateMember("hq", {
    turnStartedAt: startedAt,
    turnReadbackPending: { ...member.turnReadbackPending, id: "new-generation", startedAt },
  });
  await f.round();
  assert.equal(f.resumes(), 2);
  assert.equal(f.runtime.store.member("hq")?.turnReadbackPending?.startedAt, startedAt);
});

for (const item of [
  { type: "user_message", text: "Request" },
  { type: "assistant_message", text: "Response" },
  { type: "tool_call", name: "Read", status: "running" },
] as AgentTimelineItem[])
  test(`a retained quota failure finalizes on the first read with an untagged historical ${item.type}`, async (t) => {
    const f = await fixture(t);
    f.untagged(item);
    const member = f.runtime.store.member("hq");
    assert.ok(member?.turnReadbackPending);
    f.runtime.store.updateMember("hq", {
      turnReadbackPending: {
        ...member.turnReadbackPending,
        outcome: { kind: "failed", error: { message: "Quota exhausted. Resets in 81h40m49s." } },
      },
    });
    await f.round();
    assert.equal(f.resumes(), 1);
    const ended = f.runtime.store.member("hq");
    assert.ok(ended?.limited);
    assert.equal(ended.lastOutcome, "failed");
    assert.equal(ended.turnReadbackPending, undefined);
    assert.equal(f.runtime.autonomy.get("hq")?.quotaRetry, true);
    assert.ok(ended.resultPath);
    const result = JSON.parse(await readFile(ended.resultPath, "utf8"));
    assert.equal(result.readback.status, "failed-unreadable");
    assert.match(result.readback.receipt.error, /no turn identity/);
  });

test("a nonquota missing-identity receipt remains held and warns instead of resuming repeatedly", async (t) => {
  const f = await fixture(t);
  f.untagged({ type: "assistant_message", text: "Unattributed history" });
  await f.round();
  t.mock.timers.setTime(Date.now() + 2 * 3600000);
  await f.round();
  assert.equal(f.resumes(), 1);
  assert.equal(f.runtime.store.member("hq")?.lastOutcome, null);
  assert.match(f.runtime.wakeupHealth.error ?? "", /pending.*without progress.*no turn identity/);
});

test("a real quota end event bypasses an unchanged idle polling fingerprint", async (t) => {
  const f = await fixture(t);
  await f.round();
  await f.runtime.endTurn(
    f.agent,
    "turn",
    { kind: "failed", error: { message: "Quota exhausted. Resets in 1h." } },
    undefined,
    f.api,
  );
  assert.equal(f.resumes(), 2);
  assert.equal(f.runtime.store.member("hq")?.lastOutcome, "failed");
  assert.ok(f.runtime.store.member("hq")?.limited);
});

test("recovering a delayed native quota receipt preserves the member and assignment deadline", async (t) => {
  const f = await fixture(t);
  const member = f.runtime.store.member("hq");
  assert.ok(member?.turnReadbackPending);
  const originalEnd = member.turnReadbackPending.endedAt;
  f.runtime.store.updateMember("hq", {
    turnReadbackPending: {
      ...member.turnReadbackPending,
      outcome: { kind: "failed", error: { message: "Quota exhausted. Resets in 1h." } },
    },
  });
  t.mock.timers.setTime(Date.now() + 2 * 86400000);
  await f.runtime.reconcileTurnReadback("hq", f.api);
  const expected = originalEnd + 61 * 60000;
  assert.equal(f.runtime.store.member("hq")?.limited?.until, expected);
  assert.equal(f.runtime.autonomy.get("hq")?.dueAt, expected);
  assert.equal(f.runtime.autonomy.get("hq")?.updatedAt, Date.now());
});

test("an unreadable terminal receipt does not hide new input to an independently carried turn", async (t) => {
  const f = await fixture(t);
  const state = f.runtime.autonomy.get("hq");
  assert.ok(state);
  f.runtime.store.saveAutonomy(
    { ...state, revision: state.revision + 1, turnId: "turn", wakeTurnId: "turn", checkpointTurnId: null },
    state.revision,
  );
  f.onRead(() => ({
    epoch: "history",
    hasOlder: false,
    entries: [
      {
        seqEnd: 1,
        timestamp: new Date(Date.now() - 2000).toISOString(),
        item: { type: "assistant_message", text: "Unattributed terminal history" },
      },
      {
        turnId: "turn",
        seqEnd: 2,
        timestamp: new Date(Date.now() - 1000).toISOString(),
        item: { type: "user_message", text: "New work", messageId: "new-steer" },
      },
    ],
  }));
  await f.round();
  assert.equal(f.runtime.autonomy.get("hq")?.workPromptId, "new-steer");
  assert.equal(f.resumes(), 1, "one page must serve both semantic consumers");
  for (let round = 0; round < 12; round++) await f.round();
  assert.equal(f.resumes(), 1, "quiet rounds make no repeated history request");
});

for (const archive of ["member", "native", "during metadata read"])
  test(`an agent archived in ${archive} is never resumed by pending handback polling`, async (t) => {
    const f = await fixture(t);
    if (archive === "member") f.runtime.store.updateMember("hq", { archivedAt: "archived" });
    if (archive === "native") f.native.archivedAt = "archived";
    if (archive === "during metadata read")
      f.onRefresh(() => f.runtime.store.updateMember("hq", { archivedAt: "archived" }));
    await f.round();
    assert.equal(f.resumes(), 0);
    assert.ok(f.runtime.store.member("hq")?.turnReadbackPending, "archive preserves unread custody");
  });
