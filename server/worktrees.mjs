import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { sep } from "node:path";

/**
 * Git and process facts behind `disk` and `cleanup`. Everything here only reads, except `removeWorktree`,
 * which runs plain `git worktree remove` (never --force: git itself refuses a dirty or locked tree).
 */

export function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
  });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? result.error?.message ?? "").trim(),
  };
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

export const inside = (path, directory) => path === directory || path.startsWith(`${directory}${sep}`);

/**
 * Processes whose working directory is inside, or whose command line names, one of `paths`.
 * Linux reads /proc; elsewhere one `lsof` call lists every working directory. When the question cannot
 * be answered `ok` is false and a caller must treat every path as in use.
 */
export function holders(paths, options = {}) {
  const ignore = new Set(options.ignorePids ?? []);
  const wanted = [...new Set(paths.flatMap((path) => [path, real(path)]).filter(Boolean))];
  const found = [];
  const cwds = [];
  let ok = true;
  const platform = options.platform ?? process.platform;
  if (platform === "linux" && existsSync("/proc/self/cwd")) {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        cwds.push([Number(entry), readlinkSync(`/proc/${entry}/cwd`).replace(/ \(deleted\)$/, "")]);
      } catch {
        // Gone, or another user's: nothing of ours can be hidden there.
      }
    }
  } else {
    const listing = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-n", "-P"], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (listing.error || !listing.stdout) ok = false;
    else {
      let pid = 0;
      for (const line of listing.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n")) cwds.push([pid, line.slice(1)]);
      }
    }
  }
  for (const [pid, cwd] of cwds)
    if (!ignore.has(pid))
      for (const path of wanted) if (inside(cwd, path)) found.push({ pid, kind: "cwd", path });
  const ps = spawnSync("ps", ["-axww", "-o", "pid=,command="], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ps.error || ps.status !== 0 || !ps.stdout) ok = false;
  else
    for (const line of ps.stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!match || Number(match[1]) === process.pid || ignore.has(Number(match[1]))) continue;
      for (const path of wanted) {
        const at = match[2].indexOf(path);
        const next = at < 0 ? "" : (match[2][at + path.length] ?? " ");
        if (at >= 0 && (next === " " || next === "/"))
          found.push({ pid: Number(match[1]), kind: "args", path });
      }
    }
  return { ok, holders: found };
}

/** The tip the work must have reached: the shared default branch, else the local one. `base` overrides. */
export function mergeTarget(commonDir, base) {
  const resolves = (ref) =>
    git([`--git-dir=${commonDir}`, "rev-parse", "--verify", "-q", `${ref}^{commit}`]).ok;
  if (base) return resolves(base) ? base : null;
  const origin = git([`--git-dir=${commonDir}`, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const candidates = [
    origin.ok ? origin.out : "",
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
  ].filter(Boolean);
  return candidates.find(resolves) ?? null;
}

/** The checkout root a directory belongs to and whether it is a linked worktree; null outside Git. */
export function worktreeRoot(directory) {
  const path = real(directory);
  if (!path) return null;
  const probe = git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"],
    {
      cwd: path,
    },
  );
  const [top, gitDir, common] = probe.out.split("\n");
  if (!probe.ok || !top || !gitDir || !common) return null;
  return { top: real(top) ?? top, linked: real(gitDir) !== real(common), common: real(common) ?? common };
}

/**
 * State of one worktree: what it is, whether it is clean and merged, and every reason it must stay.
 * `removable` only says git and the filesystem agree; callers add who owns it and whether it is in use.
 */
export function inspectWorktree(directory, options = {}) {
  const info = { path: directory, exists: false, blockers: [], structural: [], removable: false };
  /** Reasons that hold whatever the worktree contains; `blockers` adds its content (dirty, unmerged). */
  const block = (reason) => {
    info.blockers.push(reason);
    info.structural.push(reason);
  };
  const root = worktreeRoot(directory);
  if (!existsSync(directory)) {
    block("missing");
    return info;
  }
  info.exists = true;
  if (!root) {
    info.kind = "not-git";
    block("not a Git checkout");
    return info;
  }
  info.path = root.top;
  info.commonDir = root.common;
  const list = git(["worktree", "list", "--porcelain"], { cwd: root.top });
  const entries = list.out.split("\n\n").map((block) => {
    const lines = block.split("\n");
    const field = (name) => lines.find((line) => line === name || line.startsWith(`${name} `));
    return {
      path: real(field("worktree")?.slice(9) ?? "") ?? field("worktree")?.slice(9),
      locked: field("locked") !== undefined,
      prunable: field("prunable") !== undefined,
    };
  });
  const mine = entries.find((entry) => entry.path === root.top);
  info.kind = !root.linked || entries[0]?.path === root.top ? "primary" : "linked";
  if (info.kind === "primary") block("primary checkout");
  else if (!mine) block("not registered with its repository");
  if (mine?.locked) block("locked");
  if (mine?.prunable) block("prunable (stale registration)");
  const status = git(["status", "--porcelain"], { cwd: root.top });
  if (!status.ok) info.blockers.push(`git status failed: ${status.err.slice(0, 120)}`);
  info.clean = status.ok && status.out === "";
  if (status.ok && !info.clean) {
    info.dirtyEntries = status.out.split("\n").length;
    info.blockers.push(`not clean (${info.dirtyEntries} changed or untracked)`);
  }
  info.ignoredEntries = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], {
    cwd: root.top,
  })
    .out.split("\n")
    .filter(Boolean).length;
  const head = git(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root.top });
  info.head = head.ok ? head.out : null;
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root.top });
  info.branch = branch.ok ? branch.out : null;
  info.mergeTarget = mergeTarget(root.common, options.base);
  if (!info.head) info.blockers.push("no commit at HEAD");
  else if (!info.mergeTarget)
    info.blockers.push("no merge target (no origin/main, origin/master, main or master)");
  else {
    info.merged = git([
      `--git-dir=${root.common}`,
      "merge-base",
      "--is-ancestor",
      info.head,
      info.mergeTarget,
    ]).ok;
    if (!info.merged) info.blockers.push(`HEAD is not merged into ${info.mergeTarget}`);
  }
  info.removable = info.blockers.length === 0;
  return info;
}

/** `git worktree remove` without --force: git refuses what is dirty, locked or in a bad state. */
export function removeWorktree(info) {
  const result = git([`--git-dir=${info.commonDir}`, "worktree", "remove", info.path]);
  return result.ok
    ? { removed: true }
    : { removed: false, reason: result.err.split("\n")[0] || "git refused" };
}

/** This process and the shells above it: a session's own shell may sit in the directory it cleans. */
export function ancestors() {
  const chain = [process.pid];
  for (let pid = process.pid; chain.length < 32; ) {
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    const next = Number.parseInt(parent.stdout ?? "", 10);
    if (!Number.isInteger(next) || next <= 1 || chain.includes(next)) break;
    chain.push(next);
    pid = next;
  }
  return chain;
}
