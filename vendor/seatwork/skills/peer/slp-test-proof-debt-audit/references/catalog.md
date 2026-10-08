# Proof Debt Catalog

Use this reference to widen an audit after the live claim and scan roots are known from the repository.

## Search Families

Search for:

- retired, legacy, removed, forbidden, blacklist, absence, or zero-hit wording
- source reads, substring checks, regexes, headings, summaries, labels, markers, and registration names
- validators or workflows whose names claim proof while their assertions only inspect metadata or prose
- expected outputs copied from the same artifact or recomputed by the same algorithm
- negative tests that hard-code a retired representation such as an old width, tag, version, field, offset, or byte sequence
- fixtures that write state and then assert only that the fixture state exists
- mock or replica benchmarks carrying production-path claims

Use repository-appropriate search and semantic tools. Search hits are leads, not findings.

## Common Smells

- permanent tests whose only claim is that a retired name or dependency is absent
- source or document text used as evidence that runtime behavior executes
- report prose or test registration used as proof that a scenario ran
- a validator that accepts its own generated output without independent truth
- a pass-through wrapper tested more deeply than the owner it forwards to
- full error-message prose locked where a typed or semantic rejection exists
- benchmarks whose measured path differs from the claimed path
- tests that survive deletion of the production module

## Better Routes

- Replace absence memory with positive coverage of the current contract.
- Derive malformed inputs from current authority, such as current width ± 1, instead of preserving retired values.
- Replace source/prose checks with executed behavior or parsed machine-readable truth.
- Replace copied goldens with invariant checks or an independently owned source of truth.
- Replace mock production claims with production-path measurement or an explicitly reduced structural claim.
- Replace broad proof naming with the truthful category: test, benchmark, validation, lint, review aid, or closeout audit.

Do not grow a proxy with more strings or patterns. Delete, demote, or replace it.
