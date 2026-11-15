import { lstat, readdir, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Used share above which a filesystem is reported, and the free space below which it is too. */
export const USED_WARN_PERCENT = 80;
export const USED_CRITICAL_PERCENT = 90;
export const FREE_WARN_BYTES = 5 * 1024 ** 3;
/** Current, previous and one release still in use; more are reclaimable by `cleanup releases`. */
export const RELEASE_POLICY = 3;

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)}G`;

async function usage(path) {
  const [info, fs] = await Promise.all([lstat(path), statfs(path)]);
  const total = fs.blocks * fs.bsize;
  const free = fs.bavail * fs.bsize;
  // Like df: the share of what an ordinary user can ever use, not of the raw size.
  const used = (fs.blocks - fs.bfree) * fs.bsize;
  return { device: info.dev, total, free, usedPercent: total ? Math.round((used / (used + free)) * 100) : 0 };
}

/**
 * Cheap disk warnings for `doctor` and `status`: the filesystems holding the Alliance home, the
 * Paseo home and `/`, and how many release directories sit under <home>/releases. One statfs per
 * filesystem and one readdir; never walks a tree. Warnings are advice, never a failed check.
 * @param {{home: string, paseoHome?: string, root?: string, measure?: typeof usage}} options
 * @returns {Promise<{filesystems: object[], releases: {count: number, policy: number}, warnings: {code: string, message: string}[]}>}
 */
export async function diskHealth({ home, paseoHome, root = "/", measure = usage }) {
  const warnings = [];
  const filesystems = [];
  const seen = new Set();
  for (const [label, path] of [
    ["Alliance home", resolve(home)],
    ["Paseo home", paseoHome ? resolve(paseoHome) : null],
    ["root", root],
  ]) {
    if (!path) continue;
    let measured;
    try {
      measured = await measure(path);
    } catch {
      continue;
    }
    if (seen.has(measured.device)) continue;
    seen.add(measured.device);
    const entry = { label, path, usedPercent: measured.usedPercent, freeBytes: measured.free };
    filesystems.push(entry);
    if (measured.usedPercent > USED_WARN_PERCENT || measured.free < FREE_WARN_BYTES)
      warnings.push({
        code: measured.usedPercent >= USED_CRITICAL_PERCENT ? "disk-critical" : "disk-high",
        message: `The filesystem of the ${label} (${path}) is ${measured.usedPercent}% used with ${gib(measured.free)} free.`,
      });
  }
  let count = 0;
  try {
    const directory = join(resolve(home), "releases");
    for (const item of await readdir(directory, { withFileTypes: true })) if (item.isDirectory()) count++;
  } catch {}
  if (count > RELEASE_POLICY)
    warnings.push({
      code: "releases-over-policy",
      message: `${count} release directories under ${join(resolve(home), "releases")}; policy keeps ${RELEASE_POLICY} (current, previous, one in use, each about 1G). Run alliance-work cleanup releases to see what can go.`,
    });
  return { filesystems, releases: { count, policy: RELEASE_POLICY }, warnings };
}

/** `status` output with the warnings added when there are any; its own fields are untouched. */
export function withDiskWarnings(result, health) {
  if (!health?.warnings.length || !result || typeof result !== "object" || Array.isArray(result))
    return result;
  return { ...result, diskWarnings: health.warnings };
}
