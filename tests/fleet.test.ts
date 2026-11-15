import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

// Hosts are directories; a fake `ssh` on PATH runs the remote command with that directory as HOME,
// answers "Connection refused" for hosts named down* and never answers for hosts named slow*. The
// real probe, df, sqlite and launcher lookup all run; only the paseo CLI is a small stand-in.
async function fleet() {
  const root = await temporary("alliance-fleet-");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "ssh"),
    [
      "#!/bin/sh",
      'while [ "$1" = "-o" ]; do shift 2; done',
      'host="$1"',
      'case "$host" in',
      '  down*) echo "ssh: connect to host $host port 22: Connection refused" >&2; exit 255 ;;',
      "  slow*) exec sleep 60 ;;",
      "esac",
      'HOME="$FLEET_HOSTS/$host" exec sh -c "$2"',
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "ssh"), 0o755);
  // Answers /api/health and / like a running daemon.
  const daemon = createServer((_, response) => response.end("ok"));
  await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
  const listen = `127.0.0.1:${(daemon.address() as { port: number }).port}`;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEET_HOSTS: join(root, "hosts") };

  async function host(
    name: string,
    {
      version,
      members = [],
      plugin = "running",
      pluginPath = "",
    }: { version: string; members?: boolean[]; plugin?: string; pluginPath?: string },
  ) {
    const home = join(root, "hosts", name);
    const alliance = join(home, ".alliance-work");
    const release = join(alliance, "releases", `v${version}`);
    const cli = join(release, "node_modules/@getpaseo/cli/bin/paseo");
    await mkdir(dirname(cli), { recursive: true });
    await mkdir(join(home, ".paseo"), { recursive: true });
    const answers = {
      daemon: { localDaemon: "running", daemonVersion: "9.9.9", listen },
      plugin: [{ id: "alliance-work", status: plugin, path: pluginPath || release }],
      agent: [{ status: "running" }, { status: "idle" }, { status: "closed" }],
    };
    await writeFile(
      cli,
      `const a = ${JSON.stringify(answers)};\nconsole.log(JSON.stringify(a[process.argv[2]]));\n`,
    );
    const launcher = join(home, "bin", "alliance-work");
    await mkdir(dirname(launcher), { recursive: true });
    await writeFile(launcher, `#!/bin/sh\nexec '${process.execPath}' '${release}/scripts/cli.mjs' "$@"\n`);
    await writeFile(
      join(alliance, "installation.json"),
      JSON.stringify({
        version,
        root: release,
        paseoHome: join(home, ".paseo"),
        binPath: launcher,
        installedAt: "2026-11-12T00:00:00.000Z",
      }),
    );
    const db = new DatabaseSync(join(alliance, "rooms.sqlite"));
    db.exec(
      "CREATE TABLE members(id TEXT PRIMARY KEY, roomId TEXT NOT NULL, launchKey TEXT, data TEXT NOT NULL)",
    );
    for (const [i, archived] of members.entries())
      db.prepare("INSERT INTO members(id, roomId, data) VALUES (?, 'r', ?)").run(
        `m${i}`,
        JSON.stringify(archived ? { archivedAt: "2026-11-01T00:00:00.000Z" } : {}),
      );
    db.close();
    return { home, alliance };
  }
  const run = (home: string, ...args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
      const started = Date.now();
      const child = spawn(
        process.execPath,
        [join(projectRoot, "scripts/cli.mjs"), "fleet", "status", "--home", home, ...args],
        { env },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    });
  return { root, host, run, stop: () => daemon.close() };
}

const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

test("fleet status reports this host and each remembered host with versions, disk, sessions, members and plugin", async () => {
  const f = await fleet();
  try {
    const here = await f.host("local", { version: "0.1.51", members: [false, true] });
    await f.host("alpha", { version: "0.1.49", members: [false, false, true, true, false] });
    await f.host("beta", { version: "0.1.50", pluginPath: "/elsewhere/other-release" });
    await writeFile(join(here.alliance, "fleet.json"), JSON.stringify({ hosts: ["alpha", "beta"] }));
    const stores = [
      join(here.alliance, "rooms.sqlite"),
      join(f.root, "hosts/alpha/.alliance-work/rooms.sqlite"),
    ];
    const before = await Promise.all(stores.map(digest));

    const json = await f.run(here.alliance, "--json", "--timeout-ms", "20000");
    assert.equal(json.code, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.equal(report.hosts.length, 3, "this host plus the two remembered ones");
    assert.equal(report.hosts[0].local, true);
    const [local, alpha, beta] = report.hosts;
    assert.deepEqual(
      [local.alliance.version, alpha.alliance.version, beta.alliance.version],
      ["0.1.51", "0.1.49", "0.1.50"],
    );
    assert.deepEqual(report.alliance, { differ: true, versions: ["0.1.49", "0.1.50", "0.1.51"] });
    for (const h of report.hosts) {
      assert.equal(h.ok, true);
      assert.equal(h.paseo.version, "9.9.9");
      assert.ok(
        h.disk.length > 0 && h.disk[0].usedPercent >= 0 && h.disk[0].usedPercent <= 100 && h.disk[0].mount,
      );
      assert.deepEqual(h.sessions, { unarchived: 3, running: 1 });
    }
    assert.equal(alpha.members.unarchived, 3, "members already archived are not counted");
    assert.equal(local.members.unarchived, 1);
    assert.equal(alpha.plugin.status, "running");
    assert.equal(alpha.plugin.healthy, true);
    assert.equal(beta.plugin.sourceMatchesInstalled, false, "a plugin running another release is visible");

    const text = await f.run(here.alliance, "--timeout-ms", "20000");
    for (const needle of [
      "alpha",
      "beta",
      "0.1.49",
      "0.1.50",
      "0.1.51",
      "running (other release)",
      "versions differ",
    ])
      assert.ok(text.stdout.includes(needle), `${needle}\n${text.stdout}`);
    assert.deepEqual(await Promise.all(stores.map(digest)), before, "reading changes no store");
  } finally {
    f.stop();
  }
});

test("a host that is down or never answers is reported with a reason and does not hang the command", async () => {
  const f = await fleet();
  try {
    const here = await f.host("local", { version: "0.1.51" });
    await f.host("alpha", { version: "0.1.49" });
    const result = await f.run(
      here.alliance,
      "--json",
      "--host",
      "alpha",
      "--host",
      "down1",
      "--host",
      "slow1",
      "--timeout-ms",
      "12000",
    );
    assert.ok(result.ms < 45000, `took ${result.ms}ms; the slow host sleeps 60s`);
    assert.equal(result.code, 1, "a host that could not be read makes the exit status nonzero");
    const byHost = Object.fromEntries(
      JSON.parse(result.stdout).hosts.map((h: { host: string }) => [h.host, h]),
    );
    assert.equal(byHost.alpha.ok, true, "other hosts are still read");
    assert.equal(byHost.down1.ok, false);
    assert.match(byHost.down1.reason, /Connection refused/);
    assert.equal(byHost.slow1.ok, false);
    assert.match(byHost.slow1.reason, /no answer within 12s/);
    const text = await f.run(here.alliance, "--host", "down1");
    assert.match(text.stdout, /down1\s+unreachable: ssh: connect to host down1 port 22: Connection refused/);
  } finally {
    f.stop();
  }
});

test("--host replaces the remembered list, and unsafe names are refused before any connection", async () => {
  const f = await fleet();
  try {
    const here = await f.host("local", { version: "0.1.51" });
    await f.host("alpha", { version: "0.1.49" });
    await f.host("beta", { version: "0.1.50" });
    await writeFile(join(here.alliance, "fleet.json"), JSON.stringify({ hosts: ["alpha", "beta"] }));
    const only = await f.run(here.alliance, "--json", "--host", "beta", "--timeout-ms", "20000");
    assert.deepEqual(
      JSON.parse(only.stdout).hosts.map((h: { host: string }) => h.host.split(" ")[0]),
      ["local", "beta"],
    );
    const bad = await f.run(here.alliance, "--host", "alpha; touch /tmp/pwned");
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Unsupported host name/);
  } finally {
    f.stop();
  }
});

test("a host with no Alliance installation is shown as not installed instead of failing", async () => {
  const f = await fleet();
  try {
    const here = await f.host("local", { version: "0.1.51" });
    await mkdir(join(f.root, "hosts/bare"), { recursive: true });
    const result = await f.run(here.alliance, "--json", "--host", "bare", "--timeout-ms", "20000");
    const bare = JSON.parse(result.stdout).hosts[1];
    assert.equal(bare.ok, true);
    assert.equal(bare.alliance, null);
    assert.ok(bare.disk.length > 0, "disk is still read");
    assert.match(
      (await f.run(here.alliance, "--host", "bare", "--timeout-ms", "20000")).stdout,
      /bare\s+not installed/,
    );
  } finally {
    f.stop();
  }
});
