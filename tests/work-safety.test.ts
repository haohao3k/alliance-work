import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withWorkSafety, workSafety } from "../scripts/work-safety.mjs";
import { temporary } from "./temp";

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...identity },
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}
/** A repository with `commits` empty commits on main, optionally pushed to a real bare remote. */
async function repository(options: { remote?: boolean; commits?: number } = {}) {
  const base = await temporary("alliance-safety-");
  const path = join(base, "project");
  await mkdir(path);
  git(path, "init", "-q", "-b", "main");
  for (let n = 1; n <= (options.commits ?? 1); n++) git(path, "commit", "-q", "--allow-empty", "-m", `c${n}`);
  if (options.remote) {
    const remote = join(base, "remote.git");
    git(base, "init", "-q", "--bare", "-b", "main", remote);
    git(path, "remote", "add", "origin", remote);
    git(path, "push", "-q", "-u", "origin", "main");
  }
  return { base, path };
}
// Generous limits: the check is judged by what it finds, not by how fast a loaded CI host runs git.
const patient = { gitTimeoutMs: 120_000, budgetMs: 600_000 };
const room = (cwd: string, id = "r1", title = "Project room") => ({ id, title, cwd });
const check = (cwd: string, extra: { members?: unknown[] } = {}) =>
  workSafety({ rooms: [room(cwd)], members: extra.members ?? [] }, patient) as Promise<{
    checked: number;
    warnings: Array<{
      kind: string;
      path: string;
      message: string;
      branches?: number;
      commits?: number;
      rooms: Array<{ id: string }>;
    }>;
  }>;
const kinds = (result: Awaited<ReturnType<typeof check>>) => result.warnings.map((w) => w.kind).sort();

test("a pushed repository with a remote raises no warning", async () => {
  const { path } = await repository({ remote: true });
  assert.deepEqual((await check(path)).warnings, []);
});

test("a repository without a remote says its commits exist only on this disk", async () => {
  const { path } = await repository({ commits: 3 });
  const { warnings } = await check(path);
  assert.deepEqual(
    warnings.map((w) => [w.kind, w.branches, w.commits]),
    [["no-remote", 1, 3]],
  );
  assert.ok(warnings[0].message.includes(path) && warnings[0].message.includes("Project room"));
  assert.deepEqual(warnings[0].rooms, [{ id: "r1", title: "Project room" }]);
});

test("work branches with commits on no remote branch are counted, with and without an upstream", async () => {
  const { path } = await repository({ remote: true });
  git(path, "checkout", "-q", "-b", "work/one");
  git(path, "commit", "-q", "--allow-empty", "-m", "w1");
  git(path, "commit", "-q", "--allow-empty", "-m", "w2");
  git(path, "checkout", "-q", "-b", "work/two", "main");
  git(path, "commit", "-q", "--allow-empty", "-m", "w3");
  git(path, "push", "-q", "-u", "origin", "work/two");
  git(path, "commit", "-q", "--allow-empty", "-m", "w4"); // ahead of its upstream
  git(path, "branch", "merged", "main"); // same commit as main: nothing to lose
  const { warnings } = await check(path);
  assert.equal(warnings.length, 1);
  const [warning] = warnings as Array<(typeof warnings)[number] & { withoutUpstream?: number }>;
  assert.equal(warning.kind, "unpushed");
  assert.equal(warning.branches, 2);
  assert.equal(warning.commits, 3);
  assert.equal(warning.withoutUpstream, 1);
  assert.ok(warning.message.includes("work/one") && !warning.message.includes("merged"));
  // Pushing the work clears the warning.
  git(path, "push", "-q", "origin", "work/two");
  git(path, "push", "-q", "-u", "origin", "work/one");
  assert.deepEqual((await check(path)).warnings, []);
});

test("a configured remote nothing was pushed to is not a safe place either", async () => {
  const { base, path } = await repository({ commits: 2 });
  git(path, "remote", "add", "origin", join(base, "nowhere.git"));
  const { warnings } = await check(path);
  assert.deepEqual(
    warnings.map((w) => [w.kind, w.branches, w.commits]),
    [["unpushed", 1, 2]],
  );
});

test("many branches are judged from one walk, and only the unpushed one is named", async () => {
  const { path } = await repository({ remote: true });
  const head = git(path, "rev-parse", "HEAD");
  const refs = Array.from({ length: 300 }, (_, n) => `create refs/heads/side/${n} ${head}\n`).join("");
  const done = spawnSync("git", ["-C", path, "update-ref", "--stdin"], { input: refs, encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual((await check(path)).warnings, []);
  git(path, "checkout", "-q", "side/150");
  git(path, "commit", "-q", "--allow-empty", "-m", "only here");
  const { warnings } = await check(path);
  assert.deepEqual(
    warnings.map((w) => [w.kind, w.branches, w.commits]),
    [["unpushed", 1, 1]],
  );
  assert.ok(warnings[0].message.includes("side/150"));
});

test("a commit held only by a detached worktree HEAD is reported", async () => {
  const { base, path } = await repository({ remote: true });
  const tree = join(base, "detached-tree");
  git(path, "worktree", "add", "-q", "--detach", tree);
  git(tree, "commit", "-q", "--allow-empty", "-m", "floating");
  assert.deepEqual(
    (await check(path)).warnings.map((w) => [w.kind, w.commits]),
    [["detached", 1]],
  );
});

test("core.bare on a normal checkout with worktrees is reported, and nothing is changed", async () => {
  const { base, path } = await repository({ remote: true });
  const tree = join(base, "linked");
  git(path, "worktree", "add", "-q", "-b", "side", tree);
  git(path, "config", "core.bare", "true");
  const config = join(path, ".git", "config");
  const before = await readFile(config, "utf8");
  const refs = git(path, "for-each-ref");
  for (const cwd of [path, tree]) {
    const { warnings } = await check(cwd);
    assert.deepEqual(
      warnings.map((w) => w.kind),
      ["core-bare"],
    );
    assert.ok(warnings[0].message.includes(join(path, ".git")) && warnings[0].message.includes("1 linked"));
  }
  assert.equal(await readFile(config, "utf8"), before);
  assert.equal(git(path, "for-each-ref"), refs);
});

test("a deliberate bare repository layout is not flagged for core.bare", async () => {
  const { base } = await repository({ remote: true });
  assert.ok(!kinds(await check(join(base, "remote.git"))).includes("core-bare"));
});

test("a check that runs out of time reports it instead of failing", async () => {
  const { path } = await repository({ remote: true });
  const result = await workSafety({ rooms: [room(path)], members: [] }, { budgetMs: 0 });
  assert.deepEqual(
    result.warnings.map((w) => w.kind),
    ["check-incomplete"],
  );
});

test("a project without version control, and one that vanished, are reported by path", async () => {
  const base = await temporary("alliance-safety-plain-");
  const result = await workSafety(
    {
      rooms: [room(base, "plain", "Plain"), room(join(base, "gone"), "gone", "Gone")],
      members: [],
    },
    patient,
  );
  assert.deepEqual(
    result.warnings.map((w) => [w.kind, w.path]).sort(),
    [
      ["no-vcs", base],
      ["path-missing", join(base, "gone")],
    ].sort(),
  );
});

test("rooms whose members are all archived are not checked, rooms with a live member are", async () => {
  const base = await temporary("alliance-safety-archive-");
  const members = [
    { roomId: "old", archived: true },
    { roomId: "live", archived: true },
    { roomId: "live", archived: false },
  ];
  const result = await workSafety(
    {
      rooms: [room(base, "old", "Old"), room(base, "live", "Live"), room(base, "fresh", "Fresh")],
      members,
    },
    patient,
  );
  assert.deepEqual(
    result.warnings.flatMap((w) => w.rooms.map((r) => r.id).sort()),
    ["fresh", "live"],
  );
  assert.equal(result.warnings.length, 1, "rooms on the same path share one warning");
});

test("rooms sharing a repository get one warning that names them all", async () => {
  const { path } = await repository({ commits: 1 });
  const result = await workSafety(
    {
      rooms: [room(path, "a", "Alpha"), room(path, "b", "Beta")],
      members: [],
    },
    patient,
  );
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.warnings[0].rooms.map((r) => r.id).sort(), ["a", "b"]);
});

test("a missing git binary or a hostile snapshot never throws", async () => {
  const { path } = await repository({ remote: true });
  const empty = await temporary("alliance-safety-nogit-");
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    const result = await check(path);
    assert.deepEqual(kinds(result), ["git-missing"]);
  } finally {
    process.env.PATH = saved;
  }
  await writeFile(join(empty, "file"), "x");
  const odd = await workSafety(
    { rooms: [room(join(empty, "file")), { id: "x", title: "x" }], members: [] },
    patient,
  );
  assert.ok(Array.isArray(odd.warnings));
  assert.deepEqual((await workSafety(undefined, patient)).warnings, []);
});

test("status keeps every field it had and leads with workSafety", async () => {
  const base = await temporary("alliance-safety-status-");
  const status = { rooms: [room(base)], members: [], jobs: [], wakeupHealth: { error: null } };
  const result = (await withWorkSafety(status)) as Record<string, unknown>;
  assert.equal(Object.keys(result)[0], "workSafety");
  for (const [key, value] of Object.entries(status)) assert.deepEqual(result[key], value);
});

test("rooms whose project lies inside the Alliance home are scratch and give no warning", async () => {
  const { base, path } = await repository({ commits: 2 }); // no remote: would warn anywhere else
  const scratch = join(base, "project", "rooms", "r1", "candidates");
  await mkdir(scratch, { recursive: true });
  const rooms = [room(path, "home-room", "Scratch"), room(scratch, "inner", "Inner")];
  const outside = await workSafety({ rooms, members: [] }, patient);
  assert.deepEqual(
    outside.warnings.map((w) => w.kind),
    ["no-remote"],
  );
  assert.equal(outside.warnings[0].rooms.length, 2);
  const inside = await workSafety({ rooms, members: [] }, { ...patient, home: path });
  assert.deepEqual(inside, { checked: 0, warnings: [] });
  // A sibling path that merely shares the prefix is not inside the home.
  const sibling = await workSafety({ rooms: [room(path)], members: [] }, { ...patient, home: `${path}-x` });
  assert.deepEqual(
    sibling.warnings.map((w) => w.kind),
    ["no-remote"],
  );
});
