# Executed coverage and failure evaluations

Lead chooses scope, tools, assertions and whether independent review is useful. These commands
record and validate evidence; they neither require every feature on every task nor register new
skills automatically. `verify --scenario NAME -- COMMAND` remains available for focused checks.

## Proof of integrated contributions

Product acceptance binds the final runtime report to every currently accepted direct contributor,
including archived children and children linked through responsible ownership or native parentage.
A child being accepted is not proof that its work landed in the final candidate.

For Git work, the child records its reviewed starting commit when verifying its contribution:

```sh
alliance-work verify --base BASE_SHA --scenario child-check -- npm test
alliance-work accept --agent CHILD_ID --report /absolute/child/report.json
# Integrate the reviewed change, then exercise the resulting product:
alliance-work verify --kind runtime --scenario integrated-journey -- npm run test:e2e
alliance-work accept --agent PARENT_ID --report /absolute/final/report.json --product journey.json
```

`--base` resolves a commit and captures the changed output files, contents, executable bits and
deletions in the same candidate snapshot as the check. Ignored inputs added with `--input` affect
verification but are not automatically Git deliverables. A normal merge needs a committed child
contribution, its source HEAD reachable from final HEAD, and matching final output fingerprints.
An ancestor commit alone does not prove that a later edit preserved the contribution.

For squash, cherry-pick, copied files or non-code review, supply `accept --integration plan.json`
alongside `--product`. Each entry pins the child and its accepted candidate digest; omitted entries
use normal merge checks. For example, portable output from another checkout:

```json
{
  "version": 1,
  "children": [{
    "agentId": "CHILD_ID", "candidate": "ACCEPTED_SHA256",
    "method": "files", "reason": "Reviewed output copied into the final project",
    "paths": [{"source": "output/report.txt", "target": "reports/final.txt"}]
  }]
}
```

`files` maps every contributed output to a relative final path. Non-Git checks capture their
explicit `--input` files as outputs. Final destinations must be captured by the parent's report;
use `--input` and rerun verification for ignored or non-Git destinations. `squash` and `cherry-pick`
require `landedHead` and a reason, with optional complete `paths` when files moved. The landed
commit must be reachable from final HEAD; source, landed and final scoped bytes are checked.
`review` requires an analysis report, a reason and specific `{path,digest}` artifacts already in
that accepted report. It records an applied non-code contribution and cannot discard recorded Git
code changes. None of these methods turns a test report into product runtime evidence.

When later accepted work intentionally replaces an earlier output, add a `supersessions` entry:
`{agentId,candidate,path,byAgentId,byCandidate,reason}`. It names the earlier source path and a later
accepted contributor covering the same final destination. Unexplained conflicts, duplicate entries
and cycles are refused. Rerun final verification after resolving conflicts; do not edit reports.

The disposition freezes contributor decision identities and hashes of their reports/artifacts.
Source worktrees may be removed after integration: their accepted snapshots remain the evidence.
Changing an artifact, the final candidate, a contributor's decision or its ownership/turn binding
invalidates the proof. Reaccepting identical child bytes is still a new decision. Automatic archive
rechecks stored integrated evidence and current contributor identities; status reports dependency
changes without rehashing the whole project. Unresolved native turn input also holds the decision.

Technical acceptance remains available without integration metadata. Older reports need another
verification with contribution scope before serving as integrated code evidence. Existing historical
dispositions are preserved; they are not retroactively labeled as having integration proof.
Dependencies are direct: a higher coordinator binds its accepted child's candidate and decision.
Reaccept that child after changing its integrated result; a grandchild decision alone does not
recursively rewrite or invalidate every ancestor's frozen proof. Keep the candidate quiet during
acceptance: final checks prevent local asynchronous callbacks interleaving with the commit, but
cannot lock arbitrary external writers or make a remote native action atomic with filesystem reads.

## Feature map

Put a map under the project, normally `.alliance/features.json`:

```json
{
  "version": 1,
  "features": [{
    "id": "tasks", "title": "Task persistence", "entryPoint": "/tasks",
    "preconditions": "Disposable app instance and seeded user",
    "behaviors": [{"id": "tasks.persist", "expect": "A saved task survives reopening"}]
  }],
  "scenarios": [{
    "id": "save-reopen", "command": ["$NODE", "checks/save-reopen.mjs"],
    "timeoutMs": 60000,
    "assertions": [{"id": "reopened-title", "behavior": "tasks.persist"}]
  }]
}
```

IDs use lowercase letters, digits, dots, underscores or hyphens. Feature, behavior and scenario
IDs are unique; assertion IDs are unique within a scenario. `$NODE` resolves to the runner's Node
binary. Commands are argument arrays, run from the project root without a shell. Each behavior
needs at least one executed, successful scenario; all declared assertions in that scenario must
pass. Unknown, duplicate or replayed assertion records are blocked. Missing/skipped assertions
and behaviors with no scenario remain uncovered. A failing scenario fails the run even when
another scenario covers the same behavior. Checks with side effects should use disposable targets.

A project driver imports the supplied adapter (also usable from compiled TypeScript):

```js
import assert from 'node:assert/strict';
const { check, skip, blocked } = await import(process.env.ALLIANCE_ASSERTION_HELPER);
// Start/connect the intended app and exercise the actual user flow here.
await check('reopened-title', async () => {
  const task = await reopenAndReadTask(); // your control driver
  assert.equal(task.title, 'Saved task');
});
// If unavailable, record blocked('reopened-title', 'Browser/target unavailable') instead.
```

`check` records PASS only after the callback resolves; assertion exceptions record FAIL and are
rethrown. A callback returning false also fails; use assertions that check an actual observed value.
`skip` and `blocked` require a reason and do not count as coverage. Non-JS drivers can append one
JSON object per line to `ALLIANCE_ASSERTIONS`, with `run: ALLIANCE_ASSERTION_RUN`, declared `id`,
`status` (PASS/FAIL/SKIP/BLOCKED) and `detail`. This is an owner-controlled evidence protocol,
not an attestation boundary against a malicious driver or fabricated assertion.

```sh
alliance-work verify --map .alliance/features.json --feature tasks --kind runtime \
  --target disposable-app --input .env.local --unverified 'Human network not tested'
alliance-work accept --agent CANDIDATE_OWNER_ID --report /absolute/report.json
```

Omit `--feature` for all features, or repeat it. The report lists selected/excluded features,
covered/total behaviors, expected/observed assertions and per-scenario reports/logs. Both the map
and ignored inputs named with `--input` join the candidate fingerprint. Changing source, map,
inputs, report artifacts or observation logs invalidates acceptance. Nested reports are checked
again on acceptance. Command output and evidence live outside the candidate tree.

`--target` remains a label; the project's control driver must verify the actual endpoint/identity.
Coverage measures the declared behavior/assertion contract, not all possible product behavior.
No system can infer that an assertion is meaningful just because the driver labels it PASS.
Use the existing proof-debt audit or a representative injected defect to test a doubtful verifier.
The bundled map covers selected Alliance contracts; excluded native scenarios require explicit
selection and installed harnesses, and no local check proves connectivity from the Human's device.

## Failure → correction → eval

A suite is a durable failure record plus a controlled comparison. It links original evidence,
the correction's layer/files, cases and two command variants. Paths are relative to project root;
failure evidence may also use absolute artifact paths outside the project. Change files must be
inside the project. Commands execute sequentially on the same candidate, with a fresh output
folder per run; they must isolate their external side effects and reset app state when needed.

```json
{
  "version": 1, "id": "proof-boundaries",
  "failure": {"summary": "Serving was reported as working login", "evidence": ["failures/login.log"]},
  "change": {"layer": "skill", "description": "Distinguish serving from user-flow proof", "files": [".agents/skills/proof-boundaries/SKILL.md"]},
  "variants": {
    "baseline": {"label": "Without lesson", "model": "chosen-model", "effort": "chosen-effort", "command": ["$NODE", "evals/model-driver.mjs", "baseline"]},
    "candidate": {"label": "With lesson", "model": "chosen-model", "effort": "chosen-effort", "command": ["$NODE", "evals/model-driver.mjs", "candidate"]}
  },
  "cases": [{"id": "original", "kind": "regression", "prompt": "Does HTTP 200 establish that login works?", "assertions": ["claim-matches-proof"]}],
  "repetitions": 1, "timeoutMs": 600000
}
```

Allowed correction layers: `architecture`, `check`, `tool`, `skill`. Case kinds: `regression`,
`holdout`, `non-trigger`, `blocked`. Model/effort fields are optional owner-supplied metadata;
the runner does not silently select a model or claim it verified that metadata.

The driver reads `ALLIANCE_EVAL_CASE` (a JSON file with case, variant, trial and configuration),
uses `ALLIANCE_EVAL_VARIANT` if useful, and records declared assertions via the same adapter.
`ALLIANCE_EVAL_OUTPUT` is the per-run output directory. Store actual model responses/tool traces
there and include them in an assertion's observations or log; stdout/stderr are retained. Baseline
and candidate receive identical prompts/assertion IDs; apply the changed skill only in the intended
variant. A deterministic/mock driver proves the eval machinery, not an improvement in agent judgment.

```sh
alliance-work eval --suite .alliance/evals/proof-boundaries.json
alliance-work eval inspect --report /absolute/eval.json
```

The summary lists fixes, regressions, unresolved and blocked trials with elapsed time per run.
IMPROVED requires a measured FAIL→PASS and no remaining candidate failure/regression/blocker.
NO_CHANGE reports no measured benefit. An unavailable baseline cannot establish improvement.
A candidate losing a baseline PASS is a regression, including on holdout/non-trigger cases.
Changed inputs yield INCONCLUSIVE; inspection also rejects changed source/evidence/artifacts.
Exit status is zero for IMPROVED/NO_CHANGE and nonzero for REGRESSED/NEEDS_WORK/INCONCLUSIVE.

Choose enough realistic cases/trials for the decision. The report notes missing holdout/non-trigger
coverage and single-trial uncertainty without imposing a case quota. Review results and decide
whether to keep, revise or remove the correction. If keeping a project skill, explicitly register
it with `alliance-work skills add`; link the evidence in the existing notebook/handoff when useful.
