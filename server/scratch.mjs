import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { chmod, lstat, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Per-session scratch. Every Alliance session gets one directory that is not tmpfs, not under a role
 * home and namespaced by user, installation, room and agent, so nobody can reach or empty another
 * session's. The path is derived, never stored: a reopened member gets the same directory back and
 * no store record exists for an older release to trip over.
 *
 *   <root>/alliance-<uid>/<installation>/<room>/<agent>     (root defaults to /var/tmp)
 */

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Where scratch lives. ALLIANCE_SCRATCH_ROOT moves it (tests, hosts whose /var/tmp is too small). */
export function scratchRoot(env = process.env) {
  const configured = env.ALLIANCE_SCRATCH_ROOT;
  if (configured && !configured.startsWith("/")) throw new Error("ALLIANCE_SCRATCH_ROOT must be absolute");
  return resolve(configured || "/var/tmp");
}

const realOrResolved = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Names one installation (its home) without putting the home path into a directory name. */
export function installationKey(home) {
  return createHash("sha256").update(realOrResolved(home)).digest("hex").slice(0, 12);
}

function segment(value, what) {
  if (typeof value !== "string" || !SEGMENT.test(value) || value === "." || value === "..")
    throw new Error(`Unsafe ${what} for a scratch directory: ${JSON.stringify(value)}`);
  return value;
}

/** The user's namespace under the root. */
export function userScratchBase(options = {}) {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  return join(scratchRoot(options.env), `alliance-${uid}`);
}

/** The directory of one session. Pure: creates nothing. */
export function scratchPath(home, roomId, agentId, options = {}) {
  return join(
    userScratchBase(options),
    installationKey(home),
    segment(roomId, "room"),
    segment(agentId, "agent"),
  );
}

/** The directory holding every session of one installation (for the disk report). */
export function installationScratch(home, options = {}) {
  return join(userScratchBase(options), installationKey(home));
}

function ownedDirectory(path, uid) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${path} is not a plain directory; refusing to use it as scratch`);
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${path} belongs to another user; refusing to use it as scratch`);
  return info;
}

/**
 * Creates the session directory owner-only, level by level, refusing a symlink or another user's
 * directory at any level below the root. Returns the path.
 */
export function ensureScratch(home, roomId, agentId, options = {}) {
  const uid = options.uid ?? process.getuid?.();
  const target = scratchPath(home, roomId, agentId, options);
  const root = scratchRoot(options.env);
  mkdirSync(root, { recursive: true, mode: 0o755 });
  let current = root;
  for (const part of target.slice(root.length + 1).split(sep)) {
    current = join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = ownedDirectory(current, uid);
    if (info.mode & 0o077) chmodSync(current, 0o700);
  }
  return target;
}

/**
 * What a session's launch environment gets. A scratch that cannot be prepared (read-only /var/tmp,
 * a planted symlink) must not stop the session from opening: it simply gets no scratch.
 * @returns {Record<string, string>}
 */
export function scratchEnvironment(home, roomId, agentId, options = {}) {
  try {
    const path = ensureScratch(home, roomId, agentId, options);
    return { TMPDIR: path, ALLIANCE_SCRATCH: path };
  } catch (error) {
    (options.log ?? console.error)(`Alliance scratch unavailable for ${agentId}: ${error.message}`);
    return { ALLIANCE_SCRATCH: "" };
  }
}

/** Disk usage of a directory tree without following links: bytes, files and newest write (epoch ms). */
export async function measure(path) {
  const total = { bytes: 0, files: 0, newest: 0 };
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      let info;
      try {
        info = await lstat(full);
      } catch {
        continue;
      }
      total.bytes += (info.blocks ?? 0) * 512 || info.size;
      total.files += 1;
      total.newest = Math.max(total.newest, info.mtimeMs);
      if (info.isDirectory()) await walk(full);
    }
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) return { ...total, exists: false };
    total.newest = info.mtimeMs;
  } catch {
    return { ...total, exists: false };
  }
  await walk(path);
  return { ...total, exists: true };
}

/**
 * Removes everything inside `directory` (not the directory itself unless `self`), never following a
 * symlink and never crossing onto another filesystem. A read-only directory that belongs to this
 * user (a pytest fixture) is made writable first. Returns what was removed.
 */
export async function emptyDirectory(directory, { self = false } = {}) {
  const rootInfo = await lstat(directory);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error(`${directory} is not a plain directory`);
  const result = { removed: 0, bytes: 0, skipped: [] };
  const uid = process.getuid?.();
  async function remove(path, info) {
    if (info.dev !== rootInfo.dev) {
      result.skipped.push(path);
      return;
    }
    if (info.isDirectory()) {
      if (uid !== undefined && info.uid === uid && (info.mode & 0o700) !== 0o700)
        await chmod(path, (info.mode & 0o7777) | 0o700);
      for (const entry of await readdir(path)) {
        const child = join(path, entry);
        await remove(child, await lstat(child));
      }
      if (result.skipped.some((skipped) => skipped.startsWith(`${path}${sep}`))) return;
      await rmdir(path);
    } else {
      await unlink(path);
      result.bytes += (info.blocks ?? 0) * 512 || info.size;
    }
    result.removed += 1;
  }
  if (uid !== undefined && rootInfo.uid === uid && (rootInfo.mode & 0o700) !== 0o700)
    await chmod(directory, (rootInfo.mode & 0o7777) | 0o700);
  for (const entry of await readdir(directory)) {
    const child = join(directory, entry);
    try {
      await remove(child, await lstat(child));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      result.skipped.push(`${child}: ${error.code ?? error.message}`);
    }
  }
  if (self && !result.skipped.length) await rmdir(directory);
  return result;
}

export async function ownScratch(home, env = process.env, what = "scratch clean") {
  const agentId = env.PASEO_AGENT_ID;
  const roomId = env.ALLIANCE_BOUND_ROOM;
  const declared = env.ALLIANCE_SCRATCH;
  if (!agentId || !roomId)
    throw new Error(`${what} runs inside an Alliance agent session; nothing was removed.`);
  if (!declared)
    throw new Error(
      "This session has no ALLIANCE_SCRATCH (the plugin could not prepare one, or it predates scratch); nothing was removed.",
    );
  const expected = scratchPath(home, roomId, agentId, { env });
  if (declared !== expected)
    throw new Error(
      `ALLIANCE_SCRATCH is not this session's scratch directory (${expected}); nothing was removed.`,
    );
  let info;
  try {
    info = await lstat(expected);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`${expected} is not a plain directory; nothing was removed.`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw new Error(`${expected} belongs to another user; nothing was removed.`);
  // Every level above must be a real directory too, or the path could leave the namespace.
  const base = installationScratch(home, { env });
  if (realpathSync(expected) !== join(realpathSync(base), roomId, agentId))
    throw new Error(`${expected} resolves outside this installation's scratch; nothing was removed.`);
  return expected;
}

/**
 * `alliance-work scratch clean [PATH]`: the session empties its own scratch, or removes one subpath of
 * it. The directory is recomputed from the session's own identity; the environment variable only has to
 * agree with it, so a variable pointing anywhere else (another session, $HOME, a symlink) is refused and
 * nothing is touched. A PATH must lie inside that directory and every directory above it must resolve
 * inside it too; a link at PATH is removed, never followed.
 */
export async function cleanOwnScratch(home, env = process.env, subpath = undefined) {
  const path = await ownScratch(home, env);
  if (!path)
    return {
      path: scratchPath(home, env.ALLIANCE_BOUND_ROOM, env.PASEO_AGENT_ID, { env }),
      removed: 0,
      bytes: 0,
      skipped: [],
    };
  if (subpath === undefined) return { path, ...(await emptyDirectory(path)) };
  const target = resolve(path, subpath);
  if (target === path) return { path, ...(await emptyDirectory(path)) };
  if (!target.startsWith(`${path}${sep}`))
    throw new Error(`${subpath} is outside this session's scratch (${path}); nothing was removed.`);
  const realScratch = realpathSync(path);
  let parent;
  try {
    parent = realpathSync(dirname(target));
  } catch (error) {
    if (error.code === "ENOENT") return { path: target, removed: 0, bytes: 0, skipped: [], missing: true };
    throw error;
  }
  if (parent !== realScratch && !parent.startsWith(`${realScratch}${sep}`))
    throw new Error(`${subpath} resolves outside this session's scratch; nothing was removed.`);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return { path: target, removed: 0, bytes: 0, skipped: [], missing: true };
    throw error;
  }
  if (info.isDirectory() && !info.isSymbolicLink())
    return { path: target, ...(await emptyDirectory(target, { self: true })) };
  await unlink(target);
  return { path: target, removed: 1, bytes: (info.blocks ?? 0) * 512 || info.size, skipped: [] };
}
