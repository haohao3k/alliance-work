import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isNewerRelease, verifyChecksum } from "../scripts/distribution.mjs";
import { restore, snapshot } from "../scripts/maintenance.mjs";
import { requireCompatibleDaemon, requireIdleState, verifyRuntime } from "../scripts/paseo.mjs";
import { loadManifest, prepareProfiles, projectRoot, verifyProfile } from "../scripts/profiles.mjs";
import { Autonomy } from "../server/autonomy";
import { AllianceRuntime } from "../server/runtime";
import { RoomStore } from "../server/store";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

const executables = { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" };
async function fixture() {
  const dir = await temporary("alliance-maintenance-");
  const home = join(dir, "home");
  const isolatedRoot = join(dir, "profiles");
  const manifest = await prepareProfiles({ home, isolatedRoot, executables });
  return { dir, home, isolatedRoot, manifest };
}

test("profile updates preflight every role before overwriting an earlier role", async () => {
  const f = await fixture();
  const candidate = join(f.dir, "candidate");
  await cp(join(projectRoot, "room"), join(candidate, "room"), { recursive: true });
  await cp(join(projectRoot, "vendor"), join(candidate, "vendor"), { recursive: true });
  const ownership = join(candidate, "room/policies/agent-ownership.md");
  await writeFile(ownership, (await readFile(ownership, "utf8")) + "\nCandidate ownership policy.\n");
  const early = join(f.manifest.profiles["codex-hq"].home, "root-instructions.md");
  const before = await readFile(early);
  const late = join(f.manifest.profiles["pi-lens"].home, "settings.json");
  await writeFile(late, '{"handwritten":true}\n');
  await assert.rejects(
    prepareProfiles({ home: f.home, isolatedRoot: f.isolatedRoot, executables, root: candidate }),
    /unowned/,
  );
  assert.deepEqual(await readFile(early), before);
  assert.equal(await readFile(late, "utf8"), '{"handwritten":true}\n');
});

test("role instructions stay within their word budget; Peer and Lens carry no owner duties", async () => {
  const f = await fixture();
  // Every session pays for these words on every turn; owner duties are written for owner roles only.
  const worker = (role: string) => ["peer", "lens"].includes(role);
  const budget = (role: string) => (worker(role) ? 2000 : 3200);
  const duties = await readFile(join(projectRoot, "room/policies/owner-duties.md"), "utf8");
  for (const [id, profile] of Object.entries(f.manifest.profiles)) {
    const text = await readFile(join(profile.home, "root-instructions.md"), "utf8");
    const words = text.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= budget(profile.role), `${id} has ${words} words; budget ${budget(profile.role)}`);
    assert.equal(text.includes(duties), !worker(profile.role), `${id}: owner duties`);
  }
});

test("rollback onto a release before 0.1.19 builds the role prompts that release shipped", async () => {
  const f = await fixture();
  // Rollback activates the previous root with this release's installer code.
  const previous = join(f.dir, "previous");
  await cp(join(projectRoot, "room"), join(previous, "room"), { recursive: true });
  await cp(join(projectRoot, "vendor"), join(previous, "vendor"), { recursive: true });
  await rm(join(previous, "room/policies/owner-duties.md"), { force: true });
  const manifest = await prepareProfiles({
    home: f.home,
    isolatedRoot: f.isolatedRoot,
    executables,
    root: previous,
  });
  // Those releases gave every role, Peer and Lens included, the Seatwork mapping and model policy.
  const shared = await Promise.all(
    ["seatwork-mapping.md", "model-selection.md"].map((name) =>
      readFile(join(previous, "room/policies", name), "utf8"),
    ),
  );
  for (const [id, profile] of Object.entries(manifest.profiles)) {
    const text = await readFile(join(profile.home, "root-instructions.md"), "utf8");
    assert.ok(
      shared.every((policy) => text.includes(policy)),
      `${id} lacks the shared policy files`,
    );
  }
});

test("rollback below 0.1.19 removes the records that only routed handbacks and keeps assignments", async () => {
  // Older releases would continue such a record like an assignment. Loaded here: 0.1.19 adds it.
  const { dropHandbackRecords } = await import("../scripts/rollback-compat.mjs");
  const dir = await temporary("alliance-rollback-records-");
  const store = new RoomStore(dir);
  try {
    store.addRoom({
      id: "room",
      cwd: dir,
      title: "test",
      workspaceId: "w",
      mission: "test",
      artifacts: dir,
      createdAt: new Date().toISOString(),
    });
    for (const [id, parentId] of [
      ["lead", null],
      ["peer", "lead"],
      ["worker", "lead"],
    ])
      store.saveMember({
        id: id as string,
        roomId: "room",
        role: "peer",
        provider: "alliance-codex-peer",
        parentId,
        assignment: "brief.md",
        decision: "open",
        decisionEvidence: null,
        lastOutcome: null,
        resultPath: null,
        launchKey: null,
        launchHash: null,
      });
    const autonomy = new Autonomy(store, new Wakeups(store));
    autonomy.ensure("peer");
    autonomy.start("worker");
    assert.equal(dropHandbackRecords(dir), 1);
    assert.deepEqual(
      autonomy.list().map((r) => r.agentId),
      ["worker"],
    );
  } finally {
    store.close();
  }
});

test("rollback below 0.1.19 sets an assignment back on the handback its member stands on, which older releases review", async () => {
  // Mac mini, 2026-10-22: Lead c3f72b0b, owned by HQ d34294ec, waited from its 00:39:14 checkpoint,
  // handed back in autonomous-turn-27 (review at 02:19:35), and Claude Code started turns 28, 30 and
  // 31 by itself. 0.1.18 asks the owner about the assignment's turn; Wakeups.add, unchanged since,
  // takes only the member's current turn, so every 0.1.18 sweep failed on "Turn is no longer current".
  const { dropHandbackRecords } = await import("../scripts/rollback-compat.mjs");
  const f = await fixture();
  const [hq, lead] = ["d34294ec", "c3f72b0b"];
  const runtime = await new AllianceRuntime(f.home).ready();
  const agent = (id: string, role: string, parentAgentId: string | null) =>
    ({ id, provider: `alliance-claude-${role}`, cwd: f.dir, parentAgentId }) as never;
  try {
    const workspaces = { open: async () => ({ id: "pilot" }) };
    await runtime.createRoom({ cwd: f.dir, title: "Pilot", mission: "pilot" }, { workspaces } as never);
    // The hooks record both; the Lead, a native child of its owner, gets an assignment.
    await runtime.bind(agent(hq, "hq", null));
    const turn = async (turnId: string, phase?: "waiting" | "review", reason = "") => {
      await runtime.startTurn(agent(lead, "lead", hq), turnId);
      if (phase) runtime.autonomy.checkpoint(lead, phase, reason);
      await runtime.endTurn(agent(lead, "lead", hq), turnId, { kind: "completed" }, []);
    };
    await turn(
      "foreground-turn-21",
      "waiting",
      "pilot: chờ Peer offline (U7c, U7b tích hợp) + máy test bật lại (HQ báo)",
    );
    await turn(
      "autonomous-turn-27",
      "review",
      "pilot: SANDBOX run2 đã chạy xong, kết quả và evidence ghi trong handback — HQ quyết accept U4; Lead tiếp tục L2 run4 đang chạy",
    );
    for (const turnId of ["autonomous-turn-28", "autonomous-turn-30", "autonomous-turn-31"])
      await turn(turnId);
  } finally {
    await runtime.close();
  }
  dropHandbackRecords(f.home);
  const store = new RoomStore(f.home);
  try {
    // An assignment in review with an outcome: 0.1.18's sweep asks the owner about its turn.
    const r = store.autonomyOf(lead);
    assert.deepEqual([r?.phase, r?.outcome], ["review", "completed"]);
    const trigger = { kind: "turn" as const, agentId: lead, turnId: String(r?.turnId) };
    const roomId = String(store.member(lead)?.roomId);
    assert.doesNotThrow(() =>
      new Wakeups(store).add({ key: "review", roomId, ownerId: hq, reason: "Review", trigger }),
    );
  } finally {
    store.close();
  }
});

test("rollback restores managed profiles/config while preserving auth, sessions and room artifacts", async () => {
  const f = await fixture();
  const paseo = join(f.dir, "paseo");
  const bin = join(f.dir, "bin/alliance-work");
  await mkdir(paseo);
  await writeFile(join(paseo, "config.json"), '{"listen":"unchanged"}');
  const role = f.manifest.profiles["codex-lead"];
  const auth = join(role.home, "auth.json");
  await writeFile(auth, '{"fixture":"private-session"}', { mode: 0o600 });
  await mkdir(join(f.home, "rooms/example"), { recursive: true });
  await writeFile(join(f.home, "rooms/example/assignment.md"), "Keep the real assignment.");
  const saved = await snapshot(f.home, paseo, bin);
  const instruction = join(role.home, "root-instructions.md");
  const original = await readFile(instruction);
  await writeFile(instruction, "broken candidate");
  await writeFile(join(paseo, "config.json"), "{}");
  await restore(f.home, saved);
  assert.deepEqual(await readFile(instruction), original);
  assert.equal(await readFile(join(paseo, "config.json"), "utf8"), '{"listen":"unchanged"}');
  assert.equal(await readFile(auth, "utf8"), '{"fixture":"private-session"}');
  assert.equal(
    await readFile(join(f.home, "rooms/example/assignment.md"), "utf8"),
    "Keep the real assignment.",
  );
  assert(!(await readFile(saved.backup, "utf8")).includes(auth));
  assert.equal((await loadManifest(f.home)).profiles["codex-lead"].home, role.home);
});

test("maintenance refuses active agents, scripts and unknown readback", () => {
  requireIdleState([{ id: "finished", status: "idle" }], []);
  requireIdleState([{ id: "closed-after-restart", status: "closed" }], []);
  assert.throws(() => requireIdleState([{ id: "working", status: "running" }], []), /working:running/);
  assert.throws(() => requireIdleState([], [{ scriptName: "dev", lifecycle: "running" }]), /dev:running/);
  assert.throws(() => requireIdleState([{ id: "unknown" }], []), /blocked/);
  assert.throws(() => requireIdleState(null, []), /unknown/);
});

test("a runtime check survives the daemon resetting the idle connection it reuses", async () => {
  const root = await temporary("alliance-runtime-check-");
  // The second check's first probe is reset, as when the daemon closed the pooled keep-alive socket
  // while the checking process was blocked in a paseo call.
  let requests = 0;
  const server = createServer((request, response) => {
    if (++requests === 3) return request.socket.resetAndDestroy();
    response.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  // The release's Paseo CLI: a stand-in reporting a reachable daemon that runs this plugin source.
  const paseoCli = join(root, "node_modules/@getpaseo/cli/bin/paseo");
  await mkdir(dirname(paseoCli), { recursive: true });
  await writeFile(
    paseoCli,
    `console.log(JSON.stringify(process.argv[2] === "daemon"
  ? { localDaemon: "running", connectedDaemon: "reachable", listen: "127.0.0.1:${address.port}", daemonVersion: "0.12.0" }
  : [{ id: "alliance-work", status: "running", path: ${JSON.stringify(root)} }]));\n`,
  );
  const paseoHome = join(root, "paseo");
  await mkdir(paseoHome);
  await writeFile(join(paseoHome, "config.json"), "{}");
  try {
    for (let check = 0; check < 2; check++)
      assert.equal((await verifyRuntime(paseoHome, root)).plugin, "running");
    assert.equal(requests, 5, "the reset probe was retried once");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("release corruption is rejected before extraction/activation", () => {
  assert.equal(
    isNewerRelease("v0.1.0", "0.1.1"),
    false,
    "A latest-release pointer must not downgrade the installation",
  );
  const archive = Buffer.from("release fixture");
  const hash = createHash("sha256").update(archive).digest("hex");
  assert.equal(verifyChecksum(archive, `${hash}  release.tar.gz\n`, "release.tar.gz"), hash);
  assert.throws(
    () => verifyChecksum(Buffer.from("changed"), `${hash}  release.tar.gz\n`, "release.tar.gz"),
    /Checksum mismatch/,
  );
});

test("update --check reports a private release without creating or changing installation state", async () => {
  const dir = await temporary("alliance-update-check-");
  const bin = join(dir, "bin"),
    home = join(dir, "home");
  await mkdir(bin);
  await mkdir(home);
  await writeFile(join(home, "installation.json"), JSON.stringify({ version: "0.1.0" }));
  await writeFile(join(home, "untouched"), "user state");
  await writeFile(
    join(bin, "gh"),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"tagName":"v0.1.1","url":"https://github.com/haohao3k/alliance-work/releases/tag/v0.1.1"}\'\n',
    { mode: 0o755 },
  );
  const before = await readFile(join(home, "installation.json"));
  const result = spawnSync(
    process.execPath,
    [join(projectRoot, "scripts/cli.mjs"), "update", "--check", "--home", home],
    { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).updateAvailable, true);
  assert.deepEqual(await readFile(join(home, "installation.json")), before);
  assert.deepEqual((await readdir(home)).sort(), ["installation.json", "untouched"]);
});

/**
 * Runs `update --wait-idle 1` from a terminal. The candidate notes who holds the scheduler pause
 * (the lock running plugins read) while it is checked and at each activation attempt. Its
 * installer finds the host busy twice; meanwhile another installer activates this same release.
 */
async function waitingUpdate(...extra: string[]) {
  const dir = await temporary("alliance-update-wait-");
  const bin = join(dir, "bin"),
    home = join(dir, "home"),
    paseoHome = join(dir, "paseo"),
    published = join(dir, "published"),
    candidate = join(dir, "source", "alliance-work"),
    log = join(dir, "pause.jsonl");
  for (const path of [bin, home, paseoHome, published, join(candidate, "scripts")])
    await mkdir(path, { recursive: true });
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:1" } }),
  );
  await writeFile(join(home, "installation.json"), JSON.stringify({ version: "0.1.0", home, paseoHome }));
  const note = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const { FIXTURE_HOME: home, FIXTURE_LOG: log } = process.env;
const phase = process.argv[2] === "install" ? "attempt" : "staging";
let pause = null;
try { pause = JSON.parse(readFileSync(home + "/.maintenance-lock/owner.json", "utf8")); } catch {}
const entry = { phase, pause };
if (phase === "staging")
  entry.other = spawnSync(process.execPath, [process.env.FIXTURE_CLI, "auth", "codex", "--separate", "--home", home], { encoding: "utf8" }).stderr;
appendFileSync(log, JSON.stringify(entry) + "\\n");
const attempts = readFileSync(log, "utf8").split("\\n").filter((line) => line.includes('"attempt"')).length;
if (phase === "attempt" && attempts === 2) {
  const installed = JSON.parse(readFileSync(home + "/installation.json", "utf8"));
  writeFileSync(home + "/installation.json", JSON.stringify({ ...installed, version: "9.9.9" }));
}
if (phase === "attempt") process.exit(attempts < 3 ? 75 : 0);
`;
  await writeFile(join(candidate, "scripts/cli.mjs"), note);
  await writeFile(
    join(candidate, "package.json"),
    JSON.stringify({ name: "alliance-work", version: "9.9.9", scripts: { check: "node scripts/cli.mjs" } }),
  );
  await writeFile(
    join(candidate, "package-lock.json"),
    JSON.stringify({
      name: "alliance-work",
      version: "9.9.9",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "alliance-work", version: "9.9.9" } },
    }),
  );
  const archive = join(published, "alliance-work-v9.9.9.tar.gz");
  spawnSync("tar", ["-czf", archive, "-C", dirname(candidate), "alliance-work"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(join(published, "checksums.txt"), `${hash}  alliance-work-v9.9.9.tar.gz\n`);
  await writeFile(
    join(bin, "gh"),
    `#!/bin/sh
case "$1 $2" in
  "release view") printf '%s\\n' '{"tagName":"v9.9.9","url":"https://example.invalid/v9.9.9"}' ;;
  "release download") while [ "$#" -gt 0 ]; do [ "$1" = "--dir" ] && cp '${archive}' '${published}/checksums.txt' "$2"; shift; done ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  );
  const cli = join(projectRoot, "scripts/cli.mjs");
  // Run as from a terminal: under npm test, npm's exported settings would reach the staged npm ci.
  const terminal = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const update = spawnSync(process.execPath, [cli, "update", "--wait-idle", "1", ...extra, "--home", home], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...terminal,
      PATH: `${bin}:${process.env.PATH}`,
      PASEO_AGENT_ID: "",
      ALLIANCE_ROLE: "",
      ALLIANCE_BOUND_ROOM: "",
      FIXTURE_HOME: home,
      FIXTURE_LOG: log,
      FIXTURE_CLI: cli,
    },
  });
  const entries = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  return { update, home, entries };
}

test("a waiting update pauses scheduled prompts only for each activation attempt it still needs", async () => {
  const { update, home, entries } = await waitingUpdate();
  assert.equal(update.status, 0, update.stderr);
  const [staging, ...attempts] = await entries();
  assert.equal(staging.pause, null, "while it stages and waits, owners keep receiving handbacks");
  assert.match(staging.other, /Another maintenance operation/, "it still excludes other maintenance");
  assert.deepEqual(
    attempts.map((attempt) => attempt.pause?.pid),
    [update.pid, update.pid],
    "each activation attempt runs paused",
  );
  assert.notEqual(attempts[0].pause.started, attempts[1].pause.started, "a busy attempt releases the pause");
  // The release became active meanwhile: no third attempt, and nothing staged or locked remains.
  assert.match(update.stdout, /v9\.9\.9/);
  assert.deepEqual(await readdir(join(home, "releases")), []);
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.startsWith(".maintenance")),
    [],
    "no lock is left behind",
  );
});

test("with --hold a waiting update keeps scheduled prompts paused from the end of staging through activation", async () => {
  const { update, home, entries } = await waitingUpdate("--hold");
  assert.equal(update.status, 0, update.stderr);
  const [staging, ...attempts] = await entries();
  assert.equal(staging.pause, null, "while it stages, owners keep receiving handbacks");
  // Agents an operator stops while it waits are not woken: one pause spans every attempt.
  assert.deepEqual(
    attempts.map((attempt) => attempt.pause?.pid),
    [update.pid, update.pid],
  );
  assert.equal(attempts[1].pause.started, attempts[0].pause.started, "a busy attempt keeps the pause");
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.startsWith(".maintenance")),
    [],
    "the pause ends with the update",
  );
  // Without a wait the whole update runs paused already; --hold alone is refused, not ignored.
  const bare = spawnSync(
    process.execPath,
    [join(projectRoot, "scripts/cli.mjs"), "update", "--hold", "--home", home],
    { encoding: "utf8" },
  );
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--wait-idle/);
});

test("an activation attempt waits for a scheduler round that began after the pause, or for no plugin at all", async () => {
  // Loaded here: 0.1.19 adds it, and the rest of this file still runs against older releases.
  const { schedulerPaused } = await import("../scripts/paseo.mjs");
  const since = Date.now();
  const round = (offset: number) => ({ checkedAt: new Date(since + offset).toISOString() });
  // A round that began before the pause may still send; the next one reads the pause first.
  const answers = [{ checkedAt: null }, round(-4000), round(10)];
  let polls = 0;
  const running = async () => true;
  assert.equal(
    await schedulerPaused(since, { health: async () => answers[polls++], running, interval: 1 }),
    true,
  );
  assert.equal(polls, 3);
  const stuck = { health: async () => round(-1), running, interval: 1, timeoutMs: 30 };
  assert.equal(await schedulerPaused(since, stuck), false, "a stuck round blocks activation");
  // Without an answer only a plugin that is not running shows that no round is in flight.
  const silent = {
    health: async () => {
      throw new Error("Plugin RPC failed");
    },
    interval: 1,
    timeoutMs: 30,
  };
  assert.equal(await schedulerPaused(since, { ...silent, running }), false);
  assert.equal(await schedulerPaused(since, { ...silent, running: async () => false }), true);
});

test("native Codex project trust survives profile verification and refresh without allowing other config drift", async () => {
  const f = await fixture();
  const profile = f.manifest.profiles["codex-peer"];
  const path = join(profile.home, "config.toml");
  const nativeConfig =
    (await readFile(path, "utf8")) + '\n[projects."/temporary/demo"]\ntrust_level = "trusted"\n';
  await writeFile(path, nativeConfig);
  await verifyProfile(profile);
  const runtime = await new AllianceRuntime(f.home).ready();
  try {
    await runtime.profile("alliance-codex-peer");
  } finally {
    runtime.close();
  }
  const refreshed = await prepareProfiles({ home: f.home, executables });
  assert.equal(await readFile(path, "utf8"), nativeConfig);
  await verifyProfile(refreshed.profiles["codex-peer"]);
  await writeFile(path, nativeConfig + '\n[mcp_servers.unmanaged]\ncommand="unexpected"\n');
  await assert.rejects(verifyProfile(refreshed.profiles["codex-peer"]), /changed/);
});

test("daemon compatibility accepts only the pinned runtime and the validated newer host", () => {
  requireCompatibleDaemon("0.10.3", "0.10.3");
  requireCompatibleDaemon("0.11.2", "0.10.3");
  assert.throws(() => requireCompatibleDaemon("0.11.3", "0.10.3"), /not validated/);
  assert.throws(() => requireCompatibleDaemon("0.9.9", "0.10.3"), /not validated/);
});

test("stable updates accept installed host prereleases without downgrading a newer base", () => {
  assert.equal(isNewerRelease("v0.1.5", "0.1.4-ryzen.1"), true);
  assert.equal(isNewerRelease("v0.1.4", "0.1.4-host.2"), true);
  assert.equal(isNewerRelease("v0.1.4", "0.1.5-host.1"), false);
});
