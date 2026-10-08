---
name: slp-ultra-review
description: Lead-only maximum-recall bug hunt on a stable candidate or plan closure: several sealed read-only [Peer:review] scouts with overlapping concerns, every candidate preserved in one durable report, then a verification queue. Use at plan closure, before a hard-to-reverse boundary (wire, storage, migration, ownership, security, process), or when the Owner asks. Not after every slice.
---

# Ultra review — instructions for the Lead

Goal: maximize bugs discovered. False positives are acceptable; never filter a candidate out of
the report because it is speculative, low-confidence, duplicated, or hard to classify.
Verification and rejection happen afterwards, through ordinary Peers.

## When (gate)

- Default: one ultra review at plan closure.
- Mid-plan only for a stable checkpoint that completes an end-to-end capability, freezes a
  dependency foundation, or crosses a hard-to-reverse boundary.
- Never on unfinished composition, pending validation, known later work, or ordinary fixes.
- After findings: focused Peer follow-up. Run again only for a materially new convergence claim.

## Inputs and strategy

Fix the scope (candidate sha or snapshot, changed paths, change intent, repository contracts,
prior-round warnings) and an identity digest (`shasum` of the snapshot). Choose the scout count:
3 for a bounded change, 5 by default, up to 10 for a wide or security-sensitive surface.

If the brief supplied directives `D01..`, every directive is mandatory and goes to at least two
scouts (three when you have ≥ 6 scouts). Otherwise derive concerns `G01..` from scope, contracts,
architecture, call paths, lifecycle, data flow, and blast radius, and overlap the risky ones
deliberately with different angles (trace, lifecycle phase, owner, adversarial input,
disconfirming approach). Every scout may also report any incidental in-scope bug.

Model: scouts on the cheap or default tier of your role's provider table with thinking high,
mixing families where the table offers them. Coverage comes from count and angle, not from a
big model.

## Scout packet (each `create_agent`, title `[Peer] scout-NN <review name>` — a plain read-only Peer, not the review specialization: scouts may return speculative candidates)

- exact scope, snapshot identity, and change intent
- relevant repository contracts and prior-round warnings
- assigned concern IDs with tailored search angles
- permission to report every incidental in-scope concern
- instruction to inspect the full relevant production surface, not only the diff
- required per candidate: `file:line`, evidence observed, contract violated, plausible failure
  mode, confidence, durable solution hypothesis, disconfirming check (read-only)
- explicit permission to return incomplete or speculative candidates
- read-only: no edits, no tests, no builds, no package managers, no agent tools; end the turn
  with `REVIEW` on the first line
- `notifyOnFinish: false`; keep scouts independent (no shared findings)

Launch all scouts in one turn, then **end your turn**; their mail wakes you.

## Search surface (raw material, allocate to the slice)

semantic and state-machine correctness · ownership × lifecycle × expected outcome gaps ·
caller/API/schema/protocol contracts · concurrency, ordering, cancellation, cleanup, resource
lifetime · error masking, fallback, retry, partial failure · authorization, trust boundaries,
adversarial input · hot-path allocation, copies, N+1, blocking, contention · generated
artifacts, fixtures, validators, snapshots · test/proof gaps, fake-pass evidence, mocked
production claims · compatibility paths, duplicate state, wrappers compensating a broken
foundation · owner/module boundaries and missing essential mechanisms · alternate end-to-end
traces and hostile edges.

## Prior round guard

Before round 2+, read every earlier report with the same review name. Give scouts concise
warnings about confirmed fixes, rejected false positives, unresolved routes, and regression
risks — as context, never as a filter.

## Consolidation (you)

When every scout has reported, write exactly one report at
`.slp/reviews/<review-name>-round-<n>.md` (create the directory if missing; it is the only
workspace artifact this review creates):

```text
# Ultra review <name> — round <n>
Date · Scope · Snapshot · Scouts · Directives
## Prior round guard
## Findings            (F001.. grouped by root cause; keep every unique or speculative candidate)
   F0NN · P0|P1|P2|P3 · confidence high|medium|low
   file:line · evidence · contract violated · failure mode · durable solution hypothesis ·
   disconfirming check (read-only)
## Verification queue  (every finding with its read-only disconfirming check)
## Strongest reason not to merge yet
## Next step
```

No raw candidate ledgers, execution receipts, or metadata clutter. Then dispatch verification
and fixes through ordinary Peers (`slp-accept-candidate` rules apply); archive the scouts.
Record the review in `.slp/status.md` and in your report.
