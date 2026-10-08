# Lens output-contract patterns

These are composable patterns, not a universal schema. Lead selects and adapts only what the case
needs. Do not copy all headings into every lens prompt.

## Shared evidence discipline

Every case output contract should make it possible to distinguish direct observation, authority,
inference, uncertainty, and the action each material conclusion changes. Ask for falsifiers or
reopen conditions when they are decision-relevant. Do not require filler sections.

## Focused decision pattern

Useful when the lenses are weighing one architecture, product, policy, or strategy route. Adapt or
omit headings that do not help the decision.

```text
POSITION
RECOMMENDATION

DECISION-CRITICAL CLAIMS
- CLAIM
- TYPE: fact | inference | causal claim | forecast | value/preference | authoritative constraint
- EVIDENCE OR AUTHORITY
- VERDICT IMPACT

BEST ALTERNATIVE
STRONGEST COUNTERARGUMENT
PRIMARY FAILURE MODE
FALSIFIER / WHAT WOULD CHANGE MY MIND
UNKNOWNS
CONFIDENCE BASIS: HIGH | MEDIUM | LOW, because ...
```

Do not use a numeric confidence percentage.

## Supplied-findings / audit pattern

Preserve one row per supplied finding. Do not impose a fixed row limit.

```markdown
| Finding | Disposition | Direct evidence | Classification | Durable route | Confidence/limits |
|---------|-------------|-----------------|----------------|---------------|-------------------|
| F001    | confirmed / falsified / narrowed / insufficient coverage | ... | bounded / foundation / architecture / mechanism / proof-only | ... | ... |
```

Add a short cross-cutting synthesis only for causal or ownership conclusions that span multiple
findings. New findings use the same evidence fields and remain clearly separate from supplied
findings.

## Plan / contract review pattern

Use one row per natural gate or obligation: status, governing authority, evidence, impact, and
required correction. Preserve user-visible requirement identity.

## Incident pattern

Use the smallest truthful timeline plus causal claims, containment/recovery decisions, unknowns,
and discriminating evidence. Do not force an option memo onto an incident.

## Material proposition pattern

Useful for a focused decision or for cross-cutting claims above a larger finding/gate ledger.

```markdown
| ID | Type | Proposition | Source/excerpt | Evidence bar | Status | Verdict impact |
|----|------|-------------|----------------|--------------|--------|----------------|
| P1 | FACT | ...         | Seat, excerpt  | Direct source evidence | unresolved | High |
```

Use an exact report excerpt or source location where practical. A proposition is material only
when changing its truth or authority could change the verdict or required action.

## Cross-examination response

Rename `PROPOSITION_ID` to the case's natural identifier, such as `FINDING_ID`, `GATE_ID`, or
`CLAIM_ID`.

```text
PROPOSITION_ID
RESPONSE: CONCEDE | MAINTAIN | NARROW | REVERSE
REASON
DIRECT EVIDENCE
NEW CLAIMS, if any
FALSIFIER
IF PROPOSITION IS TRUE, RECOMMENDATION IMPACT
IF PROPOSITION IS FALSE, RECOMMENDATION IMPACT
```

New material factual claims return to verification; they do not expand free-form debate.

## Draft-verdict audit

```text
AUDIT RESULT: CLEAR | REVISE | STOP

FINDINGS
- SEVERITY: material | non-material
- CATEGORY: falsified premise | unsupported new claim | unanswered dissent |
  omitted material claim | preference-as-constraint | scope breach | action mismatch |
  vague reopen condition
- EVIDENCE
- REQUIRED CORRECTION

UNCHECKED LIMITATIONS
```

The Auditor identifies defects but does not issue or replace the binding verdict.
