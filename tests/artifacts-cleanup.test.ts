import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { cleanupArtifacts, renderArtifacts } from "../scripts/artifacts-cli.mjs";
import { cleanupScratch, diskCommand } from "../scripts/disk-cli.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { parseAge } from "../server/artifacts.mjs";
import { ensureScratch } from "../server/scratch.mjs";
import { git, repository } from "./disk-fixture";

/** Writes a file, creating its directories, and ages everything under `top` by `days`. */
async function put(path: string, text = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}
function age(path: string, days: number) {
  const stamp = new Date(Date.now() - days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const touch = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  spawnSync("find", [path, "-exec", "touch", "-h", "-t", touch, "{}", "+"]);
}
const session = (f: { env: NodeJS.ProcessEnv }, room: string, agent: string, scratch: string) => ({
  ...f.env,
  PASEO_AGENT_ID: agent,
  ALLIANCE_ROLE: "peer",
  ALLIANCE_BOUND_ROOM: room,
  ALLIANCE_SCRATCH: scratch,
});
/** realpath that still works once the last component has been removed. */
const real = (path: string) =>
  join(spawnSync("realpath", [dirname(path)], { encoding: "utf8" }).stdout.trim(), basename(path));
const find = (result: { items: { path: string }[] }, path: string) =>
  result.items.find((item) => item.path === real(path)) as
    | { action: string; reason?: string; path: string }
    | undefined;

test("a session lists artifacts in its own scratch, then removes only old, unused, real directories there", async () => {
  const f = await repository();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const env = session(f, "room-1", "agent-a", mine);
  const outside = join(f.root, "precious");
  await put(join(outside, "keep"), "keep");
  await put(join(mine, "old/package.json"), "{}");
  await put(join(mine, "old/node_modules/pkg/index.js"));
  await put(join(mine, "old/src/keep.js"));
  await put(join(mine, "fresh/package.json"), "{}");
  await put(join(mine, "fresh/node_modules/pkg/index.js"));
  await put(join(mine, "linked/package.json"), "{}");
  await symlink(outside, join(mine, "linked/node_modules"));
  await put(join(mine, "busy/pyproject.toml"));
  await put(join(mine, "busy/.venv/lib/x"));
  await put(join(mine, "busy/src/__pycache__/m.pyc"));
  for (const dir of ["old", "linked", "busy"]) age(join(mine, dir), 3);

  const dry = await cleanupArtifacts(f.home, { env, apply: false });
  assert.equal(dry.scope, "own-scratch");
  assert.equal(find(dry, join(mine, "old/node_modules"))?.action, "would-remove");
  assert.equal(
    find(dry, join(mine, "fresh/node_modules")),
    undefined,
    "younger than the threshold: not listed",
  );
  assert.equal(dry.youngerSkipped, 1);
  assert.equal(find(dry, join(mine, "linked/node_modules")), undefined, "a symlink is never a candidate");
  assert(dry.items.every((item: { action: string }) => item.action !== "removed"));
  assert(existsSync(join(mine, "old/node_modules/pkg/index.js")), "listing deletes nothing");
  assert.match(renderArtifacts(dry), /DRY RUN/);
  assert.equal((await cleanupArtifacts(f.home, { env, apply: false, older: "0m" })).youngerSkipped, 0);
  assert.equal(parseAge("2w"), 14 * 86_400);
  assert.throws(() => parseAge("soon"), /Invalid --older/);

  const holder: ChildProcess = spawn("sleep", ["900"], { cwd: join(mine, "busy") });
  try {
    await new Promise((resolve) => holder.once("spawn", resolve));
    const applied = await cleanupArtifacts(f.home, { env, apply: true });
    assert.equal(find(applied, join(mine, "old/node_modules"))?.action, "removed");
    assert(!existsSync(join(mine, "old/node_modules")));
    assert(existsSync(join(mine, "old/src/keep.js")), "only the artifact directory goes");
    assert(existsSync(join(mine, "fresh/node_modules/pkg/index.js")), "a young directory stays");
    assert(lstatSync(join(mine, "linked/node_modules")).isSymbolicLink());
    assert(existsSync(join(outside, "keep")), "nothing behind a symlink is touched");
    assert.match(find(applied, join(mine, "busy/.venv"))?.reason ?? "", /in use by process/);
    assert(existsSync(join(mine, "busy/.venv/lib/x")), "a directory whose project has a process in it stays");
  } finally {
    holder.kill();
  }
});

test("a session cannot apply outside its own scratch and never reaches primary checkouts", async () => {
  const f = await repository();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const env = session(f, "room-1", "agent-a", mine);
  const theirs = ensureScratch(f.home, "room-1", "agent-b", { env: f.env });
  await put(join(theirs, "p/package.json"), "{}");
  await put(join(theirs, "p/node_modules/x"));
  age(join(theirs, "p"), 3);
  f.member("agent-b", f.main, true);
  await assert.rejects(
    cleanupArtifacts(f.home, { env, apply: true, scope: "archived" }),
    /only inside its own scratch/,
  );
  await assert.rejects(cleanupArtifacts(f.home, { env, includePrimary: true }), /belongs to the Human/);
  await assert.rejects(
    cleanupArtifacts(f.home, { env: { ...env, ALLIANCE_SCRATCH: theirs }, apply: true }),
    /not this session's scratch/,
  );
  assert(existsSync(join(theirs, "p/node_modules/x")), "another session's scratch stays");
  await assert.rejects(
    cleanupArtifacts(f.home, { env: f.env, scope: "own-scratch" }),
    /session's own scratch/,
  );
});

test("the Human cleans archived members' worktrees and scratch; tracked, unignored, live, young and primary stay", async () => {
  const f = await repository();
  await put(join(f.main, ".gitignore"), "node_modules/\n.venv/\n");
  await put(join(f.main, "package.json"), "{}");
  await put(join(f.main, ".turbo/tracked.txt"), "tracked on purpose");
  git(f.main, "add", ".");
  git(f.main, "commit", "-q", "-m", "manifest and a tracked cache dir");
  const done = f.worktree("done");
  const dirty = f.worktree("dirty");
  const live = f.worktree("live");
  const fresh = f.worktree("fresh");
  await writeFile(join(dirty, "wip.txt"), "uncommitted work");
  for (const tree of [done, dirty, live, fresh, f.main]) {
    await put(join(tree, "node_modules/pkg/index.js"));
    age(join(tree, "node_modules"), 3);
  }
  await put(join(done, ".next/cache"));
  age(join(done, ".next"), 3);
  age(join(done, ".turbo"), 3);
  await put(join(fresh, "node_modules/pkg/new.js"));
  f.member("m-done", done, true);
  f.member("m-dirty", dirty, true);
  f.member("m-live", live, false);
  f.member("m-fresh", fresh, true);
  const archivedScratch = ensureScratch(f.home, "room-1", "m-done", { env: f.env });
  await put(join(archivedScratch, "build/package.json"), "{}");
  await put(join(archivedScratch, "build/node_modules/x"));
  age(join(archivedScratch, "build"), 3);

  const dry = await cleanupArtifacts(f.home, { env: f.env, apply: false });
  assert.equal(dry.scope, "archived");
  assert.equal(find(dry, join(done, "node_modules"))?.action, "would-remove");
  assert.equal(find(dry, join(dirty, "node_modules"))?.action, "would-remove");
  assert.match(find(dry, join(done, ".turbo"))?.reason ?? "", /Git tracks/);
  assert.match(find(dry, join(done, ".next"))?.reason ?? "", /not ignored by Git/);
  assert.equal(find(dry, join(archivedScratch, "build/node_modules"))?.action, "would-remove");
  for (const hidden of [live, f.main]) assert.equal(find(dry, join(hidden, "node_modules")), undefined);
  assert(existsSync(join(done, "node_modules/pkg/index.js")), "listing deletes nothing");

  await cleanupArtifacts(f.home, { env: f.env, apply: true });
  assert(!existsSync(join(done, "node_modules")));
  assert(!existsSync(join(dirty, "node_modules")));
  assert(existsSync(join(dirty, "wip.txt")), "source work is never touched");
  assert(existsSync(join(done, ".turbo/tracked.txt")));
  assert(existsSync(join(done, ".next/cache")));
  assert(
    existsSync(join(live, "node_modules/pkg/index.js")),
    "a live member's worktree is outside the scope",
  );
  assert(existsSync(join(fresh, "node_modules/pkg/new.js")), "the age threshold holds in worktrees too");
  assert(
    existsSync(join(f.main, "node_modules/pkg/index.js")),
    "the primary checkout needs --include-primary",
  );
  assert(!existsSync(join(archivedScratch, "build/node_modules")));

  const primary = await cleanupArtifacts(f.home, { env: f.env, apply: false, includePrimary: true });
  assert.equal(find(primary, join(f.main, "node_modules"))?.action, "would-remove");
  assert(existsSync(join(f.main, "node_modules/pkg/index.js")));
  await cleanupArtifacts(f.home, { env: f.env, apply: true, includePrimary: true });
  assert(!existsSync(join(f.main, "node_modules")), "the Human can opt in to the primary checkout");
  assert(existsSync(join(f.main, "package.json")));
});

test("artifacts of the installation or the running code are never removed", async () => {
  const f = await repository();
  const inHome = { ...f.env, ALLIANCE_SCRATCH_ROOT: join(f.home, "scratch") };
  const path = ensureScratch(f.home, "room-1", "m-old", { env: inHome });
  f.member("m-old", f.main, true);
  await put(join(path, "release/package.json"), "{}");
  await put(join(path, "release/node_modules/x"));
  age(join(path, "release"), 3);
  const result = await cleanupArtifacts(f.home, { env: inHome, apply: true });
  assert.match(
    find(result, join(path, "release/node_modules"))?.reason ?? "",
    /installation or the running code/,
  );
  assert(existsSync(join(path, "release/node_modules/x")));
  assert(!result.items.some((item: { path: string }) => item.path.startsWith(real(projectRoot))));
});

test("files recorded evidence names are kept while a member or an owner above it is pending", async () => {
  const f = await repository();
  const child = ensureScratch(f.home, "room-1", "child", { env: f.env });
  await put(join(child, "p/package.json"), "{}");
  await put(join(child, "p/node_modules/pkg/index.js"));
  await put(join(child, "out/result.txt"), "named artifact");
  age(join(child, "p"), 3);
  f.member("lead", f.main, false);
  f.member("child", f.main, true, { parentId: "lead" });
  const run = join(f.room.artifacts, "evidence/run-1");
  await mkdir(run, { recursive: true });
  await writeFile(
    join(run, "report.json"),
    JSON.stringify({
      agentId: "child",
      candidate: { cwd: f.main },
      artifacts: [
        { path: join(child, "out/result.txt"), digest: "d" },
        { path: join(child, "p/node_modules/pkg/index.js"), digest: "e" },
      ],
    }),
  );

  const scratch = await cleanupScratch(f.home, { env: f.env, apply: true });
  assert.match((scratch.items[0] as { reason?: string }).reason ?? "", /named by the evidence of child/);
  assert(existsSync(join(child, "out/result.txt")), "a pending owner keeps the file its evidence names");
  const artifacts = await cleanupArtifacts(f.home, { env: f.env, apply: true });
  assert.match(find(artifacts, join(child, "p/node_modules"))?.reason ?? "", /named by the evidence/);
  assert(existsSync(join(child, "p/node_modules/pkg/index.js")));

  f.member("lead", f.main, true);
  const done = await cleanupArtifacts(f.home, { env: f.env, apply: true });
  assert.equal(find(done, join(child, "p/node_modules"))?.action, "removed");
  assert.equal((await cleanupScratch(f.home, { env: f.env, apply: true })).items[0].action, "removed");
  assert(!existsSync(child));
});

test("scratch clean PATH removes one subpath of the session's scratch, preserves evidence, and refuses escapes", async () => {
  const f = await repository();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  const env = session(f, "room-1", "agent-a", mine);
  const outside = join(f.root, "precious");
  await put(join(outside, "keep"), "keep");
  await put(join(mine, "rebuildable/cache/blob"));
  await put(join(mine, "manifest-data/result.txt"), "named");
  await symlink(outside, join(mine, "door"));
  f.member("agent-a", f.main, false);
  const run = join(f.room.artifacts, "evidence/run-1");
  await mkdir(run, { recursive: true });
  await writeFile(
    join(run, "report.json"),
    JSON.stringify({
      agentId: "agent-a",
      artifacts: [{ path: join(mine, "manifest-data/result.txt"), digest: "d" }],
    }),
  );
  const clean = (path: string) => diskCommand(f.home, ["scratch", "clean", path], {}, env);

  for (const attempt of ["../agent-b", outside, "..", join(mine, "door/keep"), "door/keep"])
    await assert.rejects(clean(attempt), /nothing was removed|outside/, attempt);
  assert(existsSync(join(outside, "keep")));

  assert.doesNotMatch(String(await clean("rebuildable")), /Warning/);
  assert(!existsSync(join(mine, "rebuildable")));
  assert(existsSync(join(mine, "manifest-data/result.txt")), "the rest stays");

  await assert.rejects(clean("manifest-data"), /Warning:.*evidence.*nothing was removed/);
  assert(existsSync(join(mine, "manifest-data/result.txt")), "evidence is protected before deletion");

  await clean("door");
  assert(!existsSync(join(mine, "door")), "a link is removed");
  assert(existsSync(join(outside, "keep")), "never followed");
  assert(existsSync(mine));
});

test("cleanup artifacts runs through the real CLI: lists by default and refuses a session's wider apply", async () => {
  const f = await repository();
  const mine = ensureScratch(f.home, "room-1", "agent-a", { env: f.env });
  await put(join(mine, "p/package.json"), "{}");
  await put(join(mine, "p/node_modules/x"));
  age(join(mine, "p"), 3);
  const cli = (args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [join(projectRoot, "scripts/cli.mjs"), ...args, "--home", f.home], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  const env = session(f, "room-1", "agent-a", mine);
  const listed = cli(["cleanup", "artifacts", "--json"], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).items[0].action, "would-remove");
  assert(existsSync(join(mine, "p/node_modules/x")));
  const wide = cli(["cleanup", "artifacts", "--scope", "archived", "--apply"], env);
  assert.notEqual(wide.status, 0);
  assert(existsSync(join(mine, "p/node_modules/x")));
  const own = cli(["cleanup", "artifacts", "--apply"], env);
  assert.equal(own.status, 0, own.stderr);
  assert(!existsSync(join(mine, "p/node_modules")));
});
