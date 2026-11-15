import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cleanupArtifacts } from "../scripts/artifacts-cli.mjs";
import { cleanupScratch, cleanupWorktrees, diskCommand, snapshot } from "../scripts/disk-cli.mjs";
import { bindingReferences, evidenceReferences, namedUnder } from "../server/evidence-refs.mjs";
import { ensureScratch } from "../server/scratch.mjs";
import { RoomStore } from "../server/store";
import { repository, scratchFixture } from "./disk-fixture";

async function fixture() {
  const f = await scratchFixture();
  const main = join(f.root, "candidate");
  await mkdir(main);
  const store = new RoomStore(f.home);
  const room = {
    id: "room",
    title: "Synthetic room",
    cwd: main,
    workspaceId: "w",
    mission: "",
    artifacts: join(f.root, "artifacts"),
    createdAt: "now",
  };
  store.addRoom(room);
  const member = (id: string, cwd: string, archived: boolean) =>
    store.saveMember({
      id,
      roomId: room.id,
      role: "peer",
      provider: "alliance-codex-peer",
      parentId: null,
      assignment: "",
      cwd,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
      ...(archived ? { archivedAt: "now" } : {}),
    });
  return { ...f, main, room, store, member };
}

async function report(artifacts: string, value: unknown, name = "run") {
  const path = join(artifacts, "evidence", name, "report.json");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
  return path;
}

const archived = (id: string, parentId: string | null = null) => ({ id, parentId, archivedAt: "now" });

test("all 28 sanitized open-obligation receipts remain protected, including the 27 absent from reports", async () => {
  const f = await fixture();
  f.member("owner", f.main, true);
  const scratch = ensureScratch(f.home, f.room.id, "owner", { env: f.env });
  const obligations = Array.from({ length: 28 }, (_, i) => ({
    key: `obligation-${i}`,
    roomId: f.room.id,
    ownerId: i % 2 ? "owner" : null,
    assignment: "Synthetic maintenance obligation",
    authority: "Human",
    nextAction: "Review receipt",
    closeWhen: "Reviewed",
    conditions: [],
    inputHash: "synthetic",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    state: "open" as const,
    observations: [
      {
        conditionId: "review",
        validUntil: 2,
        receipt: { path: join(scratch, `observation-${i}`), digest: "d", at: 1 },
      },
    ],
    receipt: { path: join(scratch, `receipt-${i}`), digest: "d", at: 1 },
  }));
  for (const obligation of obligations) f.store.saveObligation(obligation);
  await report(f.room.artifacts, { agentId: "owner", artifacts: [obligations[0].receipt] });
  await writeFile(obligations[27].receipt.path, "keep");
  const reportPaths = new Set((await evidenceReferences([f.room])).map((r) => r.path));
  assert.equal(obligations.filter((o) => !reportPaths.has(o.receipt.path)).length, 27);
  const binding = await bindingReferences(snapshot(f.home));
  assert.equal(
    obligations.filter((o) => !binding.some((r) => "path" in r && r.path === o.receipt.path)).length,
    0,
  );
  assert(
    obligations.every((o) => binding.some((r) => "path" in r && r.path === o.observations[0].receipt.path)),
  );
  const applied = await cleanupScratch(f.home, { env: f.env, apply: true });
  assert.equal(applied.items[0].action, "keep");
  assert(existsSync(obligations[27].receipt.path));
});

test("candidate inputs and job receipts stay while their graph has unfinished responsibility", async () => {
  const f = await fixture();
  const input = join(f.main, "node_modules/data/input.json");
  await report(f.room.artifacts, {
    agentId: "child",
    candidate: { cwd: f.main, inputs: ["node_modules/data/input.json"] },
  });
  const data = {
    rooms: [f.room],
    members: [archived("child", "lead"), { id: "lead", parentId: null }],
    jobs: [
      {
        key: "job",
        ownerId: "child",
        archivedAt: "now",
        settlement: { evidence: join(f.root, "job-receipt"), digest: "d" },
      },
    ],
    obligations: [],
  };
  const binding = await bindingReferences(data);
  assert(binding.some((r) => "path" in r && r.path === input));
  assert(namedUnder(input, binding));
  assert(namedUnder(join(f.root, "job-receipt"), binding));
  assert(namedUnder(join(f.main, "node_modules"), binding));
});

test("an unarchived job protects declared inputs and receipts even if its owner was archived", async () => {
  const binding = await bindingReferences({
    rooms: [],
    members: [archived("owner")],
    obligations: [],
    jobs: [
      {
        key: "job",
        ownerId: "owner",
        cwd: "/candidate",
        inputs: ["input.json"],
        receipt: { path: "/output/receipt", digest: "d" },
      },
    ],
  });
  assert(namedUnder("/candidate/input.json", binding));
  assert(binding.some((r) => "path" in r && r.path === "/candidate/input.json"));
  assert(binding.some((r) => "path" in r && r.path === "/output/receipt"));
  assert(namedUnder("/output/receipt", binding));
});

for (const [name, members] of [
  ["missing parent", [archived("child", "missing")]],
  ["cycle", [archived("child", "lead"), archived("lead", "child")]],
  [
    "deep owner",
    Array.from({ length: 66 }, (_, i) =>
      i === 65 ? { id: "m65", parentId: null } : archived(i ? `m${i}` : "child", `m${i + 1}`),
    ),
  ],
] as const)
  test(`evidence remains binding with an explanatory reason for ${name}`, async () => {
    const f = await fixture();
    await report(f.room.artifacts, {
      agentId: "child",
      artifacts: [{ path: "/saved/artifact", digest: "d" }],
    });
    const reason = namedUnder(
      "/saved",
      await bindingReferences({ rooms: [f.room], members, jobs: [], obligations: [] }),
    );
    assert(reason);
    assert.match(reason, /missing|cycle|pending|owner/);
  });

test("a valid archived root releases evidence, while ambiguous shared cwd ownership retains it", async () => {
  const f = await fixture();
  const saved = join(f.root, "saved");
  await mkdir(saved);
  await report(f.room.artifacts, {
    candidate: { cwd: f.main },
    artifacts: [{ path: join(saved, "artifact"), digest: "d" }],
  });
  const data = {
    rooms: [f.room],
    members: [{ ...archived("root"), cwd: f.main }],
    jobs: [],
    obligations: [],
  };
  assert.equal(namedUnder(saved, await bindingReferences(data)), null);
  data.members.unshift({ ...archived("live"), archivedAt: "", cwd: f.main });
  assert(namedUnder(saved, await bindingReferences(data)));
});

for (const failure of [
  "invalid JSON",
  "missing report",
  "directory",
  "symlink",
  "oversized",
  "unreadable listing",
  "total bytes",
])
  test(`cleanup retains scratch and explains incomplete evidence: ${failure}`, async () => {
    const f = await fixture();
    f.member("owner", f.main, true);
    const scratch = ensureScratch(f.home, f.room.id, "owner", { env: f.env });
    await writeFile(join(scratch, "keep"), "keep");
    const path = await report(f.room.artifacts, {});
    if (failure === "invalid JSON") await writeFile(path, "{");
    if (failure === "missing report") await mkdir(join(f.room.artifacts, "evidence", "missing"));
    if (failure === "directory")
      await mkdir(join(f.room.artifacts, "dispositions", "broken.json"), { recursive: true });
    if (failure === "symlink") {
      await mkdir(join(f.room.artifacts, "dispositions"), { recursive: true });
      await symlink(join(f.root, "missing"), join(f.room.artifacts, "dispositions", "broken.json"));
    }
    if (failure === "oversized") {
      const file = await open(path, "w");
      await file.truncate(32 * 1024 * 1024 + 1);
      await file.close();
    }
    if (failure === "total bytes") {
      await writeFile(path, `${" ".repeat(17 * 1024 * 1024)}{}`);
      const second = await report(f.room.artifacts, {}, "second");
      await writeFile(second, `${" ".repeat(17 * 1024 * 1024)}{}`);
    }
    if (failure === "unreadable listing")
      await writeFile(join(f.room.artifacts, "dispositions"), "not a directory");
    const result = await cleanupScratch(f.home, { env: f.env, apply: true });
    assert.equal(result.items[0].action, "keep");
    assert.match((result.items[0] as { reason?: string }).reason ?? "", /incomplete|cannot|limit/i);
    assert(existsSync(join(scratch, "keep")));
  });

test("more than 5000 evidence documents retains paths that the bounded scan cannot inspect", async () => {
  const f = await fixture();
  const dir = join(f.room.artifacts, "dispositions");
  await mkdir(dir, { recursive: true });
  for (let start = 0; start < 5001; start += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 5001 - start) }, (_, i) =>
        writeFile(join(dir, `${start + i}.json`), "{}"),
      ),
    );
  const reason = namedUnder(
    "/unseen/input",
    await bindingReferences({ rooms: [f.room], members: [], jobs: [], obligations: [] }),
  );
  assert.match(reason ?? "", /5000|limit/i);
});

test("scratch clean refuses evidence and scan uncertainty before removing any entries", async () => {
  const f = await fixture();
  f.member("owner", f.main, false);
  const scratch = ensureScratch(f.home, f.room.id, "owner", { env: f.env });
  const keep = join(scratch, "keep");
  await writeFile(keep, "keep");
  const path = await report(f.room.artifacts, { agentId: "owner", artifacts: [{ path: keep, digest: "d" }] });
  const env = {
    ...f.env,
    PASEO_AGENT_ID: "owner",
    ALLIANCE_BOUND_ROOM: f.room.id,
    ALLIANCE_SCRATCH: scratch,
  };
  await assert.rejects(diskCommand(f.home, ["scratch", "clean"], {}, env), /evidence.*nothing was removed/i);
  assert(existsSync(keep));
  await writeFile(path, "{");
  await assert.rejects(
    diskCommand(f.home, ["scratch", "clean"], {}, env),
    /incomplete.*nothing was removed/i,
  );
  assert(existsSync(keep));
});

test("omitting job or obligation records cannot certify a cleanup safe", async () => {
  for (const data of [
    { rooms: [], members: [], jobs: [] },
    { rooms: [], members: [], obligations: [] },
  ]) {
    assert.match(namedUnder("/unseen/data", await bindingReferences(data)) ?? "", /incomplete|missing/i);
  }
});

test("legacy stores without optional tables remain readable and query errors are not treated as absent tables", async () => {
  const f = await scratchFixture();
  const db = new DatabaseSync(join(f.home, "rooms.sqlite"));
  try {
    db.exec("CREATE TABLE rooms(data TEXT); CREATE TABLE members(data TEXT)");
    assert.deepEqual(snapshot(f.home), { rooms: [], members: [], jobs: [], obligations: [] });
    assert.equal(namedUnder(f.root, await bindingReferences(snapshot(f.home))), null);
    db.exec("CREATE TABLE jobs(broken TEXT)");
    assert.throws(() => snapshot(f.home), /data/);
  } finally {
    db.close();
  }
});

test("incomplete evidence retains worktrees and rebuildable artifacts as well as scratch", async () => {
  const f = await repository();
  const tree = f.worktree("done");
  f.member("owner", tree, true);
  const scratch = ensureScratch(f.home, f.room.id, "owner", { env: f.env });
  await mkdir(join(scratch, "p/node_modules"), { recursive: true });
  await writeFile(join(scratch, "p/package.json"), "{}");
  await writeFile(join(scratch, "p/node_modules/keep"), "keep");
  const path = await report(f.room.artifacts, {});
  await writeFile(path, "{");
  const worktrees = await cleanupWorktrees(f.home, { env: f.env, apply: true });
  assert.equal(worktrees.items[0].action, "keep");
  assert(worktrees.items[0].blockers.some((reason: string) => reason.includes("incomplete")));
  const artifacts = await cleanupArtifacts(f.home, { env: f.env, apply: true, older: "0m" });
  assert.equal(artifacts.items[0].action, "keep");
  assert.match(artifacts.items[0].reason, /incomplete/);
  assert(existsSync(join(scratch, "p/node_modules/keep")));
  assert(existsSync(tree));
});

test("evidence protects cleanup paths reached through a filesystem alias", async () => {
  const f = await scratchFixture();
  const real = join(f.root, "real");
  const alias = join(f.root, "alias");
  await mkdir(real);
  await symlink(real, alias);
  const binding = await bindingReferences({
    rooms: [],
    members: [],
    jobs: [],
    obligations: [
      { key: "open", ownerId: null, state: "open", receipt: { path: join(real, "receipt"), digest: "d" } },
    ],
  });
  assert(namedUnder(alias, binding));
  const throughAlias = await bindingReferences({
    rooms: [],
    members: [],
    jobs: [],
    obligations: [
      { key: "open", ownerId: null, state: "open", receipt: { path: join(alias, "receipt"), digest: "d" } },
    ],
  });
  assert.match(namedUnder(real, throughAlias) ?? "", /evidence/);
});

test("an unreadable evidence file retains unrelated scratch with a read-error reason", {
  skip: process.getuid?.() === 0,
}, async () => {
  const f = await scratchFixture();
  const artifacts = join(f.root, "artifacts");
  const path = await report(artifacts, {});
  await chmod(path, 0);
  try {
    const reason = namedUnder(
      "/unrelated/scratch",
      await bindingReferences({ rooms: [{ artifacts }], members: [], jobs: [], obligations: [] }),
    );
    assert.match(reason ?? "", /incomplete.*EACCES/);
  } finally {
    await chmod(path, 0o600);
  }
});

test("malformed evidence reports parse failure without exposing document contents", async () => {
  const f = await scratchFixture();
  const artifacts = join(f.root, "artifacts");
  const path = await report(artifacts, {});
  await writeFile(path, "synthetic-private-payload");
  const reason = namedUnder(
    "/unrelated",
    await bindingReferences({ rooms: [{ artifacts }], members: [], jobs: [], obligations: [] }),
  );
  assert.match(reason ?? "", /incomplete/);
  assert.doesNotMatch(reason ?? "", /synthetic/);
});

test("cleanup cannot infer safety when the target's canonical path is unreadable", async () => {
  const f = await scratchFixture();
  const broken = join(f.root, "loop");
  await symlink(broken, broken);
  assert.match(namedUnder(broken, []) ?? "", /cannot resolve|unknown/i);
});

for (const kind of ["obligation", "job"])
  test(`an archived ancestor's unfinished ${kind} keeps descendant report inputs`, async () => {
    const f = await fixture();
    const saved = join(f.root, "saved");
    await mkdir(saved);
    await report(f.room.artifacts, { agentId: "child", candidate: { cwd: saved, inputs: ["input"] } });
    const data = {
      rooms: [f.room],
      members: [archived("child", "owner"), archived("owner")],
      jobs: kind === "job" ? [{ key: "job", ownerId: "owner" }] : [],
      obligations: kind === "obligation" ? [{ key: "obligation", ownerId: "owner", state: "open" }] : [],
    };
    assert.match(namedUnder(saved, await bindingReferences(data)) ?? "", /owner.*(obligation|job)/);
    const closed = {
      ...data,
      jobs: [{ key: "job", ownerId: "owner", settlement: { outcome: "unverified" } }],
      obligations: [{ key: "obligation", ownerId: "owner", state: "fulfilled" }],
    };
    assert.equal(namedUnder(saved, await bindingReferences(closed)), null);
  });

test("recorded owner transfers supersede native parents, including explicit Human ownership", async () => {
  const f = await fixture();
  await report(f.room.artifacts, {
    agentId: "child",
    artifacts: [{ path: join(f.main, "input"), digest: "d" }],
  });
  const base = { rooms: [f.room], jobs: [], obligations: [] };
  const child = { ...archived("child", "old"), ownership: { ownerId: "new" as string | null } };
  assert.match(
    namedUnder(
      f.main,
      await bindingReferences({ ...base, members: [child, archived("old"), { id: "new", parentId: null }] }),
    ) ?? "",
    /new/,
  );
  const human = { ...child, parentId: "stale-missing", ownership: { ownerId: null } };
  assert.equal(namedUnder(f.main, await bindingReferences({ ...base, members: [human] })), null);
  const cycle = { ...archived("new"), ownership: { ownerId: "child" } };
  assert.match(
    namedUnder(f.main, await bindingReferences({ ...base, members: [child, cycle, archived("old")] })) ?? "",
    /cycle/,
  );
  const missing = { ...child, ownership: { ownerId: "missing" } };
  assert.match(
    namedUnder(f.main, await bindingReferences({ ...base, members: [missing, archived("old")] })) ?? "",
    /missing owner missing/,
  );
});
