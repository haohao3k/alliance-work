import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { Command, Id, projectFile, readAssertions, unique } from "./coverage.mjs";
import { artifact, candidateSnapshot, Evidence, runVerification } from "./evidence.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";
import { projectRootFor } from "./project-skills.mjs";

const Text = z.string().trim().min(1);
const Variant = z
  .object({
    command: Command,
    label: Text,
    model: Text.optional(),
    effort: Text.optional(),
  })
  .strict();
export const EvalSuite = z
  .object({
    version: z.literal(1),
    id: Id,
    failure: z.object({ summary: Text, evidence: z.array(Text).min(1) }).strict(),
    change: z
      .object({
        layer: z.enum(["architecture", "check", "tool", "skill"]),
        description: Text,
        files: z.array(Text).min(1),
      })
      .strict(),
    variants: z.object({ baseline: Variant, candidate: Variant }).strict(),
    cases: z
      .array(
        z
          .object({
            id: Id,
            kind: z.enum(["regression", "holdout", "non-trigger", "blocked"]),
            prompt: Text,
            assertions: z.array(Id).min(1),
          })
          .strict(),
      )
      .min(1),
    repetitions: z.number().int().min(1).max(10).default(1),
    timeoutMs: z.number().int().positive().max(3600000).default(600000),
  })
  .strict();

function comparison(suite, runs) {
  const fixes = [],
    regressions = [],
    unresolved = [],
    blocked = [];
  for (const test of suite.cases)
    for (let trial = 0; trial < suite.repetitions; trial++) {
      const before = runs.find((r) => r.case === test.id && r.trial === trial && r.variant === "baseline");
      const after = runs.find((r) => r.case === test.id && r.trial === trial && r.variant === "candidate");
      const id = `${test.id}#${trial + 1}`;
      if (before.verdict === "PASS" && after.verdict !== "PASS") regressions.push(id);
      if (before.verdict === "FAIL" && after.verdict === "PASS") fixes.push(id);
      if ([before.verdict, after.verdict].some((v) => ["BLOCKED", "STALE"].includes(v))) blocked.push(id);
      if (after.verdict === "FAIL") unresolved.push(id);
    }
  const outcome = regressions.length
    ? "REGRESSED"
    : blocked.length
      ? "INCONCLUSIVE"
      : unresolved.length
        ? "NEEDS_WORK"
        : fixes.length
          ? "IMPROVED"
          : "NO_CHANGE";
  return {
    outcome,
    fixes,
    regressions,
    unresolved,
    blocked,
    recommendation:
      outcome === "IMPROVED"
        ? "Consider keeping the change within this evaluated scope"
        : outcome === "NO_CHANGE"
          ? "No measured benefit; review whether this change is needed"
          : "Revise the change or resolve blocked cases before drawing a conclusion",
    limitations: [
      ...(!suite.cases.some((c) => c.kind === "holdout") ? ["No held-out case was evaluated"] : []),
      ...(!suite.cases.some((c) => c.kind === "non-trigger") ? ["No non-trigger case was evaluated"] : []),
      ...(suite.repetitions === 1
        ? ["One trial per case; this is not a statistical reliability estimate"]
        : []),
      "The driver and assertions define what was measured; model metadata is supplied by the owner",
    ],
  };
}

export async function runFailureEval({ cwd, suite: file, output }) {
  cwd = await projectRootFor(cwd);
  const suitePath = await projectFile(cwd, file);
  const suite = EvalSuite.parse(JSON.parse(await readFile(suitePath, "utf8")));
  unique(
    suite.cases.map((c) => c.id),
    "eval case",
  );
  for (const c of suite.cases) unique(c.assertions, "case assertion");
  output = resolve(output);
  const rel = relative(cwd, output);
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)))
    throw new Error("Eval output must be outside the candidate checkout");
  await assertNoLinks(output);
  // A fresh directory prevents accidental mixing with an older experiment.
  await mkdir(output, { recursive: false, mode: 0o700 });
  const inputs = [relative(cwd, suitePath)];
  for (const file of suite.change.files) inputs.push(relative(cwd, await projectFile(cwd, file)));
  const before = await candidateSnapshot(cwd, inputs);
  const sources = await Promise.all(suite.failure.evidence.map((file) => artifact(resolve(cwd, file))));
  const runs = [];
  for (const test of suite.cases)
    for (let trial = 0; trial < suite.repetitions; trial++) {
      // Alternate order to reduce a consistent warm-cache/order advantage.
      const variants = trial % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
      for (const variant of variants) {
        const dir = join(output, `${test.id}-${trial}-${variant}`);
        const input = join(output, `${test.id}-${trial}-${variant}.json`);
        await writeFile(
          input,
          JSON.stringify({
            ...test,
            variant,
            trial,
            change: suite.change,
            configuration: suite.variants[variant],
          }),
          { flag: "wx", mode: 0o600 },
        );
        const start = Date.now();
        const result = await runVerification({
          cwd,
          output: dir,
          inputs,
          scenario: `${suite.id}.${test.id}.${variant}`,
          kind: "test",
          command: suite.variants[variant].command.map((arg) => (arg === "$NODE" ? process.execPath : arg)),
          artifacts: [input],
          assertionIds: test.assertions,
          timeoutMs: suite.timeoutMs,
          environment: {
            ALLIANCE_EVAL_CASE: input,
            ALLIANCE_EVAL_VARIANT: variant,
            ALLIANCE_EVAL_OUTPUT: dir,
          },
        });
        runs.push({
          case: test.id,
          kind: test.kind,
          trial,
          variant,
          verdict: result.report.verdict,
          elapsedMs: Date.now() - start,
          report: await artifact(result.path),
        });
      }
    }
  const after = await candidateSnapshot(cwd, inputs);
  let stale = before.digest !== after.digest || runs.some((r) => r.verdict === "STALE");
  for (const source of sources) if ((await artifact(source.path)).digest !== source.digest) stale = true;
  const summary = comparison(suite, runs);
  if (stale) {
    summary.outcome = "INCONCLUSIVE";
    summary.recommendation = "Inputs changed during evaluation; rerun on a stable candidate";
  }
  const report = {
    version: 1,
    type: "failure-eval",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    candidate: before,
    suiteSource: await artifact(suitePath),
    suite,
    sources,
    runs,
    stale,
    summary,
  };
  const path = join(output, "eval.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { path, report };
}

export async function inspectFailureEval(path, cwd) {
  await assertNoLinks(path);
  const report = JSON.parse(await readFile(path, "utf8"));
  if (report.version !== 1 || report.type !== "failure-eval") throw new Error("Unknown failure eval report");
  const suite = EvalSuite.parse(report.suite);
  if (!report.suiteSource || (await artifact(report.suiteSource.path)).digest !== report.suiteSource.digest)
    throw new Error("Eval suite changed");
  const original = EvalSuite.parse(JSON.parse(await readFile(report.suiteSource.path, "utf8")));
  if (JSON.stringify(original) !== JSON.stringify(suite)) throw new Error("Eval suite identity changed");
  const sources = await Promise.all(
    suite.failure.evidence.map((file) => artifact(resolve(report.candidate.cwd, file))),
  );
  if (JSON.stringify(sources) !== JSON.stringify(report.sources)) throw new Error("Failure evidence changed");
  const current = await candidateSnapshot(cwd, report.candidate.inputs);
  if (report.stale || current.cwd !== report.candidate.cwd || current.digest !== report.candidate.digest)
    throw new Error("Eval candidate changed or run was stale");
  for (const source of report.sources)
    if ((await artifact(source.path)).digest !== source.digest) throw new Error("Failure evidence changed");
  const expected = suite.cases
    .flatMap((c) =>
      Array.from({ length: suite.repetitions }, (_, i) =>
        ["baseline", "candidate"].map((v) => `${c.id}:${i}:${v}`),
      ),
    )
    .flat();
  const actual = report.runs.map((r) => `${r.case}:${r.trial}:${r.variant}`);
  unique(actual, "eval run");
  if (actual.length !== expected.length || expected.some((id) => !actual.includes(id)))
    throw new Error("Eval run set is incomplete");
  for (const run of report.runs) {
    if ((await artifact(run.report.path)).digest !== run.report.digest)
      throw new Error("Eval run report changed");
    const proof = Evidence.parse(JSON.parse(await readFile(run.report.path, "utf8")));
    if (proof.candidate.digest !== current.digest || proof.verdict !== run.verdict)
      throw new Error("Eval run identity changed");
    const assertions = proof.assertions;
    const test = suite.cases.find((c) => c.id === run.case);
    const command = suite.variants[run.variant].command.map((arg) =>
      arg === "$NODE" ? process.execPath : arg,
    );
    if (
      JSON.stringify(command) !== JSON.stringify(proof.command) ||
      proof.scenario !== `${suite.id}.${test.id}.${run.variant}` ||
      run.kind !== test.kind
    )
      throw new Error("Eval case or command identity changed");
    if (!assertions || JSON.stringify(assertions.results.expected) !== JSON.stringify(test.assertions))
      throw new Error("Eval assertion contract changed");
    for (const item of [...proof.artifacts, assertions.log])
      if ((await artifact(item.path)).digest !== item.digest) throw new Error("Eval artifact changed");
    if (
      JSON.stringify(await readAssertions(assertions.log.path, assertions.run, test.assertions)) !==
      JSON.stringify(assertions.results)
    )
      throw new Error("Eval observations changed");
  }
  if (JSON.stringify(comparison(suite, report.runs)) !== JSON.stringify(report.summary))
    throw new Error("Eval summary changed");
  return report;
}
