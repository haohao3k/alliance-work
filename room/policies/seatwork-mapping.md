# Seatwork on Alliance

Use the pinned playbooks for judgment, with this mapping for their backend vocabulary.
The current room context supplies the checkout, artifacts directory, skill paths and CLI.
Paseo owns sessions and messaging; artifacts hold durable work. A role never imposes an
extra review round, model family, task count or mandatory planning document.

| Seatwork reference | Alliance meaning |
| --- | --- |
| `slp-feature-intake` | Restate outcome, assess uncertainty/risk and choose the smallest useful proof. This is judgment here, not an installed skill/tool. An ExecPlan is useful only when the work needs one. |
| `slp_room_stats` | Read relevant native agent status/activity and the room's assignment, turn and disposition artifacts. Report missing data as unknown; there is no statistics RPC or inferred token count. |
| `slp_projects` / room registry | Native workspaces plus Alliance rooms. Onboard by opening the target checkout with an Alliance profile; room creation is automatic. |
| `.slp/room.json` model table | Current room model settings supplied in context. Use native provider discovery for available models/efforts. |
| `.slp/mission.md` | `mission.md` in the current room artifacts directory. Existing project-owned mission documents remain inputs; link them instead of duplicating them. |
| `.slp/status.md`, `.slp/plans/` | Use an existing project plan if there is one. Otherwise use `status.md` / `plans/` in current room artifacts, only when continuity needs them. |
| `.slp/notebook.md` | `notebook.md` in current room artifacts; link any existing project notebook. |
| `~/.config/slp-room/NOTEBOOK.md` | `notebook.md` in the HQ room artifacts. Aggregate links to project evidence; never write another daily-profile notebook. |
| `slp_adopt` | Written owner handoff and native notification to affected agents. There is no backend reparent/adoption tool. |
| `slp_mail`, `slp_inbox`, `slp_status` | Native messaging/status/activity as described in the operating contract. Old example arguments are not current API schemas. |
| `ACCEPT`, `.slp/status.md` acceptance | Owner's technical decision recorded with `alliance-work accept --agent ID --report PATH`; a chat sentence alone does not create a verified disposition. |

Native session opening creates an assignment pointer before execution. The native conversation
retains exact user messages; link a substantive brief from that pointer when delegating.
Session opening cannot capture an initial prompt that Paseo's hook does not expose.

Use `alliance-verify` when recording candidate evidence. The runner's model/agent may differ
from the candidate's author: Lead may run checks directly. Accept only the scope the checks
actually establish, and retain unverified scope in the decision. Tests/analysis can establish
their own claims; they cannot be relabeled as runtime UI proof. Acceptance does not publish,
merge or deploy. Existing dispositions predating bound reports are retained as historical
decisions, not retroactively upgraded to verified evidence.

Project skills are explicitly registered in `.alliance/skills.json`, under `.agents/skills/`.
Use `alliance-work skills list` to inspect the selected skills and revision. New sessions load
the selection; a running session keeps its context. Skill changes are ordinary project work,
not permission to edit pinned Seatwork or the Human's daily profiles.
