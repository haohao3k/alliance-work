import { execFile } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

/**
 * "Is the work somewhere safe?" for `alliance-work status`. Read-only: it only runs git queries
 * that never write, never take locks, never fetch and never push, and it never throws; a path or
 * tool that cannot be read becomes a warning that says so.
 *
 * A room's results are safe when its project is a Git repository with a remote, every local
 * branch's commits are also on some remote branch, and core.bare was not switched on in a normal
 * checkout (git then refuses status/add/checkout there, and agents work around it).
 * "Remote branch" means a remote-tracking ref known locally: `git push` updates it, a plain
 * fetch is never run here, so a push made from another clone shows up after the next fetch.
 */

const GIT_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 30000;
const CONCURRENCY = 4;
const NAMED_BRANCHES = 3;

const gitEnvironment = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"])
    delete env[name];
  return env;
};

function git(cwd, args, limits) {
  return new Promise((done) => {
    const budget = limits.deadline - Date.now();
    if (budget <= 0) return done({ code: "TIMEOUT", stdout: "", stderr: "" });
    execFile(
      "git",
      ["-C", cwd, "--no-optional-locks", ...args],
      {
        env: gitEnvironment(),
        timeout: Math.min(limits.callMs, budget),
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) return done({ code: 0, stdout, stderr });
        const code = error.code === "ENOENT" ? "ENOENT" : error.killed ? "TIMEOUT" : (error.code ?? 1);
        done({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

const lines = (text) => text.split("\n").filter(Boolean);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Rooms whose project still matters: any unarchived member, or no member yet. */
export function liveRooms(snapshot) {
  const members = snapshot?.members ?? [];
  return (snapshot?.rooms ?? []).filter((room) => {
    const own = members.filter((member) => member.roomId === room.id);
    return !own.length || own.some((member) => !member.archived);
  });
}

const readText = (path) =>
  readFile(path, "utf8").then(
    (text) => text.trim(),
    () => null,
  );
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Finds the repository around `path` by reading the filesystem, with no process spawn (spawning
 * is the slow part on a busy host): the nearest `.git` directory or file upward, or a bare
 * repository layout. Returns the git dir and the common dir shared with linked worktrees.
 */
async function locateRepository(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    const dot = resolve(dir, ".git");
    const info = await stat(dot).catch(() => null);
    let gitDir = null;
    if (info?.isDirectory()) gitDir = dot;
    else if (info?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec((await readText(dot)) ?? "")?.[1];
      if (pointer) gitDir = resolve(dir, pointer);
    } else if ((await exists(resolve(dir, "HEAD"))) && (await exists(resolve(dir, "objects")))) gitDir = dir;
    // An empty or damaged `.git` is not a repository: git itself keeps looking upward.
    if (gitDir && !(await exists(resolve(gitDir, "HEAD")))) gitDir = null;
    if (gitDir) {
      const common = await readText(resolve(gitDir, "commondir"));
      return { gitDir, commonDir: common ? resolve(gitDir, common) : gitDir };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Linked worktrees and the commits that only a detached HEAD holds, from `<common>/worktrees/*`. */
async function readWorktrees({ gitDir, commonDir }) {
  const heads = [await readText(resolve(gitDir, "HEAD"))];
  const names = await readdir(resolve(commonDir, "worktrees")).catch(() => []);
  let linked = 0;
  for (const name of names) {
    const folder = resolve(commonDir, "worktrees", name);
    const marker = await readText(resolve(folder, "gitdir"));
    // A worktree whose directory is gone is prunable, not a place work lives.
    if (!marker || !(await exists(marker))) continue;
    linked++;
    heads.push(await readText(resolve(folder, "HEAD")));
  }
  return { linked, detached: [...new Set(heads.filter((head) => /^[0-9a-f]{40,64}$/.test(head ?? "")))] };
}

/** Facts about one repository from three read-only git calls; `incomplete` names what failed. */
async function inspectRepository(path, where, limits) {
  const { commonDir } = where;
  const facts = { commonDir, incomplete: [], checkout: basename(commonDir) === ".git" };
  const [config, refs, trees] = await Promise.all([
    git(
      path,
      ["config", "--file", resolve(commonDir, "config"), "--get-regexp", "^(core\\.bare|remote\\..*\\.url)$"],
      limits,
    ),
    git(path, ["for-each-ref", "--format=%(refname)\t%(upstream)", "refs/heads", "refs/remotes"], limits),
    readWorktrees(where),
  ]);
  if (refs.code === "ENOENT") return { ...facts, gitMissing: true };
  if (refs.code !== 0)
    facts.incomplete.push(refs.stderr.includes("dubious ownership") ? "refs (dubious ownership)" : "refs");
  // Exit 1 from --get-regexp only means no match.
  if (config.code !== 0 && config.code !== 1) facts.incomplete.push("config");
  facts.linkedWorktrees = trees.linked;

  const remotes = new Set();
  facts.coreBare = false;
  for (const line of lines(config.stdout)) {
    const [key, value = ""] = line.split(/\s+/, 2);
    if (key === "core.bare") facts.coreBare = value.trim().toLowerCase() === "true";
    else remotes.add(key.slice("remote.".length, -".url".length));
  }
  facts.remotes = [...remotes];

  const heads = new Map();
  let remoteRefs = 0;
  for (const line of lines(refs.stdout)) {
    const [ref, upstream = ""] = line.split("\t");
    if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), upstream);
    else if (!ref.endsWith("/HEAD")) remoteRefs++;
  }
  facts.branches = heads.size;
  facts.remoteRefs = remoteRefs;
  if (refs.code !== 0 || (!heads.size && !trees.detached.length)) return facts;

  // One walk lists every commit on a local branch that no remote branch holds, one line each,
  // with the local branches pointing at it. Detached HEADs add the commits no branch holds.
  const [walk, orphan] = await Promise.all([
    git(
      path,
      [
        "log",
        "--branches",
        ...(remoteRefs ? ["--not", "--remotes"] : []),
        "--decorate-refs=refs/heads/",
        "--format=%D",
        "--no-color",
      ],
      limits,
    ),
    trees.detached.length
      ? git(path, ["rev-list", "--count", ...trees.detached, "--not", "--branches", "--remotes"], limits)
      : Promise.resolve({ code: 0, stdout: "0" }),
  ]);
  if (walk.code === 0) {
    const rows = walk.stdout.split("\n");
    if (rows.at(-1) === "") rows.pop();
    facts.localCommits = rows.length;
    const names = new Set();
    for (const row of rows)
      for (const part of row.split(", ")) {
        const name = part.replace(/^HEAD -> /, "");
        if (heads.has(name)) names.add(name);
      }
    facts.unpushed = [...names].sort();
    facts.noUpstream = facts.unpushed.filter((name) => !heads.get(name)).length;
  } else facts.incomplete.push("commits");
  if (orphan.code === 0) facts.detachedCommits = Number.parseInt(orphan.stdout, 10) || 0;
  return facts;
}

async function inspectPath(path, cache, limits) {
  const info = await stat(path).then(
    (found) => found,
    (error) => (["ENOENT", "ENOTDIR"].includes(error.code) ? false : null),
  );
  if (info === false || (info && !info.isDirectory())) return { kind: "missing" };
  if (info === null) return { kind: "unreadable" };
  const where = await locateRepository(path);
  if (!where) {
    // Mercurial and Subversion checkouts are version control too; only Git is inspected here.
    const other = await Promise.all([".hg", ".svn"].map((name) => exists(resolve(path, name))));
    return { kind: other.some(Boolean) ? "other-vcs" : "no-vcs" };
  }
  if (!cache.has(where.commonDir)) cache.set(where.commonDir, inspectRepository(path, where, limits));
  const facts = await cache.get(where.commonDir);
  return facts.gitMissing ? { kind: "git-missing" } : { kind: "git", facts };
}

function describeRooms(rooms) {
  return rooms.map((room) => `"${room.title || room.id}"`).join(", ");
}

/** Warnings for one inspected repository, each one a concrete fact a Human can act on. */
function repositoryWarnings(facts) {
  const out = [];
  const branches = plural(facts.branches, "local branch", "local branches");
  const commits = (n) => (n === undefined ? "commits" : plural(n, "commit"));
  if (facts.coreBare && facts.checkout)
    out.push({
      kind: "core-bare",
      message: `core.bare is true in ${facts.commonDir}, a normal checkout${facts.linkedWorktrees ? ` with ${plural(facts.linkedWorktrees, "linked worktree")}` : ""}; git refuses status, add and checkout there, so agents work around it. Set it back with: git -C ${dirname(facts.commonDir)} config core.bare false`,
    });
  if (!facts.remotes.length) {
    if (facts.branches)
      out.push({
        kind: "no-remote",
        branches: facts.branches,
        commits: facts.localCommits ?? null,
        message: `the repository has no remote, so nothing is backed up elsewhere (${facts.localCommits === undefined ? "commits" : commits(facts.localCommits)} on ${branches})`,
      });
  } else if (facts.unpushed?.length) {
    const shown = facts.unpushed.slice(0, NAMED_BRANCHES).join(", ");
    const more = facts.unpushed.length - NAMED_BRANCHES;
    out.push({
      kind: "unpushed",
      branches: facts.unpushed.length,
      commits: facts.localCommits ?? null,
      withoutUpstream: facts.noUpstream,
      message: `${plural(facts.unpushed.length, "local branch", "local branches")} ${facts.unpushed.length === 1 ? "has" : "have"} ${commits(facts.localCommits)} not on any remote branch (${facts.noUpstream} without an upstream): ${shown}${more > 0 ? `, +${more} more` : ""}`,
    });
  } else if (!facts.remoteRefs && facts.branches)
    out.push({
      kind: "unpushed",
      branches: facts.branches,
      commits: facts.localCommits ?? null,
      withoutUpstream: facts.branches,
      message: `remote ${facts.remotes.join(", ")} is configured but no remote branch is known locally: ${commits(facts.localCommits)} on ${branches} were never pushed`,
    });
  if (facts.detachedCommits)
    out.push({
      kind: "detached",
      commits: facts.detachedCommits,
      message: `${plural(facts.detachedCommits, "commit")} exist only on a detached HEAD of a worktree, on no branch and no remote`,
    });
  if (facts.incomplete.length)
    out.push({
      kind: "check-incomplete",
      message: `could not read ${facts.incomplete.join(", ")} (git failed or timed out); the check is incomplete`,
    });
  return out;
}

/**
 * Warnings for the rooms of a rooms.list snapshot that are still in use. Never throws.
 * `options.gitTimeoutMs` and `options.budgetMs` bound each git call and the whole check; rooms whose
 * project lies inside `options.home` (the Alliance home) are left out.
 * @returns {Promise<{ checked: number, warnings: Array<{kind: string, path: string, rooms: Array<{id: string, title: string}>, message: string}> }>}
 */
export async function workSafety(snapshot, options = {}) {
  try {
    const limits = {
      callMs: options.gitTimeoutMs ?? GIT_TIMEOUT_MS,
      deadline: Date.now() + (options.budgetMs ?? TOTAL_BUDGET_MS),
    };
    const byPath = new Map();
    const homes = options.home
      ? [...new Set([resolve(options.home), await realpath(options.home).catch(() => null)])].filter(Boolean)
      : [];
    for (const room of liveRooms(snapshot)) {
      if (!room.cwd) continue;
      const path = resolve(room.cwd);
      // Room artifacts and candidates under the Alliance home are scratch, not project results.
      if (homes.some((home) => path === home || path.startsWith(`${home}${sep}`))) continue;
      byPath.set(path, [...(byPath.get(path) ?? []), { id: room.id, title: room.title }]);
    }
    const cache = new Map();
    const paths = [...byPath.keys()];
    const inspected = new Map();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, paths.length) }, async () => {
        while (next < paths.length) {
          const path = paths[next++];
          inspected.set(
            path,
            await inspectPath(path, cache, limits).catch((error) => ({
              kind: "unreadable",
              reason: error?.message,
            })),
          );
        }
      }),
    );

    // One warning per repository and kind, naming every room and path that points at it.
    const merged = new Map();
    const add = (id, warning, path, rooms) => {
      const key = `${id}\0${warning.kind}`;
      const entry = merged.get(key) ?? { ...warning, paths: new Set(), rooms: new Map() };
      entry.paths.add(path);
      for (const room of rooms) entry.rooms.set(room.id, room);
      merged.set(key, entry);
    };
    let gitMissing = false;
    for (const [path, rooms] of byPath) {
      const result = inspected.get(path);
      if (result.kind === "no-vcs")
        add(
          path,
          {
            kind: "no-vcs",
            message: "the project directory is not under version control; its files exist only on this disk",
          },
          path,
          rooms,
        );
      else if (result.kind === "missing")
        add(path, { kind: "path-missing", message: "the project directory no longer exists" }, path, rooms);
      else if (result.kind === "unreadable")
        add(
          path,
          {
            kind: "check-incomplete",
            message: `the project directory could not be inspected${result.reason ? ` (${result.reason})` : ""}`,
          },
          path,
          rooms,
        );
      else if (result.kind === "git-missing") gitMissing = true;
      else if (result.kind === "git")
        for (const warning of repositoryWarnings(result.facts))
          add(result.facts.commonDir, warning, path, rooms);
    }
    const warnings = [...merged.values()].map(({ paths: where, rooms, message, ...rest }) => {
      const list = [...rooms.values()];
      const at = [...where];
      return {
        ...rest,
        path: at[0],
        ...(at.length > 1 ? { paths: at } : {}),
        rooms: list,
        message: `${list.length === 1 ? "Room" : "Rooms"} ${describeRooms(list)} (${at.join(", ")}): ${message}`,
      };
    });
    if (gitMissing)
      warnings.push({
        kind: "git-missing",
        path: "",
        rooms: [],
        message:
          "git is not installed or not on PATH for alliance-work, so whether work is on a remote could not be checked",
      });
    return { checked: paths.length, warnings };
  } catch (error) {
    return {
      checked: 0,
      warnings: [
        {
          kind: "check-incomplete",
          path: "",
          rooms: [],
          message: `the safe-place check failed: ${error?.message ?? error}`,
        },
      ],
    };
  }
}

/** The status result with a leading `workSafety` entry; the original fields are untouched. */
export async function withWorkSafety(result, options = {}) {
  return { workSafety: await workSafety(result, options), ...result };
}
