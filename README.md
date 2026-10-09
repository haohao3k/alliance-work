# Alliance Work

Autonomous agent rooms on native Paseo, with separate Codex, Claude Code and Pi homes for
HQ, Supervisor, Lead, Peer and Lens. Roles define responsibility; agents retain their native
reasoning and tools. Start with one Supervisor and let the work determine the team.

[Hướng dẫn sử dụng tiếng Việt](docs/quickstart.vi.md) · [Installation, auth and updates](docs/operations.md)

## Install

Requires macOS or Linux, Node 24+, npm, Codex 0.160.0+, Claude Code 2.1.289+ and Pi 1.0.0+.
Paseo **0.10.3** is pinned and installed locally with the package. The repository is private;
GitHub downloads require `gh auth login` with access to `haohao3k/alliance-work`.

From this checkout:

```sh
./install.sh --codex-auth-from "$HOME/.codex"
```

From a published GitHub release, without a checkout:

```sh
gh release download --repo haohao3k/alliance-work --pattern install.sh --dir /tmp/alliance-installer --clobber
sh /tmp/alliance-installer/install.sh --codex-auth-from "$HOME/.codex"
```

The release installer verifies the archive checksum, installs its locked dependencies, checks
the candidate and registers `~/.local/bin/alliance-work`. Add `~/.local/bin` to your PATH if it
is not already there. Installation opts into the trusted Alliance plugin on its own dedicated
Paseo instance; it preserves existing daily Paseo installations.

Open **http://127.0.0.1:6771 → Alliance Work**, create a room with an absolute project directory,
and give its Supervisor an outcome, scope and acceptance criteria. The selected home is saved
in native plugin settings and survives a daemon restart.

## Authenticate once for all Codex roles

```sh
alliance-work auth codex --from "$HOME/.codex"
alliance-work auth status
alliance-work doctor
```

Shared auth covers **HQ, Supervisor, Lead, Peer and Lens**. Alliance reads the original Codex
access token and supplies it to each native app-server in memory. It copies no refresh token,
creates no auth symlink and imports no daily skills, plugins, MCP configuration or instructions.
Each role keeps its own `CODEX_HOME`, configuration and session history.

The original Codex owns token renewal. Alliance rereads that source when native Codex asks for
refreshed credentials; if no fresh token is available, it fails explicitly. Use the original
Codex to refresh its login, or run `codex login` there, then resume. This integration uses the
experimental native external-token API and is tested against Codex 0.160.0. Shared auth applies
to Paseo app-server sessions. See [auth and separate logins](docs/operations.md#authentication)
for standalone Codex, Claude and Pi.

## Maintain

```sh
alliance-work setup                 # installed profile/runtime status
alliance-work setup --refresh       # regenerate managed assets and hot reload when idle
alliance-work update --check        # inspect latest GitHub release without changing files
alliance-work update                # stage, verify and activate a release
alliance-work rollback              # reactivate the previous recorded installation
alliance-work doctor
```

Updates preserve room artifacts, credentials, sessions and native listen/relay/WebUI settings.
They refuse to reload while agents or workspace scripts are active, preserve handwritten
profile changes by refusing to overwrite them, and never restart a running daemon. Candidate
failures restore managed files; any failure to verify live recovery is reported. Releases and
managed-file backups remain under the Alliance home for recovery. See the
[operations guide](docs/operations.md) for exact boundaries and troubleshooting.

## Homes and isolation

| Path | Contents |
| --- | --- |
| `~/.alliance-work` | Installation record, profile manifest, room artifacts, releases and backups |
| `~/.codex-alliance-work/<role>` | Independent Codex configuration and sessions |
| `~/.claude-alliance-work/<role>` | Independent Claude configuration and credentials |
| `~/.pi-alliance-work/<role>` | Independent Pi configuration and credentials |
| `~/.paseo-alliance-work` | Dedicated native Paseo instance |
| `~/.local/bin/alliance-work` | Managed CLI launcher |

Private HOME/XDG directories prevent automatic discovery of the daily `~/.agents/skills` and
other user configuration. This also separates implicit Git/SSH configuration; configure needed
access explicitly. Home isolation is a loading boundary, not an OS filesystem sandbox.

Codex disables discovered skills outside the selected role and non-Paseo MCPs. Claude uses
only role settings, strict MCP configuration and disables cloud/bundled skills and plugins.
Pi receives explicit Seatwork skills and its native Paseo-required extensions. Repository task
instructions remain relevant; machine-managed policy is not bypassed.

## Rooms, delegation and acceptance

Paseo owns agents, workspaces, native MCP, conversations and lifecycle. Alliance adds the room
surface, durable assignments, role context and explicit candidate acceptance. It has no Piggery
runtime dependency, extra MCP server or second message transport.

One checkout has one room. Git worktrees can join an unambiguous matching room. Persist the
brief before native delegation; keep results and candidate identity before signaling completion.
The operating contract maps Seatwork vocabulary to native Paseo tools without adding aliases.

Sending a native prompt can interrupt active work. Notifications and lifecycle hooks are best
effort and are not replayed after an outage. Reconcile saved artifacts and native history on
resume. A completed turn does not accept its artifact: **Disposition** records a candidate and
evidence, and a new turn reopens current acceptance while preserving earlier decisions.

## Development

```sh
npm ci
npm run check
npm run lint
npm run test:native
```

Default tests do not call models. Native tests inspect actual Codex/Claude/Pi discovery and
require their binaries. A model delegation/handback exercise needs usable participating
credentials and is a separate acceptance check.

`vendor/seatwork/provenance.json` pins 18 selected skills / 22 files to commit
`fa540f47efb4344396a1eb532d3d6164a7056b9c`; their playbook bytes remain unchanged. Pi uses generated
valid metadata pointing to those originals. This private project's provenance does not grant
redistribution rights. Release packaging and contributor guidance are in [AGENTS.md](AGENTS.md)
and [operations](docs/operations.md#releasing).
