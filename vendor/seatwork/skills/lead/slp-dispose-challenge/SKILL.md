---
name: slp-dispose-challenge
description: Lead procedure for a Peer's REOPEN_REQUEST or BLOCKED. Demands run evidence, questions the redesign, gives exactly one disposition (HOLD: reproduce it, REVISED BRIEF, HOLD: candidate stands, NOTED, or DECISION_NEEDED), re-briefs the owners a change touches, records the dissent. Use on every challenge; never debate without it.
---
# Dispose of a challenge (Lead)

A challenge is a finding, not a vote: one disposition, recorded, then back to work.

1. Evidence first. The mail must carry something the Peer ran: a failing command, test, or
   measurement with its output. An argument alone → reply `HOLD: reproduce it — <the one check
   that would show it>`, once, no debate; the Peer answers with the output or drops it.
2. Question the redesign the way you question a brief: under which conditions does the failure
   occur · is a small fix inside the current candidate enough · which responsibilities does the
   alternative drop, which does it add, and who owns them.
3. Exactly one disposition (`slp_mail`, `reply_to` the challenge):

| The finding | Disposition |
|---|---|
| changes the decision | `REVISED BRIEF`: plan updated in `.slp/status.md`; every owner whose contract moved re-briefed; the reopening evidence added to the acceptance evidence, so the fix is proved on the code that gets accepted (`slp-accept-candidate`) |
| another route, also valid | `HOLD: candidate stands, not a defect — <one line why>`; no round |
| not worth the interruption | `NOTED: <one line>`; continue |
| would change what the outcome delivers, a non-goal, or authority | `DECISION_NEEDED` in your report: gap, options, recommendation, consequence; the Peer gets `DEFER <checkpoint>` meanwhile |

4. On any other `HOLD` the Peer may answer once with new evidence; then decide and record the
   dissent in `.slp/status.md` and your report. A second material disagreement → one `[Lens]`
   tie-break (`slp-lens`); never a third round. A Peer's `BLOCKED` after your decision →
   concede, reassign the scope to a fresh Peer with the dissent in `What was tried`, or report
   `BLOCKED`.
5. The same class of challenge from a second Peer is a brief defect: fix the template line that
   produced it before the next brief.

## Examples

- Brief: "implement the WebSocket server for call state". Peer: traffic measured one-way over
  ten calls, the real gap is state rebuild after reconnect; log attached. → `REVISED BRIEF`:
  outcome restated as the delivery semantics, transport demoted to candidate; the reconnect
  check joins the acceptance evidence.
- Peer: "the store mixes concerns; it should be two modules". No failing check, nothing another
  component depends on. → `HOLD: candidate stands, not a defect — organization inside your scope
  is yours; split it if it helps you`.
- Peer: "the names in the brief do not match the repo's convention". → `NOTED: follow the repo
  convention`.
- Peer: "the cut cannot keep the old reader; the law says hard cut, the brief implied a
  compatibility window". A compatibility window is a product decision → `DECISION_NEEDED`;
  `DEFER` the Peer to the answer.
- Peer: "this approach is wrong, a message bus would be cleaner", no run. → `HOLD: reproduce it —
  show one behavior the current candidate cannot deliver, with the command`.
