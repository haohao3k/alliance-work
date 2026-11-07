# Seatwork on Alliance

Use the pinned playbooks for judgment, with this mapping for their backend vocabulary. The room
context supplies the checkout, artifacts directory, skill paths and CLI. Paseo owns sessions and
messaging; artifacts hold durable work.

| Seatwork reference | Alliance meaning |
| --- | --- |
| `create_agent` | Native create_agent with the Alliance provider of the required role. |
| `notifyOnFinish: false`, "their mail wakes you" | Keep notifyOnFinish on. Children send no mail: they hand back by checkpoint, and Alliance wakes you. |
| Brief line `Reply with slp_mail to: owner` | Write instead: `Hand back: alliance-work autonomy checkpoint --phase review --reason TEXT; send no prompt.` |
| `slp-feature-intake` | Judgment, not a tool: restate the outcome, assess uncertainty and risk, choose the smallest useful proof. Write an ExecPlan only when the work needs one. |
| `slp_room_stats` | Native agent status/activity plus the room's assignment, turn and disposition artifacts; report missing data as unknown. |
| `slp_projects` / room registry | Native workspaces plus Alliance rooms; onboard by opening the checkout with an Alliance profile. |
| `.slp/room.json` model table | The room model policy in your context; use native provider discovery for models and efforts. |
| `.slp/mission.md`, `.slp/status.md`, `.slp/plans/`, `.slp/notebook.md` | The project's own documents when they exist; otherwise the same names in the room artifacts, only when continuity needs them. |
| `~/.config/slp-room/NOTEBOOK.md` | `notebook.md` in the HQ room artifacts, linking project evidence; never a daily-profile notebook. |
| `slp_adopt` | A written handoff (`members owner`) and a native prompt to the affected agents; there is no reparent tool. |
| `slp_skill` | The role's local skill file and its references, read with native file tools. |
| `ACCEPT` | `alliance-work accept --agent ID --report PATH` is the whole act; a chat sentence records no disposition. Send the agent nothing after it: sending reopens the decision. |

Native session opening creates an assignment pointer before execution; Paseo's hook does not
expose the initial prompt, so link a substantive brief from that pointer when delegating. Use
`alliance-verify` when recording candidate evidence; the runner may differ from the candidate's
author. Dispositions recorded before bound reports stay historical decisions.

Project skills are registered in `.alliance/skills.json` under `.agents/skills/`; `alliance-work
skills list` shows the selection. New sessions load it; running sessions keep their context.
Skill changes are ordinary project work, not permission to edit pinned Seatwork or the Human's
daily profiles.
