import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { hostPattern, sshOptions } from "./deploy.mjs";

export const defaultTimeoutMs = 30000;
const probeSource = () => readFile(new URL("./fleet-probe.mjs", import.meta.url), "utf8");

/**
 * Remote half: finds the Node the installed launcher uses (non-interactive SSH sessions often
 * lack nvm), then runs the probe from stdin. Needs only what 0.1.49 and later install.
 */
const remoteScript = (probe) => `H="$1"; [ -n "$H" ] || H="$HOME/.alliance-work"
BIN=$(sed -n 's/^ *"binPath": *"\\(.*\\)",* *$/\\1/p' "$H/installation.json" 2>/dev/null | head -n 1)
NODE=$(sed -n "s/^exec '\\([^']*\\)'.*/\\1/p" "$BIN" 2>/dev/null | head -n 1)
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || true)
[ -x "$NODE" ] || { echo '{"fatal":"Node was not found on this host"}'; exit 0; }
ALLIANCE_FLEET_HOME="$H" exec "$NODE" --no-warnings --input-type=module - <<'ALLIANCE_FLEET_PROBE'
${probe}
ALLIANCE_FLEET_PROBE
`;

/** Run a command with `input` on stdin; resolves by the deadline even if the child ignores the kill. */
function bounded(command, args, input, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const out = [],
      err = [];
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish({ code: 1, stdout: "", stderr: error.message }));
    child.on("close", (code) =>
      finish({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}

const firstLine = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 160);

/** Probe one host; always resolves with `ok` and, when not ok, the reason. */
async function probeHost(host, { local, home, remoteHome, timeoutMs, env }) {
  const source = await probeSource();
  const result = local
    ? await bounded(process.execPath, ["--no-warnings", "--input-type=module", "-"], source, timeoutMs, {
        ...env,
        ALLIANCE_FLEET_HOME: home,
      })
    : await bounded(
        "ssh",
        [
          "-o",
          `ConnectTimeout=${Math.max(1, Math.min(10, Math.floor(timeoutMs / 1000)))}`,
          ...sshOptions,
          host,
          `sh -s -- '${remoteHome ?? ""}'`,
        ],
        remoteScript(source),
        timeoutMs,
        env,
      );
  if (result.timedOut)
    return {
      host,
      ok: false,
      reason: local
        ? `the probe did not finish within ${Math.round(timeoutMs / 1000)}s`
        : `no answer within ${Math.round(timeoutMs / 1000)}s (slow or unreachable)`,
    };
  if (result.code !== 0)
    return {
      host,
      ok: false,
      reason: firstLine(result.stderr) ?? `ssh exited with status ${result.code}`,
    };
  let report;
  try {
    report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    return { host, ok: false, reason: "the host answered, but not with a fleet probe report" };
  }
  if (report.fatal) return { host, ok: false, reason: report.fatal };
  return { host, ok: true, ...report };
}

/**
 * Read-only status of the local host and every named host, probed in parallel. A host that
 * cannot be reached, or does not answer within `timeoutMs`, is reported with a reason.
 * @param {{hosts: string[], home: string, remoteHome?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv}} options
 */
export async function fleetStatus({
  hosts,
  home,
  remoteHome,
  timeoutMs = defaultTimeoutMs,
  env = process.env,
}) {
  for (const host of hosts) if (!hostPattern.test(host)) throw new Error(`Unsupported host name: ${host}`);
  if (remoteHome && !/^\/[A-Za-z0-9._/-]+$/.test(remoteHome))
    throw new Error("--remote-home must be absolute.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("--timeout-ms takes 1000 or more.");
  const names = [...new Set(hosts)];
  const results = await Promise.all([
    probeHost("local", { local: true, home, timeoutMs, env }).then((r) => ({
      ...r,
      local: true,
      host: `local (${r.hostname ?? hostname()})`,
    })),
    ...names.map((host) => probeHost(host, { local: false, remoteHome, timeoutMs, env })),
  ]);
  const versions = [
    ...new Set(results.filter((r) => r.ok && r.alliance?.version).map((r) => r.alliance.version)),
  ];
  return {
    checkedAt: new Date().toISOString(),
    hosts: results,
    ...(versions.length > 1 ? { alliance: { differ: true, versions: versions.sort() } } : {}),
  };
}

/** Hosts for a fleet run: `--host` replaces the list saved by `deploy --remember`. */
export async function fleetHosts(home, named) {
  if (named.length) return named;
  return readFile(join(home, "fleet.json"), "utf8")
    .then((text) => JSON.parse(text).hosts ?? [])
    .catch(() => []);
}

function plugin(p) {
  if (!p) return "unknown";
  if (p.status === "daemon-down") return "daemon down";
  if (p.status !== "running") return p.status;
  if (p.sourceMatchesInstalled === false) return "running (other release)";
  return p.healthy === false ? "running (health fails)" : "running";
}
const diskCell = (disk) => (disk?.length ? disk.map((v) => `${v.usedPercent}% ${v.mount}`).join(", ") : "?");

/** Plain-text table; unreachable hosts keep their row with the reason. */
export function formatFleet(report) {
  const rows = [["HOST", "ALLIANCE", "PASEO", "PLUGIN", "DISK USED", "SESSIONS", "MEMBERS"]];
  for (const h of report.hosts) {
    if (!h.ok) {
      rows.push([h.host, `unreachable: ${h.reason}`]);
      continue;
    }
    rows.push([
      h.host,
      h.alliance?.version ?? "not installed",
      h.paseo?.version ?? "?",
      plugin(h.plugin),
      diskCell(h.disk),
      h.sessions ? `${h.sessions.unarchived} (${h.sessions.running} running)` : "?",
      h.members ? String(h.members.unarchived) : "?",
    ]);
  }
  // Rows of unreachable hosts only have a name and a reason; every row's name sets the first width.
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.filter((r) => i === 0 || r.length > 2).map((r) => r[i].length)),
  );
  const lines = rows.map((row) =>
    row.length > 2
      ? row
          .map((cell, i) => cell.padEnd(widths[i]))
          .join("  ")
          .trimEnd()
      : `${row[0].padEnd(widths[0])}  ${row[1]}`,
  );
  const notes = [];
  if (report.alliance?.differ) notes.push(`Alliance versions differ: ${report.alliance.versions.join(", ")}`);
  for (const h of report.hosts)
    for (const [what, why] of Object.entries(h.problems ?? {})) notes.push(`${h.host}: ${what}: ${why}`);
  return [...lines, ...(notes.length ? ["", ...notes] : [])].join("\n");
}
