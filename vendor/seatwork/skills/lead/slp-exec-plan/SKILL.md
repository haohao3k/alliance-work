---
name: slp-exec-plan
description: Lead procedure to write a checked-in Execution Plan (ExecPlan) for work with material risk, irreversibility, uncertainty, broad contract impact, external side effects, or restart/handoff. Preserves decisions and acceptance; never implementation in prose.
---
# Execution plan (Lead)

An ExecPlan is a concise, checked-in direction document that must survive restart or handoff.
Create one when `slp-feature-intake` says the lane is high-risk, or when work must outlive the
current session. A task or issue is enough for tiny and normal work. Active plans live in
`.slp/plans/` (or the location the project law names).

## Required content

```md
# [Outcome-oriented title]

## Outcome And Constraints
[Observable outcome, governing policy, excluded scope.]

## Context And Ownership
[Owning area, affected boundaries/contracts, only the context needed to navigate.]

## Direction And Work Units
[Owner-clean direction, coherent outcome slices, invariants, failure modes, likely wrong turns.]

## Acceptance And Recovery
[Claims, evidence capable of falsifying them, rollout/rollback, recovery for risky state.]
```

Add `Progress`, `Decision Log`, or `Discoveries` only when that information must survive the
session. Empty sections are ceremony.

## Rules

An ExecPlan must: be restartable from the plan and the working tree without prior chat;
preserve settled architecture, single-contract hard-cut, reset/rebuild, safety and data rules;
divide work by outcomes or owner boundaries rather than files; state observable acceptance and
claim-shaped evidence; define rollout, rollback and recovery for externally stateful or
non-idempotent work; link code and `.slp/` records instead of restating them.

It must not: prescribe exact symbols, pseudocode, private control flow, or a line-by-line edit
sequence; leave material product, architecture, contract-cutover, or safety
decisions to the implementer; define completion as internal edits, coverage percentage, report
existence, or ceremony; become a diary, evidence archive, or review transcript.

When direction changes, update the current direction and acceptance in place. Git owns ordinary
history. Delete the plan when its outcome is accepted and its durable decisions have reached
their owner docs.
