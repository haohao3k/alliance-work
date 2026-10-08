---
name: slp-intent-record
description: Supervisor procedure to turn the Owner's request into the intent record, which is also the instruction every Lead receives: project, outcome, non-goals, verified constraints, open assumptions, decisions made vs questionable, authority, acceptance evidence, inputs, current candidate, reopen conditions, lane.
---
# Intent record (Supervisor)

Use before launching a Lead and whenever the Owner changes direction. Run `slp-feature-intake`
first to know the lane. The record is kept in `.slp/status.md` under `## Intent`; decisions and
overruled objections accumulate under `## Decisions` and `## Dissent` (template, and an example
of the status report built from them: [references/status-and-report.md](references/status-and-report.md)); each Lead's
`initialPrompt` is its workstream's slice of the same record, so the headings are identical:

```text
Project: <absolute path of the project root>
Outcome: <usable capability when done, and its limits — not a technology>
Non-goals: <what is out of scope>
Verified constraints: <must-not-touch, rules, deadlines — each one checked>
Open assumptions: <what nobody has checked yet>
Decisions made: <settled, with the reason> · Decisions the Lead may question: <...>
Authority: <what the Lead may do without asking: edit, commit on <branch>, ...; anything not listed is not granted>
Acceptance evidence: <2–4 checkable conditions>
Inputs: <accepted inputs, paths, prior decisions, contracts with other workstreams>
Current candidate: <the solution the Owner named, if any — marked changeable>
Reopen when: <conditions that bring this back for a decision>
Lane: tiny | normal | high-risk
```

0. Unknown ground first. An `Outcome` that arrives as a technology ("a WebSocket server"), or
   constraints nobody verified from the repository or the domain → launch no Lead. One
   `[Peer:research]` (read-only, provider and thinking from your role file) maps the vocabulary
   (the concepts, how they relate, what the system owns and what a provider or a process owns)
   and sorts every claim into verified / assumed; its `REVIEW` comes back as mail. Put the open
   questions to the Owner. Only then fill this record, with the technology demoted to `Current
   candidate`. Example: "Echo needs a WebSocket server" becomes `Outcome: the browser shows call
   state within 300 ms, in order, and rebuilds it after a reconnect`, `Current candidate: a
   persistent server → browser channel (changeable)`.
1. A heading you cannot fill → one precise question to the Owner before launching. A request
   to preserve product vision does not by itself prescribe a UI layout: do not route ambiguity
   as a constraint.
2. Strip every private detail: no transcript, no attribution, no "the user said", no mention of
   the Owner, other Leads, or this seat. The Lead must be able to delegate the instruction
   without passing on the conversation.
3. When the Owner changes direction, update the record first, then mail the affected Leads the
   changed lines as a new instruction.
