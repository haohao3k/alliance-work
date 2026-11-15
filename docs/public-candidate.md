# Public 0.1.55 candidate

This candidate advances the public source to the reviewed 0.1.55 feature set on public history:

- Durable ownership, evidence-bound acceptance, wakeup recovery and idle readback without repeated
  provider resumes when activity is unchanged; quota recovery retains the original reset deadline.
- Native Claude account switching and quota visibility, context controls, opt-in owner keepwarm,
  project model policies, per-project MCP and bundled-skill selection across supported harnesses.
- Read-only usage/cache/cost reports with explicit partial coverage on older Node; disk inventory,
  guarded worktree/scratch cleanup, retained job history and safe release cleanup.
- Runtime maintenance holds and recovery, public installer/update/deploy defaults, and pinned
  Paseo CLI/client/plugin 0.15.4 with Pi 1.5.0.

Installer, update and release defaults target `haohao3k/alliance-work` and require public
visibility (`private=false`). Public Peer defaults use seven configured routes; personal endpoint
routes are excluded. User-defined providers remain supported.

The candidate excludes private Git history, runtime homes, credentials, host data, personal setup
helpers and internal integration notes. The fourteen same-name Seatwork adaptations with
unestablished redistribution rights are excluded; the pre-existing public vendor bundle remains
unchanged. Optional override behavior is tested with original synthetic fixtures. Attributed
playbooks retain their existing notices and provenance. The two AGY upstream `.txt` files are
source snapshots matched to the npm package and immutable Paseo revision, retained with the
Apache-2.0 license, provenance and modified-file notices. They are not development transcripts.

Publication requires the source/native/maintenance/lint gates, an unpacked archive check and the
tracked Gitleaks plus TruffleHog pre-push gate. Historical-reader checks skip only when their
historical commit is unavailable. A source push does not itself establish deployment or model
handback; those require separate evidence. Existing published tags remain immutable.
