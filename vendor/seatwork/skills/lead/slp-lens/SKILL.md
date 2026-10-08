---
name: slp-lens
description: Lead procedure for any decision that needs independent read-only opinions — a hard technical question, a stuck approach, a review that matters, a plan phase, a contested design, an incident, a formal verdict the Owner asked for. The Lead chairs; opens 1..N lenses on a neutral brief (one = second brain, two of different families = settle an answer, more = angles), seals them, settles overlap and conflict with at most one cross-examination, verifies disputed facts with verifier lenses, audits a high-stakes draft with an audit lens, and issues one binding decision. Never inside a lens.
---
# Lenses (the Lead chairs)

A lens is its own seat, not a Peer: a strong model on a `<harness>-lens` provider, title
`[Lens] <angle>`, that answers one neutral brief by mail and never sees another lens, your
reasoning, your plan, or your preference. You are the chair and the final arbiter: lenses analyse,
you decide. You never do a lens's analysis yourself, never launch a Lead, never run this
inside a lens.

```text
size    -> how many lenses, which models, which angles (one sentence)
brief   -> neutral brief + output contract + framing lint
sealed  -> create_agent every lens, END YOUR TURN; their mail wakes you
collect -> audit each lens's conduct; handle failures
settle  -> overlap settled; conflicts cross-examined once; facts verified
model   -> (formal cases) typed decision model
audit   -> (high-stakes) one audit lens on your draft
decide  -> binding decision + handoff; archive the lenses
```

Announce each phase in one line of your own report.

## 1. Size

| Need | Lenses | Models (the lens table in your role prompt) |
|---|---|---|
| second brain on a plan, a bug, what to do next | 1 | the oracle |
| an answer that matters; one model's blind spot would hurt | 2 | the pair: two different models, always |
| a decision with several angles, a plan review, an incident, a verdict the Owner asked for | 3+, one angle each; default angles: *independent* (first principles, strongest answer, decision-critical assumptions) · *premise challenger* (tests the framing, builds one viable counterfactual, does not manufacture disagreement) · *specialist* only when a domain's rules decide it | the pair plus the pool; never the same model twice in one run |

Other angles when the question wants them: *only what the code proves* · *free to propose
what the code does not contain, labels grounded / plausible / unverified* · *this domain's
rules only*. "Fantasy" is an angle line in a brief, not a seat type. Smallest count that
settles it. **High-stakes** (irreversible, security, money, an Owner-requested verdict): 3+
lenses, verifier lenses as needed, audit mandatory.

## 2. Brief (identical for every lens except its ANGLE line)

```text
CASE_ID
ORIGINAL REQUEST       verbatim
DECISION QUESTION      may clarify, never narrow or replace
OBSERVABLE OUTCOME
AUTHORITATIVE FACTS    with provenance (Owner decisions, verified facts only)
DIRECT OBSERVATIONS    source-backed, exact locations
UNVERIFIED CLAIMS
UNKNOWNS
HARD CONSTRAINTS       separate from PREFERENCES / PRIORITY ORDER
AUTHORIZED SCOPE       paths and sources a lens may read
SNAPSHOT               commit sha, or snapshot patch + sha when the tree is dirty
ANGLE                  per lens, optional
OUTPUT CONTRACT        case-specific: focused decision, finding ledger, gate-by-gate plan
                       review, incident timeline, evidence synthesis — patterns in
                       references/report-format.md; at minimum POSITION · EVIDENCE ·
                       ASSUMPTIONS · WHAT WOULD PROVE ME WRONG · confidence
```

For a one-lens second brain the first five lines may be a paragraph; the rest still holds.

**Framing lint** — repair until every answer is yes: preserves the original request · no
wording implies a preferred answer · every authoritative fact has provenance · unverified
premises are marked as claims · hard constraints are separate from preferences · no option
space excluded without authority · lenses can investigate independently within scope · the
snapshot is unambiguous · the output contract keeps every decision unit · no heading seeds a
conclusion. Ask the Owner (`DECISION_NEEDED`) only when missing authority would change the
decision.

## 3. Sealed launch

Begin every lens prompt with:

```text
LENS EXECUTION MODE
Work as a fully autonomous reviewer with independent judgment inside the authorized scope.
Challenge false premises, choose what evidence to inspect, make ordinary analytical decisions
without waiting for the chair. This is your own analysis, not orchestration: do NOT use agent
tools, do NOT discover or contact other agents, do NOT read other lenses' work. Begin
directly, no preamble.
```

End every lens prompt with:

```text
Read-only. Do NOT edit, create, rename, or delete files. Do NOT write code. Do NOT spawn or
contact agents. Do NOT optimize for agreement. Distinguish direct observations from
inference and state what evidence would prove your position wrong. End your turn with REVIEW
on the first line.
```

`create_agent` per lens: `title` `[Lens] <angle>`, `provider` from the lens table,
`settings.modeId` for its harness, `settings.thinkingOptionId` from the lens table,
`initialPrompt`, `notifyOnFinish: false`. Launch all
lenses in one turn, then **end your turn**. Sealed means: no shared chat, no other lens's
report, no hint of your opinion, no synthesis until every required lens has reported. It is
soft, audited isolation: never claim a lens was technically unable to write or orchestrate.

## 4. Collect and audit conduct

When every required lens has reported (mail): `get_agent_activity` each one. A lens that
used agent tools, inspected another lens, or wrote to the workspace is `COMPROMISED`; its
report is not used. Compare the snapshot where practical. Failures: infrastructure or
output-contract failure → one retry with the same brief; format-only gap → one `slp_mail`
asking for the missing decision-relevant content; compromised or dead lens → one fresh
replacement. One lens cannot decide without its lens; two or more may continue `DEGRADED`
with one core lens missing and say so; high-stakes cannot.

## 5. Settle

- **One lens**: it is advice. Take the recommendation, evidence, and the check it proposes;
  have a Peer run that check before you rely on it. Advice is not verification.
- **Two or more**, per decision unit: all agree (or all reject) → settled, after checking any
  claim that is cheap to check. Conflict on a material unit → `slp_mail` (`to:` that lens's id) each lens only the
  disputed unit and the other's argument, without saying which you prefer (`needs: reply`):
  `RESPONSE: CONCEDE | MAINTAIN | NARROW | REVERSE` with reason, direct evidence, falsifier,
  and the recommendation impact either way (format in references/report-format.md). At most
  one challenge and one response per unit; a second round only if the conflict still decides
  the outcome and new evidence came in. End your turn; replies wake you.
- **Disputed fact** (not opinion): one to three `[Lens] verify <proposition>` lenses,
  each with ONE proposition and ONE mandate — supporting evidence · disconfirming evidence ·
  coverage audit — never identical prompts as a vote. Output `PROPOSITION CHECKED / MANDATE /
  SOURCES SEARCHED / DIRECT OBSERVATIONS / RESULT: verified | falsified | partial |
  insufficient coverage | snapshot mismatch / LIMITATIONS`. A snapshot mismatch stops that
  proposition until the source is refreshed. New factual claims from cross-examination go
  here, never to free debate.
- Settle on evidence, never on which lens held out longer. What stays unsettled stays open,
  and you say so. An unverified idea no lens could refute is a candidate for a bounded
  `[Peer:research]` or a spike, never an accepted design by itself. A refuted idea is closed
  with its refutation.

## 6. Decision model (3+ lenses, plan reviews, incidents, verdicts)

Reduce valid reports to the smallest model that keeps every natural unit: 3–5 material
propositions for a focused decision; one row per finding for an audit; one row per gate for
a plan review; a timeline plus causal model for an incident. Type each material claim
(`FACT` · `INFERENCE` · `CAUSAL CLAIM` · `FORECAST` · `VALUE / PREFERENCE` · `AUTHORITATIVE
CONSTRAINT`) and give it one status: `verified | falsified | authoritative | supported
inference | contested inference | unresolved | insufficient coverage | snapshot mismatch`.
Only facts and direct observations get factual verification. Seat count never creates
authority; no voting, no averaging.

## 7. Audit lens (high-stakes mandatory; otherwise when dissent is material or the chain is fragile)

Draft the decision alone. Then one fresh `[Lens] audit <case>` receives the brief, the
lens reports attributed by angle only, the decision model, verified evidence, your draft and
the material dissent. Output `AUDIT RESULT: CLEAR | REVISE | STOP` with findings (severity,
category, evidence, required correction — format in references/report-format.md). Resolve
every material finding; one audit round. The auditor finds defects; it never issues the
decision.

## 8. Binding decision and close

In your report, in the case's vocabulary: `DECISION` and why · `AGREED` · `CONFLICTS` (each:
positions, evidence, how settled) · accepted vs rejected or unproven claims · required action
and owner boundaries · do-not-touch constraints · validation · material dissent and your
response · limitations · reopen conditions · `OPEN` · whether the run was degraded or skipped
the audit. For a supplied finding set, one disposition per finding. A decision that changes
*what* the outcome delivers, cost, external effect, or irreversible risk → `DECISION_NEEDED`
to the Owner instead; a decision that does not converge → the same. Archive the lenses. The
procedure ends at the decision and the handoff; lenses never implement — a later writable
Peer receives the decision, required action, boundaries and validation. A follow-up question
gets fresh lenses with a brief that carries what was said.

## Stopping rules

One sealed round; one targeted exchange per disputed unit; one audit round; no voting; no
chat room; no lens edits; no new workspace; no standing lens team; one run per question — a
second disagreement on the same question is `DECISION_NEEDED`, not another run.
