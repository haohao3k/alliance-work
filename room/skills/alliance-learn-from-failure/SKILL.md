---
name: alliance-learn-from-failure
description: Turn an observed recurring failure into a measured correction using a baseline and candidate eval. Use when improving a reusable check, tool or project skill from concrete failure evidence; ordinary one-off fixes do not need this workflow.
---

# Learn from an observed failure

Start with the actual bad outcome and its logs, report or handback. Preserve the proof boundary:
HTTP serving is not working login, a command exit code is not scenario coverage, and a synthetic
driver is not a measurement of model judgment.

Choose the smallest useful correction. Prefer removing the cause or adding a deterministic
check when possible. A project skill is appropriate for repeated decisions requiring judgment;
keep its trigger narrow and avoid converting one incident into a rule for all tasks.

Use the Alliance CLI supplied in room context:

    alliance-work eval --suite .alliance/evals/NAME.json
    alliance-work eval inspect --report /absolute/eval.json

The suite links the observed failure evidence, changed files, baseline/candidate commands and
the same cases/assertions for both variants. Read `docs/verification.md` under the supplied
Alliance installation root for the schema and driver protocol. The runner passes the case in
`ALLIANCE_EVAL_CASE`; the driver imports `ALLIANCE_ASSERTION_HELPER` and records observations
through `check(id, callback)`. Missing assertions, skipped checks and unavailable environments
are not successes. Driver outputs and reports stay outside the project tree.

For a judgment skill, run the participating model with and without that skill, keep model,
effort and case inputs comparable, and retain the actual response/tool evidence as artifacts.
Use a grader that checks observable outcomes. Mock answers only test the harness. Include a
held-out case and a case where the skill should not trigger when they help detect overfitting;
Lead chooses cases, repetitions and cost. A single trial is not a reliability estimate.

Read fixes, regressions, blocked cases and proof boundaries before deciding to keep, revise or
drop the change. NO_CHANGE means no measured benefit; do not rewrite it as improvement. A
regression in a held-out/non-trigger case matters even if the original case is fixed. If a skill
is worth keeping, put it in the project's `.agents/skills/` and register it through
`alliance-work skills add`. Registration is the owner's decision, never an automatic eval side effect.

Link the retained lesson and eval report in the existing room notebook/handoff when useful.
No extra review role, meeting, approval quota or mandatory eval for unrelated work is introduced.
