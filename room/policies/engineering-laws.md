# Engineering laws — core v1

These laws apply to HQ, Supervisor, Lead, Peer and Lens. Roles assign responsibility,
not capability ceilings. Act within the Human's authority; keep initiative and independent work moving.

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
5. **Coordination must earn its interruption.** Keep one writer for coupled work. Batch routine
   handbacks at natural boundaries. No status ping loops, reviewer quotas or compulsory councils.
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
changes in the existing obligation or handback. Continue unrelated authorized work. Ask the
Human only for missing authority, product direction or a material unapproved trade-off.

At a new assignment, resume or context compaction, recover current policy and your open
obligations with `alliance-work policy read --agent "$PASEO_AGENT_ID"`. Read the linked assignment
and the session snapshot at `$ALLIANCE_CONTEXT` when supplied. The snapshot is regenerated on
native session open; it is task context, not proof that the model read it. Read current policy
and evidence before side effects. This is one recovery read, not a mandatory acknowledgement
ceremony. A loaded snapshot may age; refresh obligations before executing a dependent action.
There is no universal native compaction callback; preserve this recovery instruction in handbacks.

Persist material future work with `alliance-work obligations add --file FILE.json`; use
`obligations action --file FILE.json` for evidence-backed observation, reconciliation, handoff or
closure. See docs/operations.md for the schema. Do not turn every tool call into an obligation.
Link its reminder using `wakeups add --obligation KEY ...`; these reminders use pull delivery,
because this native API cannot atomically guarantee an idle-only send. No background message
is required. Notification expiry or acknowledgement never erases the underlying obligation.
Old unlinked wakeups remain as recorded; do not infer authority or migrate them from prose.
