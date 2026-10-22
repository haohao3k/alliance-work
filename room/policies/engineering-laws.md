# Engineering laws — core v1

These laws apply to HQ, Supervisor, Lead, Peer and Lens.

1. **An open obligation keeps an owner.** Sessions end; obligations survive. Before retiring an
   owner, transfer its open obligations explicitly to a live successor or the Human who owns the
   next decision. Preserve assignment, authority, next action, conditions and evidence.
2. **Due is not ready.** A timer, message acknowledgement, process exit or completed turn does
   not satisfy prerequisites. Record material waiting conditions and bounded observations of
   them. A recorded authority reference never grants permissions absent from the actual assignment.
3. **Written is not active.** Distinguish source, staged release, installed version, loaded
   runtime and observed behavior. Never activate by interrupting current work.
4. **Claims have scope and time.** Name candidate, environment, observation time and remaining
   limits. Old handbacks and expired observations are history, not current runtime truth.
5. **Coordination must earn its interruption.** Batch routine handbacks at natural boundaries.
   No status ping loops, reviewer quotas or compulsory councils.
6. **Done matches the contract.** Fixture, analysis, local-only, integrated and serving are
   different acceptance scopes. Tests, delivery receipts and reviews do not close an obligation
   without evidence for its closeWhen contract. Respect deliberate waits for Human decisions.
7. **Evidence names an immutable candidate.** Pin the run, revision or snapshot actually tested.
   Do not mutate inputs under running jobs or attribute old cohorts to new changes.
8. **Retries need a reason.** Before another attempt, identify changed conditions, a competing
   hypothesis or new evidence and a stopping condition. Keep failed attempts available.
9. **Measure the outcome.** Preserve denominators and workload scope; token counts, cache rates
   and interrupts alone do not establish cost or waste. Measure accepted outcomes and rework.
10. **Rules need counterexamples.** Verify real failure cases and legitimate exceptions. A rule
    acknowledgement, passing checklist or policy loaded in a prompt does not prove compliance.

When a law is violated: stop only the dependent action, rethink its premise using evidence,
reconcile ownership/conditions/authority/claims, then resume within authority. Record material
changes in the existing obligation or handback. Continue unrelated authorized work.

A new session already has current policy: read its assignment and start. After a resume or
context compaction, recover current policy and open obligations once with `alliance-work policy
read --agent "$PASEO_AGENT_ID"`, then read the linked assignment; the snapshot at
`$ALLIANCE_CONTEXT` repeats that policy, so read only its obligations and pending items there.
Reconcile open obligations before side effects (`policy ack` only records the read) and refresh
them before a dependent action. There is no universal compaction callback: preserve this
recovery instruction in handbacks.

Persist material future work with `alliance-work obligations add --file FILE.json`; use
`obligations action --file FILE.json` for evidence-backed observation, reconciliation, handoff or
closure (schema in docs/operations.md). Do not turn every tool call into an obligation. Bind
dependent work with `autonomy start --obligation KEY`: its owner and unexpired conditions gate
continuation and retry, so checkpoint `waiting` while prerequisites are missing. A handoff moves
the binding and its remaining budget to an idle successor; a handoff to the Human pauses
execution. Linked reminders (`wakeups add --obligation KEY`) are pull-only; their acknowledgement
or expiry never closes the obligation. Never fulfil one merely to enable archive. Do not infer
authority from old unlinked reminders.
