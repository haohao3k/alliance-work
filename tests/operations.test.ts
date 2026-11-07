import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
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

test("process identity holds incomparable legacy locale records until exit is observed", async () => {
  const identity = "Sat Nov 7 12:38:54 2026";
  const job = { pid: 123, processIdentity: identity };
  assert.equal((await observeJob(job, async () => identity)).state, "running");
  assert.equal((await observeJob(job, async () => "Sat Nov 7 12:38:55 2026")).state, "exited");
  const legacy = { ...job, processIdentity: "sam. 7 nov. 12:38:54 2026" };
  const held = await observeJob(legacy, async () => identity);
  assert.equal(held.state, "unknown", "A locale difference cannot prove that the recorded job exited");
  assert.match(held.observationError ?? "", /locale|reconcile/i);
  assert.equal(held.processIdentity, legacy.processIdentity, "Do not rebind a legacy job to a live PID");
  assert.equal((await observeJob(legacy, async () => null)).state, "exited");
});

test("process identity survives a macOS locale change without changing the caller locale", {
  skip: process.platform !== "darwin",
}, async () => {
  const run = promisify(execFile);
  const probe = async (locale: string, recorded?: string) => {
    const { stdout } = await run(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { processIdentity, observeJob } from './server/jobs.mjs';
      const pid = ${process.pid};
      console.log(JSON.stringify({
        identity: await processIdentity(pid),
        observed: ${recorded ? `await observeJob({pid, processIdentity:${JSON.stringify(recorded)}})` : "null"},
        locale: process.env.LC_ALL,
      }));
    `,
      ],
      {
        cwd: projectRoot,
        env: { ...process.env, LC_ALL: locale, LC_TIME: locale, LANG: locale },
      },
    );
    return JSON.parse(stdout);
  };
  const baseline = await probe("C");
  assert(baseline.identity);
  for (const locale of ["fr_FR.UTF-8", "vi_VN.UTF-8"]) {
    const next = await probe(locale, baseline.identity);
    assert.equal(next.identity, baseline.identity, `Same live PID under ${locale}`);
    assert.equal(next.observed.state, "running");
    assert.equal(next.locale, locale);
  }
  const missingPs = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { observeJob } from './server/jobs.mjs';
    console.log(JSON.stringify(await observeJob({pid:${process.pid},processIdentity:${JSON.stringify(baseline.identity)}})));
  `,
    ],
    { cwd: projectRoot, env: { ...process.env, PATH: "" } },
  );
  assert.equal(JSON.parse(missingPs.stdout).state, "unknown", "Missing ps is not evidence of process exit");
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
