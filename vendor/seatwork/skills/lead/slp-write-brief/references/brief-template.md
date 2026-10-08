# Brief template, read-only suffix, and a filled example

## Template (`initialPrompt`)

```text
Project: <absolute path>
Outcome: <what is usable when done, and its limits — a capability, never a technology>
Candidate: <the solution currently tried, changeable — or none>
Context: <paths and RECAP lines, never contents>
Write scope: <paths> | read-only — do not modify files
Contract / invariants: <what the API promises, valid inputs, what success means, state and data ownership, error shape, the test that proves it>
Yours to decide: everything inside the write scope the contract does not name
Constraints: <must-not-touch, rules, external-action authority>
Output: <exact shape>
Acceptance evidence: <2–4 checks>
Reopen when: <what sends it back to you>
What was tried: <on any retry: tier: approach → why it failed>
Reply with slp_mail to: owner
```

## Read-only suffix (last paragraph of every read-only brief, verbatim)

```text
This is analysis only. Do NOT edit, create, or delete any files. Do NOT write code. Do NOT spawn agents.
```

## Example: a writable brief

```text
Project: /work/echo
Outcome: the browser shows call state (ringing, connected, ended, agent status) within 300 ms of the event, in order, and rebuilds the current state after a reconnect. Nothing else.
Candidate: a persistent server → browser channel (SSE or WebSocket); changeable.
Context: src/calls/events.ts:40-120 (the event source); RECAP: events are emitted server-side only, the browser never sends over this channel; src/web/state.ts (the current polling client, to be replaced)
Write scope: src/web/state.ts, src/web/realtime/**, src/server/realtime/**
Contract / invariants: server → browser only; an event is {callId, seq, kind, at}; seq is per call and gapless; after a reconnect the client ends in the same state as a client that never dropped (test: src/web/realtime/reconnect.test.ts, to be written); a lost connection surfaces as the `disconnected` state, never as missing events
Yours to decide: everything inside the write scope the contract does not name
Constraints: no new dependency; do not touch src/calls/**; no deploy; local commits allowed on this branch
Output: CANDIDATE with the commit sha, the reconnect test green, the measured latency over ten calls
Acceptance evidence: reconnect.test.ts passes; ordering test passes; ten calls against the provider stub show every seq delivered once, latency under 300 ms on an idle machine
Reopen when: the channel cannot meet 300 ms, or "server → browser only" proves false
What was tried: —
Reply with slp_mail to: owner
```

What this brief deliberately leaves out:

- "add src/server/realtime/ws.ts and call it from app.ts": files and calls inside the scope are
  the Peer's.
- "WebSocket" in Outcome: the transport is the candidate; the delivery semantics are the outcome.
  The Peer may come back with "SSE plus HTTP commands is enough, traffic is one-way" and evidence.
- the list of edge cases: the test name carries them.
