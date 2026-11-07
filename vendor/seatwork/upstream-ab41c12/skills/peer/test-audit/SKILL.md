---
name: test-audit
description: "Judges tests by whether a regression would break them: keeps that proof, rejects tests that restate the code or need a test-only seam. Use when writing, changing or reviewing tests; not for raising coverage numbers."
---

# Test audit

- Every test you add or change passes the gate.
- Judging a candidate's tests (`[Peer:review]`): findings, not rewrites.
- A sweep of existing tests only when the brief names one: one owner area per batch, never a deletion count.

## Gate

1. Which observable behaviour, invariant or independent contract does it protect?
2. The two imagined edits:
   - **Break the behaviour.** Return a wrong value, skip an effect, do it twice. The test must go red. If it stays green, it proves nothing (assertion looser than the contract, expected value computed by the code under test, data the test built itself).
   - **Change the internals.** Keep every observable result and restructure underneath. The test must stay green. If it goes red, it is pinned to the implementation.
3. Why does existing proof miss it? One owner test per contract, at the strongest boundary. Another layer needs a risk the owner cannot reach (transport, lifecycle, restart). Extend a table case before adding a near-copy.
4. Does it need an export, flag, wrapper or hook that production never calls? Move it to the real boundary.

- A regression test fails on the pre-fix code for the bug's reason, then passes. Pre-fix code not runnable: say so.
- One regression at the owner boundary covers a bug; never replay it at every layer it crosses.
- Prefer no new test over a bad one: mostly mocks, pinned internals, timing, or heavy setup for a small fix. Use the closest real check instead and name it.

## Junk

Self-comparisons, copied inventories, source or string greps standing in for running the code, call-shape assertions, duplicate contracts, test-only seams, expected values produced by the subject, mocks that perform what is asserted, fixtures that supply the receipt or stored state the code should produce, negative cases failing on an unrelated guard, names promising more than the input exercises. Full list: [references/audit.md](references/audit.md#junk-patterns).

## Keep

- Public API, protocol, config, migration, storage, security, default, prompt-byte, package and release contracts; ordering a user can see.
- A source check that is the cheapest guard of a user-facing key or path and survives a rename.
- Slow or static is no reason to cut. A test red on the base may be a real bug: reproduce it before touching it.
- An expected value that only history explains (a retired width, tag or field kept to prove it is rejected) is debt: derive the case from the current contract instead.

## Decide

For an existing test: `keep` · `replace` · `demote` (closeout evidence, not proof) · `delete` · `escalate` (the contract itself is unclear → `QUESTION`). Before `delete`, record the evidence in [references/audit.md](references/audit.md#candidate-evidence); any field missing, it stays.

## Limits

- What a test asserts changes only where your brief says so. A deletion outside it is a line in your report.
- The room's hand-in check already flags skipped and focused tests and assertions dropped beside code changes; this judges value, not those.
- Run owner and sibling tests with the project's command; the whole suite only when the brief asks.

## Report

`CANDIDATE`: each test added, changed or removed with its decision, reason and the command that ran it. `REVIEW`: each failed gate or junk match with `path:line` and the smaller proof that replaces it.
