---
name: slp-test-proof-debt-audit
description: Audit one named behavioral claim and the test, validator, benchmark, or gate cited as proof. Do not use for ordinary implementation, failing tests, weak coverage, or the presence of mocks. Peer skill: run it when your brief names a claim and its proof, or inside a `[Peer:review]`.
---

# Test Proof Debt Audit

Audit only the claim and proof route named by the user. Do not turn ordinary
implementation, a failing test, weak coverage, or the presence of mocks into a
repository-wide proof audit.

1. Name the claim and production behavior that makes it true.
2. Identify the cited proof.
3. State what the proof actually observes: behavior, machine-readable contract, performance, or proxy text/metadata.
4. Apply deletion sensitivity: would it still pass if the claimed behavior disappeared?
5. Check whether expected values come from independent truth.
6. Choose `keep`, `replace`, `demote`, `closeout-only`, `delete`, or `escalate`.

Treat history-only expected values as proof debt. A current test must not name
or pin a retired width, tag, field, version, byte sequence, or identifier merely
to prove its rejection. Ask whether the test could be derived from the current
contract without repository history. Replace it with current-boundary cases,
demote it to closeout-only evidence, or delete it unless the historical value
is itself a current public machine/security contract.

Proxy evidence can support lint or closeout but cannot prove runtime behavior. Mocks and replicas prove only their own boundary unless the claim is explicitly about that boundary.

Report location, claimed behavior, actual observation, disconfirming scenario, and
smallest replacement. Weak proof does not authorize an architecture redesign. If
the user requested assessment only, report and stop; modify proof or production code
only when requested.

Read [references/catalog.md](references/catalog.md) only for a broad user-requested audit or when concrete replacement examples are needed.
