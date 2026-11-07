import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { runVerification } from "../server/evidence.mjs";
import { buildIntegrationProof } from "../server/integration.mjs";
import { AllianceRuntime } from "../server/runtime";
import { newTurn } from "../server/store";
import { temporary } from "./temp";

const journey = {
  outcome: "The combined result can be read",
  journey: "Read the delivered file and assert its content",
  reviewer: "Human",
  remaining: [],
};

async function fixture(t: TestContext) {
  const root = await temporary("alliance-integrated-lifecycle-");
  const home = join(root, "home");
  const parent = join(root, "parent");
  const child = join(root, "child");
  for (const cwd of [parent, child]) {
    await mkdir(cwd);
    await writeFile(join(cwd, "result.txt"), "delivered");
  }
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: {
      codex: "/usr/bin/false",
      claude: "/usr/bin/false",
      pi: "/usr/bin/false",
    },
  });
  const runtime = await new AllianceRuntime(home).ready();
  t.after(() => runtime.close());
  const archived: string[] = [];
  let onRefresh: (id: string) => void | Promise<void> = () => {};
  let onList = () => {};
  let status = "idle";
  const api = {
    workspaces: {
      ref: () => ({ refresh: async () => null }),
      open: async () => ({
        id: "workspace",
        refresh: async () => ({ title: null }),
        setTitle: async () => ({}),
      }),
    },
    agents: {
      list: async () => {
        onList();
        return { entries: [] };
      },
      ref: (id: string) => ({
        refresh: async () => {
          await onRefresh(id);
          return {
            agent: {
              status,
              archivedAt: runtime.store.member(id)?.archivedAt ?? null,
              pendingPermissions: [],
            },
          };
        },
        archive: async () => {
          archived.push(id);
        },
      }),
    },
  } as unknown as PaseoApi;
  const room = await runtime.createRoom(
    { cwd: parent, title: "Integration", mission: "Deliver both parts" },
    api,
  );
  for (const [id, cwd, role, parentId] of [
    ["parent", parent, "lead", null],
    ["child", child, "peer", "parent"],
  ] as const)
    runtime.store.saveMember({
      id,
      cwd,
      role,
      parentId,
      roomId: room.id,
      provider: `alliance-codex-${role}`,
      assignment: join(root, `${id}-assignment.md`),
      lastOutcome: "completed",
      lastTurnId: `${id}-turn`,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  let run = 0;
  const verify = (cwd: string, kind: "runtime" | "test") =>
    runVerification({
      cwd,
      output: join(root, `proof-${++run}`),
      inputs: ["result.txt"],
      kind,
      scenario: "Read delivered result",
      command: [
        process.execPath,
        "-e",
        "require('assert/strict').equal(require('fs').readFileSync('result.txt','utf8'),'delivered')",
      ],
    });
  const childProof = await verify(child, "test");
  const acceptChild = () =>
    runtime.disposition(
      "child",
      "accepted",
      childProof.report.candidate.digest,
      childProof.path,
      undefined,
      null,
    );
  await acceptChild();
  runtime.store.updateMember("child", { archivedAt: new Date().toISOString() });
  const parentProof = await verify(parent, "runtime");
  const plan = {
    version: 1,
    children: [
      {
        agentId: "child",
        candidate: childProof.report.candidate.digest,
        method: "files",
        reason: "Reviewed delivery from the child checkout",
        paths: [{ source: "result.txt", target: "result.txt" }],
      },
    ],
  };
  const acceptParent = (integration: unknown = plan) =>
    runtime.disposition(
      "parent",
      "accepted",
      parentProof.report.candidate.digest,
      parentProof.path,
      journey,
      null,
      api,
      integration,
    );
  return {
    runtime,
    parent,
    child,
    api,
    archived,
    acceptChild,
    acceptParent,
    plan,
    parentProof,
    onList: (callback: () => void) => {
      onList = callback;
    },
    status: (value: string) => {
      status = value;
    },
    onRefresh: (callback: (id: string) => void | Promise<void>) => {
      onRefresh = callback;
    },
  };
}

test("product disposition records archived child contributions and clears its dependency proof on new work", async (t) => {
  const f = await fixture(t);
  await f.acceptParent();
  const parent = f.runtime.store.member("parent");
  assert(parent?.decisionEvidence && parent.decisionIntegration);
  const disposition = JSON.parse(await readFile(parent.decisionEvidence, "utf8"));
  assert.equal(disposition.integration.contributors[0].agentId, "child");
  assert.equal(disposition.verification.candidate.digest, f.parentProof.report.candidate.digest);
  await f.runtime.lifecycle.sweep(f.api);
  assert.deepEqual(f.archived, ["parent"]);
  f.runtime.store.updateMember("parent", newTurn("rework"));
  assert.equal(f.runtime.store.member("parent")?.decisionIntegration, undefined);
});

test("product acceptance refuses an omitted child while technical acceptance remains available", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.acceptParent({ version: 1, children: [] }), /merge|mapping|contribution|non-Git/i);
  await f.runtime.disposition(
    "parent",
    "accepted",
    f.parentProof.report.candidate.digest,
    f.parentProof.path,
    undefined,
    null,
    f.api,
  );
  assert.equal(f.runtime.store.member("parent")?.decisionScope, "technical");
  assert.equal(f.runtime.store.member("parent")?.decisionIntegration, undefined);
});

test("reaccepting identical child bytes invalidates a parent product decision before archive", async (t) => {
  const f = await fixture(t);
  await f.acceptParent();
  await f.acceptChild();
  const parent = f.runtime.store.member("parent");
  assert(parent);
  const view = await f.runtime.lifecycle.describe(
    parent,
    { status: "idle", archived: false, permissions: 0 },
    new Map(),
  );
  assert.equal(view.state, "held");
  assert.match(view.blockers.join("\n"), /contribut|integration/i);
  await f.runtime.lifecycle.sweep(f.api);
  assert.deepEqual(f.archived, []);
});

test("changed final bytes and changed frozen child evidence prevent integrated automatic archive", async (t) => {
  for (const change of ["candidate", "evidence"] as const)
    await t.test(change, async (t) => {
      const f = await fixture(t);
      await f.acceptParent();
      if (change === "candidate") await writeFile(join(f.parent, "result.txt"), "regression");
      else {
        const path = f.runtime.store.member("child")?.decisionEvidence;
        assert(path);
        await writeFile(path, "{}");
      }
      await assert.rejects(f.runtime.lifecycle.sweep(f.api));
      assert.deepEqual(f.archived, []);
    });
});

test("a child decision changing during parent acceptance prevents committing the stale product proof", async (t) => {
  const f = await fixture(t);
  let reads = 0;
  f.onRefresh((id) => {
    if (id === "parent" && ++reads === 2) {
      const child = f.runtime.store.member("child");
      assert(child);
      f.runtime.store.updateMember("child", { decisionEvidence: `${child.decisionEvidence}.replacement` });
    }
  });
  await assert.rejects(f.acceptParent(), /contribut|integration|changed/i);
  assert.equal(f.runtime.store.member("parent")?.decision, "open");
});

test("candidate or evidence mutation during final native readback cannot record a product acceptance", async (t) => {
  for (const change of ["candidate", "evidence"] as const)
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const childDecision = f.runtime.store.member("child")?.decisionEvidence;
      assert(childDecision);
      let reads = 0;
      f.onRefresh(async (id) => {
        if (id === "parent" && ++reads === 2)
          await writeFile(
            change === "candidate" ? join(f.parent, "result.txt") : childDecision,
            "regression",
          );
      });
      await assert.rejects(f.acceptParent(), /changed|candidate|stale|artifact/i);
      assert.equal(f.runtime.store.member("parent")?.decision, "open");
      const decisions = await Promise.all(
        (await readdir(dirname(childDecision)))
          .filter((name) => name.endsWith(".json"))
          .map((name) => readFile(join(dirname(childDecision), name), "utf8")),
      );
      assert.ok(
        !decisions.some((text) => text.includes('"agentId": "parent"')),
        "failed review must not be shown as a historical acceptance",
      );
    });
});

test("replacing a parent's disposition with another valid runtime proof cannot change its accepted candidate", async (t) => {
  const f = await fixture(t);
  await f.acceptParent();
  const path = f.runtime.store.member("parent")?.decisionEvidence;
  assert(path);
  const record = JSON.parse(await readFile(path, "utf8"));
  await writeFile(join(f.parent, "extra.txt"), "new unreviewed input");
  const changed = await runVerification({
    cwd: f.parent,
    output: join(f.parent, "..", "extra-proof"),
    inputs: ["result.txt", "extra.txt"],
    kind: "runtime",
    scenario: "Read delivered result with a changed input set",
    command: [
      process.execPath,
      "-e",
      "require('assert/strict').equal(require('fs').readFileSync('result.txt','utf8'),'delivered')",
    ],
  });
  record.candidate = changed.report.candidate.digest;
  record.evidence = changed.path;
  record.verification = changed.report;
  record.integration = await buildIntegrationProof({
    report: changed.report,
    contributors: record.integration.contributors,
    plan: record.integration.plan,
  });
  await writeFile(path, JSON.stringify(record));
  await assert.rejects(f.runtime.lifecycle.sweep(f.api));
  assert.deepEqual(f.archived, []);
});

test("native work beginning during integration validation holds automatic archive", async (t) => {
  const f = await fixture(t);
  await f.acceptParent();
  f.onList(() => {
    setTimeout(() => f.status("running"), 0);
  });
  await f.runtime.lifecycle.sweep(f.api);
  assert.deepEqual(f.archived, []);
});
