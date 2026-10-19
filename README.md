# Alliance Work

Autonomous agent rooms on native Paseo, with separate Codex, Claude Code and Pi homes for
HQ, Supervisor, Lead, Peer and Lens. Roles define responsibility; agents retain their native
reasoning and tools. Start with one Supervisor and let the work determine the team.

[Hướng dẫn sử dụng tiếng Việt](docs/quickstart.vi.md) · [Installation, auth and updates](docs/operations.md) · [Video demo](https://github.com/haohao3k/alliance-work/releases/download/v0.1.3/alliance-work-demo.mp4)

## Install

Requires macOS or Linux, Node 24+, npm, Codex 0.160.0+ and Claude Code 2.1.289+.
Paseo **0.11.2** and Pi **1.0.0** are pinned and installed locally with the package. The repository is private;
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

Open a project in Paseo and start an **Alliance** profile. A missing room is created automatically;
an existing room is reused, including an unambiguous matching Git worktree. Give the agent its
assignment in the native chat. **Alliance Work** is the live monitor: status, project filters and
**Open** to jump to a session. **Add project** provides host-local folder completion when needed.
The dedicated installation defaults to **http://127.0.0.1:6771**; existing installations keep their port.

## Authenticate once for all Codex roles

```sh
alliance-work auth codex --from "$HOME/.codex"
alliance-work auth status
alliance-work doctor
alliance-work status                # owners, current acceptance, prior decisions and jobs
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

Codex discovers skills against the bound room directory, disables skills outside the selected
role and blocks account-synced plugins/apps as well as non-Paseo MCPs. Claude uses
only role settings, strict MCP configuration and disables cloud/bundled skills and plugins.
Pi receives explicit Seatwork skills, native Paseo-required extensions and the approved
[provider packages](docs/operations.md#pi-runtime-and-provider-packages). Repository task
instructions remain relevant; machine-managed policy is not bypassed.

## Rooms, delegation and acceptance

Paseo owns agents, workspaces, native MCP, conversations and lifecycle. Alliance adds the room
surface, durable assignments, role context and explicit candidate acceptance. It has no Piggery
runtime dependency, extra MCP server or second message transport. HQ can still use the installed
Piggery CLI for projects that already coordinate through it.

One checkout has one room. Git worktrees can join an unambiguous matching room. Persist the
brief before native delegation; keep results and candidate identity before signaling completion.
The operating contract maps Seatwork vocabulary to native Paseo tools without adding aliases.

Each room's **Models** settings control the Peer/Lens allowlist, effort and preferences by task
difficulty. Lead chooses worker models within that policy; Supervisor/HQ can intervene. Lead
prefers GPT-6 Astra or Claude Opus 5.5 at medium/high but may choose any supported model/effort.
Settings govern new Alliance launches; native
in-session model changes are outside the current SDK gate. See the [room workflow](docs/quickstart.vi.md#model-theo-room).

Sending a native prompt can interrupt active work. Notifications and lifecycle hooks are best
effort and are not replayed after an outage. Reconcile saved artifacts and native history on
resume. A completed turn does not accept its artifact: explicit acceptance records a candidate and evidence. The monitor does not turn an idle agent
into an accepted result; older disposition artifacts and RPCs remain available.

## Project skills and bound evidence

Register project-owned skills explicitly; every role can use them when relevant:

```sh
alliance-work skills add .agents/skills/verify-app --project /path/to/project
alliance-work skills list --project /path/to/project
```

The versioned `.alliance/skills.json` selection loads on fresh Codex, Claude and Pi sessions.
References/scripts remain beside their skill. Daily profiles and unrelated project settings,
hooks and MCPs stay excluded. Lead chooses the approach; registration adds no mandatory ceremony.

Run an owner-chosen check and retain its report:

```sh
alliance-work verify --scenario persistence --kind runtime --target local-test-instance --input .env.local -- npm run test:e2e
alliance-work accept --agent CANDIDATE_OWNER_ID --report /absolute/report.json
```

`verify` defaults to `--kind test`. Its report binds the checkout, HEAD, tracked/non-ignored
untracked files, explicit inputs and artifacts to the actual command result. Reports live
outside the candidate tree. For non-Git deliverables, name candidate files with `--input`.
The owner can run checks directly, choose a project control skill, include artifacts with
`--artifact` and declare gaps with `--unverified`. Acceptance rejects failed/blocked/stale
reports and changed artifacts. It does not prove that the chosen assertions establish every
product claim; Lead retains that judgment. See [workflow details](docs/quickstart.vi.md).

For executed feature coverage, run `alliance-work verify --map .alliance/features.json`;
use repeatable `--feature ID` to select the relevant scope. Declared but unexecuted assertions
remain uncovered. To evaluate a correction from a real failure, run
`alliance-work eval --suite .alliance/evals/NAME.json`. Baseline/candidate results expose
regressions and blocked cases; Lead decides whether to keep the lesson. See the
[map, driver and eval contracts](docs/verification.md).

## Development

```sh
npm ci
npm run check
npm run lint
npm run test:native
npm run test:maintenance
```

Default tests do not call models. Native tests inspect actual Codex/Claude/Pi discovery and
require the Codex/Claude binaries and bundled Pi. Maintenance tests exercise source switching and failed-candidate recovery
on a disposable native Paseo instance. A model delegation/handback exercise needs usable participating
credentials and is a separate acceptance check.

`vendor/seatwork/provenance.json` pins 18 selected skills / 22 files to commit
`fa540f47efb4344396a1eb532d3d6164a7056b9c`; their playbook bytes remain unchanged. Pi uses generated
valid metadata pointing to those originals. This private project's provenance does not grant
redistribution rights. Release packaging and contributor guidance are in [AGENTS.md](AGENTS.md)
and [operations](docs/operations.md#releasing).

See [operations and ownership](docs/operations.md#ownership-and-background-jobs) for registering
existing background jobs without restarting them. The monitor separates current turn state from
the last accepted analysis/test/runtime scope. Native messaging remains interruptible; the room
contract uses durable progress and owner reconciliation to reduce unnecessary prompts.


All roles share [engineering laws](room/policies/engineering-laws.md). Material future work can
keep an owner, authority reference, waiting conditions and evidence across sessions and handoffs
in the [durable obligation ledger](docs/operations.md#durable-obligations-0111). Recovery reads
current policy and open obligations together; no compulsory review or acknowledgement loop.

Durable wakeups can track a deadline, a registered process exit or an exact child turn.
They preserve owner/revision and restart state without accepting results. Pull delivery is the
safe default; idle auto-delivery is opt-in. See [commands and delivery limits](docs/operations.md#durable-wakeups-019).

Current sessions adopt updated operating policy at their next natural work boundary with
`alliance-work policy read` / `policy ack`; the monitor shows unacknowledged policy. Explicit
`members owner` handoffs separate responsibility from native parentage and permit related
cross-room wakeups. Product acceptance adds an observed journey to candidate-bound runtime
proof. See [operations](docs/operations.md#responsibility-and-policy-adoption-0110).

New delegated Alliance agents can now continue unfinished assignments across idle turns, retry
failed turns with bounded backoff, wake their owner for review and archive after evidence-bound
acceptance. Existing chats opt in with `alliance-work autonomy start --agent ID`; inspect with
`alliance-work autonomy list`, pause with `autonomy checkpoint --agent ID --phase paused --reason TEXT`.
See [autonomous assignment operation and real-model acceptance](docs/operations.md#autonomous-assignments-0111).
