import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseInfo, repository, run, verifyChecksum } from "./distribution.mjs";
import { instanceState, requireIdle } from "./paseo.mjs";
import { loadManifest } from "./profiles.mjs";

const archivePattern = /^alliance-work-(v\d+\.\d+\.\d+)\.tar\.gz$/;
export const hostPattern = /^[A-Za-z0-9._@-]+$/;
/** Exit status of an activation refused because the runtime was busy, with nothing changed. */
export const BUSY_EXIT = 75;

/**
 * A release copied from a verified GitHub release by `deploy`: exactly one archive plus the
 * release's checksums.txt. The archive is checked again before anything in it runs.
 */
export async function bundleRelease(directory) {
  const names = await readdir(directory);
  const archives = names.filter((name) => archivePattern.test(name));
  if (archives.length !== 1 || !names.includes("checksums.txt"))
    throw new Error("A bundle holds exactly one alliance-work-vX.Y.Z.tar.gz and its checksums.txt.");
  const tagName = archivePattern.exec(archives[0])[1];
  verifyChecksum(
    await readFile(join(directory, archives[0])),
    await readFile(join(directory, "checksums.txt"), "utf8"),
    archives[0],
  );
  return { tagName, url: `bundle:${directory}`, bundle: directory };
}

/**
 * Non-interactive SSH sessions often lack nvm or ~/.local/bin. Order: this Node (npm's shebang
 * resolves "node" through PATH), then the harness directories the installed profiles already
 * use, so an update never silently swaps codex/claude/agy for another copy, then the caller's PATH.
 */
export async function harnessPath(home, current = process.env.PATH ?? "") {
  const dirs = [dirname(process.execPath)];
  const manifest = await loadManifest(home).catch(() => null);
  for (const profile of Object.values(manifest?.profiles ?? {}))
    if (typeof profile.executable === "string" && !profile.executable.includes("/releases/"))
      dirs.push(dirname(profile.executable));
  return [...new Set([...dirs, ...current.split(":").filter(Boolean)])].join(":");
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the dedicated daemon has no running agent or script. Running work is never
 * interrupted; only a readback that proves idleness lets activation continue. Transient
 * readback failures are retried until the deadline. With `refuseStopped`, a stopped daemon is
 * an error: starting it from an SSH session would give every agent that session's environment.
 */
export async function waitForIdle(
  paseoHome,
  timeoutMs,
  { interval = 20000, report = () => {}, refuseStopped = false } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const state = await instanceState(paseoHome).catch((error) => ({ error }));
    if (state && !state.error && state.localDaemon !== "running") {
      if (refuseStopped)
        throw new Error(
          "The Paseo daemon on this host is not running. Start Paseo from the host's normal session, then rerun; it is not started from a remote shell.",
        );
      return { agents: 0, activeAgents: 0, activeScripts: 0, daemon: state.localDaemon ?? "absent" };
    }
    try {
      if (state?.error) throw state.error;
      return requireIdle(paseoHome);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      if (attempt % 15 === 0) report(`${error.message.split("\n")[0]} Waiting for idle…`);
      await sleep(interval);
    }
  }
}

/**
 * Remote half of deploy. Arguments: bundle directory, tag, wait minutes (or 0), home ("" means
 * default). Writes the exit status to $BUNDLE/rc; the caller keeps the log in $BUNDLE/deploy.log.
 */
export const remoteScript = `#!/bin/sh
BUNDLE="$1"; TAG="$2"; WAIT="$3"; HOME_DIR="\${4:-}"
finish() {
  rc=$?
  rm -rf "$BUNDLE/boot" "$BUNDLE/alliance-work-$TAG.tar.gz"
  echo "$rc" > "$BUNDLE/rc"
}
trap finish EXIT
# A kill must be recorded as a failure, not as the status of the last command.
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
set -eu
cd "$HOME"
[ -n "$HOME_DIR" ] || HOME_DIR="$HOME/.alliance-work"
INSTALL="$HOME_DIR/installation.json"
[ -f "$INSTALL" ] || { echo "No Alliance installation at $HOME_DIR; run install.sh there first." >&2; exit 2; }
BIN=$(sed -n 's/^ *"binPath": *"\\(.*\\)",* *$/\\1/p' "$INSTALL" | head -n 1)
NODE=$(sed -n "s/^exec '\\([^']*\\)'.*/\\1/p" "$BIN" | head -n 1)
[ -x "$NODE" ] || { echo "Cannot find Node from the Alliance launcher $BIN" >&2; exit 2; }
PATH="$(dirname "$NODE"):$PATH"; export PATH
WAIT_ARGS=""
[ "$WAIT" = "0" ] || WAIT_ARGS="--wait-idle $WAIT"
if "$BIN" --help 2>/dev/null | grep -q -- "--bundle"; then
  "$BIN" update --bundle "$BUNDLE" $WAIT_ARGS
  exit 0
fi
# This installation predates bundles. Verify the archive, then run the candidate's own CLI once;
# it stages a fresh copy, checks it and activates it exactly as a normal update does.
"$NODE" -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const [dir, tag] = process.argv.slice(1);
const name = "alliance-work-" + tag + ".tar.gz";
const want = readFileSync(dir + "/checksums.txt", "utf8").split(/\\r?\\n/).map((l) => l.trim().split(/\\s+/)).filter((p) => (p[1] || "").replace(/^\\*/, "") === name);
const got = createHash("sha256").update(readFileSync(dir + "/" + name)).digest("hex");
if (want.length !== 1 || want[0][0] !== got) { console.error("Checksum mismatch for " + name); process.exit(3); }
' "$BUNDLE" "$TAG"
mkdir -p "$BUNDLE/boot"
tar -xzf "$BUNDLE/alliance-work-$TAG.tar.gz" -C "$BUNDLE/boot"
(cd "$BUNDLE/boot/alliance-work" && npm ci --no-audit --no-fund > "$BUNDLE/boot-npm.log" 2>&1) || {
  echo "Bootstrap npm ci failed; see $BUNDLE/boot-npm.log" >&2
  exit 4
}
"$NODE" "$BUNDLE/boot/alliance-work/scripts/cli.mjs" update --bundle "$BUNDLE" --home "$HOME_DIR" $WAIT_ARGS
`;

const sshOptions = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=15",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=4",
];

/** Run a command without blocking other hosts; resolve with its exit code and raw output. */
function capture(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [],
      err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    const done = (code, extra = "") => {
      const bytes = Buffer.concat(out);
      resolve({
        code,
        bytes,
        stdout: bytes.toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8") + extra,
      });
    };
    child.on("error", (error) => done(1, error.message));
    child.on("close", (code) => done(code));
  });
}
async function must(command, args, what) {
  const result = await capture(command, args);
  if (result.code !== 0) throw new Error(`${what} failed: ${result.stderr.trim().slice(0, 500)}`);
  return result.stdout;
}

const rcMarker = "\n@@ALLIANCE-RC@@";
const goneMarker = "@@ALLIANCE-GONE@@";
/** Remote command printing the log from byte `offset`, then the exit status once it exists. */
export const followCommand = (log, made, offset) =>
  `[ -f '${log}' ] || { printf '${goneMarker}'; exit 0; }; tail -c +${offset + 1} '${log}'; printf '${rcMarker.replace("\n", "\\n")}'; cat '${made}/rc' 2>/dev/null || true`;
/** Parse one follow readback by bytes: a split UTF-8 character must not shift the offset. */
export function parseFollow(bytes) {
  if (bytes.subarray(0, goneMarker.length).toString() === goneMarker) return { gone: true };
  const marker = Buffer.from(rcMarker);
  const at = bytes.lastIndexOf(marker);
  if (at < 0) return { consumed: 0, text: "", rc: "" };
  return {
    consumed: at,
    text: bytes.subarray(0, at).toString("utf8"),
    rc: bytes
      .subarray(at + marker.length)
      .toString("utf8")
      .trim(),
  };
}

/**
 * The remote update always runs detached under nohup with a log, so an interrupted controller
 * or a dropped connection neither cancels it nor loses its outcome. Without --detach the
 * controller follows the log until the remote side writes its exit status.
 */
async function deployHost(host, files, release, { waitIdle, detach, remoteHome, poll = 10000 }) {
  // Staging and checks take minutes; waiting for idleness takes at most waitIdle minutes.
  const followUntil = Date.now() + ((waitIdle ?? 0) + 60) * 60000;
  // biome-ignore lint/suspicious/noTemplateCurlyInString: the remote shell expands TMPDIR.
  const mktemp = 'mktemp -d "${TMPDIR:-/tmp}/alliance-deploy.XXXXXX"';
  const made = (await must("ssh", [...sshOptions, host, mktemp], "mktemp")).trim();
  if (!/^\/[A-Za-z0-9._/+-]+$/.test(made)) throw new Error(`Unexpected remote directory from ${host}`);
  await must("scp", ["-q", ...sshOptions, ...files, `${host}:${made}/`], "scp");
  const log = `${made}/deploy.log`;
  const args = [`${made}/deploy.sh`, made, release.tagName, String(waitIdle ?? 0), remoteHome ?? ""]
    .map((value) => `'${value}'`)
    .join(" ");
  await must("ssh", [...sshOptions, host, `nohup sh ${args} > '${log}' 2>&1 < /dev/null &`], "start");
  process.stderr.write(`[${host}] remote log: ${host}:${log}\n`);
  if (detach) return { host, detached: true, log: `${host}:${log}` };
  let offset = 0,
    failures = 0;
  for (;;) {
    await sleep(poll);
    if (Date.now() > followUntil)
      return {
        host,
        ok: false,
        error: "stopped following; the update may still be running",
        log: `${host}:${log}`,
      };
    const result = await capture("ssh", [...sshOptions, host, followCommand(log, made, offset)]);
    if (result.code !== 0) {
      // The remote update keeps running; give up following after about five minutes of failures.
      if (++failures >= 30)
        return { host, ok: false, error: "lost contact; update continues remotely", log: `${host}:${log}` };
      continue;
    }
    failures = 0;
    const read = parseFollow(result.bytes);
    // The log vanished (a reboot cleared the temp directory): the outcome is unknown.
    if (read.gone)
      return { host, ok: false, error: "remote log disappeared; check alliance-work doctor on the host" };
    offset += read.consumed;
    for (const line of read.text.split(/\r?\n/)) if (line) process.stdout.write(`[${host}] ${line}\n`);
    const rc = read.rc;
    if (!rc) continue;
    const code = Number(rc);
    if (code === 0) await capture("ssh", [...sshOptions, host, `rm -rf '${made}'`]);
    return { host, ok: code === 0, ...(code === 0 ? {} : { exitCode: code, log: `${host}:${log}` }) };
  }
}

/**
 * Push one verified GitHub release to other machines over SSH and activate it there with the
 * same staged update path. Only this controller needs GitHub access.
 */
/** @param {{hosts: string[], tag?: string, waitIdle?: number, detach?: boolean, remoteHome?: string, poll?: number}} options */
export async function deploy({ hosts, tag, waitIdle = 0, detach = false, remoteHome, poll }) {
  if (!hosts.length) throw new Error("Name at least one --host, or save a fleet with --remember.");
  for (const host of hosts) if (!hostPattern.test(host)) throw new Error(`Unsupported host name: ${host}`);
  if (!Number.isFinite(waitIdle) || waitIdle < 0) throw new Error("--wait-idle takes minutes (0 or more).");
  if (remoteHome && !/^\/[A-Za-z0-9._/-]+$/.test(remoteHome))
    throw new Error("--remote-home must be absolute.");
  if (waitIdle && !detach && (process.env.PASEO_AGENT_ID || process.env.ALLIANCE_ROLE))
    throw new Error("An agent cannot block its own turn waiting for idleness; add --detach.");
  const release = releaseInfo(tag);
  if (!release) throw new Error(`No stable GitHub release in ${repository}; nothing deployed.`);
  const local = await mkdtemp(join(tmpdir(), "alliance-deploy-"));
  try {
    const name = `alliance-work-${release.tagName}.tar.gz`;
    run("gh", [
      "release",
      "download",
      release.tagName,
      "--repo",
      repository,
      "--dir",
      local,
      "--pattern",
      name,
      "--pattern",
      "checksums.txt",
    ]);
    await bundleRelease(local);
    await writeFile(join(local, "deploy.sh"), remoteScript, { mode: 0o755 });
    const files = [join(local, name), join(local, "checksums.txt"), join(local, "deploy.sh")];
    const results = await Promise.all(
      hosts.map((host) =>
        deployHost(host, files, release, { waitIdle, detach, remoteHome, poll }).catch((error) => ({
          host,
          ok: false,
          error: error.message,
        })),
      ),
    );
    return { release: release.tagName, results };
  } finally {
    await rm(local, { recursive: true, force: true });
  }
}
