---
name: alliance-friction
description: Investigate repeated rework, loops, stalls, collisions or unclear handbacks using room evidence and propose the smallest correction. Use on a relevant wake or observed pattern, not to judge one candidate.
---

# Friction

Friction is cost the work did not need. Find it in what happened: agents, assignments, commits, native history and durable records. An agent's account of itself is a lead to inspect, not independent proof.

## Look

Use the exact Alliance CLI from the room context and native Paseo tools with their current schemas. Read the affected work once; do not poll or repeatedly scan unrelated rooms.

- After a resume or wake, reconcile once with `alliance-work wakeups take` and native `get_agent_status` for your open children. Follow the relevant item through `get_agent_activity` and its linked assignment, result and evidence artifacts.
- In that affected work, look for an agent at rest with work open, errors or repeated attempts, handbacks awaiting a decision and answers owed. Context/usage information is evidence only when the provider exposes it.
- `alliance-work obligations list --owner OWNER`: missing prerequisites, obligations without a live owner, waiting conditions and dependencies recorded in assignments. There is no separate Seatwork issue graph or mailbox here.
- `alliance-work wakeups list`, `jobs list` and `autonomy list` when relevant: due versus ready, pending or uncertain delivery, a job without a verified outcome, exhausted budgets or a provider hold. A normal wait or quota reset is not automatically waste.
- Accepted results and commits since the relevant event: is the requested outcome advancing? Inspect native messages of the involved agents for the same question twice, a repeated challenge, or a brief repeatedly revised.
- Existing room notebook, assignment, obligation history and evidence: what was tried before on the same task? Read the actual target when an old “working” report may be stale.
- Use installation-wide `alliance-work status` only when those targeted records leave an unresolved scheduler or ownership question that requires broader scope. It has no room filter; it is not the default wake reconciliation.

## Classes

| Class | Shape |
|---|---|
| `LOOP` | the same action, error or rejection again with nothing new |
| `STALL` | work open, nobody running, nobody asked, and no deliberate wait explains it |
| `QUEUE` | work waiting on one agent's turn or on the Human; answers owed or a decision unanswered |
| `REWORK` | accepted work reopened, or a candidate rejected twice for the same kind of finding |
| `COLLISION` | two agents writing the same files, or one task briefed twice |
| `CONTRADICTION` | two instructions in force that cannot both hold: brief and decision, or two briefs |
| `GAP` | work nobody owns, or breakage or a workaround noted in a report with no next owner/action |
| `PROXY` | checks green while the outcome is missing; acceptance evidence a stand-in can pass |
| `AUTHORITY_LEAK` | an agent deciding outside its grant, or a correction bypassing the responsible owner |
| `GHOST_CAPABILITY` | a brief asks for an unavailable tool, permission, provider or other capability |
| `RESULT_OPACITY` | a report its reader cannot act on without reconstructing the transcript |
| `CEREMONY` | turns, prompts or review rounds that changed no outcome |
| `LAW` | evidence contradicts an applicable engineering law or assignment constraint |

## Close each candidate

- **Reachable, not merely representable.** Show it happened; otherwise call it a risk, not a measured incident.
- **Verified**, **dismissed** (with why), or **unverified risk** (what is missing and the one check that settles it).
- Rule out a legitimate wait, changed requirement, known infrastructure limit and an innocent reading before attributing waste.
- The same class twice is evidence of a pattern; one incident can still justify its own correction. Do not wait for a second failure to repair a demonstrated fault, or add a universal policy from one incident.

## Correct

Fix at the earliest layer that removes the cause, and say which one you chose. Apply the existing engineering laws and authority for this work; a new check or rule can change what agents do instead.

1. **Structure:** something code could stop, such as a guard, check or configurable limit. Implement within an authorized source task, or give the responsible implementation owner the trace and proposed change.
2. **The brief or plan:** wrong scope, missing contract or collision. Reconcile with its owner using the evidence and the needed change.
3. **The agent:** a one-off breach. Send the responsible owner a concise correction when communication is authorized; do not spawn intervening roles or interrupt busy work for routine reporting.
4. **Words:** a prompt or skill rule last, for a judgment call a structural correction cannot address. Use `alliance-learn-from-failure` when testing a reusable correction is warranted.

Read the same signal after enough relevant work before calling it fixed. No change is not an improvement; counts need a denominator, workload and observation window. A policy acknowledgement, green test or accepted candidate does not by itself prove changed agent behaviour.

Preserve the correction, evidence, next owner and open questions in the existing handback or material obligation. If a future observation is needed, use `alliance-work wait` or an appropriate durable wakeup and end the turn. Do not create another scheduler or mailbox, or poll while waiting. Deployment or broader policy changes still need the authority of the actual task.

## Report

Each friction with its class, evidence and correction; what changed since the last observation; what remains open and who owns the next action. Separate measured facts, inference and unverified risks. Use the normal room handback rather than an extra status round.

This Alliance adaptation retains the upstream taxonomy and correction method; attribution and changes are in [NOTICE.md](NOTICE.md).
