import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { AllianceRuntime } from "../server/runtime";
import { temporary } from "./temp";

function present<T>(value: T | null | undefined): T {
  assert.ok(value);
  return value;
}

/** Paseo 0.12 recordAcceptedSteer: one canonical prompt, the existing turn ID, no start hook. */
async function fixture(t: TestContext) {
  const initial = Date.parse("2026-10-24T01:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: initial });
  const home = await temporary("alliance-steered-handback-");
  await writeFile(join(home, "profiles.json"), JSON.stringify({ home, root: home, profiles: {} }));
  let runtime = await new AllianceRuntime(home).ready();
  runtime.store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Rework",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  for (const [id, role, parentId] of [
    ["owner", "lead", null],
    ["peer", "peer", "owner"],
  ] as const)
    runtime.store.saveMember({
      id,
      role,
      parentId,
      provider: `alliance-claude-${role}`,
      roomId: "room",
      assignment: "brief.md",
      cwd: home,
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      launchKey: null,
      launchHash: null,
    });
  const agent = {
    id: "peer",
    provider: "alliance-claude-peer",
    cwd: home,
    workspaceId: "w",
    parentAgentId: "owner",
    title: null,
  };
  type Row = { seq: number; timestamp: string; turnId: string; item: AgentTimelineItem };
  const rows: Row[] = [];
  let active: { turnId: string; startedAt: string } | null = null;
  let failRead = false;
  let beforeRead: (() => void) | undefined;
  const sent: { id: string; text: string; messageId: string }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: {
            status: id === "peer" && active ? "running" : "idle",
            activeTurn: id === "peer" ? active : null,
            archivedAt: null,
            pendingPermissions: [],
          },
        }),
        send: async (text: string, options: { messageId: string }) => {
          sent.push({ id, text, messageId: options.messageId });
        },
        timeline: {
          refetch: async (options?: { cursor?: { seq: number }; limit?: number }) => {
            beforeRead?.();
            if (failRead) throw new Error("native timeline disconnected");
            const eligible = rows.filter((r) => !options?.cursor || r.seq < options.cursor.seq);
            const entries = eligible.slice(-(options?.limit ?? 100));
            const last = entries.at(-1);
            return {
              epoch: "session",
              entries: entries.map(({ seq, ...row }) => ({
                ...row,
                seqStart: seq,
                seqEnd: seq,
                provider: "alliance-claude-peer",
                sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
                collapsed: ["identity"],
              })),
              hasOlder: eligible.length > entries.length,
              startCursor: entries[0] ? { epoch: "session", seq: entries[0].seq } : undefined,
              endCursor: last ? { epoch: "session", seq: last.seq } : undefined,
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  const advance = (ms = 1000) => t.mock.timers.setTime(Date.now() + ms);
  const append = (turnId: string, item: AgentTimelineItem) =>
    rows.push({ seq: rows.length + 1, turnId, timestamp: new Date().toISOString(), item });
  const prompt = (messageId: string, text = "Owner requests a revised candidate") => {
    assert.ok(active);
    append(active.turnId, { type: "user_message", text, messageId, clientMessageId: messageId });
  };
  const begin = async (turnId: string, delay = 0, beforeHook?: () => void) => {
    advance();
    active = { turnId, startedAt: new Date().toISOString() };
    beforeHook?.();
    advance(delay);
    await runtime.startTurn(agent, turnId, api);
  };
  const end = async (
    text = "Revised candidate ready",
    outcome: PluginTurnOutcome = { kind: "completed" },
  ) => {
    assert.ok(active);
    const turnId = active.turnId;
    advance();
    append(turnId, { type: "assistant_message", text, messageId: `result-${rows.length}` });
    active = null;
    await runtime.endTurn(
      agent,
      turnId,
      outcome,
      rows.map((r) => r.item),
      api,
    );
  };
  runtime.autonomy.start("peer");
  await begin("handback-1");
  prompt("initial", "Implement candidate");
  runtime.autonomy.checkpoint("peer", "review", "First candidate ready", "handback-1");
  await end("First candidate ready");
  runtime.store.updateMember("peer", {
    decision: "accepted",
    decisionTurnId: "handback-1",
    decisionEvidence: "accepted.json",
    decisionAt: new Date().toISOString(),
  });
  const original = present(runtime.store.member("peer"));
  return {
    api,
    agent,
    rows,
    sent,
    begin,
    end,
    prompt,
    advance,
    original,
    runtime: () => runtime,
    member: () => present(runtime.store.member("peer")),
    state: () => present(runtime.autonomy.get("peer")),
    onRead: (fn?: () => void) => {
      beforeRead = fn;
    },
    failRead: (value: boolean) => {
      failRead = value;
    },
    reload: async () => {
      await runtime.close();
      runtime = await new AllianceRuntime(home).ready();
    },
    close: () => runtime.close(),
  };
}

test("an owner steer in an autonomous turn publishes a new handback without a checkpoint", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.prompt("owner-steer");
    await f.end();
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().decisionEvidence, null);
    assert.equal(f.state().phase, "review");
    assert.equal(f.runtime().autonomy.carrying("peer"), false);
    assert.notEqual(f.member().resultPath, f.original.resultPath);
    assert.match(await readFile(present(f.member().resultPath), "utf8"), /Revised candidate ready/);
    await f.runtime().endTurn(f.agent, "handback-1", { kind: "completed" }, [], f.api);
    assert.equal(
      f.member().lastTurnId,
      "autonomous-turn-2",
      "a delayed old completion cannot restore the old handback",
    );
  } finally {
    await f.close();
  }
});

test("acceptance refuses the old candidate while its carried turn is doing owner rework", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.prompt("owner-steer");
    await assert.rejects(
      f
        .runtime()
        .disposition("peer", "accepted", "old-candidate", "unused-report", undefined, "owner", f.api),
      /mid-turn|new turn|new work/i,
    );
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastOutcome, null);
    assert.equal(f.member().resultPath, null);
  } finally {
    await f.close();
  }
});

test("a steer arriving during decision readback wins over the old handback decision", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    let reads = 0;
    f.onRead(() => {
      if (++reads === 2) f.prompt("racing-owner-steer");
    });
    await assert.rejects(
      f.runtime().disposition("peer", "rejected", "old-candidate", "Rework", undefined, "owner", f.api),
      /mid-turn|new turn|new work/i,
    );
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
  } finally {
    await f.close();
  }
});

test("background work preserves its handback across reload and a reused provider turn ordinal", async (t) => {
  const f = await fixture(t);
  try {
    // Old history may carry the same provider ordinal after a process/session reload.
    f.rows.push({
      seq: f.rows.length + 1,
      timestamp: "2026-10-23T01:00:00Z",
      turnId: "autonomous-turn-2",
      item: { type: "user_message", text: "Old work", clientMessageId: "old-owner-steer" },
    });
    await f.begin("autonomous-turn-2", 5000);
    await f.reload();
    await f.end("Background monitor still running");
    assert.equal(f.member().lastTurnId, f.original.lastTurnId);
    assert.equal(f.member().resultPath, f.original.resultPath);
    assert.equal(f.member().decision, "accepted");
    await f.begin("autonomous-turn-2", 5000);
    f.prompt("fresh-owner-steer");
    await f.end();
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
  } finally {
    await f.close();
  }
});

test("an acknowledged repeating wake keeps its identity after messageId clears; a later owner steer does not", async (t) => {
  const f = await fixture(t);
  try {
    const wakes = f.runtime().wakeups;
    wakes.add({
      key: "build-watch",
      roomId: "room",
      ownerId: "peer",
      reason: "Check build",
      trigger: { kind: "time", at: Date.now() },
      everyMs: 60000,
      maxRuns: 3,
    });
    await wakes.tick(f.api);
    const wake = f.sent.find((s) => s.id === "peer");
    assert.ok(wake);
    await f.begin("foreground-turn-2");
    f.prompt(wake.messageId, wake.text);
    const delivered = present(wakes.list().find((w) => w.key === "build-watch"));
    wakes.action(delivered.key, "peer", delivered.revision, "ack");
    assert.equal(wakes.list().find((w) => w.key === "build-watch")?.messageId, null);
    await f.reload();
    await f.end("Wake read");
    assert.equal(f.member().decision, "accepted");
    assert.equal(f.member().resultPath, f.original.resultPath);
    await f.begin("autonomous-turn-3");
    f.prompt("substantive", wake.text); // Wording never grants maintenance provenance.
    await f.end();
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastTurnId, "autonomous-turn-3");
  } finally {
    await f.close();
  }
});

for (const outcome of [
  { kind: "canceled", reason: "Human canceled" },
  { kind: "failed", error: { message: "Provider disconnected" } },
] as const)
  test(`a steered turn that ${outcome.kind} cannot retain the earlier acceptance`, async (t) => {
    const f = await fixture(t);
    try {
      await f.begin("autonomous-turn-2");
      f.prompt("owner-steer");
      await f.end("Partial rework", outcome);
      assert.equal(f.member().lastOutcome, outcome.kind);
      assert.equal(f.member().decision, "open");
      assert.equal(f.state().phase, outcome.kind === "canceled" ? "paused" : "active");
    } finally {
      await f.close();
    }
  });

test("unknown native input blocks a running-handback decision, and a recovered read permits background-only decisions", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.failRead(true);
    await assert.rejects(
      f.runtime().disposition("peer", "rejected", "candidate", "Evidence", undefined, "owner", f.api),
      /input|timeline|state unknown/i,
    );
    assert.equal(f.member().decision, "accepted");
    f.failRead(false);
    await f.runtime().disposition("peer", "rejected", "candidate", "Evidence", undefined, "owner", f.api);
    assert.equal(f.member().decision, "rejected");
    assert.equal(f.member().lastTurnId, "handback-1");
  } finally {
    await f.close();
  }
});

test("native start identity includes a steer accepted before a delayed plugin hook", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2", 5000, () => f.prompt("early-steer"));
    await f.end();
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
  } finally {
    await f.close();
  }
});

for (const winner of ["new turn", "reused ordinal", "checkpoint"])
  test(`a ${winner} that wins native start readback is not overwritten by its delayed hook`, async (t) => {
    const f = await fixture(t);
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let didEnter = false;
    try {
      f.advance();
      const turnId = "autonomous-turn-2";
      const startedAt = new Date().toISOString();
      const delayed = {
        agents: {
          ref: () => ({
            refresh: async () => {
              didEnter = true;
              enter?.();
              await released;
              return { agent: { activeTurn: { turnId, startedAt } } };
            },
          }),
        },
      } as unknown as PaseoApi;
      const starting = f.runtime().startTurn(f.agent, turnId, delayed);
      await Promise.race([entered, starting]);
      assert.equal(didEnter, true, "start hooks read the native generation before publishing it");
      if (winner === "checkpoint")
        f.runtime().autonomy.checkpoint("peer", "blocked", "Newer checkpoint must stand");
      else await f.begin(winner === "reused ordinal" ? turnId : "autonomous-turn-3");
      const member = f.member();
      const state = f.state();
      release?.();
      await starting;
      assert.deepEqual(f.member(), member, "the winning native generation and candidate stay current");
      assert.deepEqual(f.state(), state, "the winning turn or checkpoint keeps its revision and phase");
    } finally {
      release?.();
      await f.close();
    }
  });

test("a reused turn ordinal writes a distinct result and preserves its earlier evidence bytes", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.prompt("first-steer");
    await f.end("First revised candidate");
    const prior = f.member().resultPath;
    assert.ok(prior);
    const original = await readFile(prior, "utf8");
    await f.reload();
    await f.begin("autonomous-turn-2");
    f.prompt("second-steer");
    await f.end("Second revised candidate");
    assert.notEqual(f.member().resultPath, prior);
    assert.equal(await readFile(prior, "utf8"), original);
    assert.match(await readFile(String(f.member().resultPath), "utf8"), /Second revised candidate/);
  } finally {
    await f.close();
  }
});

for (const steered of [false, true])
  test(`a deferred ${steered ? "steered" : "background"} completion survives reload and recovers without stale acceptance`, async (t) => {
    const f = await fixture(t);
    try {
      await f.begin("autonomous-turn-2");
      if (steered) f.prompt("offline-steer");
      f.failRead(true);
      await f.end();
      assert.ok(f.member().turnInputPending);
      assert.equal(f.member().decision, "accepted", "the receipt is unknown, not inferred to be new work");
      const blockers = await f
        .runtime()
        .lifecycle.blockers(
          f.member(),
          { status: "idle", archived: false, permissions: 0 },
          async () => null,
        );
      assert.ok(blockers.some((reason) => /input.*reconciliation/i.test(reason)));
      await f.reload();
      await assert.rejects(
        f
          .runtime()
          .disposition("peer", "accepted", "old-candidate", "unused-report", undefined, "owner", f.api),
        /timeline|input/i,
      );
      f.failRead(false);
      const deciding = f
        .runtime()
        .disposition("peer", "rejected", "old-candidate", "Evidence", undefined, "owner", f.api);
      if (steered) {
        await assert.rejects(deciding, /mid-turn|new turn/i);
        assert.equal(f.member().decision, "open");
        assert.equal(f.member().lastTurnId, "autonomous-turn-2");
        assert.equal(f.member().lastOutcome, "completed");
        assert.equal(f.state().phase, "review");
        assert.match(await readFile(String(f.member().resultPath), "utf8"), /Revised candidate ready/);
      } else {
        await deciding;
        assert.equal(f.member().lastTurnId, f.original.lastTurnId);
        assert.equal(f.member().resultPath, f.original.resultPath);
      }
      assert.equal(f.member().turnInputPending, undefined);
    } finally {
      await f.close();
    }
  });

test("a newer checkpoint supersedes a deferred receipt, including one whose read was in flight", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.prompt("offline-steer");
    f.failRead(true);
    await f.end("Old rework");
    await f.begin("autonomous-turn-3");
    f.failRead(false);
    f.onRead(() => {
      f.onRead();
      f.runtime().autonomy.checkpoint(
        "peer",
        "blocked",
        "Newer checkpoint owns this work",
        "autonomous-turn-3",
      );
    });
    await assert.rejects(
      f.runtime().disposition("peer", "rejected", "old-candidate", "Evidence", undefined, "owner", f.api),
      /mid-turn|new turn/i,
    );
    assert.equal(f.member().turnInputPending, undefined);
    assert.equal(f.member().lastTurnId, "autonomous-turn-3");
    assert.equal(f.member().resultPath, null);
    assert.equal(f.state().phase, "blocked");
  } finally {
    await f.close();
  }
});

test("a recovered receipt updates the handback under a newer background turn without replacing that turn", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    f.prompt("offline-steer");
    f.failRead(true);
    await f.end("Recovered rework");
    await f.begin("autonomous-turn-3");
    f.failRead(false);
    await assert.rejects(
      f.runtime().disposition("peer", "rejected", "old-candidate", "Evidence", undefined, "owner", f.api),
      /mid-turn|new turn/i,
    );
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
    assert.equal(f.state().turnId, "autonomous-turn-3");
    assert.equal(f.runtime().autonomy.carrying("peer"), true);
    await f.end("Unrelated monitor result");
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
    assert.match(await readFile(String(f.member().resultPath), "utf8"), /Recovered rework/);
  } finally {
    await f.close();
  }
});

test("native input readback pages to the steer, then checks only new rows on a carried turn", async (t) => {
  const f = await fixture(t);
  try {
    await f.begin("autonomous-turn-2");
    for (let n = 0; n < 120; n++)
      f.rows.push({
        seq: f.rows.length + 1,
        turnId: "autonomous-turn-2",
        timestamp: new Date().toISOString(),
        item: { type: "assistant_message", text: `Monitor ${n}` },
      });
    await f.runtime().disposition("peer", "rejected", "candidate", "Evidence", undefined, "owner", f.api);
    f.prompt("buried-steer");
    for (let n = 0; n < 120; n++)
      f.rows.push({
        seq: f.rows.length + 1,
        turnId: "autonomous-turn-2",
        timestamp: new Date().toISOString(),
        item: { type: "assistant_message", text: `Work ${n}` },
      });
    await f.end();
    assert.equal(f.member().decision, "open");
    assert.equal(f.member().lastTurnId, "autonomous-turn-2");
  } finally {
    await f.close();
  }
});

for (const secondSteered of [false, true])
  test(`two deferred turns retain the latest substantive result when the second is ${secondSteered ? "rework" : "background only"}`, async (t) => {
    const f = await fixture(t);
    try {
      await f.begin("autonomous-turn-2");
      f.prompt("first-offline-steer");
      f.failRead(true);
      await f.end("First offline result");
      await f.begin("autonomous-turn-3");
      if (secondSteered) f.prompt("second-offline-steer");
      await f.end("Second offline result");
      assert.equal(f.member().turnInputPending?.following?.length, 1);
      await f.reload();
      f.failRead(false);
      await assert.rejects(
        f.runtime().disposition("peer", "rejected", "old-candidate", "Evidence", undefined, "owner", f.api),
        /mid-turn|new turn/i,
      );
      assert.equal(f.member().turnInputPending, undefined);
      assert.equal(f.member().lastTurnId, secondSteered ? "autonomous-turn-3" : "autonomous-turn-2");
      assert.equal(f.member().decision, "open");
      assert.match(
        await readFile(present(f.member().resultPath), "utf8"),
        secondSteered ? /Second offline result/ : /First offline result/,
      );
      assert.equal(f.state().phase, "review");
    } finally {
      await f.close();
    }
  });

test("receipt overflow stays bounded and cannot accept or archive the previous candidate; explicit new work supersedes it", async (t) => {
  const f = await fixture(t);
  try {
    f.failRead(true);
    for (let n = 0; n < 17; n++) {
      await f.begin(`autonomous-turn-${n + 2}`);
      f.prompt(`offline-steer-${n}`);
      await f.end(`Offline result ${n}`);
    }
    assert.equal(f.member().turnInputPending?.following?.length, 15);
    assert.equal(f.member().turnInputPending?.overflow, true);
    f.failRead(false);
    await assert.rejects(
      f.runtime().disposition("peer", "rejected", "old-candidate", "Evidence", undefined, "owner", f.api),
      /bound exceeded/i,
    );
    const blockers = await f
      .runtime()
      .lifecycle.blockers(f.member(), { status: "idle", archived: false, permissions: 0 }, async () => null);
    assert.ok(blockers.some((reason) => /input.*reconciliation/i.test(reason)));
    await f.begin("foreground-new-work");
    assert.equal(f.member().turnInputPending, undefined);
    assert.equal(f.member().decision, "open");
    f.prompt("fresh-work");
    await f.end("Fresh result");
    assert.equal(f.member().lastTurnId, "foreground-new-work");
  } finally {
    await f.close();
  }
});
