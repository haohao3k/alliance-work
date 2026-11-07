import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Contribution,
  Contributor,
  IntegrationPlan,
  IntegrationProof,
  OutputPath,
} from "../shared/integration.mjs";
import { artifact, candidateCapture, Evidence } from "./evidence.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absent = (path) => ({ path, kind: "absent", digest: null, executable: false });
const equal = (a, b) => a.kind === b.kind && a.digest === b.digest && a.executable === b.executable;
const mode = (fingerprint) =>
  fingerprint.kind === "symlink" ? "120000" : fingerprint.executable ? "100755" : "100644";
const unique = (values, label) => {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
};
async function git(cwd, args, binary = false) {
  return (
    await execute("git", ["-c", "core.fsmonitor=false", "--no-replace-objects", ...args], {
      cwd,
      encoding: binary ? "buffer" : "utf8",
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
    })
  ).stdout;
}
async function commit(cwd, ref) {
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
}
async function ancestor(cwd, from, to) {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", from, to]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw new Error(`Cannot read integration commit ${from}: ${error.message}`);
  }
}
async function tree(cwd, head) {
  const entries = (await git(cwd, ["ls-tree", "-rz", "--full-tree", head])).split("\0").filter(Boolean);
  if (entries.length > 100000) throw new Error("Integration tree exceeds 100000 entries");
  return new Map(
    entries.map((entry) => {
      const at = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, at).split(" ");
      return [entry.slice(at + 1), { mode, type, oid }];
    }),
  );
}
const sameEntry = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;
const changed = (before, after) =>
  [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => !sameEntry(before.get(path), after.get(path)))
    .sort();

/** Scope is a declared base-to-candidate delta, derived from the exact snapshot the verification records. */
export async function contributionFor(captured, base) {
  const { candidate, files, gitFiles } = captured;
  if (!gitFiles) {
    if (base)
      throw new Error("--base requires a Git candidate; non-Git contributions use explicit --input files");
    return Contribution.parse({
      version: 1,
      source: "inputs",
      base: null,
      head: null,
      committed: false,
      outputs: [...files.values()].map((entry) => entry.fingerprint),
    });
  }
  if (!base) return undefined;
  if (!candidate.head) throw new Error("verify --base needs a committed Git HEAD");
  const resolved = await commit(candidate.cwd, base);
  if (!(await ancestor(candidate.cwd, resolved, candidate.head)))
    throw new Error("Verification base must be an ancestor of candidate HEAD");
  const [before, head] = await Promise.all([
    tree(candidate.cwd, resolved),
    tree(candidate.cwd, candidate.head),
  ]);
  const current = new Map(
    [...gitFiles].flatMap((path) => {
      const entry = files.get(path);
      return entry?.oid ? [[path, { oid: entry.oid, mode: mode(entry.fingerprint) }]] : [];
    }),
  );
  const paths = changed(before, current);
  return Contribution.parse({
    version: 1,
    source: "git",
    base: resolved,
    head: candidate.head,
    committed: changed(head, current).length === 0,
    outputs: paths.map((path) => files.get(path)?.fingerprint ?? absent(path)),
  });
}

function contributorsOf(contributors) {
  if (contributors.length > 128)
    throw new Error("Integration has more than 128 accepted contributors; split the outcome");
  const sorted = contributors
    .map((c) => Contributor.parse(c))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
  unique(
    sorted.map((c) => c.agentId),
    "contributor",
  );
  return sorted;
}

/** Includes the decision identity, even when a child is accepted again with identical candidate bytes. */
export function integrationStamp(contributors) {
  return hash(JSON.stringify(contributorsOf(contributors)));
}

async function readArtifact(path) {
  if (!isAbsolute(path)) throw new Error(`Integration evidence must use an absolute path: ${path}`);
  await assertNoLinks(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024)
    throw new Error(`Integration evidence is not a bounded file: ${path}`);
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes.toString()), artifact: { path, digest: hash(bytes) } };
}

async function sourceOf(contributor, artifacts) {
  const id = contributor.agentId;
  if (!contributor.decisionEvidence) throw new Error(`Accepted child ${id} has no disposition evidence`);
  if (contributor.decisionTurnId !== contributor.lastTurnId)
    throw new Error(`Child ${id} changed turn after its acceptance`);
  const saved = await readArtifact(contributor.decisionEvidence);
  const d = saved.value;
  if (
    d.agentId !== id ||
    d.decision !== "accepted" ||
    (contributor.decisionAt && d.at !== contributor.decisionAt)
  )
    throw new Error(`Child ${id} decision changed or differs from its disposition`);
  const report = Evidence.parse(d.verification);
  if (report.artifacts.length > 100)
    throw new Error(`Child ${id} has more than 100 evidence artifacts; split the contribution`);
  if (report.verdict !== "PASS" || report.exitCode !== 0 || d.candidate !== report.candidate.digest)
    throw new Error(`Child ${id} does not hold accepted PASS evidence`);
  const original = await readArtifact(d.evidence);
  if (JSON.stringify(Evidence.parse(original.value)) !== JSON.stringify(report))
    throw new Error(`Child ${id} verification report changed after acceptance`);
  artifacts.push(saved.artifact, original.artifact);
  for (const expected of [...report.artifacts, ...(report.assertions ? [report.assertions.log] : [])]) {
    if ((await artifact(expected.path)).digest !== expected.digest)
      throw new Error(`Child ${id} evidence artifact changed: ${expected.path}`);
    artifacts.push(expected);
  }
  return { contributor, report, at: Date.parse(d.at) };
}

async function committedOutput(cwd, head, path, entries) {
  const entry = entries.get(path);
  if (!entry) {
    if ([...entries.keys()].some((name) => name.startsWith(`${path}/`)))
      throw new Error(`Output ${path} became a directory at ${head}`);
    return absent(path);
  }
  if (entry.type !== "blob")
    throw new Error(`Output ${path} is a submodule; verify that checkout separately`);
  const bytes = await git(cwd, ["cat-file", "blob", entry.oid], true);
  return {
    path,
    kind: entry.mode === "120000" ? "symlink" : "file",
    digest: hash(bytes),
    executable: entry.mode === "100755",
  };
}

/** All current accepted children are supplied by the server, never selected by an integration plan.
 * @param {{report: import("zod").infer<typeof Evidence>, contributors: readonly unknown[], plan?:unknown}} options
 */
export async function buildIntegrationProof({ report, contributors, plan = undefined }) {
  const selected = contributorsOf(contributors);
  const proposed = IntegrationPlan.parse(plan ?? { version: 1 });
  unique(
    proposed.children.map((c) => c.agentId),
    "child mapping",
  );
  unique(
    proposed.supersessions.map((s) => `${s.agentId}\0${s.path}`),
    "output supersession",
  );
  if (!selected.length) {
    if (proposed.children.length || proposed.supersessions.length)
      throw new Error("Integration plan names no current accepted contributor");
    return undefined;
  }
  if (report.kind !== "runtime" || report.verdict !== "PASS" || report.exitCode !== 0)
    throw new Error("Integrated product acceptance requires runtime PASS evidence");
  const captured = await candidateCapture(report.candidate.cwd, report.candidate.inputs);
  if (
    captured.candidate.digest !== report.candidate.digest ||
    captured.candidate.cwd !== report.candidate.cwd
  )
    throw new Error("Integrated candidate changed or its proof is stale; rerun verify");
  const artifacts = [];
  const sources = [];
  for (const contributor of selected) sources.push(await sourceOf(contributor, artifacts));
  const ids = new Set(selected.map((s) => s.agentId));
  for (const child of proposed.children)
    if (!ids.has(child.agentId))
      throw new Error(`Integration plan names unknown accepted child ${child.agentId}`);
  const cwd = report.candidate.cwd;
  const heads = new Map();
  const readTree = async (head) => {
    if (!heads.has(head)) heads.set(head, await tree(cwd, head));
    return heads.get(head);
  };
  const outputs = new Map();
  for (const source of sources) {
    const { contributor, report: child } = source;
    const id = contributor.agentId;
    const chosen = proposed.children.find((c) => c.agentId === id);
    if (chosen && chosen.candidate !== child.candidate.digest)
      throw new Error(`Child ${id} candidate changed; refresh its integration mapping`);
    if (chosen?.method === "review") {
      if (
        child.kind !== "analysis" ||
        (child.contribution?.source === "git" && child.contribution.outputs.length)
      )
        throw new Error(
          `Child ${id}: review is for non-code analysis evidence; it cannot exclude recorded source changes`,
        );
      unique(
        chosen.artifacts.map((a) => a.path),
        "review artifact",
      );
      for (const expected of chosen.artifacts) {
        if (!child.artifacts.some((a) => a.path === expected.path && a.digest === expected.digest))
          throw new Error(`Child ${id} review artifact is not bound to its accepted report`);
      }
      continue;
    }
    const scope = child.contribution;
    if (!scope)
      throw new Error(
        `Child ${id} has a report without contribution scope; rerun verify --base BASE_SHA and accept it again (non-Git: explicit --input files)`,
      );
    if (!scope.outputs.length)
      throw new Error(
        `Child ${id} declares no file outputs; non-code analysis needs an explicit review contribution with evidence`,
      );
    unique(
      scope.outputs.map((o) => o.path),
      "contribution output",
    );
    const method = chosen?.method ?? "merge";
    if (method !== "files") {
      if (scope.source !== "git" || !scope.committed || !scope.head || !scope.base || !report.candidate.head)
        throw new Error(`Child ${id} needs an explicit files mapping for non-Git or uncommitted outputs`);
      if (scope.head !== child.candidate.head)
        throw new Error(`Child ${id} contribution HEAD differs from its report`);
      const [baseTree, sourceTree] = await Promise.all([readTree(scope.base), readTree(scope.head)]);
      if (!(await ancestor(cwd, scope.base, scope.head)))
        throw new Error(`Child ${id} contribution base is not an ancestor`);
      if (
        JSON.stringify(changed(baseTree, sourceTree)) !==
        JSON.stringify(scope.outputs.map((o) => o.path).sort())
      )
        throw new Error(`Child ${id} contribution scope differs from its source commits`);
      for (const output of scope.outputs)
        if (!equal(output, await committedOutput(cwd, scope.head, output.path, sourceTree)))
          throw new Error(`Child ${id} source output ${output.path} differs from its accepted fingerprint`);
      const landing = method === "merge" ? scope.head : chosen.landedHead;
      if (!(await ancestor(cwd, landing, report.candidate.head)))
        throw new Error(
          `Child ${id} landing is not an ancestor of the integrated HEAD; use an explicit squash/cherry-pick/files mapping`,
        );
    }
    const mapping = chosen?.paths ?? scope.outputs.map((o) => ({ source: o.path, target: o.path }));
    unique(
      mapping.map((m) => m.source),
      "mapped source path",
    );
    unique(
      mapping.map((m) => m.target),
      "mapped target path",
    );
    if (
      mapping.length !== scope.outputs.length ||
      scope.outputs.some((o) => !mapping.some((m) => m.source === o.path))
    )
      throw new Error(`Child ${id} mapping must cover every declared output exactly once`);
    for (const output of scope.outputs) {
      const target = OutputPath.parse(mapping.find((m) => m.source === output.path).target);
      if (method === "squash" || method === "cherry-pick") {
        const landed = await committedOutput(
          cwd,
          chosen.landedHead,
          target,
          await readTree(chosen.landedHead),
        );
        if (!equal(output, landed))
          throw new Error(
            `Child ${id} output ${output.path} differs at declared landed HEAD ${chosen.landedHead}`,
          );
      }
      outputs.set(`${id}\0${output.path}`, { source, output, target });
    }
  }
  const replaced = new Map();
  for (const replacement of proposed.supersessions) {
    const key = `${replacement.agentId}\0${replacement.path}`;
    const older = outputs.get(key);
    const newer = [...outputs.entries()].find(
      ([, value]) =>
        value.source.contributor.agentId === replacement.byAgentId && value.target === older?.target,
    );
    if (
      !older ||
      !newer ||
      older.source.report.candidate.digest !== replacement.candidate ||
      newer[1].source.report.candidate.digest !== replacement.byCandidate
    )
      throw new Error(
        `Invalid supersession of ${replacement.agentId}:${replacement.path}; it must name current contributors and the same output`,
      );
    if (!(newer[1].source.at > older.source.at))
      throw new Error("Supersession requires a strictly newer accepted contribution");
    replaced.set(key, newer[0]);
  }
  for (const [key, value] of outputs) {
    const seen = new Set([key]);
    let final = key;
    while (replaced.has(final)) {
      final = replaced.get(final);
      if (seen.has(final)) throw new Error("Cyclic output supersession");
      seen.add(final);
    }
    const expected = outputs.get(final).output;
    for (let parent = dirname(join(cwd, value.target)); parent !== cwd; parent = dirname(parent)) {
      const stat = await lstat(parent).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat?.isSymbolicLink()) throw new Error(`Integrated output ${value.target} traverses a symlink`);
    }
    const actual = captured.files.get(value.target)?.fingerprint;
    if (!actual && expected.kind !== "absent")
      throw new Error(
        `Integrated output ${value.target} is not in the runtime report's candidate; rerun verify with --input if it is ignored/non-Git`,
      );
    if (!actual && !captured.gitFiles)
      throw new Error(
        `Non-Git deletion ${value.target} has no captured input; use a Git candidate for deletion proof`,
      );
    if (!actual) {
      const present = await lstat(join(cwd, value.target)).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (present)
        throw new Error(
          `Integrated output ${value.target} still exists outside the runtime report's captured files`,
        );
    }
    if (!actual && [...captured.files.keys()].some((path) => path.startsWith(`${value.target}/`)))
      throw new Error(`Integrated output ${value.target} became a directory`);
    if (!equal(expected, actual ?? absent(value.target)))
      throw new Error(
        `Integrated output ${value.target} changed or is missing from accepted child ${value.source.contributor.agentId}`,
      );
  }
  const distinct = new Map();
  for (const item of artifacts) {
    if (distinct.has(item.path) && distinct.get(item.path).digest !== item.digest)
      throw new Error(`Evidence changed while reading: ${item.path}`);
    distinct.set(item.path, item);
  }
  return IntegrationProof.parse({
    version: 1,
    candidate: { cwd: report.candidate.cwd, head: report.candidate.head, digest: report.candidate.digest },
    contributors: selected,
    contributorsStamp: integrationStamp(selected),
    plan: proposed,
    artifacts: [...distinct.values()].sort((a, b) => a.path.localeCompare(b.path)),
  });
}

/** Recheck the frozen evidence and structural proof; callers also validate the parent runtime report and current child decision stamp. */
export async function validateIntegrationProof(value, report) {
  const proof = IntegrationProof.parse(value);
  if (
    proof.contributorsStamp !== integrationStamp(proof.contributors) ||
    proof.candidate.digest !== report.candidate.digest ||
    proof.candidate.cwd !== report.candidate.cwd ||
    proof.candidate.head !== report.candidate.head
  )
    throw new Error("Integration proof differs from its candidate or accepted child decisions");
  for (const expected of proof.artifacts)
    if ((await artifact(expected.path)).digest !== expected.digest)
      throw new Error(`Integration evidence artifact changed: ${expected.path}`);
  const again = await buildIntegrationProof({ report, contributors: proof.contributors, plan: proof.plan });
  if (JSON.stringify(again) !== JSON.stringify(proof))
    throw new Error("Integration proof changed; verify and accept the integrated candidate again");
}

// A bounded child keeps the caller's event loop synchronous while reusing the exact same candidate,
// artifact, scope and project-skill readers. No second hashing implementation can drift from verify.
const finalGuard = (sourceRoot) => `
import { readFileSync } from "node:fs";
import { artifact, candidateSnapshot } from ${JSON.stringify(pathToFileURL(join(sourceRoot, "server/evidence.mjs")).href)};
import { validateIntegrationProof } from ${JSON.stringify(pathToFileURL(join(sourceRoot, "server/integration.mjs")).href)};
import { projectSkills } from ${JSON.stringify(pathToFileURL(join(sourceRoot, "server/project-skills.mjs")).href)};
try {
  const { report, proof, extraArtifacts } = JSON.parse(readFileSync(0, "utf8"));
  if (proof) await validateIntegrationProof(proof, report);
  const candidate = await candidateSnapshot(report.candidate.cwd, report.candidate.inputs);
  if (JSON.stringify(candidate) !== JSON.stringify(report.candidate))
    throw new Error("Candidate changed before the decision commit; rerun verify");
  if ((await projectSkills(candidate.cwd)).digest !== report.verifier.projectSkills)
    throw new Error("Project skills changed before the decision commit; rerun verify");
  for (const expected of [...report.artifacts, ...(report.assertions ? [report.assertions.log] : []),
    ...(proof?.artifacts ?? []), ...extraArtifacts])
    if ((await artifact(expected.path)).digest !== expected.digest)
      throw new Error("Evidence artifact changed before the decision commit: " + expected.path);
} catch (error) {
  process.stderr.write(error.message + "\\n");
  process.exitCode = 1;
}
`;

/** Final check after the last native await, immediately before a synchronous decision commit.
 * Prevents in-process events interleaving with the reads; external writers still require a quiet checkout.
 * @param {import("zod").infer<typeof Evidence>} report
 * @param {import("zod").infer<typeof IntegrationProof>|undefined} proof
 * @param {{path:string,digest:string}[]} extraArtifacts
 * @param {string|undefined} sourceRoot The registered release root, required at runtime because Paseo bundles plugin code as CommonJS.
 */
export function validateIntegrationCurrentSync(report, proof, extraArtifacts, sourceRoot) {
  if (typeof sourceRoot !== "string" || !isAbsolute(sourceRoot))
    throw new Error("Final integration check requires the registered absolute release root");
  Evidence.parse(report);
  if (proof) IntegrationProof.parse(proof);
  if (extraArtifacts.length > 100) throw new Error("Too many final evidence receipts");
  const input = JSON.stringify({ report, proof, extraArtifacts });
  if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw new Error("Final integration proof exceeds 16 MiB");
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", finalGuard(sourceRoot)], {
      input,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 64 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Final integration integrity check failed: ${error.stderr?.trim() || error.message}`);
  }
}
