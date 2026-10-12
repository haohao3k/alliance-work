import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isNewerRelease, verifyChecksum } from "../scripts/distribution.mjs";
import { restore, snapshot } from "../scripts/maintenance.mjs";
import { requireCompatibleDaemon, requireIdleState } from "../scripts/paseo.mjs";
import { loadManifest, prepareProfiles, projectRoot, verifyProfile } from "../scripts/profiles.mjs";
import { AllianceRuntime } from "../server/runtime";
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
