import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  bundleRelease,
  deploy,
  followCommand,
  harnessPath,
  parseFollow,
  remoteScript,
  waitForIdle,
} from "../scripts/deploy.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

async function bundle(contents = "release fixture", listed = contents) {
  const dir = await temporary("alliance-bundle-");
  const name = "alliance-work-v9.8.7.tar.gz";
  await writeFile(join(dir, name), contents);
  const hash = createHash("sha256").update(listed).digest("hex");
  await writeFile(join(dir, "checksums.txt"), `${hash}  ${name}\n`);
  return dir;
}

test("a deployed bundle must match its release checksum and hold exactly one archive", async () => {
  const good = await bundle();
  assert.equal((await bundleRelease(good)).tagName, "v9.8.7");
  await assert.rejects(bundleRelease(await bundle("tampered", "release fixture")), /Checksum mismatch/);
  await writeFile(join(good, "alliance-work-v9.8.8.tar.gz"), "second");
  await assert.rejects(bundleRelease(good), /exactly one/);
  await assert.rejects(bundleRelease(await temporary("alliance-empty-")), /exactly one/);
});

test("updates over SSH keep this Node and the installed harnesses ahead of other copies", async () => {
  const home = await temporary("alliance-path-");
  await writeFile(
    join(home, "profiles.json"),
    JSON.stringify({
      profiles: {
        "codex-peer": { executable: "/opt/harness/bin/codex" },
        "pi-peer": { executable: "/home/u/.alliance-work/releases/v1/node_modules/pi/cli.js" },
      },
    }),
  );
  const path = (await harnessPath(home, "/usr/bin:/bin")).split(":");
  assert.equal(path[0], dirname(process.execPath), "npm resolves node through PATH");
  assert.equal(path[1], "/opt/harness/bin", "a stale /usr/bin/codex must not replace the profile's");
  assert.deepEqual(path.slice(2), ["/usr/bin", "/bin"]);
  assert.ok(!path.some((dir) => dir.includes("/releases/")), "bundled release paths are not harnesses");
});

test("the remote half hands the bundle to an installed launcher that understands bundles", async () => {
  const home = await temporary("alliance-remote-");
  const launcher = join(home, "bin", "alliance-work");
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(
    launcher,
    [
      "#!/bin/sh",
      "# Alliance Work managed launcher",
      'if [ "$1" = "--help" ]; then echo "  alliance-work update --bundle DIR"; exit 0; fi',
      'if [ "$1" = "--version" ]; then echo "$INSTALLED"; exit 0; fi',
      'echo "ARGS:$*"; exit 0',
      `exec '${process.execPath}' '/release/scripts/cli.mjs' --home '${home}' "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(launcher, 0o755);
  await writeFile(join(home, "installation.json"), `${JSON.stringify({ binPath: launcher }, null, 2)}\n`);
  const script = join(home, "deploy.sh");
  await writeFile(script, remoteScript);
  const dir = await temporary("alliance-bundle-run-");
  const run = (wait: string, target = home, installed = "0.1.19", hold = "") =>
    spawnSync("sh", [script, dir, "v9.8.7", wait, target, hold], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home, INSTALLED: installed },
    });
  const waited = run("90");
  assert.equal(waited.status, 0, waited.stderr);
  assert.ok(waited.stdout.includes(`ARGS:update --bundle ${dir} --wait-idle 90`), waited.stdout);
  assert.equal((await readFile(join(dir, "rc"), "utf8")).trim(), "0", "the controller reads the outcome");
  assert.ok(run("0").stdout.trimEnd().endsWith(`ARGS:update --bundle ${dir}`));
  // deploy --hold keeps scheduled prompts paused from the end of staging, so agents the operator
  // stops on a busy host are not woken before activation.
  const held = run("90", home, "0.1.19", "hold");
  assert.ok(held.stdout.includes(`ARGS:update --bundle ${dir} --wait-idle 90 --hold`), held.stdout);
  // Before 0.1.19 a waiting update paused every scheduled prompt for the whole wait, so such a host
  // waits with the candidate's own CLI, set up from the verified bundle. Without a wait the
  // installed CLI still updates.
  const olderHost = async (...hold: string[]) => {
    const release = await temporary("alliance-candidate-");
    const candidate = join(release, "alliance-work");
    await mkdir(join(candidate, "scripts"), { recursive: true });
    const manifest = { name: "alliance-work", version: "9.8.7" };
    await writeFile(join(candidate, "package.json"), JSON.stringify(manifest));
    await writeFile(
      join(candidate, "package-lock.json"),
      JSON.stringify({ ...manifest, lockfileVersion: 3, packages: { "": manifest } }),
    );
    await writeFile(
      join(candidate, "scripts/cli.mjs"),
      'import { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nwriteFileSync(join(process.env.HOME, "candidate-args"), process.argv.slice(2).join(" "));\n',
    );
    const bundled = await temporary("alliance-bundle-old-");
    const archive = join(bundled, "alliance-work-v9.8.7.tar.gz");
    spawnSync("tar", ["-czf", archive, "-C", release, "alliance-work"], { env: { COPYFILE_DISABLE: "1" } });
    const sum = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    await writeFile(join(bundled, "checksums.txt"), `${sum}  alliance-work-v9.8.7.tar.gz\n`);
    const older = spawnSync("sh", [script, bundled, "v9.8.7", "90", home, ...hold], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home, INSTALLED: "0.1.18-ryzen.1" },
    });
    assert.equal(older.status, 0, older.stderr);
    assert.ok(!older.stdout.includes("ARGS:"), older.stdout);
    assert.equal((await readFile(join(bundled, "rc"), "utf8")).trim(), "0");
    return { bundled, args: await readFile(join(home, "candidate-args"), "utf8") };
  };
  const older = await olderHost();
  assert.equal(older.args, `update --bundle ${older.bundled} --home ${home} --wait-idle 90`);
  const olderHeld = await olderHost("hold");
  assert.equal(olderHeld.args, `update --bundle ${olderHeld.bundled} --home ${home} --wait-idle 90 --hold`);
  assert.ok(run("0", home, "0.1.18").stdout.trimEnd().endsWith(`ARGS:update --bundle ${dir}`));
  const missing = run("0", join(home, "absent"));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /No Alliance installation/);
  assert.equal((await readFile(join(dir, "rc"), "utf8")).trim(), "2", "failures are recorded too");
});

test("deploy refuses unsafe host names and negative waits before contacting anything", async () => {
  await assert.rejects(deploy({ hosts: ["ryzen; rm -rf /"] }), /Unsupported host/);
  await assert.rejects(deploy({ hosts: [] }), /at least one --host/);
  await assert.rejects(deploy({ hosts: ["ryzen"], waitIdle: -1 }), /wait-idle/);
  // --hold without a wait is refused, not ignored. Failing stubs stand in for gh and ssh in case
  // the refusal ever stops happening first.
  const stubs = await temporary("alliance-offline-");
  for (const name of ["gh", "ssh", "scp"])
    await writeFile(join(stubs, name), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${stubs}:${path}`;
  try {
    await assert.rejects(deploy({ hosts: ["deploy-test.invalid"], hold: true }), /--hold needs --wait-idle/);
  } finally {
    process.env.PATH = path;
  }
  const saved = process.env.PASEO_AGENT_ID;
  process.env.PASEO_AGENT_ID = "an-agent";
  try {
    await assert.rejects(deploy({ hosts: ["ryzen"], waitIdle: 30 }), /--detach/);
  } finally {
    if (saved === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = saved;
  }
});

test("an Alliance agent session without a Paseo identity cannot record an acceptance", async () => {
  const home = await temporary("alliance-accept-");
  const result = spawnSync(
    process.execPath,
    [
      join(projectRoot, "scripts/cli.mjs"),
      "accept",
      "--agent",
      "peer",
      "--report",
      "/nonexistent.json",
      "--home",
      home,
    ],
    { encoding: "utf8", env: { ...process.env, PASEO_AGENT_ID: "", ALLIANCE_ROLE: "peer" } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /deciding agent is unknown/);
});

test("an update over SSH refuses to start a stopped daemon with the remote shell's environment", async () => {
  const paseoHome = await temporary("alliance-stopped-");
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:1" } }),
  );
  await assert.rejects(waitForIdle(paseoHome, 0, { refuseStopped: true }), /not running/);
  const local = (await waitForIdle(paseoHome, 0)) as { daemon?: string };
  assert.notEqual(local.daemon, "running", "a local update may start it as before");
});

test("following a remote log advances by bytes, reports the exit status and notices a vanished log", async () => {
  const dir = await temporary("alliance-follow-");
  const log = join(dir, "deploy.log");
  const text = "Waiting for idle… ✔ checks\n";
  await writeFile(log, text);
  const read = (offset: number) =>
    parseFollow(spawnSync("sh", ["-c", followCommand(log, dir, offset)]).stdout as Buffer);
  const first = read(0);
  assert.equal(first.text, text);
  assert.equal(first.consumed, Buffer.byteLength(text), "multi-byte characters count as bytes");
  assert.equal(first.rc, "");
  await writeFile(log, `${text}done\n`);
  await writeFile(join(dir, "rc"), "0\n");
  const last = read(first.consumed ?? 0);
  assert.equal(last.text, "done\n");
  assert.equal(last.rc, "0");
  assert.equal(read(0).gone, undefined);
  assert.equal(
    parseFollow(spawnSync("sh", ["-c", followCommand(join(dir, "missing"), dir, 0)]).stdout as Buffer).gone,
    true,
  );
});

test("a remote update killed by a signal records a failure status", async () => {
  const home = await temporary("alliance-remote-kill-");
  const launcher = join(home, "alliance-work");
  await writeFile(
    launcher,
    [
      "#!/bin/sh",
      'if [ "$1" = "--help" ]; then echo "update --bundle DIR"; exit 0; fi',
      "sleep 30",
      `exec '${process.execPath}' x "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(launcher, 0o755);
  await writeFile(join(home, "installation.json"), `${JSON.stringify({ binPath: launcher }, null, 2)}\n`);
  await writeFile(join(home, "deploy.sh"), remoteScript);
  const dir = await temporary("alliance-remote-kill-bundle-");
  const child = spawn("sh", [join(home, "deploy.sh"), dir, "v9.8.7", "0", home], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  await new Promise((r) => setTimeout(r, 700));
  child.kill("SIGTERM");
  await once(child, "close");
  assert.notEqual((await readFile(join(dir, "rc"), "utf8")).trim(), "0");
});
