---
name: slp-candidate-handoff
description: Peer procedure to hand over writable work as an immutable CANDIDATE with base, paths, verification, evidence, residual risk, and ownership.
---
# Candidate handoff (Peer)
1. Freeze it: commit if the brief allows; otherwise `git diff --binary <base> -- <paths> >
   /tmp/<slug>-<base>.patch` and `shasum` it.
2. First line `CANDIDATE: <one line of what is usable>`. Then: identity (sha), original base,
   complete changed paths, verification (environment, exact commands, actual results, last lines
   only), durable evidence locations, residual risk, untested scope, `write ownership: retained |
   relinquished`.
3. Every test you changed or deleted: one line each, why. Every `TEMPORARY:` marker: its removal
   condition.
4. Anything outside your scope → `Suggestions`, not the diff.
5. End with `RECAP: <what you did> → <artifact>`; end your turn. Do not accept your own
   difficult change: the Owner decides.
