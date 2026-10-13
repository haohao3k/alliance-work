import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assertNoLinks } from "./profile-integrity.mjs";

export const Id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);
const Text = z.string().trim().min(1);
export const Command = z.array(Text).min(1);
export const Observation = z
  .object({
    run: z.string().uuid(),
    id: Id,
    status: z.enum(["PASS", "FAIL", "SKIP", "BLOCKED"]),
    detail: z.string(),
  })
  .strict();
export const AssertionResults = z.object({
  expected: z.array(Id).min(1),
  observed: z.array(Observation),
  missing: z.array(Id),
  error: z.string().nullable(),
  verdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
});
export const FeatureMap = z
  .object({
    version: z.literal(1),
    features: z
      .array(
        z
          .object({
            id: Id,
            title: Text,
            entryPoint: Text,
            preconditions: Text,
            behaviors: z.array(z.object({ id: Id, expect: Text }).strict()).min(1),
          })
          .strict(),
      )
      .min(1),
    scenarios: z.array(
      z
        .object({
          id: Id,
          command: Command,
          timeoutMs: z.number().int().positive().max(3600000).optional(),
          assertions: z.array(z.object({ id: Id, behavior: Id }).strict()).min(1),
        })
        .strict(),
    ),
  })
  .strict();

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
export async function projectFile(cwd, file) {
  cwd = await realpath(cwd);
  const path = resolve(cwd, file);
  const rel = relative(cwd, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`Expected a file inside the project: ${file}`);
  await assertNoLinks(path);
  return path;
}
export async function loadFeatureMap(cwd, file, selected = []) {
  const path = await projectFile(cwd, file);
  const bytes = await readFile(path);
  const map = FeatureMap.parse(JSON.parse(bytes));
  unique(
    map.features.map((f) => f.id),
    "feature id",
  );
  unique(
    map.scenarios.map((s) => s.id),
    "scenario id",
  );
  const behaviors = map.features.flatMap((f) => f.behaviors.map((b) => ({ ...b, feature: f.id })));
  unique(
    behaviors.map((b) => b.id),
    "behavior id",
  );
  for (const scenario of map.scenarios) {
    unique(
      scenario.assertions.map((a) => a.id),
      "assertion id within scenario",
    );
    for (const assertion of scenario.assertions)
      if (!behaviors.some((b) => b.id === assertion.behavior))
        throw new Error(`Unknown behavior ${assertion.behavior} in ${scenario.id}`);
  }
  unique(selected, "selected feature");
  for (const id of selected)
    if (!map.features.some((f) => f.id === id)) throw new Error(`Unknown selected feature: ${id}`);
  const features = selected.length ? selected : map.features.map((f) => f.id);
  const required = behaviors.filter((b) => features.includes(b.feature));
  const scenarios = map.scenarios.filter((s) =>
    s.assertions.some((a) => required.some((b) => b.id === a.behavior)),
  );
  return { path, digest: sha256(bytes), map, features, required, scenarios };
}

export async function readAssertions(path, run, expected) {
  unique(expected, "expected assertion");
  let observed = [],
    error = null;
  try {
    const text = await readFile(path, "utf8");
    if (text.length > 4 * 1024 * 1024) throw new Error("Assertion log exceeds 4 MiB");
    observed = text
      .split("\n")
      .filter(Boolean)
      .map((line) => Observation.parse(JSON.parse(line)));
    unique(
      observed.map((a) => a.id),
      "observed assertion",
    );
    if (observed.some((a) => a.run !== run || !expected.includes(a.id)))
      throw new Error("Assertion belongs to another run or is not declared");
  } catch (failure) {
    error = failure.message;
  }
  const missing = expected.filter((id) => !observed.some((a) => a.id === id));
  const verdict = error
    ? "BLOCKED"
    : observed.some((a) => a.status === "FAIL")
      ? "FAIL"
      : missing.length || observed.some((a) => a.status !== "PASS")
        ? "BLOCKED"
        : "PASS";
  return AssertionResults.parse({ expected, observed, missing, error, verdict });
}
