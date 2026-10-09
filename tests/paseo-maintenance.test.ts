import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { test } from "node:test";
import { activate, installation } from "../scripts/maintenance.mjs";
import { instanceState, paseo, requireIdle, verifyRuntime } from "../scripts/paseo.mjs";
import { loadManifest, projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

test("native Paseo switches release roots and restores the previous plugin after failed activation", {
  skip: process.env.ALLIANCE_NATIVE_PASEO_TESTS !== "1",
  timeout: 120000,
}, async (t) => {
  const dir = await temporary("alliance-paseo-maintenance-");
  const home = join(dir, "home"),
    paseoHome = join(dir, "paseo");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  t.after(async () => {
    const state = await instanceState(paseoHome);
    if (state?.localDaemon === "running") {
      requireIdle(paseoHome);
      paseo(["daemon", "stop"], paseoHome);
    }
    await rm(dir, { recursive: true, force: true });
  });
  const options = {
    home,
    paseoHome,
    port,
    binDir: join(dir, "bin"),
    isolatedRoot: join(dir, "roles"),
    authFrom: undefined,
  };
  await activate(options);
  const candidate = join(dir, "release candidate");
  await cp(projectRoot, candidate, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", "dist"].includes(relative(projectRoot, path).split("/")[0]),
  });
  await symlink(join(projectRoot, "node_modules"), join(candidate, "node_modules"), "dir");
  const room = join(home, "rooms/preserved/assignment.md");
  await mkdir(join(home, "rooms/preserved"), { recursive: true });
  await writeFile(room, "Keep this assignment through release switches.");
  const auth = join((await loadManifest(home)).profiles["codex-lead"].home, "auth.json");
  await writeFile(auth, "private fixture", { mode: 0o600 });
  await activate({ ...options, root: candidate });
  const current = await installation(home);
  assert.equal(current.root, candidate);
  assert.equal(current.previous.root, projectRoot);
  await verifyRuntime(paseoHome, candidate);
  const broken = join(dir, "broken release");
  await cp(candidate, broken, {
    recursive: true,
    filter: (path) => relative(candidate, path) !== "node_modules",
  });
  await symlink(join(projectRoot, "node_modules"), join(broken, "node_modules"), "dir");
  await writeFile(join(broken, "index.server.ts"), 'throw new Error("activation fixture"); export {};\n');
  await assert.rejects(activate({ ...options, root: broken }), /Managed files restored/);
  assert.equal((await installation(home)).root, candidate);
  await verifyRuntime(paseoHome, candidate);
  assert.equal(await readFile(auth, "utf8"), "private fixture");
  assert.equal(await readFile(room, "utf8"), "Keep this assignment through release switches.");
});
