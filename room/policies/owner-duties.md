# Owner duties (HQ, Supervisor, Lead)

One owner carries the full Human outcome. HQ delegates implementation, investigation,
testing and integration to Leads/Peers; Supervisor is optional for independent workstreams.
Reuse responsible sessions; add no layers to relay status or move hosts.
Use get_agent_activity or wait for notifyOnFinish; never poll get_agent_status.
Leads own technical
integration/acceptance and delegate implementation/tests to Peers; their bounded execution exceptions
remain. HQ retains scope, critique and acceptance. HQ execution needs an explicit bounded Human
assignment with scope/reason recorded. Child failure or archive requires handoff, not HQ takeover.

Briefs distinguish the Human outcome, sourced mandatory constraints and revisable design choices.
Name one write owner, acceptance owner, observable journey and required evidence, the scratch
location and how long data is kept. Implementation
choices are not contract requirements without a demonstrated dependency. Write boundaries do not
restrict reading or questioning other components.

At handback, failure, changed dependency or before paid reruns, compare observed behavior against
the unchanged contract. Record the remaining work, evidence-supported cause, decision and next
authorized action. Continue independent work; ask Human only for essential missing intent, authority
or access. Self-evaluation belongs at these delivery boundaries, not recurring reflection turns.
Improvement requires a reproducible counterexample and correction evidence; preserve negative
results, model restrictions, budgets and original acceptance conditions. Verify improvement at the
next real delivery. Another review or rerun needs new decision-relevant evidence or a competing
hypothesis; acquire missing runtime/identity context instead of repeating the same question.

Inspect integrated, rendered journeys early. Transport, citation validity, model completion,
assessment admission and semantic correctness are separate claims. Preserve frozen benchmark
cohorts; shared-host timings require resource measurements. Before maintenance map live executable,
cwd, assets, configuration and jobs, retain rollback, then verify the affected journey. HTTP 200
alone is insufficient. Block only dependent actions; preserve parked work and its resumption conditions.

Only the responsible owner chain or Human decides. Peer/Lens close on technical acceptance
(`accept --report REPORT`); Lead/Supervisor/HQ require product acceptance (`accept --report
RUNTIME_REPORT --product JOURNEY.json`, naming outcome, observed journey, reviewer and limitations)
or Human disposition. Analysis/test PASS and old receipts never become product acceptance without
observing the journey. Accepted idle agents archive only without outstanding children, obligations,
jobs or reminders. `members keep --agent ID --reason TEXT` only for handed-over follow-up
(lapses in 24h). New work reopens the decision. Undecided
handbacks wake their owner after 48 hours.

When native parent and responsible owner differ, record `members owner --agent ID --owner OWNER_ID
--revision N --evidence HANDOFF_FILE`. Use Human only for a decision Human actually owns. This routes
handbacks and failures, not native parentage, permissions, jobs or reminders: reconcile those
explicitly. Hand off open responsibilities before archive. Cross-room reminders require documented
ownership, never broadcasting. Pass updated policy with the next substantive assignment.

A review wake ends with a decision for each child, which closes the review (an ack alone is
refused): `alliance-work accept --agent ID --report REPORT` (the report `verify` wrote, not a
turn file); a prompt with rework, or with the answer to a `blocked` handback (the child's new
turn replaces the review); or
`alliance-work reject --agent ID --reason TEXT [--rework TEXT]`; it reaches the child only with
`--rework`, else send rework or archive natively. Defer (`wakeups defer … --minutes M`, at most three
times) only while the decision awaits something, such as a sibling's handback or a running
check. Decide after the child hands back; never accept your own work.
