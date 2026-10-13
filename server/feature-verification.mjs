import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeatureMap } from "./coverage.mjs";
import { artifact, Evidence, runVerification, validateEvidence } from "./evidence.mjs";
import { projectRootFor } from "./project-skills.mjs";

export async function inspectCoverage(coverage, cwd, candidate, accepting = false) {
  const loaded = await loadFeatureMap(cwd, coverage.map.path, coverage.features);
  if (loaded.digest !== coverage.map.digest) throw new Error("Feature map changed");
  const ids = coverage.runs.map((r) => r.scenario);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== loaded.scenarios.length ||
    loaded.scenarios.some((s) => !ids.includes(s.id))
  )
    throw new Error("Coverage scenario set does not match map");
  const proved = new Set(),
    artifacts = [];
  let failed = false,
    blocked = false;
  for (const run of coverage.runs) {
    if ((await artifact(run.report.path)).digest !== run.report.digest)
      throw new Error("Scenario report changed");
    const report = Evidence.parse(JSON.parse(await readFile(run.report.path, "utf8")));
    const scenario = loaded.scenarios.find((s) => s.id === run.scenario);
    if (report.candidate.digest !== candidate || report.candidate.cwd !== cwd)
      throw new Error("Scenario candidate differs from coverage candidate");
    if (
      report.coverage ||
      !report.assertions ||
      JSON.stringify(report.assertions.results.expected) !==
        JSON.stringify(scenario.assertions.map((a) => a.id))
    )
      throw new Error("Scenario assertion contract differs from feature map");
    if (accepting) await validateEvidence(run.report.path, cwd, candidate);
    artifacts.push(report.assertions.log.path, ...report.artifacts.map((a) => a.path));
    if (report.verdict === "FAIL") failed = true;
    if (report.verdict !== "PASS") blocked = true;
    // Only successful runs count: a passing assertion before a crash isn't a
    // completed scenario. All assertions mapped to a behavior must have passed.
    if (report.verdict === "PASS") {
      for (const binding of scenario.assertions) {
        const bindings = scenario.assertions.filter((a) => a.behavior === binding.behavior);
        if (
          bindings.every((a) =>
            report.assertions.results.observed.some((o) => o.id === a.id && o.status === "PASS"),
          )
        )
          proved.add(binding.behavior);
      }
    }
  }
  const behaviors = loaded.required.map((b) => ({ ...b, status: proved.has(b.id) ? "PASS" : "UNCOVERED" }));
  const covered = behaviors.filter((b) => b.status === "PASS").length;
  return {
    verdict: failed ? "FAIL" : blocked || covered !== behaviors.length ? "BLOCKED" : "PASS",
    selected: loaded.features,
    excluded: loaded.map.features.filter((f) => !loaded.features.includes(f.id)).map((f) => f.id),
    covered,
    total: behaviors.length,
    behaviors,
    artifacts: [...new Set(artifacts)],
  };
}

export async function runFeatureVerification(options) {
  const cwd = await projectRootFor(options.cwd);
  const loaded = await loadFeatureMap(cwd, options.map, options.features ?? []);
  const coverageFile = join(options.output, "coverage.json");
  const result = await runVerification({
    ...options,
    cwd,
    scenario: options.scenario ?? "feature-map",
    kind: options.kind ?? "test",
    inputs: [...new Set([...(options.inputs ?? []), relative(cwd, loaded.path)])],
    command: [
      process.execPath,
      fileURLToPath(new URL("../scripts/feature-runner.mjs", import.meta.url)),
      loaded.path,
      JSON.stringify(loaded.features),
      coverageFile,
      JSON.stringify(options.inputs ?? []),
      options.kind ?? "test",
      options.target ?? cwd,
    ],
    coverageFile,
  });
  return {
    ...result,
    coverage: result.report.coverage
      ? await inspectCoverage(result.report.coverage, cwd, result.report.candidate.digest).catch(() => null)
      : null,
  };
}
