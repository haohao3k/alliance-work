---
name: slp-accept-candidate
description: Lead procedure on every CANDIDATE: identify the artifact, check scope and evidence, get the independent cross-family review, close the loop with an explicit disposition.
---
# Accept or reject a candidate (Lead)
1. Identity: commit sha or snapshot patch + sha, base, changed paths; anything else → `REJECT`
   asking for the identity.
2. Scope: paths outside the brief → `REJECT` with "move or justify".
3. Evidence item by item against what the Peer actually ran. Passing tests prove the tests, not
   the outcome; a test change needs its one-line justification; a weak
   proof route → `slp-test-proof-debt-audit` by a reviewer before accepting the claim. A
   candidate that answers a `REVISED BRIEF` re-runs the evidence that reopened it: the fix is
   proved on the code that gets accepted, not on the argument that won. A `TEMPORARY:` marker
   without a removal task in the plan → add the task now or `REJECT`.
4. Implementation work → a fresh `[Peer:review]` from the other model family (provider table in your role) with
   the candidate identity, the acceptance evidence, and one bounded question; security-sensitive
   change → two reviewers in parallel. The reviewer asks whether contract, invariants and outcome
   hold, not whether the code matches the plan. End your turn; the review mails you.
5. Findings you agree with → `REJECT <candidate>: <reason> + repair`; new candidate → same
   reviewer, fixes only; at most two rounds.
6. `ACCEPT <candidate>: <reason>` by `slp_mail` with `needs: nothing`; release or keep write
   ownership explicitly; update `.slp/status.md`; pick the next ready task. Technical acceptance
   never authorizes push, merge, or deploy. The workstream's last candidate → the integrated
   check from your role file before `DONE`.
