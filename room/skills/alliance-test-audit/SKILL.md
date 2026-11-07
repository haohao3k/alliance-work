---
name: alliance-test-audit
description: Judge tests by whether a regression would break them. Use when writing, changing or reviewing tests, not to raise coverage numbers or start an unrelated cleanup.
---

# Test audit

Use this for tests being added, changed or reviewed. For a named claim whose cited proof is in doubt, use `slp-test-proof-debt-audit` when available; do not run both audits by default over the same evidence.

- Every test you add or change passes the gate.
- Judging a candidate's tests in a review-only assignment means findings, not rewrites.
- Sweep existing tests only when the assignment includes it: one owner area per batch, never a deletion count.

## Gate

1. Which observable behaviour, invariant or independent contract does it protect?
2. The two imagined edits:
   - **Break the behaviour.** Return a wrong value, skip an effect, do it twice. The test must go red. If it stays green, it proves nothing: the assertion is looser than the contract, the expected value is computed by the code under test, or the data was supplied by the test itself.
   - **Change the internals.** Keep every observable result and restructure underneath. The test must stay green. If it goes red, it is pinned to the implementation.
3. Why does existing proof miss it? Keep one owner test per contract at the strongest boundary. Another layer needs a risk the owner cannot reach, such as transport, lifecycle or restart. Extend a table case before adding a near-copy.
4. Does it need an export, flag, wrapper or hook that production never calls? Move it to the real boundary.

- A regression test fails on the pre-fix code for the bug's reason, then passes. If pre-fix code is not runnable, say so.
- One regression at the owner boundary covers a bug; do not replay it at every layer it crosses without a distinct risk.
- Prefer no new test over a bad one: mostly mocks, pinned internals, timing, or heavy setup for a small fix. Use the closest real check instead and name it.

## Junk

Self-comparisons, copied inventories, source or string greps standing in for running the code, call-shape assertions, duplicate contracts, test-only seams, expected values produced by the subject, mocks that perform what is asserted, fixtures that supply the receipt or stored state the code should produce, negative cases failing on an unrelated guard, and names promising more than the input exercises. For examples or a deletion decision, read [references/audit.md](references/audit.md#junk-patterns).

## Keep

- Public API, protocol, config, migration, storage, security, default, prompt-byte, package and release contracts; ordering a user can see.
- A source check that is the cheapest guard of a user-facing key or path and survives an internal rename.
- Slow or static is no reason to cut. A test red on the base may be a real bug: reproduce it before touching it.
- An expected value that only history explains, such as a retired width, tag or field kept to prove it is rejected, is debt unless that historical value is itself a current public or security contract. Otherwise derive the case from the current contract.

## Decide

For an existing test: `keep` · `replace` · `demote` (closeout evidence, not proof) · `delete` · `escalate` (the contract itself is unclear). Before `delete`, record the [candidate evidence](references/audit.md#candidate-evidence); any field missing, it stays. Resolve technical uncertainty within your mandate; ask the responsible owner only for a decision or authority you lack.

## Limits

- Change what a test asserts only within the assignment. A proposed deletion outside it is a finding for its owner.
- Inspect skipped/focused tests and assertions removed beside code changes when relevant. Do not assume Alliance has Seatwork's automatic hand-in guard.
- Run owner and sibling tests with the project's command, plus repository-required checks. In Alliance Work, preserve `npm run check`, `npm run lint` and applicable native or maintenance checks from `AGENTS.md`; this skill does not waive them.
- Keep controls and mutations away from shared work and running jobs. Use a disposable copy when needed; do not stash, reset or restore another writer's changes.

## Report

In the existing handback, list each test added, changed or removed, its decision and reason, and the command and actual result. In a review, report each failed gate or junk match with `path:line` and the smaller proof that would replace it. Name untested scope. Use the room's normal checkpoint/handback flow; do not send an extra acknowledgement or accept your own work.

This Alliance adaptation retains the upstream audit guidance; attribution and changes are in [NOTICE.md](NOTICE.md).
