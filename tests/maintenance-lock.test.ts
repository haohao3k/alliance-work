import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
