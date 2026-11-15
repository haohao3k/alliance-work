import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs, { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { withMaintenance } from "../scripts/maintenance.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import {
  collectReleases,
  describeCollection,
  liveProcesses,
  planReleases,
  removeBundleBoot,
  summarizeCollection,
} from "../scripts/release-gc.mjs";
import { diskHealth, withDiskWarnings } from "../server/disk-health.mjs";
import { LOCK, MUTEX } from "../server/maintenance-lock.mjs";
import { temporary } from "./temp";

const cli = join(projectRoot, "scripts/cli.mjs");
// Collection also reads the user's harness configuration under the OS home; keep these tests off the real one.
process.env.HOME = await temporary("alliance-gc-home-");
const none = () => ({ processes: [], detection: { args: true, cwd: true } });
const humanEnv = { ...process.env };
for (const key of ["PASEO_AGENT_ID", "ALLIANCE_ROLE", "ALLIANCE_BOUND_ROOM", "ALLIANCE_PARENT_MAINTENANCE"])
  delete humanEnv[key];

async function release(home: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = join(home, "releases", name);
  await mkdir(join(dir, "node_modules/dep"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "alliance-work", version: "0.0.0", ...extra }),
  );
  await writeFile(join(dir, "node_modules/dep/index.js"), "x");
  return dir;
}

/** A home with an installation on `current`, rollback to `previous`, and a launcher and Paseo config naming them. */
async function installed(...old: string[]) {
  const dir = await temporary("alliance-gc-");
  const home = join(dir, "home"),
    paseoHome = join(dir, "paseo"),
    bin = join(dir, "bin/alliance-work");
  const current = await release(home, "v0.1.3-cccccccccccc-1000");
  const previous = await release(home, "v0.1.2-bbbbbbbbbbbb-900");
  for (const name of old) await release(home, name);
  await mkdir(paseoHome, { recursive: true });
  await mkdir(join(dir, "bin"), { recursive: true });
  // The recorded root keeps the trailing slash the real installer writes.
  await writeFile(
    join(home, "installation.json"),
    JSON.stringify({ root: `${current}/`, previous: { root: previous }, paseoHome, binPath: bin }),
  );
  await writeFile(join(home, "profiles.json"), JSON.stringify({ root: current, profiles: {} }));
  await writeFile(bin, `#!/bin/sh\nexec node '${current}/scripts/cli.mjs' "$@"\n`);
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({ plugins: { "alliance-work": { source: "directory", path: current } } }),
  );
  return { dir, home, paseoHome, current, previous };
}
const names = (entries: { name: string }[]) => entries.map((entry) => entry.name).sort();
const hold: ChildProcess[] = [];
function stop() {
  for (const child of hold.splice(0)) child.kill("SIGKILL");
}
async function running(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: "ignore" });
  hold.push(child);
  await new Promise((resolve) => setTimeout(resolve, 300));
  return child;
}

test("updates left every old release behind; collection keeps what installation, config and processes need", async (t) => {
  t.after(stop);
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800", "v0.1.0", "v0.1.3-cccccccccccc-1000-old");
  const cwdHeld = await release(f.home, "v0.1.4-cwd");
  const argsHeld = await release(f.home, "v0.1.5-args");
  const configHeld = await release(f.home, "v0.1.6-config");
  await writeFile(join(f.paseoHome, "alliance-instance.json"), JSON.stringify({ root: configHeld }));
  const foreign = join(f.home, "releases/v0.1.7-notes");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "package.json"), JSON.stringify({ name: "someone-elses-app" }));
  const outside = await temporary("alliance-gc-outside-");
  await writeFile(join(outside, "precious"), "keep");
  await symlink(outside, join(f.home, "releases/v0.1.8-link"));
  const staging = join(f.home, "releases", `.download-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  await running("sleep", ["30"], cwdHeld);
  await running(
    process.execPath,
    ["-e", "setTimeout(()=>{},30000)", join(argsHeld, "scripts/launch.mjs")],
    f.dir,
  );

  const dry = await collectReleases({ home: f.home, minAgeMs: 0 });
  assert.deepEqual(
    names(dry.remove),
    [staging.split("/").pop(), "v0.1.0", "v0.1.1-aaaaaaaaaaaa-800", "v0.1.3-cccccccccccc-1000-old"].sort(),
  );
  for (const entry of dry.keep) assert.ok(entry.reasons.length, `${entry.name} says why it stays`);
  assert.ok(existsSync(join(f.home, "releases/v0.1.0")), "a dry run deletes nothing");
  assert.ok(existsSync(staging));

  const applied = await collectReleases({ home: f.home, minAgeMs: 0, apply: true });
  assert.deepEqual(applied.failed, []);
  assert.deepEqual(names(applied.removed.map((name: string) => ({ name }))), names(dry.remove));
  for (const kept of [f.current, f.previous, cwdHeld, argsHeld, configHeld, foreign])
    assert.ok(existsSync(kept), `${kept} survives`);
  assert.ok(existsSync(join(outside, "precious")), "a symlink is never followed");
  assert.ok(existsSync(join(f.home, "releases/v0.1.8-link")));
  assert.ok(!existsSync(join(f.home, "releases/v0.1.0")));
  assert.ok(existsSync(join(f.previous, "package.json")), "rollback target is intact");
  const again = await planReleases({ home: f.home, minAgeMs: 0 });
  assert.equal(again.entries.filter((entry: { action: string }) => entry.action === "remove").length, 0);
});

test("a release that is the prefix of another's name is not protected by it", async () => {
  const f = await installed("v0.1.3-cccccccccccc", "v0.1.3-cccccccccccc-10");
  const plan = await planReleases({ home: f.home, minAgeMs: 0, processes: none });
  const action = (name: string) =>
    plan.entries.find((entry: { name: string }) => entry.name === name)?.action;
  assert.equal(action("v0.1.3-cccccccccccc-1000"), "keep");
  assert.equal(action("v0.1.3-cccccccccccc"), "remove");
  assert.equal(action("v0.1.3-cccccccccccc-10"), "remove");
});

test("without an installation record or a process list nothing is deleted", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const broken = await collectReleases({
    home: f.home,
    minAgeMs: 0,
    apply: true,
    processes: () => {
      throw new Error("ps failed");
    },
  });
  assert.deepEqual(broken.removed, []);
  assert.ok(existsSync(join(f.home, "releases/v0.1.1-aaaaaaaaaaaa-800")));
  const lonely = await temporary("alliance-gc-lonely-");
  await release(lonely, "v0.1.1-aaaaaaaaaaaa-800");
  const result = await collectReleases({ home: lonely, minAgeMs: 0, apply: true, processes: none });
  assert.deepEqual(result.removed, []);
});

test("a release changed within the hour is left for the installer that may be staging it", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const plan = await planReleases({ home: f.home, processes: none });
  assert.equal(plan.entries.filter((entry: { action: string }) => entry.action === "remove").length, 0);
});

test("the operator command lists first and deletes only with --apply", async (t) => {
  t.after(stop);
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [cli, "cleanup", "releases", "--home", f.home, "--min-age-minutes", "0", ...args],
      {
        encoding: "utf8",
        env: humanEnv,
      },
    );
  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /would remove\s+v0\.1\.1-aaaaaaaaaaaa-800/);
  assert.match(dry.stdout, /keep\s+v0\.1\.3-cccccccccccc-1000/);
  assert.ok(existsSync(join(f.home, "releases/v0.1.1-aaaaaaaaaaaa-800")));
  const applied = run("--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(!existsSync(join(f.home, "releases/v0.1.1-aaaaaaaaaaaa-800")));
  assert.ok(existsSync(f.current) && existsSync(f.previous));
});

for (const context of [
  { PASEO_AGENT_ID: "native-agent" },
  { ALLIANCE_ROLE: "peer" },
  { ALLIANCE_BOUND_ROOM: "room" },
])
  test(`${Object.keys(context)} may preview releases but only the Human may apply collection`, async () => {
    const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [cli, "cleanup", "releases", "--home", f.home, "--min-age-minutes", "0", ...args],
        { encoding: "utf8", env: { ...humanEnv, ...context } },
      );
    const dry = run("--json");
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(
      JSON.parse(dry.stdout).remove.some(
        (entry: { name: string }) => entry.name === "v0.1.1-aaaaaaaaaaaa-800",
      ),
    );
    const applied = run("--apply");
    assert.notEqual(applied.status, 0, `${Object.keys(context)} must not delete releases`);
    assert.match(applied.stderr, /Human/);
    assert.ok(existsSync(join(f.home, "releases/v0.1.1-aaaaaaaaaaaa-800")));
    assert.ok(!existsSync(join(f.home, MUTEX)), "denial takes no maintenance lock");
  });

test("release apply refuses a competing maintenance operation while previews remain available", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  await withMaintenance(
    f.home,
    async () => {
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [cli, "cleanup", "releases", "--home", f.home, "--min-age-minutes", "0", ...args],
          { encoding: "utf8", env: humanEnv },
        );
      assert.equal(run().status, 0);
      const applied = run("--apply");
      assert.notEqual(applied.status, 0);
      assert.match(applied.stderr, /Another maintenance operation/);
      assert.ok(existsSync(join(f.home, "releases/v0.1.1-aaaaaaaaaaaa-800")));
      assert.ok(existsSync(join(f.home, MUTEX)), "the other operation keeps its lock");
    },
    { pause: false },
  );
});

test("direct collection takes the maintenance mutex before reading safety state", async () => {
  const name = "v0.1.1-aaaaaaaaaaaa-800";
  const f = await installed(name);
  const locked: boolean[] = [];
  const result = await collectReleases({
    home: f.home,
    apply: true,
    minAgeMs: 0,
    now: Date.now() + 5000,
    processes: () => {
      locked.push(existsSync(join(f.home, MUTEX)));
      return none();
    },
  });
  assert.deepEqual(result.removed, [name]);
  assert.ok(locked.length > 0 && locked.every(Boolean), "all safety snapshots hold the mutex");
  assert.ok(!existsSync(join(f.home, MUTEX)), "collection releases its own mutex");
});

for (const mode of ["foreign", "inherited", "invalid parent"] as const)
  test(`direct collection validates a ${mode} maintenance lock`, async () => {
    const name = "v0.1.1-aaaaaaaaaaaa-800";
    const f = await installed(name);
    await withMaintenance(f.home, async () => {
      if (mode === "invalid parent") {
        const path = join(f.home, LOCK, "owner.json");
        const owner = JSON.parse(await readFile(path, "utf8"));
        await writeFile(path, JSON.stringify({ ...owner, pid: process.ppid }));
      }
      const script = `
        import { collectReleases } from ${JSON.stringify(join(projectRoot, "scripts/release-gc.mjs"))};
        await collectReleases({ home: ${JSON.stringify(f.home)}, apply: true, minAgeMs: 0, now: Date.now() + 5000 });
      `;
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
          ...humanEnv,
          ...(mode !== "foreign" ? { ALLIANCE_PARENT_MAINTENANCE: String(process.pid) } : {}),
        },
      });
      if (mode === "inherited") assert.equal(child.status, 0, child.stderr);
      else {
        assert.notEqual(child.status, 0);
        assert.match(
          child.stderr,
          mode === "foreign" ? /Another maintenance operation/ : /Parent maintenance lock does not match/,
        );
      }
      assert.equal(existsSync(join(f.home, "releases", name)), mode !== "inherited");
      assert.ok(existsSync(join(f.home, MUTEX)), "the parent retains its mutex");
    });
  });

test("a dry run of a missing home creates nothing and reads no processes", async () => {
  const home = join(await temporary("alliance-gc-missing-"), "missing");
  const result = await collectReleases({
    home,
    processes: () => {
      throw new Error("unexpected process scan");
    },
  });
  assert.deepEqual(result.remove, []);
  assert.deepEqual(result.removed, []);
  assert.ok(!existsSync(home));
});

for (const change of [
  "pin",
  "current",
  "previous",
  "config",
  "process",
  "unreadable config",
  "unknown processes",
  "unknown cwd",
] as const)
  test(`release apply retains a candidate when ${change} changes after planning under the lock`, async (t) => {
    const name = "v0.1.1-aaaaaaaaaaaa-800";
    const f = await installed(name);
    const candidate = join(f.home, "releases", name);
    const userHome = await temporary("alliance-gc-user-");
    let changed = false;
    const measure = fs.statfs;
    // Free-space measurement yields after the preview and before the first removal.
    t.mock.method(fs, "statfs", async (...args: Parameters<typeof fs.statfs>) => {
      if (!changed) {
        assert.ok(existsSync(join(f.home, MUTEX)), "the safety state changes while locked");
        changed = true;
        if (change === "pin") await writeFile(join(candidate, ".keep"), "");
        if (change === "current" || change === "previous") {
          const recordPath = join(f.home, "installation.json");
          const record = JSON.parse(await readFile(recordPath, "utf8"));
          if (change === "current") record.root = candidate;
          else record.previous.root = candidate;
          await writeFile(recordPath, JSON.stringify(record));
        }
        if (change === "config")
          await writeFile(
            join(userHome, ".claude.json"),
            JSON.stringify({ command: `${candidate}/tool.mjs` }),
          );
        if (change === "unreadable config") await mkdir(join(userHome, ".claude.json"));
      }
      return measure(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const processes = () => {
      assert.ok(existsSync(join(f.home, MUTEX)), "every process snapshot is taken under the lock");
      if (changed && change === "unknown processes") throw new Error("process scan unavailable");
      if (changed && change === "unknown cwd")
        return { processes: [], detection: { args: true, cwd: false } };
      return changed && change === "process"
        ? { processes: [{ pid: 123, text: "sleep", cwd: candidate }], detection: { args: true, cwd: true } }
        : none();
    };
    const result = await withMaintenance(
      f.home,
      () =>
        collectReleases({
          home: f.home,
          userHome,
          apply: true,
          minAgeMs: 0,
          now: Date.now() + 5000,
          processes,
        }),
      { pause: false },
    );
    assert.ok(changed);
    assert.deepEqual(result.removed, [], "new protection prevents deletion");
    assert.deepEqual(result.failed, [], "retaining a newly protected release is not a deletion failure");
    assert.ok(existsSync(join(candidate, "node_modules/dep/index.js")), "release contents survive");
    assert.ok(result.keep.some((entry: { name: string }) => entry.name === name));
    assert.ok(!result.remove.some((entry: { name: string }) => entry.name === name));
    const rendered = describeCollection(result);
    assert.match(rendered, new RegExp(`keep  ${name}`));
    assert.doesNotMatch(rendered, /FAILED/);
    if (["unknown processes", "unknown cwd", "unreadable config"].includes(change)) assert.ok(result.held);
  });

test("unknown process working directories retain all releases even when command lines are readable", async () => {
  const name = "v0.1.1-aaaaaaaaaaaa-800";
  const f = await installed(name);
  const result = await collectReleases({
    home: f.home,
    apply: true,
    minAgeMs: 0,
    now: Date.now() + 5000,
    processes: () => ({ processes: [], detection: { args: true, cwd: false } }),
  });
  assert.deepEqual(result.removed, []);
  assert.ok(existsSync(join(f.home, "releases", name)));
  assert.match(result.held ?? "", /working directories/i);
  assert.match(describeCollection(result), /Kept every release: .*working directories/i);
});

for (const code of ["EACCES", "EIO"])
  test(`a .keep check that fails with ${code} retains the release and explains why`, async (t) => {
    const name = "v0.1.1-aaaaaaaaaaaa-800";
    const f = await installed(name);
    const inspect = fs.lstat;
    t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === join(f.home, "releases", name, ".keep"))
        throw Object.assign(new Error(`${code}: cannot inspect .keep`), { code });
      return inspect(...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const result = await collectReleases({
      home: f.home,
      apply: true,
      minAgeMs: 0,
      now: Date.now() + 5000,
      processes: none,
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.failed, []);
    assert.ok(existsSync(join(f.home, "releases", name, "node_modules/dep/index.js")));
    assert.match(
      result.keep.find((entry: { name: string }) => entry.name === name)?.reasons.join("; ") ?? "",
      new RegExp(`\\.keep.*${code}`),
    );
    assert.match(describeCollection(result), new RegExp(`keep  ${name}.*${code}`));
  });

test("collection rechecks later candidates after deleting an earlier release", async (t) => {
  const first = "v0.1.0-first",
    second = "v0.1.1-second";
  const f = await installed(first, second);
  const remove = fs.rm;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    await remove(...args);
    if (args[0] === join(f.home, "releases", first))
      await writeFile(join(f.home, "releases", second, ".keep"), "");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await withMaintenance(
    f.home,
    () =>
      collectReleases({
        home: f.home,
        apply: true,
        minAgeMs: 0,
        now: Date.now() + 5000,
        processes: none,
      }),
    { pause: false },
  );
  assert.deepEqual(result.removed, [first]);
  assert.ok(existsSync(join(f.home, "releases", second, "node_modules/dep/index.js")));
  assert.ok(result.keep.some((entry: { name: string }) => entry.name === second));
});

test("process detection sees command lines and working directories on this platform", async (t) => {
  t.after(stop);
  const dir = await temporary("alliance-procs-");
  const child = await running("sleep", ["30"], dir);
  const scan = liveProcesses();
  const found = scan.processes.find((process: { pid: number }) => process.pid === child.pid);
  assert.ok(found, "the child is listed");
  assert.equal(scan.detection.cwd, true);
  assert.equal(found.cwd, dir);
});

test("a deploy bundle's bootstrap copy is removed after the update, but never under the running CLI", async () => {
  const bundle = await temporary("alliance-bundle-");
  await mkdir(join(bundle, "boot/alliance-work/scripts"), { recursive: true });
  await writeFile(join(bundle, "boot/alliance-work/scripts/cli.mjs"), "x");
  await writeFile(join(bundle, "deploy.log"), "log");
  assert.equal(
    await removeBundleBoot(bundle, { running: join(bundle, "boot/alliance-work/scripts/cli.mjs") }),
    false,
  );
  assert.ok(existsSync(join(bundle, "boot")));
  assert.equal(await removeBundleBoot(bundle, { running: cli }), true);
  assert.ok(!existsSync(join(bundle, "boot")));
  assert.ok(existsSync(join(bundle, "deploy.log")), "the log stays");
  assert.equal(await removeBundleBoot(bundle, { running: cli }), false);
});

test("disk warnings appear above 80% used or under 5G free, once per filesystem, and never block", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const fs = (device: number, usedPercent: number, free = 200 * 1024 ** 3) => ({
    device,
    usedPercent,
    total: 0,
    free,
  });
  const quiet = await diskHealth({ home: f.home, paseoHome: f.paseoHome, measure: async () => fs(1, 50) });
  assert.deepEqual(quiet.warnings, []);
  const shared = await diskHealth({ home: f.home, paseoHome: f.paseoHome, measure: async () => fs(1, 85) });
  assert.deepEqual(
    shared.warnings.map((w: { code: string }) => w.code),
    ["disk-high"],
  );
  assert.equal(shared.filesystems.length, 1, "one filesystem is reported once");
  const split = await diskHealth({
    home: f.home,
    paseoHome: f.paseoHome,
    measure: async (path: string) => (path === "/" ? fs(9, 95) : fs(1, 20, 2 * 1024 ** 3)),
  });
  assert.deepEqual(split.warnings.map((w: { code: string }) => w.code).sort(), [
    "disk-critical",
    "disk-high",
  ]);
  assert.deepEqual(quiet.releases, { count: 3, policy: 3 });
  await release(f.home, "v0.1.0");
  const over = await diskHealth({ home: f.home, measure: async () => fs(1, 10) });
  assert.deepEqual(
    over.warnings.map((w: { code: string }) => w.code),
    ["releases-over-policy"],
  );
  const status = { rooms: [] };
  assert.equal(withDiskWarnings(status, quiet), status, "no warning leaves status as it was");
  assert.deepEqual(withDiskWarnings(status, over), { rooms: [], diskWarnings: over.warnings });
});

// Timestamps have sub-millisecond precision; with a zero window a just-made release can look newer than "now".
const later = () => Date.now() + 5000;
const actionOf = (plan: { entries: { name: string; action: string }[] }, name: string) =>
  plan.entries.find((entry) => entry.name === name)?.action;
const reasonsOf = (plan: { entries: { name: string; reasons: string[] }[] }, name: string) =>
  plan.entries.find((entry) => entry.name === name)?.reasons.join("; ");

test("a release the user's own harness configuration names is kept with no process using it", async () => {
  // Synthetic case: a Mobbin MCP launched out of an old release by ~/.codex, ~/.claude.json and AGY.
  const f = await installed("v0.1.0-aaaaaaaaaaaa-1");
  const userHome = await temporary("alliance-gc-user-");
  const configs: Record<string, string> = {
    ".codex/config.toml": "v0.1.10-codex",
    ".claude.json": "v0.1.11-claude",
    ".gemini/config/mcp_config.json": "v0.1.12-agy",
    ".pi/agent/mcp.json": "v0.1.13-pi",
  };
  for (const [file, name] of Object.entries(configs)) {
    const root = await release(f.home, name);
    await mkdir(join(userHome, file, ".."), { recursive: true });
    await writeFile(join(userHome, file), `command = "node ${root}/scripts/mobbin.mjs"\n`);
  }
  // `~` and `$HOME` spellings of the same path count too.
  await release(f.home, "v0.1.14-tilde");
  await mkdir(join(userHome, ".claude"), { recursive: true });
  await writeFile(
    join(userHome, ".claude/settings.json"),
    '{"args":["~/.alliance-work/releases/v0.1.14-tilde/x"]}',
  );
  const plan = await planReleases({ home: f.home, userHome, minAgeMs: 0, now: later(), processes: none });
  for (const name of [...Object.values(configs), "v0.1.14-tilde"])
    assert.equal(actionOf(plan, name), "keep", `${name} is named by a user config`);
  assert.match(reasonsOf(plan, "v0.1.10-codex") ?? "", /named by user harness config .*config\.toml/);
  assert.equal(actionOf(plan, "v0.1.0-aaaaaaaaaaaa-1"), "remove", "an unnamed release still goes");
  const applied = await collectReleases({
    home: f.home,
    userHome,
    minAgeMs: 0,
    now: later(),
    apply: true,
    processes: none,
  });
  assert.deepEqual(applied.removed, ["v0.1.0-aaaaaaaaaaaa-1"]);
  for (const name of [...Object.values(configs), "v0.1.14-tilde"])
    assert.ok(existsSync(join(f.home, "releases", name)), `${name} survives`);
});

test("a user config that is missing is normal; one that cannot be read keeps every release", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const empty = await temporary("alliance-gc-user-");
  const plain = await planReleases({
    home: f.home,
    userHome: empty,
    minAgeMs: 0,
    now: later(),
    processes: none,
  });
  assert.equal(actionOf(plain, "v0.1.1-aaaaaaaaaaaa-800"), "remove");
  assert.equal(plain.held, null);
  const unreadable = await temporary("alliance-gc-user-");
  await mkdir(join(unreadable, ".codex/config.toml"), { recursive: true }); // a directory cannot be read as a file
  const held = await planReleases({
    home: f.home,
    userHome: unreadable,
    minAgeMs: 0,
    now: later(),
    processes: none,
  });
  assert.match(held.held ?? "", /Cannot read user harness config .*config\.toml/);
  assert.equal(actionOf(held, "v0.1.1-aaaaaaaaaaaa-800"), "keep");
  assert.equal(actionOf(held, f.current.split("/").pop() as string), "keep");
  const large = await temporary("alliance-gc-user-");
  await writeFile(join(large, ".claude.json"), Buffer.alloc(17 * 1024 * 1024, 32));
  const tooBig = await planReleases({
    home: f.home,
    userHome: large,
    minAgeMs: 0,
    now: later(),
    processes: none,
  });
  assert.match(tooBig.held ?? "", /too large to read/);
  assert.equal(actionOf(tooBig, "v0.1.1-aaaaaaaaaaaa-800"), "keep");
});

test("a .keep file pins a release", async () => {
  const f = await installed();
  const pinned = await release(f.home, "v0.1.20-pinned");
  await release(f.home, "v0.1.21-free");
  await writeFile(join(pinned, ".keep"), "");
  const plan = await planReleases({
    home: f.home,
    userHome: await temporary("alliance-gc-user-"),
    minAgeMs: 0,
    now: later(),
    processes: none,
  });
  assert.equal(actionOf(plan, "v0.1.20-pinned"), "keep");
  assert.match(reasonsOf(plan, "v0.1.20-pinned") ?? "", /pinned by \.keep/);
  assert.equal(actionOf(plan, "v0.1.21-free"), "remove");
});

test("when everything is kept for lack of evidence, the activation and the dry run say so", async () => {
  const f = await installed("v0.1.1-aaaaaaaaaaaa-800");
  const userHome = await temporary("alliance-gc-user-");
  const blind = await collectReleases({
    home: f.home,
    userHome,
    minAgeMs: 0,
    now: later(),
    apply: true,
    processes: () => {
      throw new Error("Cannot list processes (ps failed).");
    },
  });
  assert.deepEqual(blind.removed, []);
  const summary = summarizeCollection(blind);
  assert.match(
    (summary as { heldAll?: string } | undefined)?.heldAll ?? "",
    /^Kept every release: Cannot list processes/,
  );
  assert.match(describeCollection(blind), /^Kept every release: Cannot list processes/);
  // Nothing removed, nothing held, nothing failed: silent as before.
  const quiet = await collectReleases({
    home: f.home,
    userHome,
    minAgeMs: 0,
    now: later(),
    apply: true,
    processes: none,
  });
  assert.ok(
    (summarizeCollection(quiet) as { removed?: string[] } | undefined)?.removed?.length,
    "a removal is reported",
  );
  const again = await collectReleases({
    home: f.home,
    userHome,
    minAgeMs: 0,
    now: later(),
    apply: true,
    processes: none,
  });
  assert.equal(summarizeCollection(again), undefined);
  assert.deepEqual(summarizeCollection({ error: "boom" }), { error: "boom" });
  // The activation path uses the same summary.
  assert.match(
    await readFile(join(projectRoot, "scripts/cli.mjs"), "utf8"),
    /summarizeCollection\(collected\)/,
  );
});
