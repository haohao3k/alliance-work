# Alliance Work contributor guidance

This repository owns the Alliance plugin, installer/CLI and generated role assets. Paseo owns
native agents, sessions, tools, workspaces and permissions. Keep its pinned SDK/CLI compatibility
and use native APIs. Do not add another coordination MCP server or message transport.

Each harness/role retains a separate home and private HOME/XDG environment. Never link or import
skills, plugins, configuration or instructions from daily profiles. Shared Codex auth is an
explicit read-only source; only access tokens reach ephemeral native app-servers. Never copy,
log, record, commit or rotate the source refresh token.

Roles assign responsibility and authority, not capability ceilings. Preserve agent initiative.
Vendored Seatwork playbooks stay byte-for-byte pinned; place local interpretation in the room
operating contract and verify provenance with `npm run verify:vendor`.

Run `npm run check` and `npm run lint` for code changes. Run `npm run test:native` when changing
harness launch/discovery or generated profile formats. Run `npm run test:maintenance` for
installer/update/recovery changes; it starts and stops only disposable native Paseo instances. Tests cover user-visible invariants and
real failure risks; do not add wording or implementation-mirroring tests. Reproduce a regression
against the prior behavior, and report added/removed test lines with the result.

Setup is `npm ci` on Node 24 (macOS or Linux). Native and maintenance tests need `codex`, `claude`
and `pi` on PATH; Pi is `npm i -g @earendil-works/pi-coding-agent`. Maintenance tests use
a temp home and a free loopback port; the installed instance defaults to 6771. Do not run
`./install.sh` or `setup` for source checks: they write `~/.alliance-work` and `~/.local/bin`.

Activation is part of installer/plugin changes: obtain fresh idle readback, run the owned
installer or `setup --refresh`, verify plugin running, health/root and the changed behavior.
Never restart a running daemon to load a plugin. Never alter the user's daily Paseo instance.
An active or unknown runtime state blocks only activation; continue independent source work.

Updates preserve credentials, sessions, rooms and native instance settings. Reject unowned paths,
modified managed files and unverified releases. Keep the previous installation usable and report
any recovery that cannot be verified. Do not silently fall back to another auth source or repo.

Document commands where users operate them: README for first use, docs/operations.md for lifecycle
and auth, docs/quickstart.vi.md for the room workflow. Keep facts in one place. The repository and
release assets remain private. No source/test-only result proves an end-to-end model handback.
