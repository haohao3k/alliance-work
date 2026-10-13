import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { assertNoLinks } from "../server/profile-integrity.mjs";
import { AssertionResults, readAssertions } from "./coverage.mjs";
import { inspectCoverage } from "./feature-verification.mjs";
import { projectSkills } from "./project-skills.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Artifact = z.object({ path: z.string().min(1), digest: Digest });
export const Evidence = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  createdAt: z.string(),
  candidate: z.object({
    cwd: z.string(),
    head: z.string().nullable(),
    digest: Digest,
    inputs: z.array(z.string()),
  }),
  assignment: z.string().nullable(),
  agentId: z.string().nullable(),
  verifier: z.object({ version: z.string(), host: z.string(), projectSkills: Digest }),
  kind: z.enum(["runtime", "test", "analysis"]),
  target: z.string().min(1),
  scenario: z.string().min(1),
  command: z.array(z.string()).min(1),
  commandCwd: z.string(),
  exitCode: z.number().int().nullable(),
  verdict: z.enum(["PASS", "FAIL", "BLOCKED", "STALE"]),
  error: z.string().nullable(),
  artifacts: z.array(Artifact).min(1),
  unverified: z.array(z.string()),
  assertions: z.object({ run: z.string().uuid(), log: Artifact, results: AssertionResults }).optional(),
  coverage: z
    .object({
      map: Artifact,
      features: z.array(z.string()).min(1),
      runs: z.array(z.object({ scenario: z.string(), report: Artifact })),
    })
    .optional(),
});

function within(root, path) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** @param {string} cwd @param {string[]} inputs */
export async function candidateSnapshot(cwd, inputs = []) {
  cwd = await realpath(cwd);
  const git = async (...args) => (await execute("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
  let root;
  try {
    root = (await git("rev-parse", "--show-toplevel")).trim();
  } catch {
    if (!inputs.length) throw new Error("For non-Git work, name the candidate files with --input FILE");
  }
  cwd = root ? await realpath(root) : cwd;
  const head = root
    ? await execute("git", ["rev-parse", "--verify", "HEAD"], { cwd })
        .then((r) => r.stdout.trim())
        .catch(() => null)
    : null;
  const listed = root
    ? (
        await execute("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
          cwd,
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout
        .split("\0")
        .filter(Boolean)
    : [];
  const extra = inputs.map((input) => {
    const path = resolve(cwd, input);
    if (!within(cwd, path)) throw new Error(`Verification input is outside the checkout: ${input}`);
    return relative(cwd, path);
  });
  const digest = createHash("sha256").update(JSON.stringify({ cwd, head }));
  for (const name of [...new Set([...listed, ...extra])].sort()) {
    const path = join(cwd, name);
    const stat = await lstat(path).catch((error) => {
      if (error.code === "ENOENT" && !extra.includes(name)) return null;
      throw error;
    });
    let content;
    if (!stat) content = "deleted";
    else if (stat.isSymbolicLink()) content = `link:${await readlink(path)}`;
    else if (stat.isFile()) content = `file:${stat.mode & 0o111}:${hash(await readFile(path))}`;
    else
      throw new Error(
        `Candidate contains a directory/submodule entry: ${name}; verify that checkout separately.`,
      );
    digest.update(JSON.stringify([name, content]));
  }
  return { cwd, head, digest: digest.digest("hex"), inputs: [...new Set(extra)].sort() };
}

export async function artifact(path) {
  path = resolve(path);
  await assertNoLinks(path);
  if (!(await lstat(path)).isFile()) throw new Error(`Evidence artifact is not a file: ${path}`);
  return { path, digest: hash(await readFile(path)) };
}

/** Run one owner-chosen check. Command success describes only that check's boundary.
 * @param {{cwd:string, output:string, command:string[], scenario:string, kind?:string, target?:string, inputs?:string[], artifacts?:string[], unverified?:string[], assignment?:string|null, agentId?:string|null, timeoutMs?:number, assertionIds?:string[], environment?:Record<string,string>, coverageFile?:string, signal?:AbortSignal}} options
 */
export async function runVerification({
  cwd,
  output,
  command,
  scenario,
  kind = "test",
  target = "",
  inputs = [],
  artifacts = [],
  unverified = [],
  assignment = null,
  agentId = null,
  timeoutMs = 600000,
  assertionIds,
  environment = {},
  coverageFile,
  signal,
}) {
  if (!command.length || !scenario?.trim()) throw new Error("A scenario and command are required");
  Evidence.shape.kind.parse(kind);
  const commandCwd = await realpath(cwd);
  const before = await candidateSnapshot(cwd, inputs);
  cwd = before.cwd;
  output = resolve(output);
  if (within(cwd, output)) throw new Error("Evidence output must be outside the candidate checkout");
  await assertNoLinks(output);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const assertionRun = randomUUID();
  const assertionLog = join(output, "assertions.jsonl");
  if (assertionIds) await writeFile(assertionLog, "", { flag: "wx", mode: 0o600 });
  const log = join(output, "command.log");
  const sink = (await open(log, "wx", 0o600)).createWriteStream();
  let error = null;
  let exitCode = null;
  try {
    exitCode = await new Promise((done) => {
      const child = spawn(command[0], command.slice(1), {
        cwd: commandCwd,
        env: {
          ...process.env,
          ...environment,
          ALLIANCE_ASSERTIONS: assertionIds ? assertionLog : "",
          ALLIANCE_ASSERTION_RUN: assertionIds ? assertionRun : "",
          ALLIANCE_ASSERTION_HELPER: new URL("./assertions.mjs", import.meta.url).href,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stop = (signal) => {
        if (!child.pid) return;
        try {
          process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal);
        } catch (failure) {
          if (failure.code !== "ESRCH") throw failure;
        }
      };
      const abort = () => {
        error = "Verification aborted";
        stop("SIGKILL");
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let force;
      const timeout = setTimeout(() => {
        error = "Verification command timed out";
        stop("SIGTERM");
        force = setTimeout(() => stop("SIGKILL"), 1000);
        force.unref();
      }, timeoutMs);
      timeout.unref();
      child.stdout.pipe(sink, { end: false });
      child.stderr.pipe(sink, { end: false });
      child.on("error", (failure) => {
        clearTimeout(timeout);
        error = failure.message;
      });
      child.on("close", (code, exitSignal) => {
        signal?.removeEventListener("abort", abort);
        clearTimeout(timeout);
        clearTimeout(force);
        if (exitSignal) error = `Command ended with ${exitSignal}`;
        done(code);
      });
    });
  } finally {
    sink.end();
    await finished(sink);
  }
  const after = await candidateSnapshot(cwd, inputs);
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const assertions = assertionIds
    ? {
        run: assertionRun,
        log: await artifact(assertionLog),
        results: await readAssertions(assertionLog, assertionRun, assertionIds),
      }
    : undefined;
  let coverage;
  let coverageState;
  if (coverageFile) {
    try {
      coverage = JSON.parse(await readFile(coverageFile, "utf8"));
      coverageState = await inspectCoverage(coverage, cwd, before.digest);
      artifacts.push(
        coverageFile,
        coverage.map.path,
        ...coverage.runs.map((r) => r.report.path),
        ...coverageState.artifacts,
      );
    } catch (failure) {
      error = `Coverage unavailable: ${failure.message}`;
    }
  }
  const report = Evidence.parse({
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    candidate: before,
    assignment,
    agentId,
    verifier: { version: pkg.version, host: hostname(), projectSkills: (await projectSkills(cwd)).digest },
    kind,
    target: target || cwd,
    scenario,
    command,
    commandCwd,
    exitCode,
    verdict: before.digest !== after.digest ? "STALE" : error ? "BLOCKED" : exitCode === 0 ? "PASS" : "FAIL",
    assertions,
    coverage,
    error,
    artifacts: await Promise.all([log, ...artifacts.map((path) => resolve(cwd, path))].map(artifact)),
    unverified,
  });
  if (report.verdict === "PASS" && assertions?.results.verdict !== undefined)
    report.verdict = assertions.results.verdict;
  if (report.verdict === "PASS" && coverageState?.verdict !== undefined)
    report.verdict = coverageState.verdict;
  const path = join(output, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { path, report };
}

export async function validateEvidence(path, cwd, candidate) {
  if (!isAbsolute(path))
    throw new Error("Evidence must be an absolute report.json path from alliance-work verify");
  await assertNoLinks(path);
  const report = Evidence.parse(JSON.parse(await readFile(path, "utf8")));
  if (report.verdict !== "PASS" || report.exitCode !== 0)
    throw new Error(
      "Acceptance needs a PASS verification report; record a rejection or resolve the failed/blocked check",
    );
  const current = await candidateSnapshot(cwd, report.candidate.inputs);
  if (
    report.candidate.cwd !== current.cwd ||
    report.candidate.digest !== candidate ||
    current.digest !== candidate
  )
    throw new Error("Candidate changed or evidence is stale/from another checkout; rerun the relevant check");
  if ((await projectSkills(cwd)).digest !== report.verifier.projectSkills)
    throw new Error("Project skills changed after verification; rerun the relevant check");
  for (const expected of report.artifacts) {
    if ((await artifact(expected.path)).digest !== expected.digest)
      throw new Error(`Evidence artifact changed: ${expected.path}`);
  }
  if (report.assertions) {
    const { run, log, results } = report.assertions;
    if ((await artifact(log.path)).digest !== log.digest) throw new Error("Assertion log changed");
    const actual = await readAssertions(log.path, run, results.expected);
    if (actual.verdict !== "PASS" || JSON.stringify(actual) !== JSON.stringify(results))
      throw new Error("Assertion coverage is incomplete or changed");
  }
  if (report.coverage) {
    const coverage = await inspectCoverage(report.coverage, cwd, candidate, true);
    if (coverage.verdict !== "PASS") throw new Error("Feature coverage is incomplete");
  }
  return report;
}
