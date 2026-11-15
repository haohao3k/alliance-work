# Qualified Paseo 0.15.4 idle retirement

Paseo 0.15.4 exposes only an interrupting session reload to plugins. Checking idle in the
plugin and then calling reload races incoming prompts. This private compatibility patch adds
`idleAccountSwitch` capability negotiation and an `idleOnly` branch on the existing native
refresh RPC. The branch retires a process through the native runtime-cleanup capability;
it never unarchives, cancels, reloads, sends prompts, changes ownership or edits persistence
records directly. Native resume still owns the conversation and transcript.

`scripts/paseo-idle-retirement.mjs` is the readable method embedded in the pinned AgentManager.
`scripts/paseo-0.15.4-idle-switch.json` records exact upstream before/after SHA256 and the narrow replacements. `npm ci`
applies it only to this release's dependencies. Unknown hashes abort before any write; running
processes and other installations are not patched. Tests exercise the patched native lifecycle
owner and its final eligibility guard, plus the client capability gate.

The daemon must start from these qualified dependencies to advertise the capability. A plugin
hot reload cannot add it. Do not restart a running daemon to load this change. Preserve active
jobs; wait for a native idle maintenance window before an owned stop/start. Until then the UI
reports unsupported automatic switching and keeps old processes intact. No ordinary reload
fallback is allowed. The public edition is unaffected.

Remove this compatibility patch once an upstream native guarded-retirement API is qualified.
