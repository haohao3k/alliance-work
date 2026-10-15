import assert from "node:assert/strict";
import { cp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectCapabilities } from "../scripts/capabilities.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { observeJob } from "../server/jobs.mjs";
import { acceptanceLabel, ownerState } from "../shared/operations";
import { temporary } from "./temp";

test("process exit and PID reuse never claim completion or accept a job", async () => {
  const job = { pid: 123, processIdentity: "boot:100" };
  assert.equal((await observeJob(job, async () => "boot:100")).state, "running");
  assert.equal((await observeJob(job, async () => "boot:200")).state, "exited");
  assert.equal((await observeJob(job, async () => null)).state, "exited");
  assert.equal(
    (
      await observeJob(job, async () => {
        throw new Error("permission");
      })
    ).state,
    "unknown",
  );
  assert.equal(ownerState("gone", []).ownerStatus, "needs-owner");
  assert.equal(
    ownerState("a", [{ id: "a", title: "Lead", archived: true, status: "idle" }]).ownerStatus,
    "needs-owner",
  );
  assert.equal(acceptanceLabel({ decision: "accepted", kind: "analysis" }), "Accepted analysis");
  assert.equal(
    acceptanceLabel({ decision: "open", lastOutcome: "completed" }),
    "Turn finished · awaiting acceptance",
  );
});

test("capability checks reject missing coverage and modified pinned runtime bytes", async () => {
  const root = await temporary("alliance-capabilities-");
  for (const path of [
    "package.json",
    "package-lock.json",
    "paseo-plugin.json",
    "index.server.ts",
    "index.client.tsx",
    "scripts",
    "server",
    "shared",
    "client",
    "room",
    "vendor",
    ".alliance",
  ])
    await cp(join(projectRoot, path), join(root, path), { recursive: true });
  const baseline = await inspectCapabilities(root);
  assert.equal(baseline.ok, true);
  assert.equal((await inspectCapabilities(root, baseline.sourceDigest)).ok, true);
  await writeFile(join(root, "server/jobs.mjs"), "changed runtime");
  assert.equal((await inspectCapabilities(root, baseline.sourceDigest)).ok, false);
  await rm(join(root, "server/coverage.mjs"));
  assert.equal((await inspectCapabilities(root)).capabilities["feature-coverage"], false);
});
