import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runVerification, validateEvidence } from "../server/evidence.mjs";
import { runFeatureVerification } from "../server/feature-verification.mjs";
import { temporary } from "./temp";

async function fixture() {
  const root = await temporary("alliance-coverage-");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  const driver = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {check,skip}=await import(process.env.ALLIANCE_ASSERTION_HELPER);
const mode=await readFile('mode.txt','utf8');
if(mode==='missing')process.exit(0);
if(mode==='skip')skip('persisted','target unavailable');
else await check('persisted',()=>assert.equal(mode,'good'));
if(mode==='duplicate')await check('persisted',()=>{});
`;
  await writeFile(join(cwd, "driver.mjs"), driver);
  await writeFile(join(cwd, "mode.txt"), "good");
  const map = {
    version: 1,
    features: [
      {
        id: "persistence",
        title: "Persistence",
        entryPoint: "driver.mjs",
        preconditions: "fixture ready",
        behaviors: [{ id: "persist", expect: "The persisted value is read back correctly" }],
      },
      {
        id: "remote",
        title: "Remote access",
        entryPoint: "remote",
        preconditions: "remote host available",
        behaviors: [{ id: "remote-access", expect: "Reach the remote host" }],
      },
    ],
    scenarios: [
      {
        id: "save",
        command: ["$NODE", "driver.mjs"],
        assertions: [{ id: "persisted", behavior: "persist" }],
      },
    ],
  };
  await writeFile(join(cwd, "features.json"), JSON.stringify(map));
  return { root, cwd, map };
}

test("exit zero without executing the declared assertion is blocked", async () => {
  const f = await fixture();
  const result = await runVerification({
    cwd: f.cwd,
    output: join(f.root, "empty"),
    command: [process.execPath, "-e", "process.exit(0)"],
    scenario: "empty",
    assertionIds: ["persisted"],
  });
  assert.equal(result.report.verdict, "BLOCKED");
  await assert.rejects(validateEvidence(result.path, f.cwd, result.report.candidate.digest), /PASS/);
});

test("feature coverage binds executed assertions and explicit scope; missing and skipped checks never count", async () => {
  const f = await fixture();
  const verify = (name: string, features = ["persistence"]) =>
    runFeatureVerification({
      cwd: f.cwd,
      output: join(f.root, name),
      map: "features.json",
      features,
    });
  const good = await verify("good");
  assert.equal(good.report.verdict, "PASS");
  assert.equal(good.coverage?.covered, 1);
  assert.deepEqual(good.coverage?.excluded, ["remote"]);
  await validateEvidence(good.path, f.cwd, good.report.candidate.digest);
  const all = await verify("all", []);
  assert.equal(all.report.verdict, "BLOCKED");
  assert.equal(all.coverage?.total, 2);
  for (const [mode, verdict] of [
    ["missing", "BLOCKED"],
    ["skip", "BLOCKED"],
    ["bug", "FAIL"],
  ]) {
    await writeFile(join(f.cwd, "mode.txt"), mode);
    const result = await verify(mode);
    assert.equal(result.report.verdict, verdict);
    assert.equal(result.coverage?.covered, 0);
    await assert.rejects(validateEvidence(result.path, f.cwd, result.report.candidate.digest), /PASS/);
  }
});

test("coverage refuses stale maps, altered observation logs and undeclared assertions", async () => {
  const f = await fixture();
  const good = await runFeatureVerification({
    cwd: f.cwd,
    output: join(f.root, "proof"),
    map: "features.json",
    features: ["persistence"],
  });
  f.map.features[0].behaviors.push({ id: "cancel", expect: "Cancellation leaves the previous state" });
  await writeFile(join(f.cwd, "features.json"), JSON.stringify(f.map));
  await assert.rejects(validateEvidence(good.path, f.cwd, good.report.candidate.digest), /changed|stale/i);
  f.map.features[0].behaviors.pop();
  await writeFile(join(f.cwd, "features.json"), JSON.stringify(f.map));
  assert(good.report.coverage);
  const scenario = JSON.parse(await readFile(good.report.coverage.runs[0].report.path, "utf8"));
  await writeFile(scenario.assertions.log.path, "");
  await assert.rejects(validateEvidence(good.path, f.cwd, good.report.candidate.digest), /changed/);
  await writeFile(
    join(f.cwd, "driver.mjs"),
    `const {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);await check('undeclared',()=>{});`,
  );
  const bad = await runFeatureVerification({
    cwd: f.cwd,
    output: join(f.root, "bad"),
    map: "features.json",
    features: ["persistence"],
  });
  assert.equal(bad.report.verdict, "BLOCKED");
});

test("duplicate observations, false predicates and crashing scenarios cannot manufacture coverage; source mutation is stale", async () => {
  const f = await fixture();
  const programs = {
    duplicate: "await check('persisted',()=>{});await check('persisted',()=>{});",
    predicate: "await check('persisted',()=>false);",
    crash: "await check('persisted',()=>{});process.exit(1);",
    mutation:
      "await import('node:fs/promises').then(fs=>fs.writeFile('mode.txt','mutated'));await check('persisted',()=>{});",
  };
  for (const [mode, program] of Object.entries(programs)) {
    await writeFile(
      join(f.cwd, "driver.mjs"),
      `const {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);${program}`,
    );
    const result = await runFeatureVerification({
      cwd: f.cwd,
      output: join(f.root, mode),
      map: "features.json",
      features: ["persistence"],
    });
    assert.equal(
      result.report.verdict,
      mode === "duplicate" ? "BLOCKED" : mode === "mutation" ? "STALE" : "FAIL",
    );
    assert.equal(result.coverage?.covered, 0);
  }
});

test("timing out a feature suite stops its scenario process and retains a blocked report", {
  skip: process.platform === "win32",
}, async () => {
  const f = await fixture();
  const pidFile = join(f.root, "scenario.pid");
  await writeFile(
    join(f.cwd, "driver.mjs"),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`,
  );
  const result = await runFeatureVerification({
    cwd: f.cwd,
    output: join(f.root, "timeout"),
    map: "features.json",
    features: ["persistence"],
    timeoutMs: 1500,
  });
  assert.equal(result.report.verdict, "BLOCKED");
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
