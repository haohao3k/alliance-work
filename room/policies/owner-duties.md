# Owner duties (HQ, Supervisor, Lead)

Peer is the default owner of substantive implementation, investigation and tests. For one bounded
task, use one Peer; add a Lead only for a real framing, integration or acceptance responsibility,
a Supervisor for independent workstreams and HQ for cross-project decisions or dependencies.
Never instantiate every level just to relay the same assignment or status. You may inspect,
verify, make a small local fix or directly resolve a difficult technical decision; delegate
sustained implementation to an economical Peer, and record a reason when you execute directly.

A brief separates the Human's outcome, verified mandatory constraints (and their source), and
current design choices that may be revised. Name one write owner, the integration/acceptance
owner, the user journey or other observable result, and the evidence that would establish it.
Keep helper names, algorithms, file layouts and intermediate phases out of the contract unless an
external contract or demonstrated dependency requires them. A write boundary does not restrict
reading or questioning another component.

Before another review or paid rerun, name the unresolved decision and the new evidence or
competing hypothesis that makes it useful. Missing runtime, dependency or identity context is a
blocker to acquire or expose, not a reason to ask another model the same question. Record
material findings, the resulting decision and whether the outcome changed; stop a review loop
that adds no decision-relevant evidence. For user-facing work, establish the integrated user
journey early and inspect actual rendered behavior. Synthetic transport, citation validity, model
completion, assessment admission and semantic correctness are different claims. Frozen benchmark
cohorts keep their original identities; shared-host timings need measured resource conditions.

Deciding closes work, and only the responsible owner chain or the Human decides. A Peer or Lens
closes on its owner's technical acceptance (`accept --report REPORT`). A Lead, Supervisor or HQ
closes only on product acceptance by its owner (`accept --report RUNTIME_REPORT --product
JOURNEY.json` with outcome, observed journey, reviewer and remaining limitations) or on the
Human's decision. Name the accepted scope: an analysis or test PASS is not a product journey, and
old receipts are never promoted without observing it. An accepted agent is archived once idle with
no outstanding children, obligations, jobs or reminders; `members keep --agent ID` keeps it open.
New work reopens the decision. A handback nobody decides on for 48 hours wakes its owner.

When a session's native parent is not its responsible owner, record the handoff with `members
owner --agent ID --owner OWNER_ID --revision N --evidence HANDOFF_FILE`; use `Human` only when the
Human truly owns the next decision. OWNER_ID then receives this agent's handbacks, including every
turn it ends without a checkpoint and every failed turn; native parentage, permissions, jobs and
reminders do not move: reconcile those explicitly. Before archiving an owner, hand its open
responsibilities to an available owner. A cross-room reminder may target a documented responsible
owner; unrelated rooms are not a broadcast destination. Pass current policy to existing Peers
with their next substantive assignment, not a separate broadcast.
