---
name: slp-decompose-outcome
description: Lead procedure to split an outcome into Peer tasks along real seams with one owner per write scope and the fewest intermediate states; decides the plan shape (task, ExecPlan, lenses, ultra review) from the intake lane.
---
# Decompose the outcome (Lead)
1. Restate outcome, constraints, and current candidate from your instruction; if you cannot tell
   which is which, `QUESTION` the Owner before planning. Confirm the lane
   (`slp-feature-intake`): high-risk → `slp-exec-plan` first; a contested design → `slp-lens` (three or more lenses)
   before binding it.
2. Find seams, not steps: write scopes verifiable on their own (module, layer, file batch) and the
   contracts between them (API shape, invariants, data ownership, error semantics, acceptance
   tests). Write contracts down before dispatch. Spend the care where change is expensive: a
   boundary that spreads once settled (ownership and lifetimes in Rust, a public schema, who
   owns which data) gets its contract agreed before any code; folder layout, naming and first
   abstractions are cheap to pivot, so scaffold and learn from the running system instead.
3. For every phase ask: "skip it and go straight to the end state — what breaks?" A phase stays
   only for a real dependency (B needs A's accepted output), a checkpoint that must be verified
   before more is built on it, a production constraint (live data, staged rollout, external
   clients), or a prototype that settles an open assumption. Only the plan's tidiness → delete
   the phase. Changes that are only correct together (a store and its consumers, a schema and
   its readers) are one task with one owner, never split in time: a half state has to compile,
   test, be reviewed and understood by the next seat, and the adapter written for it will be
   defended as architecture. Anything temporary that survives a task is a `TEMPORARY:` marker
   with a removal condition and a removal task in the plan, owned, closed before `DONE`.
4. Tiny-lane tasks and the first scaffold are yours to do (role file); everything else is a
   Peer task. Size each task within the reading budget in your role (`wc -c`, bytes ÷ 4 ≈ tokens); over budget → split along a seam that leaves each part compiling and tested with no
   compatibility code; a change that only works whole and does not fit → raise the tier, never
   split it in time; unknown scope → one
   `[Peer:research]` first.
5. Tier per task from the provider table in your role; when unsure, lower. Parallel writers only with disjoint scopes
   and agreed contracts; otherwise sequence. Three to five live Peers is the healthy band.
6. Record the plan (tasks, tier, scope, dependencies, state) in `.slp/status.md` and your first
   report. Three or more tasks, or any expensive-tier task → one `[Lens] plan review` before launching (angle: missing or redundant tasks, write-scope overlap, tier
   misroutes, phases that only serve the plan's shape, risks; concrete changes or LGTM). Plan closure → `slp-ultra-review` when the gate says so.
