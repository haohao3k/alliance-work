import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { projectRoot } from "../scripts/profiles.mjs";
import { AllianceRuntime } from "../server/runtime";
import { type MemberRecord, RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("alliance-warm-");
  await writeFile(
    join(home, "profiles.json"),
    JSON.stringify({ home, root: home, profiles: { "claude-lead": { home } } }),
  );
  await writeFile(join(home, "root-instructions.md"), "isolated fixture");
  const runtime = await new AllianceRuntime(home).ready();
  const store = runtime.store;
  store.addRoom({
    id: "r",
    cwd: home,
    artifacts: home,
    title: "Warm",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  store.saveMember({
    id: "owner",
    roomId: "r",
    role: "lead",
    provider: "alliance-claude-lead",
    parentId: null,
    assignment: "brief",
    lastTurnId: "real",
    lastOutcome: "completed",
    resultPath: "real.json",
    lastTurnEndedAt: Date.now() - 46 * 60000,
    decision: "rejected",
    decisionEvidence: "review",
    decisionTurnId: "real",
    launchKey: null,
    launchHash: null,
    warm: {
      idleSince: Date.now() - 46 * 60000,
      pings: 0,
      lastAt: 0,
      messageIds: ["warm-message"],
      model: "opus",
      effort: "high",
      account: "test",
      pending: { messageId: "warm-message", at: Date.now() },
    },
    claudeAccounts: ["test"],
  });
  const agent = {
    id: "owner",
    provider: "alliance-claude-lead",
    cwd: home,
    workspaceId: "w",
    parentAgentId: null,
    title: null,
  } as PluginHookAgent;
  return { home, runtime, store, agent };
}

test("a warm turn without an autonomy record preserves the real handback and decision through both hooks", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const before = f.store.member("owner");
  await f.runtime.startTurn(f.agent, "warm-turn");
  await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, [
    { type: "user_message", messageId: "warm-message", text: "warm" },
    { type: "assistant_message", text: "OK" },
  ]);
  const after = f.store.member("owner");
  for (const field of [
    "lastTurnId",
    "lastOutcome",
    "resultPath",
    "lastTurnEndedAt",
    "decision",
    "decisionEvidence",
    "decisionTurnId",
  ] as const)
    assert.deepEqual(after?.[field], before?.[field], field);
  assert.equal(f.store.autonomyOf("owner"), undefined);
});

async function scheduler() {
  const f = await fixture();
  const m = f.store.member("owner")!;
  f.store.updateMember(m.id, { warm: { ...m.warm!, pending: undefined, messageIds: [] } });
  const live = {
    status: "idle",
    archivedAt: null as string | null,
    updatedAt: new Date(m.lastTurnEndedAt!).toISOString(),
    pendingPermissions: [] as unknown[],
    providerUnavailable: false,
    model: "opus" as string | null,
    effectiveThinkingOptionId: "high" as string | null,
    activeTurn: null as unknown,
    lastUsage: { contextWindowUsedTokens: 60000, cachedInputTokens: 60000 },
  };
  let refreshes = 0;
  let quotaCalls = 0;
  let refusal: string | null = null;
  let onRefresh = () => {};
  let quota = {
    accounts: [
      {
        id: "test",
        error: null as string | null,
        windows: [
          { label: "Session (5h)", usedPct: 10 },
          { label: "Weekly", usedPct: 20 },
        ],
      },
    ],
  };
  const sent: { text: string; options: { messageId: string; activeTurnBehavior: string } }[] = [];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => {
          refreshes++;
          onRefresh();
          return { agent: live };
        },
        send: async (text: string, options: { messageId: string; activeTurnBehavior: string }) => {
          sent.push({ text, options });
          if (refusal) throw new Error(refusal);
        },
      }),
    },
  } as unknown as PaseoApi;
  f.runtime.wakeups = new Wakeups(f.store, Date.now, async () => {
    quotaCalls++;
    return quota;
  });
  const enable = () => f.store.setKeepwarm("r", true, null);
  const patch = (value: Partial<MemberRecord>) => f.store.updateMember("owner", value);
  const add = (key: string, extra = {}) =>
    f.runtime.wakeups.add({
      key,
      roomId: "r",
      ownerId: "owner",
      reason: key,
      trigger: { kind: "time", at: Date.now() },
      delivery: "idle",
      ...extra,
    });
  return {
    ...f,
    live,
    api,
    sent,
    enable,
    patch,
    add,
    refreshes: () => refreshes,
    quotaCalls: () => quotaCalls,
    quota: (value: typeof quota) => {
      quota = value;
    },
    refuse: (value: string | null) => {
      refusal = value;
    },
    onRefresh: (callback: () => void) => {
      onRefresh = callback;
    },
  };
}

test("failed optional warm accounting preserves the real handback without rejecting the end hook", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  t.mock.method(f.runtime.wakeups.keepwarm, "complete", () => {
    throw new Error("warm accounting failed");
  });
  const before = f.store.member("owner");
  await f.runtime.startTurn(f.agent, "warm-turn");
  await assert.doesNotReject(
    f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, [
      { type: "user_message", messageId: "warm-message", text: "warm" },
      { type: "assistant_message", text: "OK" },
    ]),
  );
  const after = f.store.member("owner");
  assert.equal(after?.lastTurnId, before?.lastTurnId);
  assert.equal(after?.resultPath, before?.resultPath);
  assert.equal(after?.decision, before?.decision);
  assert.ok(after?.warm?.pending, "failed accounting stays recoverable");
});

for (const failure of ["absent", "complete", "baseline"] as const)
  test(`real turn completion survives keepwarm ${failure}`, async (t) => {
    const f = await fixture();
    t.after(() => f.runtime.close());
    f.store.updateMember("owner", { warm: undefined });
    const wakes = f.runtime.wakeups;
    if (failure === "absent") {
      f.runtime.wakeups = undefined as unknown as Wakeups;
      t.after(() => {
        f.runtime.wakeups = wakes;
      });
    } else
      t.mock.method(wakes.keepwarm, failure, () => {
        throw new Error("keepwarm unavailable");
      });
    await f.runtime.startTurn(f.agent, "real-next");
    await assert.doesNotReject(
      f.runtime.endTurn(f.agent, "real-next", { kind: "completed" }, [
        { type: "user_message", messageId: "real-input", text: "Continue work" },
        { type: "assistant_message", text: "Done" },
      ]),
    );
    assert.equal(f.store.member("owner")?.lastTurnId, "real-next");
    assert.equal(f.store.member("owner")?.lastOutcome, "completed");
    assert.ok(f.store.member("owner")?.resultPath);
  });

test("enabled eligible owners receive one short native batch with a durable plugin receipt", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  const w = f.runtime.wakeups.list().find((w) => w.key.startsWith("warm-"))!;
  assert.equal(w.state, "delivered");
  assert.equal(w.expiresAt - w.dueAt, 10 * 60000);
  assert.equal(f.sent[0].options.activeTurnBehavior, "steer");
  assert.equal(f.store.member("owner")?.pluginMessages?.[0].id, w.messageId);
  assert.equal(f.store.member("owner")?.warm?.pending?.messageId, w.messageId);
  assert.equal(f.store.member("owner")?.warm?.pings, 1);
  assert.match(f.sent[0].text, /one word/);
  assert.doesNotMatch(f.sent[0].text, /Inspect|alliance-work|ack|durable assignment/);
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
});

test("existing rooms are off by default and only the Human can change the bounded budget", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  assert.equal(f.store.keepwarm("r").enabled, false);
  assert.equal(f.store.keepwarm("r").maxPings, 3);
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 0);
  assert.equal(f.refreshes(), 0);
  assert.throws(() => f.store.setKeepwarm("r", true, "owner"), /Human/);
  for (const max of [0, 6, 1.5, Number.NaN]) assert.throws(() => f.store.setKeepwarm("r", true, null, max));
  f.store.setKeepwarm("r", true, null, 5);
  assert.equal(f.store.keepwarm("r").maxPings, 5);
  f.store.setKeepwarm("r", false, null);
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 0);
});

const exclusions: [string, (f: Awaited<ReturnType<typeof scheduler>>) => void][] = [
  ["non-Claude harness", (f) => f.patch({ provider: "alliance-codex-lead" })],
  ["peer", (f) => f.patch({ role: "peer", provider: "alliance-claude-peer" })],
  ["lens", (f) => f.patch({ role: "lens", provider: "alliance-claude-lens" })],
  ...["active", "paused", "blocked", "review", "archived"].map(
    (phase) =>
      [
        phase,
        (f: Awaited<ReturnType<typeof scheduler>>) => {
          const a = f.runtime.autonomy.start("owner");
          f.store.saveAutonomy(
            { ...a, phase: phase as typeof a.phase, revision: a.revision + 1 },
            a.revision,
          );
        },
      ] as [string, (f: Awaited<ReturnType<typeof scheduler>>) => void],
  ),
  ["accepted", (f) => f.patch({ decision: "accepted" })],
  ["archived member", (f) => f.patch({ archivedAt: "archived" })],
  ["keep-only", (f) => f.patch({ keep: { by: "Human", at: "now" } })],
  ["provider limited", (f) => f.patch({ limited: { until: Date.now() + 60000, messageId: null } })],
  [
    "sign-in held",
    (f) =>
      f.patch({
        signIn: { until: Date.now() + 60000, since: 0, lastAt: 0, failures: 3, holds: 1, reason: "signin" },
      }),
  ],
  ["unknown baseline", (f) => f.patch({ warm: undefined })],
  ["unknown account", (f) => f.patch({ claudeAccounts: undefined })],
  ["switching accounts", (f) => f.patch({ claudeAccounts: ["test", "other"] })],
  ["changed account", (f) => f.patch({ claudeAccounts: ["other"] })],
  ["spent budget", (f) => f.patch({ warm: { ...f.store.member("owner")!.warm!, pings: 3 } })],
  ["idle under 45 minutes", (f) => f.patch({ lastTurnEndedAt: Date.now() - 44 * 60000 })],
  [
    "idle 50 minutes",
    (f) => {
      const at = Date.now() - 50 * 60000;
      f.patch({ lastTurnEndedAt: at, warm: { ...f.store.member("owner")!.warm!, idleSince: at } });
      f.live.updatedAt = new Date(at).toISOString();
    },
  ],
  [
    "idle at least 55 minutes",
    (f) => {
      const at = Date.now() - 55 * 60000;
      f.patch({ lastTurnEndedAt: at, warm: { ...f.store.member("owner")!.warm!, idleSince: at } });
      f.live.updatedAt = new Date(at).toISOString();
    },
  ],
  [
    "recent native activity",
    (f) => {
      f.live.updatedAt = new Date().toISOString();
    },
  ],
  [
    "missing native idle timestamp",
    (f) => {
      f.live.updatedAt = "";
    },
  ],
  [
    "running",
    (f) => {
      f.live.status = "running";
    },
  ],
  [
    "closed",
    (f) => {
      f.live.status = "closed";
    },
  ],
  [
    "native archived",
    (f) => {
      f.live.archivedAt = "archived";
    },
  ],
  [
    "pending permission",
    (f) => {
      f.live.pendingPermissions = [{}];
    },
  ],
  [
    "unavailable provider",
    (f) => {
      f.live.providerUnavailable = true;
    },
  ],
  [
    "active native turn",
    (f) => {
      f.live.activeTurn = { turnId: "new" };
    },
  ],
  [
    "small context",
    (f) => {
      f.live.lastUsage.contextWindowUsedTokens = 59999;
    },
  ],
  [
    "missing context",
    (f) => {
      delete (f.live.lastUsage as { contextWindowUsedTokens?: number }).contextWindowUsedTokens;
    },
  ],
  [
    "changed model",
    (f) => {
      f.live.model = "sonnet";
    },
  ],
  [
    "changed effort",
    (f) => {
      f.live.effectiveThinkingOptionId = "low";
    },
  ],
  [
    "missing effort",
    (f) => {
      delete (f.live as { effectiveThinkingOptionId?: string | null }).effectiveThinkingOptionId;
    },
  ],
  [
    "credits",
    (f) =>
      f.quota({
        accounts: [
          {
            id: "test",
            error: null,
            windows: [
              { label: "Session (5h)", usedPct: 100 },
              { label: "Weekly", usedPct: 10 },
            ],
          },
        ],
      }),
  ],
  [
    "missing quota window",
    (f) => f.quota({ accounts: [{ id: "test", error: null, windows: [{ label: "Weekly", usedPct: 10 }] }] }),
  ],
  ["unknown quota", (f) => f.quota({ accounts: [] })],
  ["quota error", (f) => f.quota({ accounts: [{ id: "test", error: "offline", windows: [] }] })],
  [
    "readback pending",
    (f) =>
      f.patch({
        turnReadbackPending: {
          id: "p",
          agent: f.agent,
          turnId: "old",
          endedAt: 1,
          outcome: { kind: "completed" },
          error: "offline",
        },
      }),
  ],
];
for (const [name, exclude] of exclusions)
  test(`keepwarm fails closed: ${name}`, async (t) => {
    const f = await scheduler();
    t.after(() => f.runtime.close());
    f.enable();
    exclude(f);
    await f.runtime.wakeups.tick(f.api);
    assert.equal(f.sent.length, 0);
  });

test("held quota notices ride the warm batch and remain unheld after it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.add("quota-other", { expiresAt: Date.now() + 60 * 60000 });
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /quota-other/);
  assert.equal(f.store.wakeup("quota-other")?.messageId, f.store.member("owner")?.warm?.pending?.messageId);
  const messageId = f.sent[0].options.messageId;
  f.runtime.wakeups.keepwarm.complete(
    "owner",
    [
      { type: "user_message", messageId, text: "warm" },
      { type: "assistant_message", text: "OK" },
    ],
    f.live,
  );
  t.mock.timers.setTime(Date.now() + 5 * 60000);
  f.add("quota-later", { expiresAt: Date.now() + 60 * 60000 });
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 2);
  assert.equal(f.store.wakeup("quota-later")?.state, "delivered");
});

for (const withAutonomy of [false, true])
  test(`warm hooks preserve review and reminder state with autonomy=${withAutonomy}`, async (t) => {
    const f = await scheduler();
    t.after(() => f.runtime.close());
    f.enable();
    if (withAutonomy) {
      const a = f.runtime.autonomy.start("owner");
      f.store.saveAutonomy({ ...a, phase: "waiting", revision: a.revision + 1 }, a.revision);
    }
    f.store.saveMember({ ...f.store.member("owner")!, id: "parent", warm: undefined });
    f.patch({ parentId: "parent", decision: "open", remind: { turnId: "real", owners: {}, at: 0 } });
    const review = f.add("auto-review-real", {
      ownerId: "parent",
      trigger: { kind: "turn", agentId: "owner", turnId: "real" },
      delivery: "pull",
    });
    const before = f.store.member("owner")!;
    const autonomy = f.store.autonomyOf("owner");
    await f.runtime.wakeups.tick(f.api);
    assert.equal(f.sent.length, 1);
    const messageId = f.sent[0].options.messageId;
    await f.runtime.startTurn(f.agent, "warm-turn", f.api);
    await f.runtime.autonomy.tick(f.api);
    await f.runtime.lifecycle.sweep(f.api);
    assert.deepEqual(f.store.autonomyOf("owner"), autonomy);
    assert.equal(f.store.member("owner")?.lastTurnId, "real");
    await f.runtime.endTurn(
      f.agent,
      "warm-turn",
      { kind: "completed" },
      [
        { type: "user_message", messageId, text: "warm" },
        { type: "assistant_message", text: "OK" },
      ],
      f.api,
    );
    const after = f.store.member("owner")!;
    for (const key of [
      "lastTurnId",
      "lastOutcome",
      "resultPath",
      "lastTurnEndedAt",
      "turnStartedAt",
      "turnInputCursor",
      "decision",
      "decisionEvidence",
      "decisionTurnId",
      "remind",
    ] as const)
      assert.deepEqual(after[key], before[key], key);
    assert.deepEqual(f.store.autonomyOf("owner"), autonomy);
    await f.runtime.wakeups.tick();
    assert.notEqual(f.store.wakeup(review.key)?.note, "Turn superseded or decided");
    assert.equal(f.runtime.wakeups.list().filter((w) => /stale-decision|auto-review/.test(w.key)).length, 1);
  });

test("interrupted sends with proven absent native input release the warm hold", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  t.after(() => f.runtime.close());
  t.mock.timers.setTime(Date.now() + 60000);
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle" } }),
        timeline: { refetch: async () => ({ entries: [], hasOlder: false }) },
      }),
    },
  } as unknown as PaseoApi;
  await f.runtime.wakeups.keepwarm.recover(api);
  assert.equal(f.store.member("owner")?.warm?.pending, undefined);
  assert.equal(f.store.member("owner")?.lastTurnId, "real");
});

test("lost warm end hooks recover from native completion without replacing the real handback", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  t.after(() => f.runtime.close());
  const at = new Date().toISOString();
  await f.runtime.startTurn(f.agent, "warm-turn");
  t.mock.timers.setTime(Date.now() + 60000);
  const messages = [
    { type: "user_message", messageId: "warm-message", text: "warm" },
    { type: "assistant_message", text: "OK" },
  ];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle" } }),
        timeline: {
          refetch: async () => ({
            entries: messages.map((item) => ({ timestamp: at, turnId: "warm-turn", item })),
            hasOlder: false,
          }),
        },
      }),
    },
  } as unknown as PaseoApi;
  await f.runtime.wakeups.keepwarm.recover(api);
  assert.equal(f.store.member("owner")?.warm?.pending, undefined);
  assert.equal(f.store.member("owner")?.lastTurnId, "real");
});

test("permanently unavailable warm readback stays visibly held and real input can reclassify it", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  t.after(() => f.runtime.close());
  t.mock.timers.setTime(Date.now() + 60000);
  let attempts = 0;
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle" } }),
        timeline: {
          refetch: async () => {
            attempts++;
            throw new Error("offline");
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  await f.runtime.wakeups.keepwarm.recover(api);
  await f.runtime.wakeups.keepwarm.recover(api);
  assert.equal(attempts, 2);
  assert.match(f.store.member("owner")?.warm?.pending?.error ?? "", /retrying/);
  await f.runtime.startTurn(f.agent, "human-work");
  await f.runtime.endTurn(f.agent, "human-work", { kind: "completed" }, [
    { type: "user_message", messageId: "human", text: "work" },
    { type: "assistant_message", text: "done" },
  ]);
  assert.equal(f.store.member("owner")?.warm?.pending, undefined);
  assert.equal(f.store.member("owner")?.lastTurnId, "human-work");
  assert.equal(f.store.member("owner")?.decision, "open");
});

for (const withAutonomy of [false, true])
  test(`a real prompt during a pending warm generation remains ordinary work, autonomy=${withAutonomy}`, async (t) => {
    const f = await fixture();
    t.after(() => f.runtime.close());
    if (withAutonomy) {
      const a = f.runtime.autonomy.start("owner");
      f.store.saveAutonomy({ ...a, phase: "waiting", revision: a.revision + 1 }, a.revision);
    }
    await f.runtime.startTurn(f.agent, "real-racing-turn");
    await f.runtime.endTurn(f.agent, "real-racing-turn", { kind: "completed" }, [
      { type: "user_message", messageId: "warm-message", text: "warm" },
      { type: "user_message", messageId: "human-message", text: "real work" },
      { type: "assistant_message", text: "real result" },
    ]);
    assert.equal(f.store.member("owner")?.lastTurnId, "real-racing-turn");
    assert.equal(f.store.member("owner")?.decision, "open");
    assert.equal(f.store.member("owner")?.lastOutcome, "completed");
    assert.notEqual(f.store.member("owner")?.resultPath, "real.json");
    if (withAutonomy) {
      assert.equal(f.store.autonomyOf("owner")?.phase, "waiting");
      assert.equal(f.store.autonomyOf("owner")?.turnId, "real-racing-turn");
    }
  });

test("unknown prompt readback holds the real handback until canonical input recovers", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  await f.runtime.startTurn(f.agent, "warm-turn");
  await assert.rejects(
    f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, []),
    /prompt identity unknown/,
  );
  assert.equal(f.store.member("owner")?.lastTurnId, "real");
  assert.ok(f.store.member("owner")?.turnReadbackPending);
  await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, [
    { type: "user_message", messageId: "warm-message", text: "warm" },
    { type: "assistant_message", text: "OK" },
  ]);
  assert.equal(f.store.member("owner")?.turnReadbackPending, undefined);
  assert.equal(f.store.member("owner")?.lastTurnId, "real");
});

test("native canonical end readback after restart preserves a warm owner's real turn", async (t) => {
  const f = await fixture();
  await f.runtime.startTurn(f.agent, "warm-turn");
  const at = new Date().toISOString();
  await f.runtime.close();
  const runtime = await new AllianceRuntime(f.home).ready();
  t.after(() => runtime.close());
  const messages: AgentTimelineItem[] = [
    { type: "user_message", messageId: "warm-message", text: "warm" },
    { type: "assistant_message", text: "OK" },
  ];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: { status: "idle", lastUsage: { contextWindowUsedTokens: 60000, cachedInputTokens: 60000 } },
        }),
        timeline: {
          refetch: async () => ({
            epoch: "e",
            hasOlder: false,
            entries: messages.map((item, i) => ({ item, timestamp: at, turnId: "warm-turn", seqEnd: i + 1 })),
          }),
        },
      }),
    },
  } as unknown as PaseoApi;
  await runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, undefined, api);
  const m = runtime.store.member("owner");
  assert.equal(m?.lastTurnId, "real");
  assert.equal(m?.decision, "rejected");
  assert.equal(m?.warm?.pending, undefined);
  assert.equal(m?.turnReadbackPending, undefined);
});

test("a delayed warm end cannot overwrite a later real turn or renew its warm clock", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", messageId: "warm-message", text: "warm" },
    { type: "assistant_message", text: "OK" },
  ];
  await f.runtime.startTurn(f.agent, "warm-turn");
  await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, timeline);
  await f.runtime.startTurn(f.agent, "real-next");
  const before = f.store.member("owner");
  await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, timeline);
  assert.deepEqual(f.store.member("owner"), before);
});

test("an old warm message remains transparent while preserving a newer pending ping", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  t.after(() => f.runtime.close());
  f.store.setKeepwarm("r", true, null);
  t.mock.timers.setTime(Date.now() + 45 * 60000);
  f.runtime.wakeups.keepwarm.claim("owner", "new-warm-message", 60000);
  const before = f.store.member("owner");
  assert.equal(
    f.runtime.wakeups.keepwarm.complete(
      "owner",
      [
        { type: "user_message", messageId: "warm-message", text: "old warm" },
        { type: "assistant_message", text: "OK" },
      ],
      { status: "idle", lastUsage: { contextWindowUsedTokens: 60000, cachedInputTokens: 120000 } },
    ),
    true,
  );
  assert.deepEqual(f.store.member("owner"), before);
  assert.equal(f.store.keepwarm("r").enabled, true);
});

for (const nextTurnId of ["new-warm-turn", "warm-turn"])
  test(`a delayed prior end preserves the next warm generation ${nextTurnId}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture();
    t.after(() => f.runtime.close());
    const oldTimeline: AgentTimelineItem[] = [
      { type: "user_message", messageId: "warm-message", text: "old warm" },
      { type: "assistant_message", text: "OK" },
    ];
    await f.runtime.startTurn(f.agent, "warm-turn");
    await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, oldTimeline);
    t.mock.timers.setTime(Date.now() + 45 * 60000);
    f.runtime.wakeups.keepwarm.claim("owner", "new-warm-message", 60000);
    await f.runtime.startTurn(f.agent, nextTurnId);
    const before = f.store.member("owner");
    await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, oldTimeline);
    assert.deepEqual(f.store.member("owner"), before);
  });

test("truncated warm recovery cannot hide an earlier tool call in the same generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  t.after(() => f.runtime.close());
  f.store.setKeepwarm("r", true, null);
  const at = new Date().toISOString();
  await f.runtime.startTurn(f.agent, "warm-turn");
  const messages: AgentTimelineItem[] = [
    {
      type: "tool_call",
      callId: "earlier-tool",
      name: "shell",
      detail: { type: "shell", command: "true" },
      status: "completed",
      error: null,
    },
    { type: "user_message", messageId: "warm-message", text: "warm" },
    ...Array.from({ length: 98 }, () => ({ type: "reasoning" as const, text: "observed reasoning" })),
    { type: "assistant_message", text: "OK" },
  ];
  const entries = messages.map((item, i) => ({ timestamp: at, turnId: "warm-turn", item, seqEnd: i + 1 }));
  let earlierPages = 0;
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle" } }),
        timeline: {
          refetch: async ({ direction }: { direction: string }) => {
            const before = direction === "before";
            if (before) earlierPages++;
            return {
              entries: before ? entries.slice(0, 1) : entries.slice(-100),
              hasOlder: !before,
              epoch: "e",
              startCursor: { epoch: "e", seq: before ? 1 : 2 },
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  t.mock.timers.setTime(Date.now() + 60000);
  const before = f.store.member("owner")?.warm;
  await f.runtime.wakeups.keepwarm.recover(api);
  const held = f.store.member("owner")?.warm;
  assert.equal(held?.pending?.messageId, "warm-message");
  assert.equal(held?.lastAt, before?.lastAt);
  assert.match(held?.pending?.error ?? "", /truncated|incomplete/);
  await f.runtime.endTurn(f.agent, "warm-turn", { kind: "completed" }, undefined, api);
  assert.equal(earlierPages, 1);
  assert.equal(f.store.member("owner")?.warm?.pending, undefined);
  assert.equal(f.store.keepwarm("r").enabled, false);
  assert.match(f.store.keepwarm("r").disabledReason ?? "", /called a tool/);
});

for (const real of [false, true])
  test(`canonical input reconciliation before a checkpoint preserves autonomy, real input=${real}`, async (t) => {
    const f = await fixture();
    t.after(() => f.runtime.close());
    const a = f.runtime.autonomy.start("owner");
    f.store.saveAutonomy({ ...a, phase: "waiting", revision: a.revision + 1 }, a.revision);
    await f.runtime.startTurn(f.agent, "racing");
    const before = f.store.autonomyOf("owner");
    const messages: AgentTimelineItem[] = [
      { type: "user_message", messageId: "warm-message", text: "warm" },
      ...(real ? [{ type: "user_message" as const, messageId: "human", text: "work" }] : []),
    ];
    const api = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: async () => ({
              epoch: "e",
              hasOlder: false,
              entries: messages.map((item, i) => ({
                item,
                turnId: "racing",
                timestamp: new Date().toISOString(),
                seqEnd: i + 1,
              })),
            }),
          },
        }),
      },
    } as unknown as PaseoApi;
    if (real) {
      await f.runtime.checkpoint("owner", "waiting", "real work waits", "racing", api);
      assert.equal(f.store.member("owner")?.lastTurnId, "racing");
      assert.equal(f.store.member("owner")?.decision, "open");
      assert.equal(f.store.member("owner")?.warm?.pending, undefined);
      assert.equal(f.store.autonomyOf("owner")?.reason, "real work waits");
    } else {
      await assert.rejects(
        f.runtime.checkpoint("owner", "waiting", "warm cannot change old work", undefined, api),
        /Keepwarm input is still pending/,
      );
      assert.deepEqual(f.store.autonomyOf("owner"), before);
      assert.equal(f.store.member("owner")?.lastTurnId, "real");
    }
  });

test("immediate checkpoint fails closed on unavailable canonical warm input", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const a = f.runtime.autonomy.start("owner");
  await f.runtime.startTurn(f.agent, "racing");
  const api = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => {
            throw new Error("history offline");
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  await assert.rejects(f.runtime.checkpoint("owner", "review", "result", undefined, api), /history offline/);
  assert.deepEqual(f.store.autonomyOf("owner"), a);
  assert.equal(f.store.member("owner")?.lastTurnId, "real");
});

test("a provider limit on another same-account member blocks keepwarm", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.store.saveMember({
    ...f.store.member("owner")!,
    id: "limited-peer",
    role: "peer",
    provider: "alliance-claude-peer",
    warm: undefined,
    limited: { until: Date.now() + 60000, messageId: null, account: "test" },
  });
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 0);
  assert.equal(f.refreshes(), 0);
});

test("actionable plugin notices retain normal delivery instead of riding a warm ping", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.add("silent-peer");
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Alliance wakeups/);
  assert.equal(f.runtime.wakeups.list().filter((w) => w.key.startsWith("warm-")).length, 0);
});

test("real-turn readback resets the warm budget and records only known native model/effort/account", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.patch({ warm: { ...f.store.member("owner")!.warm!, pings: 3 } });
  await f.runtime.startTurn(f.agent, "real-next");
  await f.runtime.endTurn(
    f.agent,
    "real-next",
    { kind: "completed" },
    [
      { type: "user_message", messageId: "human", text: "work" },
      { type: "assistant_message", text: "done" },
    ],
    f.api,
  );
  const warm = f.store.member("owner")?.warm;
  assert.equal(warm?.pings, 0);
  assert.equal(warm?.model, "opus");
  assert.equal(warm?.effort, "high");
  assert.equal(warm?.account, "test");
  assert.equal(warm?.idleSince, f.store.member("owner")?.lastTurnEndedAt);
  delete (f.live as { effectiveThinkingOptionId?: string | null }).effectiveThinkingOptionId;
  await f.runtime.startTurn(f.agent, "real-unknown");
  await f.runtime.endTurn(f.agent, "real-unknown", { kind: "completed" }, [], f.api);
  assert.equal(f.store.member("owner")?.warm, undefined);
});

test("refused warm sends retain budget and cooldown instead of retrying in a storm", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.refuse("Agent not found: owner");
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  assert.equal(f.store.member("owner")?.warm?.pending, undefined);
  assert.equal(f.store.member("owner")?.warm?.pings, 1);
  for (let i = 0; i < 20; i++) {
    t.mock.timers.setTime(Date.now() + 15000);
    await f.runtime.wakeups.tick(f.api);
  }
  assert.equal(f.sent.length, 1);
  assert.equal(f.runtime.wakeups.list()[0].state, "expired");
  t.mock.timers.setTime(Date.now() + 41 * 60000);
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  assert.equal(f.quotaCalls(), 1);
  assert.equal(f.store.member("owner")?.warm?.lastAt, 0);
});

test("quota checks are cached per account for ten minutes", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  await f.runtime.wakeups.keepwarm.prepare(f.api);
  await f.runtime.wakeups.keepwarm.prepare(f.api);
  assert.equal(f.quotaCalls(), 1);
});

test("the pilot budget sends at most three warm turns before the next real turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  for (let i = 0; i < 3; i++) {
    await f.runtime.wakeups.tick(f.api);
    assert.equal(f.sent.length, i + 1);
    const messageId = f.sent[i].options.messageId;
    f.runtime.wakeups.keepwarm.complete(
      "owner",
      [
        { type: "user_message", messageId, text: "warm" },
        { type: "assistant_message", text: "OK" },
      ],
      f.live,
    );
    t.mock.timers.setTime(Date.now() + 45 * 60000);
  }
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 3);
  assert.equal(f.store.member("owner")?.warm?.pings, 3);
});

test("a real item arriving during native eligibility refresh suppresses the ping", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.onRefresh(() => {
    if (!f.store.wakeup("racing-work")) f.add("racing-work");
  });
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.runtime.wakeups.list().filter((w) => w.key.startsWith("warm-")).length, 0);
});

test("keepwarm configuration is readable without migration in read-only stores", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  const db = new DatabaseSync(join(f.home, "rooms.sqlite"));
  db.exec(
    "CREATE TABLE store_compat(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO store_compat VALUES('write_level','2')",
  );
  db.close();
  const reader = new RoomStore(f.home);
  t.after(() => reader.close());
  assert.ok(reader.readOnly);
  assert.equal(reader.keepwarm("r").enabled, true);
  assert.throws(() => reader.setKeepwarm("r", false, null), /cannot write/);
  await new Wakeups(reader).tick(f.api);
  assert.equal(f.sent.length, 0);
});

test("read-only legacy stores without the new table still expose disabled defaults", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const db = new DatabaseSync(join(f.home, "rooms.sqlite"));
  db.exec(
    "DROP TABLE room_keepwarm; CREATE TABLE store_compat(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO store_compat VALUES('write_level','2')",
  );
  db.close();
  const reader = new RoomStore(f.home);
  t.after(() => reader.close());
  assert.equal(reader.keepwarm("r").enabled, false);
});

test("the prior store reader opens and updates a store containing keepwarm additions", async (t) => {
  try {
    execFileSync("git", ["-C", projectRoot, "cat-file", "-e", "64eb124^{commit}"], { stdio: "ignore" });
  } catch {
    t.skip("commit 64eb124 (prior keepwarm store reader) is not in this checkout");
    return;
  }
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  const old = await temporary("alliance-warm-old-");
  const archive = execFileSync("git", ["archive", "64eb124", "server", "shared"], {
    cwd: projectRoot,
  });
  execFileSync("tar", ["-x", "-C", old], { input: archive });
  await symlink(join(projectRoot, "node_modules"), join(old, "node_modules"));
  await writeFile(join(old, "package.json"), JSON.stringify({ type: "module" }));
  const script = join(old, "read.mjs");
  await writeFile(
    script,
    `import { RoomStore } from './server/store.ts';
    const s = new RoomStore(process.argv[2]);
    s.updateMember('owner', { assignment: 'changed by old writer' });
    console.log(JSON.stringify({ member: s.member('owner'), rooms: s.rooms().length })); s.close();`,
  );
  const result = JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", script, f.home], {
      cwd: projectRoot,
      encoding: "utf8",
    }).trim(),
  );
  assert.equal(result.rooms, 1);
  assert.equal(result.member.warm.model, "opus");
  assert.equal(f.store.member("owner")?.assignment, "changed by old writer");
  assert.equal(f.store.keepwarm("r").enabled, true);
});

test("CLI prevents agent configuration and validates max before connecting to a daemon", () => {
  for (const args of [
    ["keepwarm", "--room", "r", "on"],
    ["keepwarm", "--room", "r", "off"],
  ]) {
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/cli.mjs", ...args], {
          env: { ...process.env, PASEO_AGENT_ID: "owner" },
          stdio: "pipe",
        }),
      (error: unknown) => /belong to the Human/.test(String((error as { stderr: Buffer }).stderr)),
    );
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/cli.mjs", "keepwarm", "--room", "r", "on", "--max", "6"], {
        stdio: "pipe",
      }),
    (error: unknown) => /Usage: alliance-work keepwarm/.test(String((error as { stderr: Buffer }).stderr)),
  );
});

test("pending real work is delivered normally and suppresses a warm ping", async (t) => {
  const f = await scheduler();
  t.after(() => f.runtime.close());
  f.enable();
  f.add("real-work");
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.length, 1);
  assert.equal(f.runtime.wakeups.list().filter((w) => w.key.startsWith("warm-")).length, 0);
  assert.match(f.sent[0].text, /Inspect the room/);
  assert.equal(f.quotaCalls(), 0);
});

for (const [name, extra, usage] of [
  ["tool call", [{ type: "tool_call", callId: "tool", name: "shell", input: {} }], undefined],
  ["two assistant responses", [{ type: "assistant_message", text: "another" }], undefined],
  ["multiple requests in usage", [], { contextWindowUsedTokens: 60000, cachedInputTokens: 90001 }],
] as const)
  test(`warm safety stops on ${name}, except a batch containing a notice`, async (t) => {
    for (const withNotice of [false, true]) {
      const f = await scheduler();
      t.after(() => f.runtime.close());
      f.enable();
      if (withNotice) f.add("quota-other", { expiresAt: Date.now() + 60000 });
      await f.runtime.wakeups.tick(f.api);
      const messageId = f.sent[0].options.messageId;
      const timeline = [
        { type: "user_message", messageId, text: "warm" },
        { type: "assistant_message", text: "OK" },
        ...extra,
      ] as AgentTimelineItem[];
      assert.equal(
        f.runtime.wakeups.keepwarm.complete(
          "owner",
          timeline,
          usage ? { ...f.live, lastUsage: usage } : f.live,
        ),
        true,
      );
      assert.equal(f.store.keepwarm("r").enabled, withNotice);
      if (!withNotice) {
        assert.match(f.store.keepwarm("r").disabledReason!, /Keepwarm turn/);
        f.enable();
        assert.equal(f.store.keepwarm("r").disabledReason, undefined);
      }
    }
  });

test("warm and provider notices are not work that prevents inferred handback", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  for (const prefix of ["warm", "quota", "silent", "permission", "signin"]) {
    f.runtime.wakeups.add({
      key: `${prefix}-owner-1`,
      roomId: "r",
      ownerId: "owner",
      reason: "notice",
      trigger: { kind: "time", at: Date.now() + 60000 },
      delivery: "idle",
    });
    assert.equal(f.runtime.autonomy.wakeSource("owner"), false, prefix);
  }
});

test("interrupted warm delivery expires at restart without requiring an ack", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const w = f.runtime.wakeups.add({
    key: "warm-owner-1",
    roomId: "r",
    ownerId: "owner",
    reason: "warm",
    trigger: { kind: "time", at: Date.now() },
    delivery: "idle",
  });
  f.store.claimWakeups([w], "warm-message", Date.now());
  await f.runtime.wakeups.tick();
  assert.equal(f.store.wakeup(w.key)?.state, "expired");
});
