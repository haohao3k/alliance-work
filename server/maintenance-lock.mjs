import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

/** The scheduler pause: running plugins (0.1.16+) start no scheduled prompt while it is held. */
export const LOCK = ".maintenance-lock";
/**
 * One maintenance command per home holds this for its whole run (0.1.19+). Plugins never read it,
 * so holding it pauses nothing; a waiting update takes LOCK only while it activates (with --hold,
 * from the end of staging through activation).
 */
export const MUTEX = ".maintenance-mutex";
/** Seconds since the epoch at which this host booted; changes after a reboot. */
export const bootTime = () => Math.round(Date.now() / 1000 - uptime());

/**
 * Whether a maintenance lock is held by a live process. A lock is stale when its owner process
 * on this host is gone, the host rebooted since it was taken, or its owner record was never
 * written (the taker died between mkdir and write) and a grace period passed.
 */
export async function lockState(home, now = Date.now(), name = LOCK) {
  const path = join(home, name);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return { held: false, stale: false, path };
    throw error;
  }
  const owner = await readFile(join(path, "owner.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (!owner) return now - stat.mtimeMs > 60000 ? { held: false, stale: true, path } : { held: true, path };
  if (owner.host !== hostname()) return { held: true, stale: false, path, owner };
  if (Number.isInteger(owner.boot) && Math.abs(owner.boot - bootTime()) > 120)
    return { held: false, stale: true, path, owner };
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return { held: false, stale: true, path, owner };
  }
  return { held: true, stale: false, path, owner };
}

/** Take the lock, replacing a stale one atomically: only one taker can rename it away. */
export async function takeLock(home, name = LOCK) {
  const path = join(home, name);
  try {
    await mkdir(path);
    return path;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const state = await lockState(home, Date.now(), name);
  if (!state.stale)
    throw new Error(
      `Another maintenance operation owns ${path}. If it crashed, verify its process has exited before removing this lock.`,
    );
  const tombstone = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, tombstone);
    // Another taker may have replaced the stale lock between our read and the rename. If what we
    // moved is not the lock we judged stale, put it back and yield.
    const moved = await readFile(join(tombstone, "owner.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (moved?.started !== state.owner?.started || moved?.pid !== state.owner?.pid) {
      await rename(tombstone, path).catch(() => undefined);
      throw new Error(`Another maintenance operation took ${path} first.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rm(tombstone, { recursive: true, force: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another maintenance operation took ${path} first.`);
    throw error;
  }
  return path;
}
