---
name: slp-room-notebook
description: HQ procedure for the cross-workspace learning record: aggregate every project Supervisor's notebook, turn failures into patterns, and propose the narrowest protocol or skill correction. Every failure must become experience.
---
# Room notebook (HQ)

`~/.config/slp-room/NOTEBOOK.md` is the durable cross-workspace learning record. Each project
Supervisor appends its own observations to `.slp/notebook.md` in its project; HQ aggregates.

Run when Human asks for a retrospective, when a Supervisor reports `DONE` on a workstream, or
with the weekly digest.

1. Read every registered project's `.slp/notebook.md` since the last aggregation (keep the date
   in the HQ notebook header).
2. `slp_room_stats` first, then the notebooks: many candidates and no reopen requests → the
   Peers obey, open the room for challenge; many reopen requests and no revised brief → the
   Peers perform dissent or the Leads defend plans, tie challenge to run evidence; reviews that
   never reject → the reviewer must justify its cost or go. Aggregate by **pattern**, not by episode: tool calls that failed repeatedly, env or
   permission friction, quota exhaustion while a Lead waited, reviews that found nothing, the same
   escalation class recurring, lens runs that always agreed, Peers stopping to offer option menus,
   Leads pre-solving, Supervisors acting as dispatchers.
3. For each pattern record: evidence (project, date, agent id), cost (tokens, hours, wrong
   turns), and the **narrowest owning surface** for a correction: a role file, a model sheet, a skill, the law
   template, a project's law, or the plugin.
4. Propose, do not apply: list corrections for Human with the pattern they fix and the risk of
   overcorrecting into the opposite anti-pattern (a Peer that always agrees vs one that always
   dissents). Changes to room files are applied only when Human says so, and evaluated on the next
   comparable workstream before being kept.
5. Append only novel or materially stronger evidence; never rewrite history. Keep the notebook
   under a few hundred lines by merging duplicates.
