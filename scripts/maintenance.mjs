import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { authStatus, setAuthSource } from "./auth.mjs";
import { run } from "./distribution.mjs";
import { install } from "./install.mjs";
import { instanceState, paseo, reloadRegisteredPlugin, requireIdle, verifyRuntime } from "./paseo.mjs";
import { bundledPi } from "./pi-runtime.mjs";
import {
  assertNoLinks,
  atomicWrite,
  loadManifest,
  prepareProfiles,
  projectRoot,
  verifyProfile,
} from "./profiles.mjs";

export async function installation(home) {
  return readFile(join(home, "installation.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
}
export async function withMaintenance(home, action) {
  await assertNoLinks(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, ".maintenance-lock");
  if (process.env.ALLIANCE_PARENT_MAINTENANCE === String(process.ppid)) {
    const owner = await readFile(join(path, "owner.json"), "utf8").then(JSON.parse);
    if (owner.pid !== process.ppid) throw new Error("Parent maintenance lock does not match.");
    return action();
  }
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `Another maintenance operation owns ${path}. If it crashed, verify its process has exited before removing this lock.`,
    );
  }
  try {
    await atomicWrite(
      join(path, "owner.json"),
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }) + "\n",
    );
    return await action();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
export async function findExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`${name} is missing from PATH. Install the native harness, then rerun setup.`);
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const marker = "# Alliance Work managed launcher";
export async function writeLauncher(path, home, root) {
  await assertNoLinks(path);
  const old = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (old && !old.includes(marker)) throw new Error(`Refusing to replace an unrelated executable: ${path}`);
  await atomicWrite(
    path,
    `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(root, "scripts/cli.mjs"))} --home ${quote(home)} "$@"\n`,
  );
  await chmod(path, 0o755);
}
export async function snapshot(home, paseoHome, binPath) {
  const manifest = await loadManifest(home).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const paths = new Set([
    ...Object.values(manifest?.profiles ?? {}).flatMap((profile) => Object.keys(profile.files)),
    ...["profiles.json", "providers.json", "installation.json", "auth-source.json"].map((name) =>
      join(home, name),
    ),
    join(paseoHome, "config.json"),
    join(paseoHome, "alliance-instance.json"),
    binPath,
  ]);
  const files = {};
  for (const path of paths) {
    await assertNoLinks(path);
    try {
      files[path] = {
        bytes: (await readFile(path)).toString("base64"),
        mode: (await lstat(path)).mode & 0o777,
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files[path] = null;
    }
  }
  const backup = join(
    home,
    "backups",
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`,
    "managed-files.json",
  );
  await atomicWrite(backup, JSON.stringify(files));
  return { files, backup };
}
export async function restore(home, saved) {
  const current = await loadManifest(home).catch(() => null);
  for (const profile of Object.values(current?.profiles ?? {})) {
    for (const path of Object.keys(profile.files)) {
      if (path in saved.files) continue;
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      let parent = dirname(path);
      while (parent !== profile.home && parent !== dirname(parent)) {
        try {
          await rmdir(parent);
        } catch {
          break;
        }
        parent = dirname(parent);
      }
    }
  }
  for (const [path, value] of Object.entries(saved.files)) {
    if (value) {
      await atomicWrite(path, Buffer.from(value.bytes, "base64"));
      await chmod(path, value.mode);
    } else
      await unlink(path).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

export async function activate({
  home,
  paseoHome,
  root = projectRoot,
  port = 6771,
  binDir,
  isolatedRoot,
  authFrom,
  separateAuth = false,
}) {
  const previous = await installation(home);
  paseoHome = resolve(paseoHome ?? previous?.paseoHome ?? join(homedir(), ".paseo-alliance-work"));
  const binPath =
    previous?.binPath ?? join(resolve(binDir ?? join(homedir(), ".local/bin")), "alliance-work");
  const oldManifest = await loadManifest(home).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const previousRoot = previous?.root ?? oldManifest?.root ?? root;
  const state = await instanceState(paseoHome, root);
  if (state) {
    const owner = await readFile(join(paseoHome, "alliance-instance.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (owner?.allianceHome !== home)
      throw new Error("Selected Paseo home is not owned by this Alliance installation.");
    if (state.localDaemon === "running") requireIdle(paseoHome, root);
    else if (state.localDaemon !== "stopped") throw new Error("Daemon state unknown; no update applied.");
  }
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (state?.daemonVersion && state.daemonVersion !== pkg.devDependencies["@getpaseo/cli"])
    throw new Error(
      `Running Paseo ${state.daemonVersion} does not match this release's ${pkg.devDependencies["@getpaseo/cli"]}. Update the dedicated runtime explicitly before proceeding.`,
    );
  const pi = await bundledPi(root);
  const executables = Object.fromEntries(
    await Promise.all(
      ["codex", "claude", "pi"].map(async (name) => {
        const executable = name === "pi" && pi ? pi.executable : await findExecutable(name);
        await access(executable, constants.X_OK);
        return [name, executable];
      }),
    ),
  );
  run("npm", ["run", "typecheck"], { cwd: root, stdio: "inherit" });
  const saved = await snapshot(home, paseoHome, binPath);
  try {
    await prepareProfiles({ home, root, executables, isolatedRoot });
    if (authFrom) await setAuthSource(home, authFrom);
    else if (separateAuth) await setAuthSource(home, null);
    const runtime = await install({ home, paseoHome, port, root, previousRoot });
    await writeLauncher(binPath, home, root);
    const record = {
      version: pkg.version,
      root,
      home,
      paseoHome,
      binPath,
      previous:
        previous?.root !== root && previous
          ? { version: previous.version, root: previous.root }
          : previous?.previous,
      backup: saved.backup,
      installedAt: new Date().toISOString(),
    };
    await atomicWrite(join(home, "installation.json"), JSON.stringify(record, null, 2) + "\n");
    return { ...runtime, version: pkg.version, command: binPath, home, auth: await authStatus(home) };
  } catch (error) {
    let recovery = "Managed files restored.";
    if (state?.localDaemon !== "running") {
      try {
        const created = await instanceState(paseoHome, root);
        if (created?.localDaemon === "running") {
          requireIdle(paseoHome, root);
          paseo(["daemon", "stop"], paseoHome, root);
        }
      } catch {
        recovery =
          "Managed files restored; could not verify cleanup of the newly started dedicated daemon. Check doctor/native status.";
      }
    }
    await restore(home, saved);
    if (state?.localDaemon === "running") {
      try {
        paseo(["daemon", "reload"], paseoHome, previousRoot);
        await reloadRegisteredPlugin(paseoHome, previousRoot);
        await verifyRuntime(paseoHome, previousRoot);
      } catch {
        recovery =
          "Managed files restored; live recovery could not be verified. Run doctor before continuing.";
      }
    }
    throw new Error(`${error.message}\n${recovery} Backup: ${saved.backup}`);
  }
}

export async function doctor(home) {
  const findings = [];
  let manifest;
  try {
    manifest = await loadManifest(home);
    for (const [id, profile] of Object.entries(manifest.profiles)) {
      await verifyProfile(profile);
      await access(profile.executable, constants.X_OK);
      findings.push({ check: id, ok: true, skills: profile.skillDirectories.length });
    }
  } catch (error) {
    findings.push({ check: "profiles", ok: false, error: error.message });
  }
  const auth = await authStatus(home);
  findings.push({ check: "codex-auth", ok: auth.ready !== false, ...auth });
  const record = await installation(home);
  const paseoHome = record?.paseoHome ?? join(homedir(), ".paseo-alliance-work");
  try {
    findings.push({
      check: "runtime",
      ok: true,
      ...(await verifyRuntime(paseoHome, record?.root ?? projectRoot)),
    });
  } catch (error) {
    findings.push({ check: "runtime", ok: false, error: error.message });
  }
  if (!record)
    findings.push({
      check: "installation",
      ok: false,
      error: "Run ./install.sh to register this checkout and its CLI.",
    });
  return { ok: findings.every((finding) => finding.ok), version: record?.version, home, findings };
}
