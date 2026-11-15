import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { holdTasks, resumeTasks, runTaskMaintenance } from "../scripts/task-maintenance.mjs";
import { controlBodySha, qualifyControlAlias } from "../server/maintenance-control.mjs";
import {
  heldTask,
  maintenanceHeld,
  readMaintenanceHold,
  saveMaintenanceHold,
} from "../server/maintenance-hold.mjs";
import { temporary } from "./temp";

interface NativeAgent {
  id: string;
  provider: string;
  model: string;
  thinkingOptionId: string;
  effectiveThinkingOptionId: string;
  cwd: string;
  status: string;
  activeTurn: { turnId: string; startedAt: string } | null;
  persistence: { provider: string; sessionId: string };
  runtimeInfo: { provider: string; sessionId: string };
  pendingPermissions: unknown[];
  archivedAt: null;
  updatedAt: string;
}
interface NativeMessage {
  item: { type: string; text: string; clientMessageId: string; messageId: string };
  timestamp: string;
  turnId: string;
}
interface NativeSend {
  id: string;
  text: string;
  options: { messageId: string; activeTurnBehavior?: string };
}

const clone = <T>(value: T): T => structuredClone(value);
async function fixture() {
  const home = await temporary("alliance-maintenance-hold-");
  let clock = Date.parse("2026-11-10T07:00:00Z");
  let holding = true;
  let paused = false;
  let loseResumeAck = false;
  let cooperate = true;
  let fabricateResumeMention = false;
  let unsupportedSteer = false;
  const agents = new Map<string, NativeAgent>();
  for (const [id, active] of [
    ["claude-task", true],
    ["codex-task", true],
    ["agy-task", true],
    ["idle-owner", false],
    ["parked-task", false],
  ] as const) {
    const provider = id.startsWith("agy")
      ? "alliance-agy-peer"
      : id.startsWith("codex")
        ? "alliance-codex-peer"
        : "alliance-claude-lead";
    agents.set(id, {
      id,
      provider,
      model: id.startsWith("agy") ? "gemini-4-argon" : "claude-sonnet-5-5",
      thinkingOptionId: "high",
      effectiveThinkingOptionId: "high",
      cwd: home,
      status: active ? "running" : id.startsWith("parked") ? "closed" : "idle",
      activeTurn: active ? { turnId: `turn-${id}`, startedAt: new Date(clock).toISOString() } : null,
      persistence: { provider, sessionId: `retained-${id}` },
      runtimeInfo: { provider, sessionId: `retained-${id}` },
      pendingPermissions: [],
      archivedAt: null,
      updatedAt: new Date(clock).toISOString(),
    });
  }
  const rows = new Map<string, NativeMessage[]>([...agents.keys()].map((id) => [id, []]));
  const sends: NativeSend[] = [];
  const stops: string[] = [];
  const responsibility = {
    members: [...agents.keys()].map((id) => ({ id, assignment: `${id}.md`, parentId: "owner" })),
    autonomy: [{ agentId: "claude-task", maxRetries: 2, maxContinuations: 7, continuations: 3 }],
    obligations: [{ key: "open-security-obligation", ownerId: "claude-task", state: "open" }],
    jobs: [
      { key: "retained-background", ownerId: "idle-owner", pid: 12345, processIdentity: "native-proof" },
    ],
  };
  const adapter = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += Math.max(ms, 1);
    },
    pause: async () => {
      paused = true;
    },
    list: async () => clone([...agents.values()]),
    get: async (id: string) => clone(agents.get(id) ?? null),
    timeline: async (id: string) => ({ entries: clone(rows.get(id) ?? []) }),
    snapshot: async () => clone(responsibility),
    health: async () => ({ ok: true, version: "0.15.4", pid: process.pid }),
    send: async (id: string, text: string, options: NativeSend["options"]) => {
      assert.equal(paused, true, "scheduler pause precedes every maintenance prompt");
      sends.push({ id, text, options: clone(options) });
      if (holding && unsupportedSteer && id === "agy-task" && options.activeTurnBehavior === "steer")
        throw new Error("AGY does not support prompt.steer");
      const agent = agents.get(id);
      assert.ok(agent);
      const timeline = rows.get(id);
      assert.ok(timeline);
      if (!holding && fabricateResumeMention) {
        fabricateResumeMention = false;
        timeline.push({
          item: {
            type: "assistant_message",
            text: `Checkpoint mentions ${options.messageId}`,
            clientMessageId: "unrelated",
            messageId: "unrelated",
          },
          timestamp: new Date(clock).toISOString(),
          turnId: `unrelated-${id}`,
        });
        throw new Error("Native acknowledgement lost without admitted user prompt");
      }
      timeline.push({
        item: {
          type: "user_message",
          text,
          clientMessageId: options.messageId,
          messageId: options.messageId,
        },
        timestamp: new Date(clock).toISOString(),
        turnId: agent.activeTurn?.turnId ?? `resumed-${id}`,
      });
      agent.status = holding && cooperate ? "idle" : "running";
      agent.activeTurn =
        holding && cooperate ? null : { turnId: `resumed-${id}`, startedAt: new Date(clock).toISOString() };
      if (!holding && loseResumeAck) {
        loseResumeAck = false;
        throw new Error("Native acknowledgement lost after prompt admission");
      }
      return {};
    },
    stop: async (id: string) => {
      stops.push(id);
      const agent = agents.get(id);
      assert.ok(agent);
      agent.status = "idle";
      agent.activeTurn = null;
    },
  };
  return {
    home,
    agents,
    rows,
    sends,
    stops,
    responsibility,
    adapter,
    resume: () => {
      holding = false;
    },
    loseNextResumeAck: () => {
      loseResumeAck = true;
    },
    refuseCooperativeHold: () => {
      cooperate = false;
    },
    quoteUnadmittedResumeId: () => {
      fabricateResumeMention = true;
    },
    rejectAgySteering: () => {
      unsupportedSteer = true;
    },
  };
}
const holdOptions = { reason: "Upgrade the native runtime", timeoutMs: 10, interrupt: true };
const resumeOptions = { reason: "Updated native runtime passed health verification", result: "updated" };

test("maintenance captures exactly the three running tasks and never prompts originally idle or parked sessions", async () => {
  const f = await fixture();
  const before = clone([...f.agents.values()]);
  const hold = await holdTasks(f.home, f.adapter, holdOptions);
  assert.ok(hold);
  assert.deepEqual(hold.targets.map((target: { id: string }) => target.id).sort(), [
    "agy-task",
    "claude-task",
    "codex-task",
  ]);
  assert.deepEqual([...new Set(f.sends.map((send) => send.id))].sort(), [
    "agy-task",
    "claude-task",
    "codex-task",
  ]);
  assert.equal(await maintenanceHeld(f.home), true);
  assert.ok(await heldTask(f.home, "claude-task"));
  assert.equal(Boolean(await heldTask(f.home, "idle-owner")), false);
  assert.deepEqual(await readMaintenanceHold(f.home), hold);
  assert.deepEqual(hold.snapshot, f.responsibility);
  assert.deepEqual(hold.originalAgents, before);
  for (const id of ["idle-owner", "parked-task"])
    assert.deepEqual(
      f.agents.get(id),
      before.find((agent) => agent.id === id),
    );
  assert.deepEqual(f.stops, [], "cooperatively idle work is not interrupted");
});

test("a persisted checkpoint remains held in a fresh process after the maintenance controller exits", async () => {
  const f = await fixture();
  const hold = await holdTasks(f.home, f.adapter, holdOptions);
  assert.ok(hold);
  const module = pathToFileURL(join(import.meta.dirname, "../server/maintenance-hold.mjs")).href;
  const code = `import { maintenanceHeld, readMaintenanceHold } from ${JSON.stringify(module)};
const home = process.argv[1];
console.log(JSON.stringify({ held: await maintenanceHeld(home), ledger: await readMaintenanceHold(home) }));`;
  const observed = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", code, f.home], {
      encoding: "utf8",
    }),
  );
  assert.equal(observed.held, true);
  assert.deepEqual(observed.ledger, hold);
});

test("resume continues the held native sessions once and preserves their models, custody and remaining budgets", async () => {
  const f = await fixture();
  const before = clone([...f.agents.values()]);
  const responsibility = clone(f.responsibility);
  await holdTasks(f.home, f.adapter, holdOptions);
  const heldSends = f.sends.length;
  f.resume();
  await resumeTasks(f.home, f.adapter, resumeOptions);
  assert.equal(f.sends.length - heldSends, 3);
  const sent = clone(f.sends);
  await resumeTasks(f.home, f.adapter, resumeOptions);
  assert.deepEqual(f.sends, sent, "a repeated recovery command sends no duplicate prompt");
  assert.equal(await maintenanceHeld(f.home), false);
  for (const original of before) {
    const agent = f.agents.get(original.id);
    assert.ok(agent);
    for (const key of [
      "provider",
      "model",
      "thinkingOptionId",
      "effectiveThinkingOptionId",
      "persistence",
      "cwd",
    ] as const)
      assert.deepEqual(agent[key], original[key]);
  }
  assert.deepEqual(f.responsibility, responsibility);
  assert.equal(
    f.sends.some((send) => ["idle-owner", "parked-task"].includes(send.id)),
    false,
  );
});

test("lost resume acknowledgement is recovered from native timeline evidence without sending again", async () => {
  const f = await fixture();
  await holdTasks(f.home, f.adapter, holdOptions);
  const heldSends = f.sends.length;
  f.resume();
  f.loseNextResumeAck();
  await resumeTasks(f.home, f.adapter, resumeOptions).catch(() => undefined);
  await resumeTasks(f.home, f.adapter, resumeOptions);
  const resumes = f.sends.slice(heldSends);
  assert.equal(resumes.length, 3);
  assert.equal(new Set(resumes.map((send) => send.id)).size, 3);
  assert.equal(await maintenanceHeld(f.home), false);
});

test("an unsuccessful update keeps the exact held responsibility recoverable and sends no completion resume", async () => {
  const f = await fixture();
  await assert.rejects(
    runTaskMaintenance(f.home, f.adapter, {
      ...holdOptions,
      update: async () => {
        throw new Error("Candidate activation failed");
      },
    }),
    /Candidate activation failed/,
  );
  assert.equal(await maintenanceHeld(f.home), true);
  const hold = await readMaintenanceHold(f.home);
  assert.ok(hold);
  assert.equal(hold.targets.length, 3);
  assert.equal(f.sends.length, 3, "failure sends only the original hold prompts");
  f.resume();
  await resumeTasks(f.home, f.adapter, {
    result: "recovered",
    reason: "Original native runtime and retained assignments verified after rollback",
  });
  assert.equal(await maintenanceHeld(f.home), false);
});

test("recovery refuses an altered model or provider and leaves the hold available for reconciliation", async () => {
  const f = await fixture();
  await holdTasks(f.home, f.adapter, holdOptions);
  const agent = f.agents.get("claude-task");
  assert.ok(agent);
  agent.model = "unexpected-expensive-model";
  f.resume();
  const before = f.sends.length;
  await assert.rejects(resumeTasks(f.home, f.adapter, resumeOptions));
  assert.equal(await maintenanceHeld(f.home), true);
  assert.equal(f.sends.length, before, "identity validation precedes every resume delivery");
});

test("the authorized timeout fallback interrupts only the tasks captured as running", async () => {
  const f = await fixture();
  f.refuseCooperativeHold();
  await holdTasks(f.home, f.adapter, holdOptions);
  assert.deepEqual([...new Set(f.stops)].sort(), ["agy-task", "claude-task", "codex-task"]);
  assert.equal(
    f.stops.some((id) => ["idle-owner", "parked-task"].includes(id)),
    false,
  );
  assert.equal(await maintenanceHeld(f.home), true);
});

test("quoting a resume message ID in unrelated timeline text is not proof that the prompt was admitted", async () => {
  const f = await fixture();
  await holdTasks(f.home, f.adapter, holdOptions);
  f.resume();
  f.quoteUnadmittedResumeId();
  await assert.rejects(resumeTasks(f.home, f.adapter, resumeOptions));
  const admitted = f.sends.length;
  await assert.rejects(resumeTasks(f.home, f.adapter, resumeOptions), /uncertain|not observed/);
  assert.equal(f.sends.length, admitted, "uncertain delivery is never retried automatically");
  assert.equal(await maintenanceHeld(f.home), true);
});

test("a new running task after the hold was recorded blocks the update instead of silently expanding the target set", async () => {
  const f = await fixture();
  await holdTasks(f.home, f.adapter, holdOptions);
  const idle = f.agents.get("idle-owner");
  assert.ok(idle);
  idle.status = "running";
  idle.activeTurn = { turnId: "new-human-turn", startedAt: new Date().toISOString() };
  let updated = false;
  await assert.rejects(
    runTaskMaintenance(f.home, f.adapter, {
      ...holdOptions,
      update: async () => {
        updated = true;
      },
    }),
    /running|active|idle/,
  );
  assert.equal(updated, false);
  assert.equal(
    f.sends.some((send) => send.id === idle.id),
    false,
  );
  assert.equal(await maintenanceHeld(f.home), true);
});

test("a provider without steering checkpoints after the authorized native interruption and resumes only once", async () => {
  const f = await fixture();
  f.rejectAgySteering();
  await holdTasks(f.home, f.adapter, holdOptions);
  const agyNotices = f.sends.filter((send) => send.id === "agy-task");
  assert.equal(agyNotices.length, 2);
  assert.equal(agyNotices[0]?.options.activeTurnBehavior, "steer");
  assert.equal(agyNotices[1]?.options.activeTurnBehavior, "interrupt");
  assert.deepEqual(f.stops, ["agy-task"]);
  const heldSends = f.sends.length;
  f.resume();
  await resumeTasks(f.home, f.adapter, resumeOptions);
  await resumeTasks(f.home, f.adapter, resumeOptions);
  assert.equal(f.sends.length - heldSends, 3);
  assert.equal(await maintenanceHeld(f.home), false);
});

test("explicit same-ledger extension keeps four checkpoints, captures only a newly running fifth task, and resumes all five once", async () => {
  const f = await fixture();
  const template = f.agents.get("claude-task");
  assert.ok(template);
  const fourth = clone(template);
  fourth.id = "fourth-task";
  fourth.persistence.sessionId = "retained-fourth";
  fourth.runtimeInfo.sessionId = "retained-fourth";
  f.agents.set(fourth.id, fourth);
  f.rows.set(fourth.id, []);
  const baseline = clone(f.responsibility);
  let extended = false;
  const adapter = {
    ...f.adapter,
    snapshot: async () => ({
      responsibilities: extended
        ? {
            ...clone(baseline),
            members: [
              ...clone(baseline.members),
              { id: "new-fifth", assignment: "new-fifth.md", parentId: "owner" },
            ],
            autonomy: [
              { ...clone(baseline.autonomy[0]), maxContinuations: 999 },
              { agentId: "new-fifth", maxRetries: 1, maxContinuations: 4, continuations: 1 },
            ],
          }
        : clone(baseline),
    }),
  };
  const held = await holdTasks(f.home, adapter, holdOptions);
  assert.ok(held);
  const oldTargets = clone(held.targets);
  const oldSends = f.sends.length;
  const fifth = clone(template);
  fifth.id = "new-fifth";
  fifth.persistence.sessionId = "retained-new-fifth";
  fifth.runtimeInfo.sessionId = "retained-new-fifth";
  fifth.status = "running";
  fifth.activeTurn = { turnId: "new-fifth-turn", startedAt: new Date().toISOString() };
  f.agents.set(fifth.id, fifth);
  f.rows.set(fifth.id, []);
  await assert.rejects(
    runTaskMaintenance(f.home, adapter, {
      ...holdOptions,
      update: async () => {
        throw new Error("must not update");
      },
    }),
    /New running/,
  );
  extended = true;
  f.resume();
  // The fixture cooperates with holds until the update callback starts the resume stage.
  const extensionAdapter = {
    ...adapter,
    send: async (id: string, text: string, options: NativeSend["options"]) => {
      const ack = await adapter.send(id, text, options);
      if (text.includes(" hold ")) {
        const agent = f.agents.get(id);
        assert.ok(agent);
        agent.status = "idle";
        agent.activeTurn = null;
      }
      return ack;
    },
  };
  const result = await runTaskMaintenance(f.home, extensionAdapter, {
    ...holdOptions,
    key: held.id,
    includeNew: true,
    update: async (ledger: { targets: { id: string }[] }) => {
      assert.equal(ledger.targets.length, 5);
      assert.deepEqual(ledger.targets.slice(0, 4), oldTargets);
      assert.deepEqual(
        f.sends.slice(oldSends).map((row) => row.id),
        ["new-fifth"],
      );
      return { verified: true };
    },
  });
  assert.ok(result);
  assert.equal(result.id, held.id);
  assert.equal(result.phase, "complete");
  const snapshot = result.snapshot as { responsibilities: typeof baseline };
  assert.equal(
    snapshot.responsibilities.autonomy.find((row) => row.agentId === "claude-task")?.maxContinuations,
    7,
  );
  assert.equal(
    snapshot.responsibilities.autonomy.find((row) => row.agentId === "new-fifth")?.maxContinuations,
    4,
  );
  for (const id of [...oldTargets.map((task: { id: string }) => task.id), "new-fifth"])
    assert.equal(
      f.sends.filter((row) => row.id === id && row.text.split("]")[0].includes(" resume ")).length,
      1,
    );
  assert.equal(
    f.sends.some((row) => ["idle-owner", "parked-task"].includes(row.id)),
    false,
  );
});

test("an update child's validated control aliases and reconciliation audit survive the controller's post-update save", async () => {
  const f = await fixture();
  const alias = "77777777-7777-4777-8777-777777777777";
  const reconciledAt = "2026-11-10T10:01:00.000Z";
  const audit = [
    {
      at: reconciledAt,
      source: "verified-update-child",
      proofs: [
        { targetId: "claude-task", dispatchId: "owned-control-before-update", providerMessageId: alias },
      ],
    },
  ];
  await runTaskMaintenance(f.home, f.adapter, {
    ...holdOptions,
    update: async () => {
      const ledger = await readMaintenanceHold(f.home);
      assert.ok(ledger);
      ledger.controls["claude-task"].push(alias);
      ledger.controlAliasQualifications = audit;
      ledger.reconciledAt = reconciledAt;
      await saveMaintenanceHold(f.home, ledger);
      f.resume();
      return { verified: true };
    },
  });
  const ledger = await readMaintenanceHold(f.home);
  assert.ok(ledger);
  assert.equal(ledger.phase, "complete");
  assert.ok(ledger.controls["claude-task"].includes(alias));
  assert.deepEqual(ledger.controlAliasQualifications, audit);
  assert.equal(ledger.reconciledAt, reconciledAt);
});

test("the next hold preserves and backfills the immediately previous legacy control dispatches before a new cycle", async () => {
  const f = await fixture();
  await runTaskMaintenance(f.home, f.adapter, {
    ...holdOptions,
    key: "legacy-cycle",
    update: async () => {
      f.resume();
      return { verified: true };
    },
  });
  const previous = await readMaintenanceHold(f.home);
  assert.ok(previous);
  const legacy = JSON.parse(JSON.stringify(previous));
  delete legacy.controlDispatches;
  for (const task of legacy.targets) {
    delete task.notice.bodySha256;
    delete task.notice.acknowledgedAt;
    delete task.resume.bodySha256;
    delete task.resume.acknowledgedAt;
  }
  await saveMaintenanceHold(f.home, legacy);
  const holdSend = f.sends.find((send) => send.id === "claude-task");
  assert.ok(holdSend);
  const resumeSend = f.sends.find(
    (send) => send.id === "claude-task" && send.options.messageId !== holdSend.options.messageId,
  );
  assert.ok(resumeSend);
  const next = await holdTasks(f.home, f.adapter, { ...holdOptions, key: "next-cycle" });
  assert.ok(next);
  const registry = JSON.parse(JSON.stringify(next)).controlDispatches;
  assert.equal(registry[holdSend.options.messageId].bodySha256, controlBodySha(holdSend.text));
  assert.equal(registry[resumeSend.options.messageId].bodySha256, controlBodySha(resumeSend.text));
  assert.ok(Number.isFinite(Date.parse(registry[holdSend.options.messageId].acknowledgedAt)));
  const task = next.targets.find((target: { id: string }) => target.id === "claude-task");
  assert.ok(task);
  const current = f.agents.get("claude-task");
  assert.ok(current);
  const row = {
    timestamp: legacy.updatedAt,
    item: { type: "user_message", text: holdSend.text, messageId: "88888888-8888-4888-8888-888888888888" },
  };
  assert.ok(qualifyControlAlias(next, task, row, current));
});
