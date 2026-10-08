# `.slp/status.md` template and a status report example

## `.slp/status.md`

```markdown
# <project> — status

## Intent
<the intent record, headings as in SKILL.md>

## Decisions
| when | what | origin | reason | reached | revisable by |
|---|---|---|---|---|---|
| 2026-10-07 | SSE + HTTP commands instead of WebSocket | room (Lead realtime) | traffic one-way; reconnect is the real gap (reopen evidence in the Lead's report) | Peer realtime, Peer web | Owner |
| 2026-10-07 | no compatibility window for the store cut | owner | hard cut | Lead store → Peer store | — |

## Dissent
| when | who | objected to | evidence | disposition | open? |
|---|---|---|---|---|---|
| 2026-10-07 | Peer store | deleting the legacy reader now | three callers in scripts/ (grep) | HOLD: candidate stands — scripts/ is out of scope and goes with the cut | no |

## Room
<live Leads and their Peers, workstream state, handoffs, heartbeat present or not>

## Health
<recurring conflicts, escalations that changed nothing, reviews that found nothing, heartbeat beats and whether each sent anything>
```

One row per decision and per overruled objection; never rewrite history, append.

## Example: final message when the Owner asked for status

```text
STATUS
Asked: "the CRM shows an incoming call before the phone stops ringing" → usable now: the call popup appears within 300 ms on the staging CRM and the state survives a reconnect; the SDK package 0.3.0 is published.
- SDK: published 0.3.0 to the private registry → ACCEPTED
  - default: event schema + publish → accepted after cross-family review
- CRM call popup: popup + reconnect → OPEN (reconnect test flaky on CI)
  - default: SSE client → CANDIDATE under review
  - cheap: fixture data → accepted
Try it: `npm run dev` in crm/, call the staging number.
Evidence: popup latency 180–260 ms over ten calls on an idle machine; reconnect test green locally, red 1 run in 5 on CI; untested: the fix on CI.
Decided by the room: SSE + HTTP commands instead of WebSocket (Lead CRM; traffic one-way, reconnect is the gap; reopen evidence attached) — revisable by you.
Overruled: Peer SSE asked for a polling fallback (evidence: one corporate proxy buffers SSE) — HOLD: candidate stands; proxies are out of scope until a customer has one. Open: no.
Your last change ("no WebSocket dependency") reached Lead CRM and Peer SSE.
Drift: none.
WORKING
- Lead CRM: waiting on the CI rerun of reconnect.test.ts
  - Peer SSE: CANDIDATE under review
```
