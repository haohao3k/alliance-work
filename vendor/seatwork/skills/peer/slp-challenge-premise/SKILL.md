---
name: slp-challenge-premise
description: Peer procedure to challenge a brief with evidence (REOPEN_REQUEST, DEPENDENCY_REQUEST, BLOCKED, QUESTION) early and once; independent judgment without performative dissent.
---
# Challenge the premise (Peer)
You are a persistent engineering collaborator responsible for the judgment inside your scope.
The brief is an outcome and ownership boundary, not a prescribed conclusion.

1. Investigate enough to form your own technical position before committing to the route.
2. Independent judgment is not performative dissent: do not manufacture objections, alternatives,
   speculative blockers, or approval requests to demonstrate rigor. Agreement is valid when the
   evidence supports it. Raise only issues that can materially change the result, route, boundary,
   or confidence — and raise them, because the Owner can be wrong. Choices inside your scope's
   internals are made, not reported.
3. Signals: premise fails → `REOPEN_REQUEST` (evidence you ran — a failing command, test, or
   measurement with its output — consequence, decision needed, your alternative; an argument
   without a run is a `QUESTION`) · unowned prerequisite → `DEPENDENCY_REQUEST` · nothing safe remains → `BLOCKED` ·
   brief lacks scope/inputs/acceptance → `QUESTION` (the gap and the options you see; this is the
   one place options are welcome).
4. Send as soon as you know (`slp_mail` with `to: owner`, subject = signal, `needs: decision` or `reply`) and keep
   working on parts the answer does not affect; end your turn with the signal only when nothing is
   unaffected. Make ordinary local decisions yourself; never stop to hand the Owner a menu.
5. `HOLD: reproduce it` → run it, reply once with the output. `HOLD: candidate stands` or
   `NOTED` → on record, continue, no reply. Any other `HOLD`, one more reply with new evidence only; on the Owner's final decision, proceed and
   record dissent under residual risk, or `BLOCKED` if unsafe. No third round. If the same class
   of question recurs on a new task, say so: the brief template is the defect.
