# Public source update

This candidate advances the public 0.1.18 source to the reviewed 0.1.34 feature set:

- Project cards collapse by default, with compact status summaries and expandable details.
- Native workspace/session naming follows project, role and assignment context.
- Per-project MCP settings and skill selection apply across native harnesses.
- Account selection and quota reporting keep credential values out of configuration and RPCs.
- Durable ownership, wakeup recovery and process identity checks preserve unfinished work.
- Paseo CLI/client/plugin 0.15.3, Pi 1.5.0 and updated runtime dependencies are pinned.
- Gitleaks and TruffleHog are required by the tracked pre-push hook.

The public branch is based on its existing public history. It does not import private Git
history, host snapshots, runtime homes, credentials, personal setup helpers or internal
integration notes. Fourteen additional same-name Seatwork adaptations are not included because
their redistribution rights have not been established. The pre-existing pinned bundle remains
unchanged. The three new attributed playbooks carry their MIT/Apache notices and provenance.

Installer and update defaults target `haohao3k/alliance-work`. A source push is not a tagged
release or fleet deployment. Existing release tags remain unchanged.
