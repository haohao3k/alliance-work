import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { cleanupScratch, cleanupWorktrees, diskCommand, diskReport } from "../scripts/disk-cli.mjs";
import { launchPlan } from "../scripts/launch.mjs";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
import {
  cleanOwnScratch,
  ensureScratch,
  installationKey,
  scratchEnvironment,
  scratchPath,
} from "../server/scratch.mjs";
import { RoomStore } from "../server/store";
import { git, repository, scratchFixture } from "./disk-fixture";

const uid = process.getuid?.() ?? 0;

test("every session gets its own owner-only scratch, namespaced by installation, room and agent", async () => {
  const f = await scratchFixture();
  const other = join(f.root, "other-home");
  await mkdir(other);
  const a = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const b = ensureScratch(f.home, "room-1", "agent-b", { env: f.env });
  const c = ensureScratch(f.home, "room-2", "agent-a", { env: f.env });
  const d = ensureScratch(other, "room-1", "agent-a", { env: f.env });
  assert.equal(new Set([a, b, c, d]).size, 4, "no two sessions share a directory");
  assert.equal(ensureScratch(f.home, "room-1", "agent-a", { env: f.env }), a, "a reopened session returns");
  assert.notEqual(installationKey(f.home), installationKey(other));
  for (let level = a; level !== f.scratchRoot; level = join(level, "..")) {
    assert.equal(lstatSync(level).mode & 0o077, 0, `${level} is owner-only`);
    assert.equal(lstatSync(level).uid, uid);
  }
  assert(a.startsWith(join(f.scratchRoot, `alliance-${uid}`)));
  for (const unsafe of ["..", "a/b", "", ".hidden/../x"])
    assert.throws(() => scratchPath(f.home, "room-1", unsafe, { env: f.env }), /Unsafe/);
});

test("a planted symlink or foreign directory never becomes a session's scratch, and the session still opens", async () => {
  const f = await scratchFixture();
  const outside = join(f.root, "elsewhere");
  await mkdir(outside);
  await mkdir(join(f.scratchRoot, "unused"));
  await symlink(outside, join(f.scratchRoot, `alliance-${uid}`));
  assert.throws(() => ensureScratch(f.home, "room-1", "agent-a", { env: f.env }), /not a plain directory/);
  assert.deepEqual(await readdir(outside), [], "nothing was created through the link");
  const messages: string[] = [];
  const env = scratchEnvironment(f.home, "room-1", "agent-a", {
    env: f.env,
    log: (m: string) => messages.push(m),
  });
  assert.deepEqual(env, { ALLIANCE_SCRATCH: "" }, "no TMPDIR is invented when scratch is unavailable");
  assert.equal(messages.length, 1);
});

test("the launch hook gives every harness a scratch that reaches the native process environment", async () => {
  const f = await scratchFixture();
  const repo = join(f.root, "repo");
  const repo2 = join(f.root, "repo2");
  await mkdir(repo);
  await mkdir(repo2);
  const manifest = await prepareProfiles({
    home: f.home,
    isolatedRoot: join(f.root, "roles"),
    executables: {
      codex: "/usr/bin/false",
      claude: "/usr/bin/false",
      pi: "/usr/bin/false",
      agy: "/usr/bin/false",
    },
  });
  assert(manifest);
  type Handler = (input: unknown, context: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const before = process.env.ALLIANCE_SCRATCH_ROOT;
  process.env.ALLIANCE_SCRATCH_ROOT = f.scratchRoot;
  const dispose = contribute({
    registerProvider() {},
    registerUsageSource() {},
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { home: f.home } }),
      subscribe: () => () => {},
    }),
    handle: (rpc: { name: string; input: { parse(value: unknown): unknown } }, handler: Handler) =>
      handlers.set(rpc.name, (input, context) => handler(rpc.input.parse(input), context)),
    addHook: (name: string, handler: Handler) => hooks.set(name, handler),
  } as unknown as PluginServerContext);
  const workspace = (id: string) => ({
    id,
    refresh: async () => ({ title: null }),
    setTitle: async () => ({}),
  });
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { model: "claude-sonnet-5-5" } }) }) },
    workspaces: { open: async () => workspace("w"), ref: workspace },
  };
  const call = (name: string, input: unknown) => {
    const method = handlers.get(name) ?? hooks.get(name);
    assert(method, `${name} is registered`);
    return method(input, { paseo });
  };
  try {
    const first = (await call("rooms.create", { cwd: repo })) as { id: string };
    const second = (await call("rooms.create", { cwd: repo2 })) as { id: string };
    const open = async (
      agentId: string,
      harness: string,
      cwd: string,
      ambient: Record<string, string> = {},
    ) =>
      (
        (await call("agent.open.before", {
          request: { agentId, workspaceId: "w", provider: `alliance-${harness}-peer`, cwd, env: ambient },
        })) as { env: Record<string, string> }
      ).env;
    const seen = new Map<string, string>();
    for (const harness of ["codex", "claude", "pi", "agy"]) {
      // A stale inherited TMPDIR (the daemon's) must lose to the session's own scratch.
      const env = await open(`${harness}-agent`, harness, repo, { TMPDIR: "/tmp/daemon" });
      assert.equal(env.TMPDIR, env.ALLIANCE_SCRATCH);
      assert.equal(env.ALLIANCE_SCRATCH, scratchPath(f.home, first.id, `${harness}-agent`, { env: f.env }));
      assert(lstatSync(env.TMPDIR).isDirectory());
      assert(!seen.has(env.TMPDIR));
      seen.set(env.TMPDIR, harness);
      // The launcher the native process starts through keeps both variables.
      const plan = await launchPlan(
        f.home,
        `${harness}-peer`,
        ["--version"],
        { PATH: process.env.PATH, PASEO_AGENT_ID: `${harness}-agent`, ...env },
        repo,
      );
      assert.equal(plan.env.TMPDIR, env.TMPDIR, `${harness} sees its own TMPDIR`);
      assert.equal(plan.env.ALLIANCE_SCRATCH, env.ALLIANCE_SCRATCH, `${harness} sees ALLIANCE_SCRATCH`);
    }
    const other = await open("codex-agent", "codex", repo2);
    assert.equal(
      other.ALLIANCE_SCRATCH,
      scratchPath(f.home, first.id, "codex-agent", { env: f.env }),
      "a reopened member keeps its room's scratch",
    );
    assert.notEqual(
      (await open("codex-elsewhere", "codex", repo2)).ALLIANCE_SCRATCH,
      other.ALLIANCE_SCRATCH,
      "another room's member never shares it",
    );
    assert(second.id !== first.id);
  } finally {
    await dispose();
    if (before === undefined) delete process.env.ALLIANCE_SCRATCH_ROOT;
    else process.env.ALLIANCE_SCRATCH_ROOT = before;
  }
});

test("scratch clean empties only the session's own scratch and refuses anything resolving outside it", async () => {
  const f = await scratchFixture();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const neighbour = ensureScratch(f.home, "room-1", "agent-b", { env: f.env });
  const outside = join(f.root, "precious");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  await writeFile(join(neighbour, "theirs.txt"), "theirs");
  await mkdir(join(mine, "pytest/readonly"), { recursive: true });
  await writeFile(join(mine, "pytest/readonly/fixture.bin"), "x".repeat(4096));
  await chmod(join(mine, "pytest/readonly"), 0o500);
  await symlink(outside, join(mine, "link-to-outside"));
  await symlink(neighbour, join(mine, "link-to-neighbour"));
  const session = {
    ...f.env,
    PASEO_AGENT_ID: "agent-a",
    ALLIANCE_BOUND_ROOM: "room-1",
    ALLIANCE_SCRATCH: mine,
  };
  const refusals: [string, NodeJS.ProcessEnv][] = [
    ["another session's directory", { ...session, ALLIANCE_SCRATCH: neighbour }],
    ["a directory outside scratch", { ...session, ALLIANCE_SCRATCH: outside }],
    ["a path climbing out", { ...session, ALLIANCE_SCRATCH: `${mine}/../../../../precious` }],
    ["no ALLIANCE_SCRATCH", { ...session, ALLIANCE_SCRATCH: "" }],
    ["no agent identity", { ...session, PASEO_AGENT_ID: "" }],
  ];
  for (const [what, env] of refusals) {
    await assert.rejects(cleanOwnScratch(f.home, env), /nothing was removed/, what);
    assert(existsSync(join(outside, "keep.txt")), what);
    assert(existsSync(join(neighbour, "theirs.txt")), what);
    assert(existsSync(join(mine, "link-to-outside")), `${what} left this session's own files`);
  }
  const result = await cleanOwnScratch(f.home, session);
  assert(result.removed >= 4);
  assert.deepEqual(await readdir(mine), [], "everything inside, including a read-only fixture tree, is gone");
  assert(existsSync(mine), "the directory itself stays so TMPDIR remains valid");
  assert.equal(
    await (await import("node:fs/promises")).readFile(join(outside, "keep.txt"), "utf8"),
    "keep",
    "a symlink is removed, never followed",
  );
  assert(existsSync(join(neighbour, "theirs.txt")));
});

test("scratch clean refuses a scratch directory that is itself a symlink or reached through one", async () => {
  const f = await scratchFixture();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const outside = join(f.root, "precious");
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  const session = {
    ...f.env,
    PASEO_AGENT_ID: "agent-a",
    ALLIANCE_BOUND_ROOM: "room-1",
    ALLIANCE_SCRATCH: mine,
  };
  const { rm, rename } = await import("node:fs/promises");
  await rm(mine, { recursive: true });
  await symlink(outside, mine);
  await assert.rejects(cleanOwnScratch(f.home, session), /nothing was removed/);
  assert(existsSync(join(outside, "keep.txt")));
  await rm(mine);
  const roomDirectory = join(mine, "..");
  await rm(roomDirectory, { recursive: true });
  await rename(outside, join(f.root, "moved"));
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep");
  await mkdir(join(outside, "agent-a"));
  await writeFile(join(outside, "agent-a", "victim.txt"), "keep");
  await symlink(outside, roomDirectory);
  await assert.rejects(cleanOwnScratch(f.home, session), /nothing was removed/);
  assert(
    existsSync(join(outside, "agent-a", "victim.txt")),
    "a symlinked room directory cannot redirect the clean",
  );
});

test("the scratch command runs through the real CLI and needs no approval", async () => {
  const f = await scratchFixture();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  await writeFile(join(mine, "junk"), "junk");
  const run = (env: NodeJS.ProcessEnv) =>
    spawnSync(
      process.execPath,
      [join(projectRoot, "scripts/cli.mjs"), "scratch", "clean", "--home", f.home],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ALLIANCE_ROLE: "peer", ...env },
      },
    );
  const refused = run({ ...f.env, PASEO_AGENT_ID: "agent-a", ALLIANCE_BOUND_ROOM: "room-1" });
  assert.notEqual(refused.status, 0, "a session without scratch is refused");
  assert(existsSync(join(mine, "junk")));
  const ok = run({
    ...f.env,
    PASEO_AGENT_ID: "agent-a",
    ALLIANCE_BOUND_ROOM: "room-1",
    ALLIANCE_SCRATCH: mine,
  });
  assert.equal(ok.status, 0, ok.stderr);
  assert(!existsSync(join(mine, "junk")));
});

const human = (f: { env: NodeJS.ProcessEnv }) => ({ ...f.env });
const agent = (f: { env: NodeJS.ProcessEnv }) => ({
  ...f.env,
  PASEO_AGENT_ID: "lead",
  ALLIANCE_ROLE: "lead",
});

test("cleanup worktrees lists by default and removes only clean, merged, unused worktrees of archived members", async () => {
  const f = await repository();
  const removable = f.worktree("removable");
  const dirty = f.worktree("dirty");
  await writeFile(join(dirty, "scratch-notes.txt"), "uncommitted");
  const unmerged = f.worktree("unmerged", true);
  const live = f.worktree("live");
  const shared = f.worktree("shared");
  const held = f.worktree("held");
  const locked = f.worktree("locked");
  git(f.main, "worktree", "lock", locked);
  f.member("m-removable", removable, true);
  f.member("m-dirty", dirty, true);
  f.member("m-unmerged", unmerged, true);
  f.member("m-live", live, false);
  f.member("m-shared-done", shared, true);
  f.member("m-shared-live", join(shared), false);
  f.member("m-held", held, true);
  f.member("m-locked", locked, true);
  f.member("m-primary", f.main, true);
  const removableReal = lstatPath(removable);
  const holder: ChildProcess = spawn("sleep", ["900"], { cwd: held });
  try {
    await new Promise((resolve) => holder.once("spawn", resolve));
    const dry = await cleanupWorktrees(f.home, { env: human(f), apply: false });
    const by = new Map(dry.items.map((item: { path: string }) => [item.path, item as unknown]));
    const state = (path: string) =>
      by.get(lstatPath(path)) as unknown as { eligible: boolean; blockers: string[] };
    assert.equal(state(removable).eligible, true);
    for (const kept of [dirty, unmerged, shared, held, locked])
      assert.equal(state(kept).eligible, false, kept);
    assert.equal(by.has(lstatPath(live)), false, "a worktree only live members use is not even a candidate");
    assert.match(state(dirty).blockers.join(), /not clean/);
    assert.match(state(unmerged).blockers.join(), /not merged/);
    assert.match(state(held).blockers.join(), /in use by process/);
    assert.match(state(shared).blockers.join(), /not archived/);
    assert(
      !by.has(lstatPath(f.main)) || (by.get(lstatPath(f.main)) as { eligible: boolean }).eligible === false,
    );
    assert(dry.items.every((item: { action: string }) => item.action !== "removed"));
    for (const path of [removable, dirty, unmerged, live, shared, held, locked])
      assert(existsSync(path), `dry run left ${path}`);

    // Applying is the Human's: an agent session is refused and nothing moves.
    await assert.rejects(cleanupWorktrees(f.home, { env: agent(f), apply: true }), /belongs to the Human/);
    assert(existsSync(removable));

    // Judged again right before removal: the member came back since the listing.
    f.member("m-removable", removable, false);
    const reopened = await cleanupWorktrees(f.home, { env: human(f), apply: true });
    assert(
      reopened.items.every(
        (i: { path: string; action: string }) => i.path !== lstatPath(removable) || i.action === "keep",
      ),
    );
    assert(existsSync(removable), "a member that is no longer archived keeps its worktree");

    f.member("m-removable", removable, true);
    const applied = await cleanupWorktrees(f.home, { env: human(f), apply: true });
    const gone = applied.items.find((i: { path: string }) => i.path === removableReal) as { action: string };
    assert.equal(gone.action, "removed");
    assert(!existsSync(removable));
    for (const kept of [dirty, unmerged, live, shared, held, locked, f.main])
      assert(existsSync(kept), `kept ${kept}`);
    assert.equal(
      git(f.main, "branch", "--list", "feature/removable"),
      "feature/removable",
      "the branch and its commits stay",
    );
    assert(existsSync(join(dirty, "scratch-notes.txt")));
  } finally {
    holder.kill();
  }
});

function lstatPath(path: string) {
  return spawnSync("realpath", [path], { encoding: "utf8" }).stdout.trim();
}

test("merged means reached the shared default branch when the repository has one", async () => {
  const f = await repository();
  const origin = join(f.root, "origin.git");
  git(f.root, "init", "-q", "--bare", "-b", "main", origin);
  git(f.main, "remote", "add", "origin", origin);
  git(f.main, "push", "-q", "origin", "main");
  git(f.main, "remote", "set-head", "origin", "main");
  const merged = f.worktree("merged-here");
  spawnSync("sh", ["-c", "echo later >> README.md"], { cwd: merged });
  git(merged, "commit", "-qam", "merged locally only");
  git(f.main, "merge", "-q", "--ff-only", "feature/merged-here");
  f.member("m-local", merged, true);
  const before = await cleanupWorktrees(f.home, { env: human(f), apply: true });
  assert.equal(
    (before.items[0] as { action: string }).action,
    "keep",
    "a merge that exists only in local main is not shared yet",
  );
  assert(existsSync(merged));
  git(f.main, "push", "-q", "origin", "main");
  const after = await cleanupWorktrees(f.home, { env: human(f), apply: true });
  assert.equal((after.items[0] as { action: string }).action, "removed");
  assert(!existsSync(merged));
});

test("disk reports scratch per room and member, marks archived members cleanable and deletes nothing", async () => {
  const f = await repository();
  const done = f.worktree("done");
  f.member("archived-peer", done, true);
  const activeTree = f.worktree("active");
  f.member("active-peer", activeTree, false);
  const archivedScratch = ensureScratch(f.home, "room-1", "archived-peer", { env: f.env });
  const activeScratch = ensureScratch(f.home, "room-1", "active-peer", { env: f.env });
  const orphan = ensureScratch(f.home, "room-gone", "ghost", { env: f.env });
  await writeFile(join(archivedScratch, "big"), "x".repeat(200_000));
  await writeFile(join(activeScratch, "small"), "x".repeat(10_000));
  await writeFile(join(orphan, "stray"), "x");

  const report = await diskReport(f.home, { env: human(f) });
  const room = report.rooms[0];
  const members = new Map(room.members.map((m: { id: string }) => [m.id, m as unknown]));
  const archived = members.get("archived-peer") as { scratch: { cleanable: boolean; bytes: number } };
  const active = members.get("active-peer") as { scratch: { cleanable: boolean; bytes: number } };
  assert.equal(archived.scratch.cleanable, true);
  assert.equal(active.scratch.cleanable, false);
  assert(archived.scratch.bytes >= 200_000 && active.scratch.bytes >= 10_000);
  assert.equal(room.cleanableBytes, archived.scratch.bytes);
  assert.deepEqual(
    report.orphanScratch.map((o: { path: string }) => o.path),
    [orphan],
  );
  const tree = report.worktrees.find((w: { path: string }) => w.path === lstatPath(done)) as {
    clean: boolean;
    merged: boolean;
    eligible: boolean;
  };
  assert.deepEqual([tree.clean, tree.merged, tree.eligible], [true, true, true]);
  assert(
    !report.worktrees.some((w: { path: string }) => w.path === lstatPath(activeTree)),
    "an active member's worktree is not listed",
  );
  for (const path of [archivedScratch, activeScratch, orphan, done])
    assert(existsSync(path), `disk left ${path}`);
  const text = (await diskCommand(f.home, ["disk"], {}, human(f))) as string;
  assert.match(text, /cleanable/);

  // Archiving is only a mark: a reopened member stops being cleanable without anything stored or timed.
  f.member("archived-peer", done, false);
  const reopened = await diskReport(f.home, { env: human(f) });
  assert.equal(reopened.rooms[0].cleanableBytes, 0);

  // cleanup scratch: dry run first, then only archived members' directories.
  f.member("archived-peer", done, true);
  const dry = await cleanupScratch(f.home, { env: human(f), apply: false });
  assert.deepEqual(
    dry.items.map((i: { action: string }) => i.action),
    ["would-remove"],
  );
  assert(existsSync(join(archivedScratch, "big")));
  await assert.rejects(cleanupScratch(f.home, { env: agent(f), apply: true }), /belongs to the Human/);
  const applied = await cleanupScratch(f.home, { env: human(f), apply: true });
  assert.deepEqual(
    applied.items.map((i: { action: string }) => i.action),
    ["removed"],
  );
  assert(!existsSync(archivedScratch));
  assert(existsSync(join(activeScratch, "small")), "an active member's scratch stays");
  assert(existsSync(join(orphan, "stray")), "scratch nobody records is listed, never removed");
});
