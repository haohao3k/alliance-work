---
name: alliance-verify
description: Run a chosen check and bind its evidence to an Alliance candidate before technical acceptance. Use for candidate handback or acceptance; the project verification skill supplies product-specific scenarios.
---

# Bound candidate evidence

Choose the smallest check that establishes the assignment's acceptance conditions. Use the
project's verification/control skill when it exists. Lead chooses tools, scenarios, model and
whether independent review adds value; this skill introduces no review quota.

Use the Alliance CLI path supplied in room context (`--help` lists current arguments):

    alliance-work verify --scenario NAME --kind test -- COMMAND ARGS...

Use `--kind runtime` only when the command drives the real behavior claimed; `analysis` for
an analysis check. A successful shell command proves only its assertions and observed boundary.
For a UI change, build/unit tests alone do not establish the user flow. An unavailable target
is a blocker, not permission to invent a successful check.

Add `--target` to identify the instance, `--input FILE` for ignored configuration that affects
the run, `--artifact FILE` for screenshots/traces or other proof, and `--unverified REASON`
for material scope not exercised. These options are repeatable except target. Commands run
directly; use an explicit shell only if the chosen check needs one. Reports/logs are private
files outside the checkout. Do not include credentials in commands or published artifacts.

The CLI records checkout contents (tracked and non-ignored untracked files), HEAD, explicit
inputs, command result and artifact hashes. Source changes during a check produce STALE.
Ignored files, external services, dependencies and symlink targets are not automatically
covered by the source fingerprint: include relevant input files and observe the target.

Hand back the report path, candidate digest, actual proof boundary, unverified scope and
owner. The accepting owner reads the report and relevant artifacts, then records its decision:

    alliance-work accept --agent CANDIDATE_OWNER_ID --report /absolute/report.json

Acceptance refuses non-PASS results, wrong checkouts, changed candidates and changed artifacts.
It does not judge whether a weak check proves a strong claim. Use engineering judgment and
the existing proof-debt audit when that specific question warrants it. If code or inputs
change after verification, rerun the affected check rather than rewriting the report.
