// This deterministic eval measures the check, not an LLM or skill's judgment.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runVerification } from "../server/evidence.mjs";

const { check } = await import(process.env.ALLIANCE_ASSERTION_HELPER);
const test = JSON.parse(await readFile(process.env.ALLIANCE_EVAL_CASE, "utf8"));
const cwd = join(process.env.ALLIANCE_EVAL_OUTPUT, "fixture");
await mkdir(cwd);
await writeFile(join(cwd, "input.txt"), "fixture");
const program =
  test.id === "valid"
    ? `const {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);await check('observed',()=>{});`
    : test.id === "skipped"
      ? `const {skip}=await import(process.env.ALLIANCE_ASSERTION_HELPER);skip('observed','target unavailable');`
      : "process.exit(0)";
// Baseline runs still emit records so that the measurement is comparable. Its
// verdict reproduces v0.1.6's command-only interpretation of those same results.
const result = await runVerification({
  cwd,
  inputs: ["input.txt"],
  output: join(process.env.ALLIANCE_EVAL_OUTPUT, "proof"),
  scenario: test.id,
  command: test.id === "unavailable" ? [join(cwd, "absent-driver")] : [process.execPath, "-e", program],
  assertionIds: ["observed"],
});
const verdict = test.variant === "baseline" && result.report.exitCode === 0 ? "PASS" : result.report.verdict;
console.log(
  JSON.stringify({
    case: test.id,
    variant: test.variant,
    verdict,
    observed: result.report.assertions.results,
  }),
);
await check("honest-verdict", () => assert.equal(verdict, test.id === "valid" ? "PASS" : "BLOCKED"));
