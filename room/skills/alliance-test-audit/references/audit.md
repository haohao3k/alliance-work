# Audit reference

## Junk patterns

Reject a new match unless the retention bar names the contract it guards. For an existing match, audit it:

- probes with no assertion; self-comparisons; identity copies; expected values produced by the subject;
- copied inventories, manifests or export lists; exact source, import or string greps;
- private predicate or call-shape tests that duplicate proof at the real boundary; one contract invoked again and again;
- test-only exports, globals or wrappers; production paths only tests call;
- mocks that implement the asserted behaviour, or one mock posing as several APIs;
- fixtures that supply the receipt, admission or callback order the owner should produce; persistence asserted on a store the path never writes;
- capability flags asserted instead of the delivery or acknowledgement they promise;
- negative controls that pass on an unrelated guard or a rejection production never reaches;
- names promising behaviour the inputs and assertions never exercise;
- values pinned only by history where the current contract could derive the case. Keep historical inputs that remain a current public or security contract.

## Candidate evidence

Before an edit, read the whole test, its production owner, entry point, callers, callees, siblings, overlapping proof and relevant history. Record, per candidate:

- exact name and place, and the failure it can detect;
- non-test callers of the seam it covers;
- the stronger owner proof that remains, or why none is needed;
- why it exists, and the deletion it unlocks;
- the risk, and the focused command that validates the change.

Missing evidence means no deletion. An audit-only assignment stays read-only. Within an already authorized fix, record the evidence before editing; no additional approval round is introduced. Prefer a few high-confidence candidates. Remove obsolete seams and dead paths with their tests only within scope; move kept regressions to the owner. Never add a replacement test that restates the implementation, and never turn uncertainty into cleanup.

## Validation

- Do not mutate inputs under a running watcher or job; use a disposable copy for the control when the shared tree is in use.
- Run owner and sibling tests and the repository's required checks. For a removed source grep, run the code that owns the real contract.
- Report causes, removed categories and seams, kept false positives, proof run, production versus test lines changed, and follow-ups in the existing handback.
