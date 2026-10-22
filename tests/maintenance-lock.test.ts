import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { withMaintenance } from "../scripts/maintenance.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { bootTime, LOCK, lockState, takeLock } from "../server/maintenance-lock.mjs";
import { temporary } from "./temp";

const deadPid = () => {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
};

test("a lock left by a dead process, a reboot or an unwritten owner is stale and can be taken", async () => {
  const home = await temporary("alliance-lock-");
  const path = join(home, LOCK);
  await mkdir(path);
  const write = (owner: object) => writeFile(join(path, "owner.json"), JSON.stringify(owner));
  await write({ pid: process.pid, host: hostname(), boot: bootTime(), started: "a" });
  assert.equal((await lockState(home)).held, true, "a live owner holds it");
  await assert.rejects(takeLock(home), /Another maintenance operation/);
  await write({ pid: deadPid(), host: hostname(), boot: bootTime(), started: "b" });
  assert.equal((await lockState(home)).stale, true, "a dead owner does not");
  await write({ pid: process.pid, host: hostname(), boot: bootTime() - 3600, started: "c" });
  assert.equal((await lockState(home)).stale, true, "a pid from before a reboot does not");
  await takeLock(home);
  assert.equal((await lockState(home)).held, true, "the new taker holds a fresh lock");
});

test("a lock directory without an owner record is held briefly, then stale", async () => {
  const home = await temporary("alliance-lock-empty-");
  const path = join(home, LOCK);
  await mkdir(path);
  assert.equal((await lockState(home)).held, true);
  const old = new Date(Date.now() - 120000);
  await utimes(path, old, old);
  assert.equal((await lockState(home)).stale, true);
});

test("one maintenance command runs per home; a waiting one pauses nothing and, interrupted, removes only its own locks", async (t) => {
  const home = await temporary("alliance-lock-waiting-");
  const cleaned = join(home, "cleaned");
  const module = pathToFileURL(join(projectRoot, "scripts/maintenance.mjs")).href;
  // A command that waits for idleness the way update --wait-idle does.
  const waiting = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { writeFileSync } from "node:fs";
import { onInterrupt, withMaintenance } from ${JSON.stringify(module)};
onInterrupt.add(() => writeFileSync(${JSON.stringify(cleaned)}, "yes"));
await withMaintenance(${JSON.stringify(home)}, () => {
  setInterval(() => {}, 1000);
  console.log("waiting");
  return new Promise(() => {});
}, { pause: false });`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => waiting.kill("SIGKILL"));
  const started = await new Promise<boolean>((resolve) => {
    waiting.stdout.once("data", () => resolve(true));
    waiting.once("exit", () => resolve(false));
  });
  assert(started, "the waiting command started");
  assert.equal((await lockState(home)).held, false, "scheduled prompts keep running while it waits");
  await assert.rejects(
    withMaintenance(home, async () => {}),
    /Another maintenance operation/,
  );
  // An older release's command knows only the scheduler pause and takes it meanwhile.
  await takeLock(home);
  await writeFile(
    join(home, LOCK, "owner.json"),
    JSON.stringify({ pid: process.pid, host: hostname(), boot: bootTime(), started: "older" }),
  );
  const exited = once(waiting, "exit");
  waiting.kill("SIGINT");
  await exited;
  assert.equal(await readFile(cleaned, "utf8"), "yes", "its own cleanup ran");
  assert.equal((await lockState(home)).owner?.started, "older", "the older command's pause survives");
  // While that older command runs, a new one is refused and leaves nothing of its own behind.
  await assert.rejects(
    withMaintenance(home, async () => {}),
    /Another maintenance operation/,
  );
  assert.deepEqual(
    (await readdir(home)).filter((name) => name.startsWith(".maintenance")),
    [LOCK],
  );
});
