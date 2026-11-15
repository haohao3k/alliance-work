import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { saveMaintenanceHold } from "../server/maintenance-hold.mjs";
import { AllianceRuntime } from "../server/runtime";
import { Member } from "../shared/contracts";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("alliance-maintenance-reconcile-");
  await writeFile(join(home, "profiles.json"), JSON.stringify({ home, root: home, profiles: {} }));
  const runtime = await new AllianceRuntime(home).ready();
  runtime.store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Task",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  runtime.store.saveMember({
    id: "task",
    roomId: "room",
    role: "lead",
    provider: "alliance-claude-lead",
    parentId: null,
    assignment: "original-scope.md",
    cwd: home,
    lastOutcome: null,
    resultPath: null,
    decision: "open",
    decisionEvidence: null,
    launchKey: null,
    launchHash: null,
  });
  const first = runtime.autonomy.start("task", { maxRetries: 3, maxContinuations: 8 });
  runtime.store.saveAutonomy(
    {
      ...first,
      revision: first.revision + 1,
      phase: "waiting",
      retries: 2,
      continuations: 5,
      dueAt: 123456789,
    },
    first.revision,
  );
  const autonomy = runtime.autonomy.get("task");
  assert.ok(autonomy);
  const member = Member.parse({
    id: "task",
    roomId: "room",
    role: "lead",
    provider: "alliance-claude-lead",
    title: "Task",
    updatedAt: "2026-11-10T00:00:00Z",
    model: null,
    selectedModel: null,
    archived: false,
    parentId: null,
    assignment: "original-scope.md",
    lastOutcome: null,
    lastTurnId: null,
    resultPath: null,
    decision: "open",
    decisionEvidence: null,
    status: "running",
    error: null,
    ownerId: null,
    ownerLabel: "Human",
    ownerStatus: "human",
    ownerRevision: 0,
    ownerEvidence: null,
    policyDigest: "",
    policyAcknowledged: false,
    lastAcceptance: null,
    decisionScope: null,
    lifecycle: { state: "held", blockers: ["running"] },
  });
  await saveMaintenanceHold(home, {
    version: 1,
    id: "bootstrap",
    phase: "updating",
    reason: "Runtime update",
    createdAt: "now",
    updatedAt: "now",
    targets: [{ id: "task", phase: "held", controlUserIds: ["original-product-input"] }],
    controls: { task: ["maintenance-checkpoint-input"] },
    snapshot: { responsibilities: { members: [member], autonomy: [autonomy] } },
  });
  // Reproduce hooks from a release that predates durable maintenance holds.
  runtime.autonomy.started("task", "checkpoint-turn");
  runtime.autonomy.ended("task", "checkpoint-turn", "canceled");
  runtime.store.updateMember("task", {
    lastOutcome: "completed",
    resultPath: "checkpoint-turn-result.json",
    lastTurnId: "checkpoint-turn",
  });
  const users = ["original-product-input", "maintenance-checkpoint-input"];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: {
            id: "task",
            provider: "alliance-claude-lead",
            cwd: home,
            model: null,
            thinkingOptionId: null,
            effectiveThinkingOptionId: null,
            status: "idle",
            activeTurn: null,
          },
        }),
        timeline: {
          refetch: async () => ({
            epoch: "new-worker-epoch",
            entries: users.map((messageId, index) => ({
              seqStart: 100 + index,
              seqEnd: 100 + index,
              item: { type: "user_message", messageId },
            })),
          }),
        },
      }),
    },
  } as unknown as PaseoApi;
  return { runtime, home, autonomy, users, api };
}

test("first-upgrade reconciliation restores old-hook phase, counters and deadlines using exact native control identities", async () => {
  const f = await fixture();
  try {
    assert.notEqual(
      f.runtime.autonomy.get("task")?.phase,
      f.autonomy.phase,
      "old interrupt hooks really changed the assignment phase",
    );
    const restored = await f.runtime.reconcileMaintenance("bootstrap", f.api);
    assert.deepEqual(restored.restored, ["task"]);
    const actual = f.runtime.autonomy.get("task");
    assert.ok(actual);
    for (const field of [
      "phase",
      "reason",
      "dueAt",
      "retries",
      "continuations",
      "maxRetries",
      "maxContinuations",
      "autoArchive",
    ] as const)
      assert.equal(actual[field], f.autonomy[field]);
    assert.equal(f.runtime.store.member("task")?.lastOutcome, null);
    const revision = actual.revision;
    assert.equal((await f.runtime.reconcileMaintenance("bootstrap", f.api)).alreadyRestored, true);
    assert.equal(
      f.runtime.autonomy.get("task")?.revision,
      revision,
      "recovery does not restore or charge twice",
    );
  } finally {
    await f.runtime.close();
  }
});

test("reconciliation preserves a raced Human product input and refuses to overwrite its state", async () => {
  const f = await fixture();
  try {
    f.users.push("new-human-scope");
    const before = f.runtime.autonomy.get("task");
    await assert.rejects(f.runtime.reconcileMaintenance("bootstrap", f.api), /New product input/);
    assert.deepEqual(f.runtime.autonomy.get("task"), before);
    assert.equal(f.runtime.store.member("task")?.resultPath, "checkpoint-turn-result.json");
  } finally {
    await f.runtime.close();
  }
});

test("reconciliation cannot erase a Human acceptance or a changed execution budget", async () => {
  const f = await fixture();
  try {
    f.runtime.store.updateMember("task", {
      decision: "accepted",
      decisionEvidence: "human-acceptance.json",
      decisionBy: null,
    });
    await assert.rejects(f.runtime.reconcileMaintenance("bootstrap", f.api), /Product decision/);
    assert.equal(f.runtime.store.member("task")?.decisionEvidence, "human-acceptance.json");
    f.runtime.store.updateMember("task", { decision: "open", decisionEvidence: null });
    const current = f.runtime.autonomy.get("task");
    assert.ok(current);
    f.runtime.store.saveAutonomy(
      { ...current, revision: current.revision + 1, maxContinuations: 2 },
      current.revision,
    );
    await assert.rejects(f.runtime.reconcileMaintenance("bootstrap", f.api), /budget or binding changed/);
    assert.equal(f.runtime.autonomy.get("task")?.maxContinuations, 2);
  } finally {
    await f.runtime.close();
  }
});
