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
- values pinned only by history (a retired width, tag, field, version or byte sequence) where the current contract could derive the case.

## Candidate evidence

Before an edit, read the whole test, its production owner, entry point, callers, callees, siblings, overlapping proof and history. Record, per candidate:

- exact name and place, and the failure it can detect;
- non-test callers of the seam it covers;
- the stronger owner proof that remains, or why none is needed;
- why it exists, and the deletion it unlocks;
- the risk, and the focused command that validates the change.

Missing evidence means no deletion. Discovery is read-only; report before editing. Prefer a few high-confidence candidates. Delete obsolete seams and dead paths with their tests; move kept regressions to the owner. Never add a replacement test that restates the implementation, and never turn uncertainty into cleanup.

## Validation

- Never edit while a test watcher runs in the tree.
- Run the owner and sibling tests; for a removed source grep, run the code that owns the real contract.
- Report causes, removed categories and seams, kept false positives, proof run, production versus test lines changed, follow-ups.
