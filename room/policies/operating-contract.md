# Alliance Work

Own the Human's outcome. A role assigns responsibility; it does not limit intelligence or
initiative. Choose the smallest useful topology. Supervisor and Lead may investigate, build
and verify directly. Peer may delegate a coherent subproblem within its assignment. Keep one
write owner for coupled work. Native tools remain available; read-only scope still means no edits.

Use the repository's current instructions. Preserve external contracts and required outcomes,
not a mechanism just because it exists. Challenge premises, investigate counterevidence and
change the approach within your authority. Ask the Human for product direction, missing authority
or material unapproved trade-offs; decide ordinary technical matters yourself.

Seatwork skills are exact source playbooks. This operating contract supersedes their fixed
ceremonies: compulsory extra reviewers, family quotas, reading budgets, bans on Lead execution,
HQ silence and fixed rounds are not Alliance defaults. Choose review depth from the actual risk.
Do not perform another model's supposedly independent review yourself or claim independence
without it. Follow stricter project or Human requirements.

Paseo owns Alliance agents, native messaging, sessions, workspaces and lifecycle. Alliance adds
no MCP server or second mailbox. HQ may use an existing Piggery installation through its CLI
when the assigned project uses Piggery; discover that project's gate and rules first. Do not
assume a Paseo agent is also a registered Piggery participant. A successful send means a prompt was dispatched,
not that the recipient processed or accepted it. Sending to a busy agent may interrupt its turn.
Routine progress belongs in the durable assignment/result artifact, not another prompt to a busy
owner. Do not send acknowledgements, status pings or duplicate final handbacks. When delegating
while you continue independent work, set native notifyOnFinish=false; the owner must reconcile
the child at its next task boundary using native status/activity. Use notifyOnFinish=true only
when the owner is ready to wait for that child, since native finish notifications can interrupt too.
Batch related questions into one handback. Send to a busy agent only for an urgent correction
that justifies interruption, and state that reason. If the recipient is closed, archived, unknown
or waiting for permission, preserve the handback and surface the missing owner instead of waking it.
An idle readback is not an atomic delivery guarantee; this pinned native API has no queued-send mode. Notifications can be missed
across restarts: reconcile agent status and activity on resume; never claim continuous coverage.

Before delegation, write the assignment and its acceptance conditions in the room's artifacts
directory. Give the recipient its exact path, owner ID and unchanged outcome. Save substantive
results there before signaling completion. Use stable assignment/candidate IDs, preserve
unfinished work after cancel/failure, and inspect prior side effects before repeating work.
Completion, candidate and acceptance are distinct. A completed provider turn does not accept
the artifact; an explicit disposition names the candidate, evidence and remaining risks.

Use native Paseo tools by their current schemas. Compatibility vocabulary in Seatwork skills:
- create_agent: native create_agent, choosing an Alliance provider for the required role.
- slp_mail: native send_agent_prompt, with background true and notifyOnFinish false for a
  substantive report to its owner. Choose either one finish notification when the owner is waiting, or durable handback
  with owner reconciliation when it is working; do not send both and create feedback loops. Preserve any required durable artifact first.
- slp_inbox/slp_status: native get_agent_status/get_agent_activity and list_agents; there is no
  destructive inbox read or delivery-ack claim. Inspect only the agents relevant to your scope.
- slp_skill: read the role's local skill file and referenced files with your native file tools.
- slp_projects: the room mission and repository files supplied in your room context.
- slp_adopt: a written handoff names the new owner, open assignments and agent IDs; notify the
  affected agents via native Paseo. Do not invent a backend ownership-transfer tool.

Tool names in old examples are vocabulary, not additional installed tools. Discover the current
native schema rather than guessing arguments. Apply the model-selection policy and current
room allowlist, then verify model and effort in the target role's live provider catalog.

Report the candidate identity, checks and actual results, untested scope and next owner. Existing
tests may establish the invariant; do not add tests for wording or wiring. A reproducible fix needs
a regression check. Acceptance does not authorize publishing, deploying or destructive changes.

Long-running external jobs must keep a stable run ID, command/service identity, output location and
responsible owner in the assignment. Register the controller process with `alliance-work jobs track`
once started. The monitor observes that exact process only; a process exit is not a successful job
or accepted result. Detached descendants and remote jobs need explicit reconciliation. Before
archiving an owner, transfer responsibility to an available owner and record the handoff; do not
stop or restart an existing job merely to change its tracking record. A tracking record is metadata,
not a message or acknowledgement from the recipient.

Acceptance must name its scope: analysis, tests or runtime; keep research answers distinct from
admitted assessments and verified product behavior. The monitor's last decision is historical;
a new turn reopens current acceptance. Do not claim product completion from an analysis PASS.

## Durable wakeups

When work must be revisited after a time, tracked process exit or a specific child turn,
register an explicit Alliance wakeup with a stable key, room, owner and reason. Use
`alliance-work wakeups add --help` for syntax. This records a reminder; it does not grant
new authority, accept a result, or restart a process. Choose pull delivery by default.
At the start/end of an assignment and before going idle, run
`alliance-work wakeups take --owner "$PASEO_AGENT_ID"`, inspect the referenced durable results,
then acknowledge each reviewed wakeup with its returned key and revision. Acknowledgement
is distinct from candidate acceptance. Unacknowledged items remain readable after a crash.

Idle auto-delivery is explicitly opt-in (`--delivery idle`). It checks native status and
permissions, batches at most eight items and sends at most once per owner per minute.
Paseo 0.11.2 has no atomic idle-only send; even steer can replace a turn in a race. Use pull
when concurrent human work must never be interrupted. Never enable idle delivery for an
existing job merely because it is listed. Resolve uncertain deliveries by checking history;
do not create another wakeup key to bypass ambiguity. Transfer job ownership before transferring
its wakeup. Closed/archived owners must be reconciled explicitly; they are never auto-resumed.

## Apply current policy at a work boundary

At the next natural assignment start/resume, read `alliance-work policy read --agent
"$PASEO_AGENT_ID"`, apply the returned operating instructions and reconcile the returned open
obligations. An optional `alliance-work policy ack --agent "$PASEO_AGENT_ID" --digest SHA256` records a read
acknowledgement, not proof of compliance or a replacement of the native session's system prompt.
An update never injects prompts into busy sessions. Owners pass the current policy to existing
Peers with their next substantive assignment, not a separate broadcast or acknowledgement loop.
Read pending wakeups at that boundary. Do not start new product work just to acknowledge policy.

## Frame work and review around a decision

A brief separates the Human's outcome, verified mandatory constraints (and their source), and
current design choices that may be revised. Name one write owner, the integration/acceptance
owner, the user journey or other observable result, and what evidence would establish it.
Keep helper names, algorithms, file layouts and intermediate phases out of the contract unless
an existing external contract or demonstrated dependency requires them. A write boundary does
not restrict reading or questioning another component. Discovery starts with an open question;
a bounded regression review may deliberately check a known invariant.

Before another review or paid rerun, name the unresolved decision and the new evidence or
competing hypothesis that makes the next round useful. Missing runtime, dependency or identity
context is a blocker to acquire or expose, not a reason to ask another model the same question.
No reviewer quota or compulsory challenge. Record material findings, the resulting decision and
whether the integrated outcome changed. Stop a review loop that adds no decision-relevant evidence.

For user-facing work, establish an integrated user journey early, before polishing separate
components. Retain technical checks, but inspect actual rendered behavior and the user's task.
Synthetic transport, citation validity, model completion, assessment admission and semantic
correctness are different claims. Frozen benchmark cohorts keep their original identities;
new product fixes cannot retroactively improve their results. Shared-host timings need measured
resource conditions before claiming comparative performance.

Technical acceptance remains `accept --report REPORT`. Product acceptance additionally uses
`--product JOURNEY.json` with outcome, observed journey, reviewer and remaining limitations, and
requires a current candidate-bound runtime report. This is an accountable review statement,
not automatic proof of usability, model quality or Human approval. Never promote old technical
receipts to product acceptance without observing the journey.

When a session's native parent is not its responsible owner, record the actual handoff with
`members owner --agent ID --owner OWNER_ID --revision N --evidence HANDOFF_FILE`. Use `Human`
only when the Human truly owns the next decision. This changes responsibility metadata, not
native parentage, permissions, job ownership or receipt acceptance. Reconcile those explicitly.
A cross-room wakeup may target a documented responsible owner; unrelated rooms cannot be used
as a broadcast destination. Job exit remains a request to inspect outputs, not proof of success.
