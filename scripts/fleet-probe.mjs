// Read-only probe of one host. `alliance-work fleet status` sends this file to node on stdin
// (over SSH for remote hosts), so nothing is installed or written there and a host running
// 0.1.49-0.1.51 needs no newer CLI. It prints one JSON object: no tokens, no conversation text.
// Reads: installation.json, rooms.sqlite (read-only), `df`, and the pinned paseo CLI's
// `daemon status`, `plugin ls` and `agent ls`, which only read daemon state.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const STEP_MS = 12000;
const problems = {};
const short = (error) =>
  String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, 160);

function exec(command, args) {
  return new Promise((resolveRun, reject) =>
    execFile(command, args, { timeout: STEP_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolveRun(stdout);
      const what = args
        .filter((arg) => !arg.startsWith("-") && !arg.includes("/"))
        .slice(0, 2)
        .join(" ");
      const why = error.killed
        ? `timed out after ${STEP_MS / 1000}s`
        : stderr.trim().split("\n")[0] || error.message;
      reject(new Error(`${command.includes("node") ? `paseo ${what}` : command}: ${why}`));
    }),
  );
}
/** Run one step; a failure is recorded under `name` and never stops the other steps. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    problems[name] = short(error);
    return null;
  }
}

const home = resolve(process.env.ALLIANCE_FLEET_HOME || join(homedir(), ".alliance-work"));
const install = await readFile(join(home, "installation.json"), "utf8")
  .then((text) => JSON.parse(text))
  .catch((error) => {
    problems.installation = error.code === "ENOENT" ? "no installation.json" : short(error);
    return null;
  });
const paseoHome = install?.paseoHome ?? join(homedir(), ".paseo-alliance-work");
const cli = install?.root ? join(install.root, "node_modules/@getpaseo/cli/bin/paseo") : null;
const paseo = (...command) =>
  cli
    ? exec(process.execPath, [cli, ...command, "--home", paseoHome, "--json"]).then((out) => JSON.parse(out))
    : Promise.reject(new Error("no installed release to run paseo from"));

// Disk: the volumes that hold Alliance state, the Paseo home and scratch space. `df` on the
// directory itself gives the right volume on macOS (the Data volume) and Linux alike.
async function disk() {
  const volumes = new Map();
  for (const [role, path] of [
    ["alliance", home],
    ["paseo", paseoHome],
    ["tmp", tmpdir()],
  ]) {
    const lines = (await exec("df", ["-Pk", path]).catch(() => "")).trim().split("\n");
    const cells = lines[1]?.trim().split(/\s+/);
    if (!cells || cells.length < 6) {
      problems[`disk-${role}`] = "df gave no answer";
      continue;
    }
    const mount = cells.slice(5).join(" ");
    const usedPercent = Number.parseInt(cells[4], 10);
    const volume = volumes.get(mount) ?? {
      mount,
      usedPercent,
      freeGiB: Math.round(cells[3] / 1048576),
      for: [],
    };
    volume.for.push(role);
    volumes.set(mount, volume);
  }
  return [...volumes.values()].sort((a, b) => b.usedPercent - a.usedPercent);
}

async function runtime() {
  const daemon = await paseo("daemon", "status");
  const state = { paseoVersion: daemon.daemonVersion ?? null, daemon: daemon.localDaemon ?? "unknown" };
  if (daemon.localDaemon !== "running") return { ...state, plugin: { status: "daemon-down" } };
  const [plugins, agents, healthy] = await Promise.all([
    step("plugin", () => paseo("plugin", "ls")),
    step("sessions", () => paseo("agent", "ls")),
    // The same two endpoints `doctor` reads after an activation: Paseo's health and the plugin UI root.
    Promise.all(
      ["/api/health", "/"].map((path) =>
        fetch(`http://${daemon.listen}${path}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.ok),
      ),
    )
      .then((answers) => answers.every(Boolean))
      .catch(() => false),
  ]);
  let plugin = { status: "unknown" };
  if (plugins) {
    const found = (Array.isArray(plugins) ? plugins : plugins.plugins)?.find((p) => p.id === "alliance-work");
    plugin = !found
      ? { status: "missing" }
      : {
          status: found.error ? "error" : String(found.status),
          // A running plugin that is not the installed release means the host drifted.
          sourceMatchesInstalled:
            install?.root && found.path ? resolve(found.path) === resolve(install.root) : null,
          healthy,
        };
  }
  const sessions = Array.isArray(agents)
    ? { unarchived: agents.length, running: agents.filter((a) => a.status === "running").length }
    : null;
  return { ...state, plugin, sessions };
}

// Members the room store still lists as not archived. Read-only; 0.1.49-0.1.51 share this schema.
async function members() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "rooms.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT count(*) AS total, coalesce(sum(json_extract(data, '$.archivedAt') IS NULL), 0) AS open FROM members",
      )
      .get();
    return { unarchived: Number(row.open), total: Number(row.total) };
  } finally {
    db.close();
  }
}

const [volumes, live, roomMembers] = await Promise.all([
  step("disk", disk),
  step("runtime", runtime),
  step("members", members),
]);
console.log(
  JSON.stringify({
    hostname: hostname(),
    platform: platform(),
    alliance: install ? { version: install.version ?? null, installedAt: install.installedAt ?? null } : null,
    paseo: live ? { version: live.paseoVersion, daemon: live.daemon } : null,
    plugin: live?.plugin ?? null,
    disk: volumes,
    sessions: live?.sessions ?? null,
    members: roomMembers,
    problems,
  }),
);
