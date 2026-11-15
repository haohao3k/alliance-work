import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rm, statfs } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join, resolve, sep } from "node:path";
import { lockState, MUTEX } from "../server/maintenance-lock.mjs";
import { assertNoLinks } from "../server/profile-integrity.mjs";
import { withMaintenance } from "./maintenance.mjs";

/**
 * Release garbage collection. Every activation unpacks a ~1G release under <home>/releases and
 * nothing used to delete the old ones. A release stays when it is the current or previous
 * installation (rollback needs it), is named by a file the installation depends on or by the
 * user's own harness configuration, is used by a live process, holds a `.keep` file, or was touched
 * recently (it may be a candidate another installer is staging).
 * Everything else owned by Alliance goes. Never touches anything outside <home>/releases, never
 * follows a symlink, and keeps everything when the evidence is missing or unreadable.
 */

/** Generated names (`v0.1.51-<hash>-<ms>`, `v0.1.46-<hash>`, `v0.1.38`) and by-hand copies of them. */
export const releaseName = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
/** Leftovers of an interrupted update (`.download-<uuid>`) or of install.sh (`install.XXXXXX`). */
export const stagingName = /^(?:\.download-[0-9a-f-]{36}|install\.[A-Za-z0-9]{6})$/;
export const MIN_AGE_MS = 60 * 60 * 1000;
/** A file inside a release directory that pins it: the release is never collected while it exists. */
export const KEEP_FILE = ".keep";
/**
 * Configuration the user edits by hand in their OS home (not a role's home) that can launch a tool
 * out of a release, e.g. an MCP server. Deliberately short: each one is read whole, no tree is walked.
 */
export const USER_CONFIGS = [
  ".claude.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
  ".gemini/config/mcp_config.json",
  ".gemini/settings.json",
  ".pi/agent/settings.json",
  ".pi/agent/mcp.json",
];
const USER_CONFIG_MAX_BYTES = 16 * 1024 * 1024;

const nameChar = /[A-Za-z0-9._-]/;
/** Whether `text` names `base` as a path: followed by `/`, a delimiter or the end, not a longer name. */
export function mentions(text, base) {
  for (let at = text.indexOf(base); at >= 0; at = text.indexOf(base, at + 1)) {
    const next = text[at + base.length];
    if (next === undefined || !nameChar.test(next)) return true;
  }
  return false;
}

/**
 * Live processes as `{pid, text, cwd}`. Linux reads /proc; macOS uses ps for the full command line
 * and lsof for working directories. Without lsof the working directory is unknown (`cwd: null`
 * and `detection.cwd` false), and a missing process list throws so callers keep everything.
 */
export function liveProcesses({ platform = process.platform, proc = "/proc", exec = spawnSync } = {}) {
  const processes = [];
  if (platform === "linux") {
    let ids;
    try {
      ids = readdirSync(proc).filter((name) => /^\d+$/.test(name));
    } catch (error) {
      throw new Error(`Cannot list processes: ${error.message}`);
    }
    for (const pid of ids) {
      const at = (name) => join(proc, pid, name);
      let text = "",
        cwd = null,
        exe = null;
      try {
        text = readFileSync(at("cmdline"), "latin1").replaceAll("\0", " ");
      } catch {}
      try {
        cwd = readlinkSync(at("cwd"));
      } catch {}
      try {
        exe = readlinkSync(at("exe"));
      } catch {}
      processes.push({ pid: Number(pid), text: exe ? `${text} ${exe}` : text, cwd });
    }
    return { processes, detection: { args: true, cwd: true } };
  }
  const ps = exec("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (ps.error || ps.status !== 0) throw new Error("Cannot list processes (ps failed).");
  const byPid = new Map();
  for (const line of ps.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match) byPid.set(Number(match[1]), { pid: Number(match[1]), text: match[2], cwd: null });
  }
  const lsof = exec("lsof", ["-a", "-d", "cwd", "-Fpn"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // lsof exits 1 when it could not read some processes (other users'); the rest is still valid.
  const cwdKnown = !lsof.error && lsof.stdout.length > 0;
  if (cwdKnown) {
    let pid = null;
    for (const line of lsof.stdout.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && byPid.has(pid)) byPid.get(pid).cwd = line.slice(1);
    }
  }
  return { processes: [...byPid.values()], detection: { args: true, cwd: cwdKnown } };
}

/** Files that make an installation depend on a release root, read as text. */
async function referenceFiles(home, record, userHome) {
  const files = [
    ["installation record", join(home, "installation.json")],
    ["profile manifest", join(home, "profiles.json")],
    ["provider commands", join(home, "providers.json")],
  ];
  if (record.binPath) files.push(["launcher", resolve(record.binPath)]);
  if (record.paseoHome) {
    files.push(["Paseo config", join(resolve(record.paseoHome), "config.json")]);
    files.push(["Paseo instance marker", join(resolve(record.paseoHome), "alliance-instance.json")]);
  }
  const manifest = await readFile(join(home, "profiles.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  for (const profile of Object.values(manifest?.profiles ?? {}))
    for (const path of Object.keys(profile?.files ?? {})) files.push(["managed profile file", path]);
  for (const path of USER_CONFIGS) files.push(["user harness config", join(userHome, path)]);
  const texts = [];
  for (const [label, path] of files) {
    try {
      const info = await lstat(path);
      // A hand-edited harness config may name a release in any form; one too large to read means unknown.
      if (label === "user harness config" && info.size > USER_CONFIG_MAX_BYTES)
        throw new Error(`${path} is too large to read (${info.size} bytes)`);
      // A launcher or config that is a symlink is read through: the fact that it names a root counts.
      if (label !== "user harness config" && info.size > 4 * 1024 * 1024) continue;
      texts.push({
        label,
        path,
        text: await readFile(path, "utf8"),
        // Users write `~/.alliance-work/releases/NAME` or `$HOME/…` as often as the absolute path.
        relative: label === "user harness config",
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot read ${label} ${path}: ${error.message}`);
    }
  }
  return texts;
}

const real = async (path) => realpath(path).catch(() => resolve(path));
const inside = (path, directory) => path === directory || path.startsWith(directory + sep);

/**
 * Decide, without deleting anything, what each entry of <home>/releases would do and why.
 * @param {{home: string, userHome?: string, minAgeMs?: number, now?: number, processes?: () => {processes: {pid:number,text:string,cwd:string|null}[], detection: {cwd:boolean}}}} options
 */
export async function planReleases({
  home,
  userHome = homedir(),
  minAgeMs = MIN_AGE_MS,
  now = Date.now(),
  processes = liveProcesses,
}) {
  home = resolve(home);
  await assertNoLinks(home);
  const directory = join(home, "releases");
  let names;
  try {
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error(`${directory} is not a directory`);
    names = (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT")
      return { directory, entries: [], current: null, previous: null, notes: [], held: null };
    throw error;
  }
  const notes = [];
  const record = await readFile(join(home, "installation.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw new Error(`Cannot read installation.json: ${error.message}`);
    });
  // Without an installation record nothing can be called unused.
  let hold = record ? null : "no installation record; nothing is known to be unused";
  const roots = { current: record?.root, previous: record?.previous?.root };
  const protectedRoots = {};
  for (const [label, root] of Object.entries(roots))
    if (typeof root === "string" && root) protectedRoots[label] = await real(root);
  let references = [],
    live = [];
  if (!hold)
    try {
      references = await referenceFiles(home, record, resolve(userHome));
      const scan = processes();
      live = scan.processes;
      if (!scan.detection.cwd)
        throw new Error("Working directories of processes are unknown; cannot establish unused releases");
    } catch (error) {
      hold = error.message;
    }
  const realDirectory = await real(directory);
  const entries = [];
  for (const name of names) {
    const path = join(directory, name);
    const entry = { name, path, action: "keep", reasons: [] };
    entries.push(entry);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      entry.reasons.push("symlink; not followed");
      continue;
    }
    if (!info.isDirectory()) {
      entry.reasons.push("not a directory");
      continue;
    }
    const staging = stagingName.test(name);
    let owned = staging;
    if (!staging && releaseName.test(name)) {
      const pkg = await readFile(join(path, "package.json"), "utf8")
        .then(JSON.parse)
        .catch(() => null);
      owned = pkg?.name === "alliance-work";
    }
    if (!owned) {
      entry.reasons.push("not an Alliance release (name or package.json); left alone");
      continue;
    }
    entry.kind = staging ? "staging" : "release";
    const targets = [path, join(realDirectory, name)];
    const realPath = join(realDirectory, name);
    for (const [label, root] of Object.entries(protectedRoots))
      if (inside(root, realPath) || inside(root, path))
        entry.reasons.push(`${label} installation (${label === "previous" ? "rollback target" : "active"})`);
    for (const reference of references)
      if (
        targets.some((base) => mentions(reference.text, base)) ||
        (reference.relative && mentions(reference.text, `releases/${name}`))
      )
        entry.reasons.push(`named by ${reference.label} ${reference.path}`);
    try {
      await lstat(join(path, KEEP_FILE));
      entry.reasons.push(`pinned by ${KEEP_FILE} file`);
    } catch (error) {
      if (error.code !== "ENOENT") entry.reasons.push(`cannot inspect ${KEEP_FILE}: ${error.message}`);
    }
    const users = live.filter(
      (process) =>
        targets.some((base) => mentions(process.text, base)) ||
        (process.cwd && targets.some((base) => inside(process.cwd, base))),
    );
    if (users.length)
      entry.reasons.push(
        `used by ${users.length} running process${users.length === 1 ? "" : "es"} (pid ${users
          .slice(0, 3)
          .map((process) => process.pid)
          .join(", ")}${users.length > 3 ? ", …" : ""})`,
      );
    const touched = Math.max(info.mtimeMs, info.ctimeMs);
    if (now - touched < minAgeMs)
      entry.reasons.push("changed within the last hour; may be staged by an installer");
    if (hold) entry.reasons.push(`${hold}; every release is kept`);
    if (!entry.reasons.length) {
      entry.action = "remove";
      entry.reasons.push(staging ? "leftover staging directory" : "superseded release");
    }
  }
  return { directory, entries, ...protectedRoots, notes, held: hold };
}

/** Free bytes on the filesystem holding `path`, or null when it cannot be read. */
const freeBytes = (path) =>
  statfs(path)
    .then((fs) => fs.bavail * fs.bsize)
    .catch(() => null);

/**
 * Apply holds the maintenance mutex, borrowing it when activation in this process already owns it.
 * withMaintenance also validates an installer's inherited parent lock. Dry runs need no lock.
 */
export async function collectReleases(options) {
  if (!options.apply) return collect(options);
  const mutex = await lockState(options.home, Date.now(), MUTEX);
  if (mutex.held && mutex.owner?.pid === process.pid && mutex.owner.host === hostname())
    return collect(options);
  return withMaintenance(options.home, () => collect(options), { pause: false });
}

async function collect({ home, apply = false, ...options }) {
  const plan = await planReleases({ home, ...options });
  const result = {
    apply,
    directory: plan.directory,
    keep: plan.entries.filter((entry) => entry.action === "keep"),
    remove: plan.entries.filter((entry) => entry.action === "remove"),
    notes: plan.notes,
    held: plan.held,
    removed: [],
    failed: [],
  };
  if (!apply) return result;
  const before = await freeBytes(plan.directory);
  for (const entry of [...result.remove]) {
    try {
      // Earlier removals yield: pins, references and process use may have changed under the mutex.
      const fresh = await planReleases({ home, ...options });
      result.notes = fresh.notes;
      result.held = fresh.held;
      const current = fresh.entries.find((candidate) => candidate.name === entry.name);
      if (current?.action !== "remove") {
        result.remove = result.remove.filter((candidate) => candidate.name !== entry.name);
        result.keep.push(
          current ?? { ...entry, action: "keep", reasons: ["no longer a collection candidate"] },
        );
        continue;
      }
      const info = await lstat(entry.path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("no longer an ordinary directory");
      if (resolve(entry.path, "..") !== resolve(plan.directory) || entry.name.includes(sep))
        throw new Error("outside the releases directory");
      await rm(entry.path, { recursive: true, force: true, maxRetries: 2 });
      result.removed.push(entry.name);
    } catch (error) {
      result.failed.push({ name: entry.name, error: error.message });
    }
  }
  const after = await freeBytes(plan.directory);
  if (before !== null && after !== null) result.freedBytes = Math.max(0, after - before);
  return result;
}

/**
 * After a successful update: delete a deploy bundle's `boot/` directory (the unpacked copy used to
 * bootstrap hosts that predate bundles). Refuses when the running CLI lives inside it.
 */
export async function removeBundleBoot(bundle, { running = process.argv[1] } = {}) {
  const boot = join(resolve(bundle), "boot");
  let info;
  try {
    info = await lstat(boot);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return false;
  const here = running ? await real(running) : "";
  if (inside(here, await real(boot))) return false;
  await rm(boot, { recursive: true, force: true });
  return true;
}

/**
 * What an activation says about collection, or undefined when there is nothing to say: what was
 * removed, what failed, a collection that could not run, and (one line) that every release was
 * kept because the evidence was missing.
 */
export function summarizeCollection(collected) {
  if (collected.error) return { error: collected.error };
  if (!collected.removed?.length && !collected.failed?.length && !collected.held) return undefined;
  return {
    removed: collected.removed,
    failed: collected.failed,
    freedBytes: collected.freedBytes,
    ...(collected.held ? { heldAll: `Kept every release: ${collected.held}` } : {}),
  };
}

export function describeCollection(result) {
  const lines = [];
  if (result.held) lines.push(`Kept every release: ${result.held}`);
  for (const entry of result.remove) {
    const state = !result.apply ? "would remove" : result.removed.includes(entry.name) ? "removed" : "FAILED";
    lines.push(`${state}  ${entry.name}  (${entry.reasons.join("; ")})`);
  }
  for (const entry of result.keep) lines.push(`keep  ${entry.name}  (${entry.reasons.join("; ")})`);
  for (const failure of result.failed) lines.push(`error  ${failure.name}: ${failure.error}`);
  for (const note of result.notes) lines.push(`note: ${note}`);
  return lines.join("\n");
}
