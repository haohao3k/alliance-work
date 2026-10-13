import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { inspectFailureEval, runFailureEval } from "../server/failure-evals.mjs";
import { temporary } from "./temp";

async function fixture() {
  const root = await temporary("alliance-failure-eval-");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(
    join(cwd, "failure.log"),
    "Observed: healthy HTTP caused a false claim that login worked.\n",
  );
  await writeFile(join(cwd, "lesson.md"), "Distinguish HTTP health from verified user login.\n");
  await writeFile(
    join(cwd, "driver.mjs"),
    `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);
const c=JSON.parse(await readFile(process.env.ALLIANCE_EVAL_CASE,'utf8'));
const mode=process.argv[2];
if(mode==='blocked')process.exit(0);
// A deterministic regression fixture, not a model-quality measurement.
const claimsLogin = c.kind==='regression' && mode==='baseline';
await check('honest',()=>assert.equal(claimsLogin,false));
if(mode==='overfit' && c.kind==='holdout')throw new Error('held-out regression');
`,
  );
  const suite = {
    version: 1,
    id: "honest-proof",
    failure: { summary: "HTTP health was overstated as working login", evidence: ["failure.log"] },
    change: { layer: "skill", description: "Teach proof boundaries", files: ["lesson.md"] },
    variants: {
      baseline: { label: "Before", command: ["$NODE", "driver.mjs", "baseline"] },
      candidate: { label: "After", command: ["$NODE", "driver.mjs", "candidate"] },
    },
    cases: [
      { id: "original", kind: "regression", prompt: "Does HTTP 200 prove login?", assertions: ["honest"] },
      {
        id: "held-out",
        kind: "holdout",
        prompt: "Does a rendered login form prove tenant switching?",
        assertions: ["honest"],
      },
      { id: "unrelated", kind: "non-trigger", prompt: "Rename a label", assertions: ["honest"] },
    ],
  };
  await writeFile(join(cwd, "eval.json"), JSON.stringify(suite));
  return { root, cwd, suite };
}

test("failure eval compares the same cases and retains evidence without auto-installing a lesson", async () => {
  const f = await fixture();
  const result = await runFailureEval({ cwd: f.cwd, suite: "eval.json", output: join(f.root, "eval") });
  assert.equal(result.report.summary.outcome, "IMPROVED");
  assert.deepEqual(result.report.summary.fixes, ["original#1"]);
  assert.equal(result.report.runs.length, 6);
  await inspectFailureEval(result.path, f.cwd);
  await assert.rejects(readFile(join(f.cwd, ".alliance/skills.json")), /ENOENT/);
  await writeFile(join(f.cwd, "lesson.md"), "modified lesson");
  await assert.rejects(inspectFailureEval(result.path, f.cwd), /changed|stale/);
});

test("failure eval exposes held-out regressions and blocked runs instead of claiming improvement", async () => {
  const f = await fixture();
  for (const [mode, outcome] of [
    ["overfit", "REGRESSED"],
    ["blocked", "REGRESSED"],
  ]) {
    f.suite.variants.candidate.command[2] = mode;
    await writeFile(join(f.cwd, "eval.json"), JSON.stringify(f.suite));
    const result = await runFailureEval({ cwd: f.cwd, suite: "eval.json", output: join(f.root, mode) });
    assert.equal(result.report.summary.outcome, outcome);
    assert(result.report.summary.regressions.includes("held-out#1"));
    if (mode === "blocked") assert(result.report.summary.blocked.length);
    await inspectFailureEval(result.path, f.cwd);
  }
  f.suite.variants.baseline.command[2] = "blocked";
  f.suite.variants.candidate.command[2] = "candidate";
  await writeFile(join(f.cwd, "eval.json"), JSON.stringify(f.suite));
  const result = await runFailureEval({
    cwd: f.cwd,
    suite: "eval.json",
    output: join(f.root, "blocked-baseline"),
  });
  assert.equal(result.report.summary.outcome, "INCONCLUSIVE");
  assert.equal(result.report.summary.fixes.length, 0);
});

test("eval inspection rejects changed suite identity and altered raw model/check evidence", async () => {
  const f = await fixture();
  const result = await runFailureEval({ cwd: f.cwd, suite: "eval.json", output: join(f.root, "eval") });
  const changed = structuredClone(result.report);
  changed.suite.variants.candidate.label = "A different model was measured";
  await writeFile(result.path, JSON.stringify(changed));
  await assert.rejects(inspectFailureEval(result.path, f.cwd), /suite identity changed/);
  await writeFile(result.path, JSON.stringify(result.report));
  const first = JSON.parse(await readFile(result.report.runs[0].report.path, "utf8"));
  await writeFile(first.artifacts[0].path, "fabricated response");
  await assert.rejects(inspectFailureEval(result.path, f.cwd), /artifact changed/);
});
