import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { Autonomy } from "../server/autonomy";
import { Lifecycle } from "../server/lifecycle";
import { Obligations } from "../server/obligations";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

async function fixture() {
  const home = await temporary("alliance-autonomy-");
  const store = new RoomStore(home);
  store.addRoom({
    id: "room",
    cwd: home,
    title: "test",
    workspaceId: "w",
    mission: "test",
    artifacts: home,
    createdAt: new Date().toISOString(),
  });
  for (const id of ["owner", "worker"])
    store.saveMember({
      id,
      roomId: "room",
      role: id === "owner" ? "lead" : "peer",
      provider: "alliance-codex-peer",
      parentId: id === "worker" ? "owner" : null,
      assignment: "brief.md",
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      lastTurnId: null,
      launchKey: null,
      launchHash: null,
    });
  let now = 100000;
  let status = "idle",
    permissions: unknown[] = [],
    archived = false;
  let sends = 0,
    archives = 0,
    ambiguous = false;
  const prompts: string[] = [];
  let children: unknown[] = [];
  let onRefresh = () => {};
  const wakes = new Wakeups(store, () => now);
  const autonomy = new Autonomy(store, wakes, () => now);
  const lifecycle = new Lifecycle(store, wakes, autonomy, () => now);
  const api = {
    agents: {
      list: async () => ({ entries: children }),
      ref: () => ({
        refresh: async () => {
          onRefresh();
          return { agent: { status, archivedAt: archived ? "yes" : null, pendingPermissions: permissions } };
        },
        send: async (text: string) => {
          sends++;
          prompts.push(text);
          if (ambiguous) throw new Error("disconnected");
        },
        archive: async () => {
          archives++;
          archived = true;
          return { archivedAt: "yes" };
        },
      }),
    },
  } as unknown as PaseoApi;
  const end = (turn: string, outcome = "completed") => {
    store.updateMember("worker", { lastTurnId: turn, lastOutcome: outcome, resultPath: "result.json" });
    autonomy.ended("worker", turn, outcome);
  };
  return {
    store,
    home,
    autonomy,
    lifecycle,
    wakes,
    api,
    // One scheduler round: continuation/review first, then the archive sweep.
    tick: async () => {
      await autonomy.tick(api);
      await lifecycle.sweep(api);
    },
    end,
    advance: () => {
      now += 120000;
    },
    status: (s: string) => {
      status = s;
    },
    children: (items: unknown[]) => {
      children = items;
    },
    onRefresh: (fn: () => void) => {
      onRefresh = fn;
    },
    permission: () => {
      permissions = [{}];
    },
    ambiguous: () => {
      ambiguous = true;
    },
    counts: () => ({ sends, archives }),
    prompts: () => prompts,
  };
}

test("continuation and review prompts name the current CLI so older sessions switch to it", async () => {
  const f = await fixture();
  try {
    const cli = { command: "/opt/alliance/bin/alliance-work --home /srv/alliance", managed: true };
    f.autonomy.cli = f.wakes.cli = () => cli;
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "review", "handback ready", "t2");
    f.end("t2");
    f.advance();
    await f.autonomy.tick(f.api);
    await f.wakes.tick(f.api);
    assert.equal(f.prompts().length, 2, "one continuation, then one review wakeup for the owner");
    for (const prompt of f.prompts()) assert.ok(prompt.includes(cli.command), prompt);
  } finally {
    f.store.close();
  }
});

test("bound continuation and retry wait for prerequisites while unrelated work remains independent", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "gated",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "continue",
        closeWhen: "verified",
        conditions: [{ id: "ready", requires: "dependency verified" }],
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "gated" });
    f.end("t1", "failed");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 0);
    assert.equal(f.autonomy.get("worker")?.retries, 0);
    const evidence = join(f.home, "evidence.txt");
    await writeFile(evidence, "dependency verified");
    await ledger.action(
      {
        key: "gated",
        ownerId: "worker",
        revision: 1,
        action: "observe",
        conditionId: "ready",
        validUntil: 999999,
        evidence,
      },
      f.api,
    );
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    f.autonomy.started("worker", "t2");
    f.end("t2");
    for (let n = 0; n < 7; n++) f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1, "expired evidence blocks again");
    f.autonomy.start("owner");
    f.store.updateMember("owner", { lastTurnId: "independent", lastOutcome: "completed" });
    f.autonomy.ended("owner", "independent", "completed");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2, "unrelated task continues");
  } finally {
    f.store.close();
  }
});

test("accepted work cannot archive with open obligations even after reminder expiry", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "open",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "handoff",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker");
    f.autonomy.checkpoint("worker", "review", "ready");
    f.end("t1");
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "receipt" });
    f.wakes.add({
      key: "expired",
      roomId: "room",
      ownerId: "worker",
      obligationKey: "open",
      reason: "review",
      trigger: { kind: "time", at: 100000 },
      expiresAt: 110000,
    });
    f.advance();
    await f.wakes.tick();
    assert.equal(f.wakes.list()[0].state, "expired");
    await f.tick();
    assert.equal(f.counts().archives, 0);
    const evidence = join(f.home, "close.txt");
    await writeFile(evidence, "verified");
    await ledger.action({ key: "open", ownerId: "worker", revision: 1, action: "fulfill", evidence }, f.api);
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("obligation handoff moves managed continuation and budget atomically without replaying old owner", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "move",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "finish",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "move", maxContinuations: 3 });
    f.end("t1");
    f.advance();
    const evidence = join(f.home, "handoff.txt");
    await writeFile(evidence, "successor owns remaining work");
    await ledger.action(
      { key: "move", ownerId: "worker", revision: 1, action: "handoff", nextOwnerId: "owner", evidence },
      f.api,
    );
    assert.equal(f.autonomy.get("worker")?.phase, "paused");
    assert.equal(f.autonomy.get("worker")?.pausedBy, "handoff");
    f.autonomy.started("worker", "after-handoff");
    assert.equal(f.autonomy.get("worker")?.phase, "paused", "a handoff pause is not resumed by a new turn");
    assert.equal(f.autonomy.get("owner")?.obligationKey, "move");
    assert.equal(f.autonomy.get("owner")?.maxContinuations, 3);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(f.autonomy.get("owner")?.continuations, 1);
    assert.equal(f.autonomy.get("worker")?.continuations, 0);
  } finally {
    f.store.close();
  }
});

test("unfinished assignments continue across idle turns and review wakes the owner once", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    f.autonomy.started("worker", "t2");
    f.autonomy.checkpoint("worker", "review", "Candidate ready");
    f.end("t2");
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.wakes.list().length, 1);
    assert.equal(f.wakes.list()[0].delivery, "idle");
    assert.equal(f.counts().archives, 0, "turn completion is not acceptance");
  } finally {
    f.store.close();
  }
});

test("failed turns retry with a bound, while cancellation and permission do not restart work", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    for (let n = 1; n <= 3; n++) {
      f.autonomy.started("worker", `t${n}`);
      f.end(`t${n}`, "failed");
      f.advance();
      await f.autonomy.tick(f.api);
    }
    assert.equal(f.counts().sends, 2);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked");
    f.autonomy.start("worker");
    f.autonomy.started("worker", "cancel");
    f.end("cancel", "canceled");
    f.advance();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2);
    assert.equal(f.autonomy.get("worker")?.phase, "paused");
    f.autonomy.start("worker");
    f.autonomy.started("worker", "permission");
    f.end("permission", "failed");
    f.advance();
    f.permission();
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 2);
  } finally {
    f.store.close();
  }
});

test("uncertain delivery survives reload without replay; a new observed turn resolves it", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    f.ambiguous();
    await f.autonomy.tick(f.api);
    const restarted = new Autonomy(f.store, f.wakes, () => 999999);
    await restarted.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(restarted.get("worker")?.delivery, "uncertain");
    restarted.started("worker", "t2");
    assert.equal(restarted.get("worker")?.delivery, "none");
  } finally {
    f.store.close();
  }
});

test("only accepted idle work with no outstanding dependents is archived", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.autonomy.checkpoint("worker", "review", "ready");
    f.end("t1");
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "acceptance.json" });
    f.status("running");
    await f.tick();
    assert.equal(f.counts().archives, 0);
    f.status("idle");
    await f.tick();
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("reload continues retained work, ignores stale outcomes, and does not replay interrupted dispatch", async () => {
  const f = await fixture();
  f.autonomy.start("worker");
  f.autonomy.started("worker", "current");
  f.end("current");
  f.autonomy.ended("worker", "old", "failed");
  f.store.close();
  const store = new RoomStore(f.home);
  try {
    const recovered = new Autonomy(store, new Wakeups(store), () => 999999);
    await recovered.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(recovered.get("worker")?.retries, 0);
    const record = recovered.get("worker");
    assert.ok(record);
    store.saveAutonomy(
      { ...record, delivery: "dispatching", revision: record.revision + 1 },
      record.revision,
    );
    await new Autonomy(store, new Wakeups(store), () => 999999).tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(store.autonomous()[0].delivery, "uncertain");
  } finally {
    store.close();
  }
});

test("pause during native readback prevents send and native children prevent cascade archive", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker");
    f.end("t1");
    f.advance();
    f.onRefresh(() => {
      f.autonomy.checkpoint("worker", "paused", "Operator paused");
    });
    await f.tick();
    assert.equal(f.counts().sends, 0);
    f.onRefresh(() => {});
    f.store.updateMember("worker", { decision: "accepted", decisionEvidence: "acceptance.json" });
    await f.tick();
    assert.equal(f.counts().archives, 0, "paused work remains open even after acceptance");
    f.autonomy.checkpoint("worker", "review", "Ready");
    f.children([{ agent: { id: "unmanaged-native-child", status: "idle" } }]);
    await f.tick();
    assert.equal(f.counts().archives, 0, "all native children must be archived separately");
    f.children([]);
    await f.tick();
    assert.equal(f.counts().archives, 1);
  } finally {
    f.store.close();
  }
});

test("continuation exhaustion requests review and preserves an explicit blocker", async () => {
  const f = await fixture();
  try {
    f.autonomy.start("worker", { maxContinuations: 1 });
    f.end("t1");
    f.advance();
    await f.autonomy.tick(f.api);
    f.autonomy.started("worker", "t2");
    f.end("t2");
    f.advance();
    await f.autonomy.tick(f.api);
    await f.autonomy.tick(f.api);
    assert.equal(f.counts().sends, 1);
    assert.equal(f.autonomy.get("worker")?.phase, "blocked");
    assert.equal(f.wakes.list().length, 1);
    f.autonomy.started("worker", "t3");
    f.autonomy.checkpoint("worker", "blocked", "Need external credentials");
    f.end("t3");
    assert.equal(f.autonomy.get("worker")?.reason, "Need external credentials");
  } finally {
    f.store.close();
  }
});

test("handing off an obligation keeps a Human's cancellation hold on the old owner", async () => {
  const f = await fixture();
  try {
    const ledger = new Obligations(f.store, () => 100000);
    await ledger.add(
      {
        key: "held",
        roomId: "room",
        ownerId: "worker",
        assignment: "brief",
        authority: "test",
        nextAction: "finish",
        closeWhen: "verified",
      },
      f.api,
    );
    f.autonomy.start("worker", { obligationKey: "held" });
    f.autonomy.started("worker", "t1");
    f.end("t1", "canceled");
    const evidence = join(f.home, "handoff-held.txt");
    await writeFile(evidence, "successor owns remaining work");
    await ledger.action(
      { key: "held", ownerId: "worker", revision: 1, action: "handoff", nextOwnerId: "owner", evidence },
      f.api,
    );
    assert.equal(f.autonomy.get("worker")?.pausedBy, "cancel");
  } finally {
    f.store.close();
  }
});
