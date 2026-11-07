import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { runVerification, validateEvidence } from "../server/evidence.mjs";
import { runFeatureVerification } from "../server/feature-verification.mjs";
import { temporary } from "./temp";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url).href);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function fixture() {
  const root = await temporary("alliance-integration-");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  git(cwd, "init", "-q");
  await writeFile(join(cwd, "app.txt"), "base\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  let n = 0;
  const verify = (options: Record<string, unknown> = {}) =>
    runVerification({
      cwd,
      output: join(root, `proof-${++n}`),
      command: [process.execPath, "-e", "require('fs').readFileSync('app.txt')"],
      scenario: "read the deliverable",
      kind: "runtime",
      ...options,
    });
  const change = async (value: string) => {
    await writeFile(join(cwd, "app.txt"), `${value}\n`);
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", value);
    return git(cwd, "rev-parse", "HEAD");
  };
  const accepted = async (agentId: string, proof: Awaited<ReturnType<typeof verify>>) => {
    const decisionAt = new Date(1700000000000 + ++n * 1000).toISOString();
    const decisionEvidence = join(root, `${agentId}-${n}.json`);
    await writeFile(
      decisionEvidence,
      JSON.stringify({
        agentId,
        decision: "accepted",
        at: decisionAt,
        candidate: proof.report.candidate.digest,
        evidence: proof.path,
        verification: proof.report,
      }),
    );
    return {
      agentId,
      decisionEvidence,
      decisionAt,
      decisionTurnId: "turn-1",
      lastTurnId: "turn-1",
      parentId: "lead",
      ownerId: "lead",
    };
  };
  return { root, cwd, base, verify, change, accepted };
}

test("a contribution records the reviewed base and exact outputs, including deletes and loose files", async () => {
  const f = await fixture();
  await writeFile(join(f.cwd, "added.txt"), "new output");
  await rm(join(f.cwd, "app.txt"));
  const proof = await f.verify({ base: f.base, command: [process.execPath, "-e", "process.exit(0)"] });
  assert(proof.report.contribution, "a scoped report is needed to detect omitted accepted work");
  assert.equal(proof.report.contribution.base, f.base);
  assert.equal(proof.report.contribution.committed, false);
  assert.deepEqual(
    proof.report.contribution.outputs.map((o: { path: string; kind: string }) => [o.path, o.kind]),
    [
      ["added.txt", "file"],
      ["app.txt", "absent"],
    ],
  );
});

test("merged work remains bound to accepted outputs; missing commits and later overwrites are refused", async () => {
  const { buildIntegrationProof, validateIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  await f.change("accepted");
  const child = await f.verify({ base: f.base });
  const source = await f.accepted("peer", child);
  const parent = await f.verify();
  const proof = await buildIntegrationProof({ report: parent.report, contributors: [source] });
  assert(proof);
  await validateIntegrationProof(proof, parent.report);
  await f.change("overwritten");
  await assert.rejects(validateIntegrationProof(proof, parent.report), /candidate changed|stale/i);
  const changed = await f.verify();
  await assert.rejects(
    buildIntegrationProof({ report: changed.report, contributors: [source] }),
    /output.*app.txt|app.txt.*changed/i,
  );
  git(f.cwd, "checkout", "-q", "--detach", f.base);
  const missing = await f.verify();
  await assert.rejects(
    buildIntegrationProof({ report: missing.report, contributors: [source] }),
    /ancestor|not integrated/i,
  );
});

test("a legacy child report needs explicit contribution scope while no-child and technical proof remain usable", async () => {
  const { buildIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  const legacy = await f.verify();
  const source = await f.accepted("peer", legacy);
  assert.equal(await buildIntegrationProof({ report: legacy.report, contributors: [] }), undefined);
  await assert.rejects(
    buildIntegrationProof({ report: legacy.report, contributors: [source] }),
    /peer.*verify --base|verify --base.*peer/i,
  );
  assert.equal(JSON.parse(await readFile(legacy.path, "utf8")).verdict, "PASS");
});

test("the final synchronous guard rejects candidate and frozen artifact changes after async review", async () => {
  const { buildIntegrationProof, validateIntegrationCurrentSync } = await import("../server/integration.mjs");
  const { artifact } = await import("../server/evidence.mjs");
  const f = await fixture();
  await f.change("accepted");
  const child = await f.verify({ base: f.base });
  const source = await f.accepted("peer", child);
  const parent = await f.verify();
  const proof = await buildIntegrationProof({ report: parent.report, contributors: [source] });
  const receipt = await artifact(parent.path);
  assert.equal(validateIntegrationCurrentSync(parent.report, proof, [receipt], sourceRoot), undefined);
  await writeFile(join(f.cwd, "app.txt"), "changed after native readback\n");
  assert.throws(
    () => validateIntegrationCurrentSync(parent.report, proof, [receipt], sourceRoot),
    /candidate|changed/i,
  );
  await writeFile(join(f.cwd, "app.txt"), "accepted\n");
  await writeFile(parent.path, "{}");
  assert.throws(
    () => validateIntegrationCurrentSync(parent.report, proof, [receipt], sourceRoot),
    /artifact|changed/i,
  );
  await writeFile(parent.path, JSON.stringify(parent.report));
  const changedReceipt = await artifact(parent.path);
  await writeFile(source.decisionEvidence, "{}");
  assert.throws(
    () => validateIntegrationCurrentSync(parent.report, proof, [changedReceipt], sourceRoot),
    /artifact|changed/i,
  );
});

test("the final guard covers non-Git product artifacts and registered project skills without children", async () => {
  const { validateIntegrationCurrentSync } = await import("../server/integration.mjs");
  const f = await fixture();
  const cwd = join(f.root, "portable");
  await mkdir(cwd);
  await writeFile(join(cwd, "result.txt"), "delivered");
  const proof = await f.verify({
    cwd,
    inputs: ["result.txt"],
    command: [process.execPath, "-e", "process.exit(0)"],
  });
  assert.equal(validateIntegrationCurrentSync(proof.report, undefined, [], sourceRoot), undefined);
  await mkdir(join(cwd, ".alliance"));
  await mkdir(join(cwd, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    join(cwd, ".alliance", "skills.json"),
    JSON.stringify({ version: 1, skills: [".agents/skills/review"] }),
  );
  await writeFile(
    join(cwd, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review a project\n---\nNew procedure\n",
  );
  assert.throws(
    () => validateIntegrationCurrentSync(proof.report, undefined, [], sourceRoot),
    /skill.*changed/i,
  );
  await rm(join(cwd, ".alliance"), { recursive: true });
  await writeFile(proof.report.artifacts[0].path, "changed log");
  assert.throws(
    () => validateIntegrationCurrentSync(proof.report, undefined, [], sourceRoot),
    /artifact.*changed/i,
  );
});

test("the final guard also works from a native CommonJS plugin bundle", async () => {
  const f = await fixture();
  const proof = await f.verify();
  const bundle = buildSync({
    entryPoints: [join(sourceRoot, "server", "integration.mjs")],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
    logLevel: "silent",
  }).outputFiles[0].text;
  const compiled = new Function("require", "module", "exports", `${bundle}\nreturn module.exports;`)(
    createRequire(import.meta.url),
    { exports: {} },
    {},
  );
  assert.equal(compiled.validateIntegrationCurrentSync(proof.report, undefined, [], sourceRoot), undefined);
});

test("squash and cherry-pick mappings prove scoped bytes at the landing and final candidate, not semantic equivalence", async () => {
  const { buildIntegrationProof, validateIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  await f.change("accepted");
  const child = await f.verify({ base: f.base });
  const source = await f.accepted("peer", child);
  git(f.cwd, "checkout", "-q", "--detach", f.base);
  await writeFile(join(f.cwd, "package.txt"), "another contribution");
  git(f.cwd, "add", ".");
  git(f.cwd, "commit", "-qm", "package");
  const landedHead = await f.change("accepted");
  const parent = await f.verify();
  await assert.rejects(buildIntegrationProof({ report: parent.report, contributors: [source] }), /ancestor/);
  for (const method of ["squash", "cherry-pick"]) {
    const plan = {
      version: 1,
      children: [
        {
          agentId: "peer",
          candidate: child.report.candidate.digest,
          method,
          landedHead,
          reason: "Reviewed rewritten history",
        },
      ],
    };
    const proof = await buildIntegrationProof({ report: parent.report, contributors: [source], plan });
    await validateIntegrationProof(proof, parent.report);
    await assert.rejects(
      buildIntegrationProof({
        report: parent.report,
        contributors: [source],
        plan: {
          ...plan,
          children: [{ ...plan.children[0], landedHead: f.base }],
        },
      }),
      /landed HEAD/,
    );
  }
});

test("integration uses accepted worktree evidence even after that worktree is removed", async () => {
  const { buildIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  const childTree = join(f.root, "child-tree");
  git(f.cwd, "worktree", "add", "-qb", "child", childTree, f.base);
  await writeFile(join(childTree, "app.txt"), "worktree candidate\n");
  git(childTree, "add", ".");
  git(childTree, "commit", "-qm", "child");
  const child = await f.verify({ cwd: childTree, base: f.base });
  const source = await f.accepted("peer", child);
  git(f.cwd, "merge", "-q", "child");
  git(f.cwd, "worktree", "remove", childTree);
  const parent = await f.verify();
  assert(await buildIntegrationProof({ report: parent.report, contributors: [source] }));
});

test("only a later accepted output can supersede an overlapping output, and every other child still counts", async () => {
  const { buildIntegrationProof, integrationStamp } = await import("../server/integration.mjs");
  const f = await fixture();
  const firstHead = await f.change("first");
  const first = await f.verify({ base: f.base });
  const a = await f.accepted("first", first);
  await f.change("second");
  const second = await f.verify({ base: firstHead });
  const b = await f.accepted("second", second);
  const parent = await f.verify();
  const contributors = [a, b];
  await assert.rejects(buildIntegrationProof({ report: parent.report, contributors }), /app.txt.*changed/);
  const supersession = {
    agentId: "first",
    candidate: first.report.candidate.digest,
    path: "app.txt",
    byAgentId: "second",
    byCandidate: second.report.candidate.digest,
    reason: "Review requested the later correction",
  };
  const plan = { version: 1, supersessions: [supersession] };
  assert(await buildIntegrationProof({ report: parent.report, contributors, plan }));
  await assert.rejects(
    buildIntegrationProof({
      report: parent.report,
      contributors,
      plan: { version: 1, supersessions: [supersession, supersession] },
    }),
    /Duplicate output supersession/,
  );
  await assert.rejects(
    buildIntegrationProof({
      report: parent.report,
      contributors,
      plan: {
        version: 1,
        supersessions: [
          {
            ...supersession,
            agentId: "second",
            candidate: second.report.candidate.digest,
            byAgentId: "first",
            byCandidate: first.report.candidate.digest,
          },
        ],
      },
    }),
    /newer/,
  );
  await assert.rejects(
    buildIntegrationProof({ report: parent.report, contributors: [a], plan }),
    /Invalid supersession/,
  );
  assert.notEqual(
    integrationStamp(contributors),
    integrationStamp([a, { ...b, decisionAt: new Date().toISOString() }]),
    "same bytes reaccepted is a new decision",
  );
});

test("portable non-Git outputs need complete explicit mappings and never reread changed source files as accepted work", async () => {
  const { buildIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  const documents = join(f.root, "documents");
  await mkdir(documents);
  await writeFile(join(documents, "note.txt"), "accepted note");
  const child = await f.verify({
    cwd: documents,
    inputs: ["note.txt"],
    command: [process.execPath, "-e", "require('fs').readFileSync('note.txt')"],
  });
  const source = await f.accepted("writer", child);
  await writeFile(join(documents, "note.txt"), "changed original");
  await writeFile(join(f.cwd, "published.txt"), "accepted note");
  const parent = await f.verify();
  await assert.rejects(
    buildIntegrationProof({ report: parent.report, contributors: [source] }),
    /explicit files mapping/,
  );
  const plan = {
    version: 1,
    children: [
      {
        agentId: "writer",
        candidate: child.report.candidate.digest,
        method: "files",
        reason: "Publish the accepted document",
        paths: [{ source: "note.txt", target: "published.txt" }],
      },
    ],
  };
  assert(await buildIntegrationProof({ report: parent.report, contributors: [source], plan }));
  await assert.rejects(
    buildIntegrationProof({
      report: parent.report,
      contributors: [source],
      plan: {
        ...plan,
        children: [{ ...plan.children[0], paths: [{ source: "other.txt", target: "published.txt" }] }],
      },
    }),
    /every declared output/,
  );
  await writeFile(join(f.cwd, "published.txt"), "changed original");
  const wrong = await f.verify();
  await assert.rejects(
    buildIntegrationProof({ report: wrong.report, contributors: [source], plan }),
    /published.txt.*changed/,
  );
});

test("review contributions require accepted analysis artifacts and cannot discard code changes", async () => {
  const { buildIntegrationProof, validateIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  const review = join(f.root, "review.txt");
  await writeFile(review, "Observed boundary and rationale");
  const child = await f.verify({ kind: "analysis", artifacts: [review] });
  const source = await f.accepted("reviewer", child);
  const parent = await f.verify();
  const reviewArtifact = child.report.artifacts.find((a: { path: string }) => a.path === review);
  assert(reviewArtifact);
  const plan = {
    version: 1,
    children: [
      {
        agentId: "reviewer",
        candidate: child.report.candidate.digest,
        method: "review",
        reason: "Analysis informed the final product decision; no code contribution",
        artifacts: [reviewArtifact],
      },
    ],
  };
  const proof = await buildIntegrationProof({ report: parent.report, contributors: [source], plan });
  assert(proof);
  await writeFile(review, "altered finding");
  await assert.rejects(validateIntegrationProof(proof, parent.report), /artifact changed/);
  await f.change("code");
  const code = await f.verify({ base: f.base, kind: "analysis", artifacts: [review] });
  const coder = await f.accepted("coder", code);
  const after = await f.verify();
  await assert.rejects(
    buildIntegrationProof({
      report: after.report,
      contributors: [coder],
      plan: {
        version: 1,
        children: [
          {
            ...plan.children[0],
            agentId: "coder",
            candidate: code.report.candidate.digest,
            artifacts: code.report.artifacts,
          },
        ],
      },
    }),
    /cannot exclude recorded source changes/,
  );
});

test("plans reject traversal, duplicate mappings, stale candidate identities and unlisted children", async () => {
  const { buildIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  await f.change("accepted");
  const child = await f.verify({ base: f.base });
  const source = await f.accepted("peer", child);
  const parent = await f.verify();
  const mapping = {
    agentId: "peer",
    candidate: child.report.candidate.digest,
    method: "files",
    reason: "Copy accepted bytes",
    paths: [{ source: "app.txt", target: "app.txt" }],
  };
  for (const [children, expected] of [
    [[mapping, mapping], /Duplicate child mapping/],
    [[{ ...mapping, candidate: "0".repeat(64) }], /candidate changed/],
    [[{ ...mapping, agentId: "omitted" }], /unknown accepted child/],
    [[{ ...mapping, paths: [{ source: "app.txt", target: "../escaped.txt" }] }], /relative file path/],
    [[{ ...mapping, paths: [...mapping.paths, ...mapping.paths] }], /Duplicate mapped source/],
  ] as const) {
    await assert.rejects(
      buildIntegrationProof({
        report: parent.report,
        contributors: [source],
        plan: { version: 1, children },
      }),
      expected,
    );
  }
});

test("a deleted accepted output cannot remain physically present as an ignored file", async () => {
  const { buildIntegrationProof } = await import("../server/integration.mjs");
  const f = await fixture();
  git(f.cwd, "rm", "-q", "app.txt");
  git(f.cwd, "commit", "-qm", "delete output");
  const command = [process.execPath, "-e", "process.exit(0)"];
  const child = await f.verify({ base: f.base, command });
  const source = await f.accepted("peer", child);
  await writeFile(join(f.cwd, ".gitignore"), "app.txt\n");
  git(f.cwd, "add", ".gitignore");
  git(f.cwd, "commit", "-qm", "ignore removed output");
  await writeFile(join(f.cwd, "app.txt"), "still here");
  const parent = await f.verify({ command });
  await assert.rejects(
    buildIntegrationProof({ report: parent.report, contributors: [source] }),
    /app.txt still exists/,
  );
});

test("technical acceptance validates captured scope and feature-map verification preserves the reviewed base", async () => {
  const f = await fixture();
  await writeFile(
    join(f.cwd, "driver.mjs"),
    `import assert from 'node:assert/strict';\nimport {readFile} from 'node:fs/promises';\nconst {check}=await import(process.env.ALLIANCE_ASSERTION_HELPER);\nawait check('read',async()=>assert.equal(await readFile('app.txt','utf8'),'base\\n'));\n`,
  );
  await writeFile(
    join(f.cwd, "features.json"),
    JSON.stringify({
      version: 1,
      features: [
        {
          id: "read",
          title: "Read",
          entryPoint: "app.txt",
          preconditions: "fixture",
          behaviors: [{ id: "value", expect: "read correct value" }],
        },
      ],
      scenarios: [
        { id: "read", command: ["$NODE", "driver.mjs"], assertions: [{ id: "read", behavior: "value" }] },
      ],
    }),
  );
  const proof = await runFeatureVerification({
    cwd: f.cwd,
    output: join(f.root, "map-proof"),
    map: "features.json",
    base: f.base,
  });
  assert.equal(proof.report.verdict, "PASS");
  assert.equal(proof.report.contribution?.base, f.base);
  assert(proof.report.contribution?.outputs.some((o: { path: string }) => o.path === "driver.mjs"));
  await validateEvidence(proof.path, f.cwd, proof.report.candidate.digest);
  assert(proof.report.contribution);
  proof.report.contribution.outputs = [];
  await writeFile(proof.path, JSON.stringify(proof.report));
  await assert.rejects(
    validateEvidence(proof.path, f.cwd, proof.report.candidate.digest),
    /Contribution scope/,
  );
});
