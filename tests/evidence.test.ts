import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { runVerification, validateEvidence } from "../server/evidence.mjs";
import { temporary } from "./temp";

test("evidence binds the actual command, candidate, ignored inputs and artifacts; stale proof is refused", async () => {
  const root = await temporary("alliance-evidence-");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(join(cwd, "code.txt"), "works");
  await writeFile(join(cwd, ".gitignore"), ".env.local\n");
  await writeFile(join(cwd, ".env.local"), "fixture-only");
  const result = await runVerification({
    cwd,
    output: join(root, "proof"),
    command: [
      process.execPath,
      "-e",
      "if(require('fs').readFileSync('code.txt','utf8')!=='works')process.exit(1)",
    ],
    scenario: "actual-behavior",
    kind: "test",
    inputs: [".env.local"],
  });
  const report = await validateEvidence(result.path, cwd, result.report.candidate.digest);
  assert.equal(report.verdict, "PASS");
  await writeFile(join(cwd, ".env.local"), "changed");
  await assert.rejects(validateEvidence(result.path, cwd, report.candidate.digest), /changed|stale/i);
  await writeFile(join(cwd, ".env.local"), "fixture-only");
  await writeFile(join(cwd, "new-source.txt"), "untracked change");
  await assert.rejects(validateEvidence(result.path, cwd, report.candidate.digest), /changed|stale/i);
  await unlink(join(cwd, "new-source.txt"));
  await writeFile(report.artifacts[0].path, "altered output");
  await assert.rejects(validateEvidence(result.path, cwd, report.candidate.digest), /artifact changed/);
  const bad = await runVerification({
    cwd,
    output: join(root, "failed"),
    command: [process.execPath, "-e", "process.exit(1)"],
    scenario: "failing-check",
    kind: "test",
  });
  await assert.rejects(validateEvidence(bad.path, cwd, bad.report.candidate.digest), /PASS/);
  assert.equal(JSON.parse(await readFile(bad.path, "utf8")).verdict, "FAIL");
});

test("verification reports source mutations and blocked commands without claiming PASS; non-Git deliverables use explicit inputs", async () => {
  const root = await temporary("alliance-check-outcomes-");
  const cwd = join(root, "documents");
  await mkdir(cwd);
  await writeFile(join(cwd, "report.txt"), "first");
  const stale = await runVerification({
    cwd,
    inputs: ["report.txt"],
    output: join(root, "stale"),
    scenario: "document-check",
    command: [process.execPath, "-e", "require('fs').writeFileSync('report.txt','second')"],
  });
  assert.equal(stale.report.verdict, "STALE");
  const blocked = await runVerification({
    cwd,
    inputs: ["report.txt"],
    output: join(root, "blocked"),
    scenario: "missing-driver",
    command: [join(root, "missing-driver")],
  });
  assert.equal(blocked.report.verdict, "BLOCKED");
  const timedOut = await runVerification({
    cwd,
    inputs: ["report.txt"],
    output: join(root, "timeout"),
    scenario: "hung-check",
    command: [process.execPath, "-e", "setInterval(()=>{},1000)"],
    timeoutMs: 100,
  });
  assert.equal(timedOut.report.verdict, "BLOCKED");
  await assert.rejects(validateEvidence(timedOut.path, cwd, timedOut.report.candidate.digest), /PASS/);
  const passed = await runVerification({
    cwd,
    inputs: ["report.txt"],
    output: join(root, "passed"),
    scenario: "document-check",
    kind: "analysis",
    command: [
      process.execPath,
      "-e",
      "if(require('fs').readFileSync('report.txt','utf8')!=='second')process.exit(1)",
    ],
  });
  await validateEvidence(passed.path, cwd, passed.report.candidate.digest);
});
