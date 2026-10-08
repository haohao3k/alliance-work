# Alliance Work

Agent-owned rooms on native Paseo, with independent Codex, Claude and Pi homes.

Alliance provides a room surface, durable assignments and explicit acceptance. Paseo owns
agents, workspaces, native MCP, conversations and lifecycle. There is no Piggery dependency,
Alliance MCP server or second message transport. The dedicated daemon explicitly enables
`daemon.mcp.injectIntoAgents`; merely enabling its MCP endpoint does not expose tools to agents.

## Run

Requires Node 24+, Codex 0.160.0+, Claude Code 2.1.289+ and Pi 1.0.0+. This release is tested
with Paseo 0.10.3. The installer uses its pinned local CLI and a **dedicated** Paseo home;
it refuses to take over an existing unrelated home or provider registration.

```sh
npm ci
npm run prepare:homes -- --home "$HOME/.alliance-work"
node scripts/install.mjs --home "$HOME/.alliance-work" --paseo-home "$HOME/.paseo-alliance-work" --port 6771
```

Open http://127.0.0.1:6771 and select **Alliance Work**. Create a room with an absolute project
path and an outcome. Select a role, harness and model, then supply the assignment. Existing
Paseo installations and their listen, relay, credentials and WebUI settings are not migrated.

The home layout is:

| Path | Contents |
| --- | --- |
| `~/.alliance-work` | Profile manifest, room metadata and durable work artifacts |
| `~/.codex-alliance-work/<role>` | Fresh CODEX_HOME for that role |
| `~/.claude-alliance-work/<role>` | Fresh CLAUDE_CONFIG_DIR for that role |
| `~/.pi-alliance-work/<role>` | Fresh PI_CODING_AGENT_DIR for that role |
| `~/.paseo-alliance-work` | The dedicated native Paseo instance |

Roles are HQ, Supervisor, Lead, Peer and Lens. Each harness/role has its own home. Nothing is
linked or imported from daily profiles. Authentication is deliberately initially empty; sign in
only to the roles you use. For example:

```sh
node scripts/launch.mjs "$HOME/.alliance-work" codex-supervisor login
node scripts/launch.mjs "$HOME/.alliance-work" claude-peer auth login
node scripts/launch.mjs "$HOME/.alliance-work" pi-peer
# In Pi, use /login.
```

Each role signs in independently. An optional `credentials.env.json` inside a role home can
hold that role's explicit API-key environment (for example ANTHROPIC_API_KEY); keep it mode
0600. Never put credentials in this repository. Pi's authenticated model catalog is empty
until the selected role has a usable credential. Model IDs can also be entered directly.

Home isolation controls automatic configuration and resource loading, not OS file permissions.
The child process also receives a private HOME/XDG environment to prevent Codex from discovering
`~/.agents/skills`. Consequently Git, SSH and other tools' implicit user configuration is separate
too; configure needed access explicitly for Alliance. Native reasoning and tools remain available.

## How work is represented

A room belongs to one checkout; Git worktrees can join when there is one unambiguous matching
room. A second room for the exact same checkout is rejected. Create a room for a particular
worktree if its membership would otherwise be ambiguous.

The role sets responsibility, not a ceiling on capability. Supervisors and Leads can implement;
Peers can delegate within their authority. Review depth follows risk and project requirements.
The common ownership policy and role instructions append to the harness's native prompt.

Assignments are written before UI-launched agents start. Native delegation uses Paseo's
`create_agent` and Alliance provider aliases, with a playbook instruction to persist the brief
and candidate before notification. The room records native child identities through lifecycle
hooks. Skills' old tool vocabulary is mapped to existing Paseo operations in the operating
contract; no aliases are installed as extra MCP tools.

Paseo `send_agent_prompt` can replace an active turn. It is not a transactional inbox.
Finish notifications and explicit reports are coordination signals, not acknowledgements or
acceptance. Lifecycle hooks are best effort and are not replayed after a daemon outage. An
unobserved outcome stays unknown; reconcile native history and saved artifacts on resume.
Alliance does not claim exactly-once delivery or equivalent durability to Piggery's mailbox.

The room shows provider status separately from the last recorded turn and acceptance.
Canceled or failed work keeps its assignment. **Resume** refuses to interrupt an active agent
or bypass an outstanding permission; use its native chat for intentional steering. A disposition
records the exact candidate and evidence. Starting another turn reopens current acceptance;
previous dispositions remain immutable files.

## Skills and profiles

`vendor/seatwork/provenance.json` pins 18 selected skills / 22 files to Seatwork commit
`fa540f47efb4344396a1eb532d3d6164a7056b9c`. Their source and installed playbook bytes are unchanged.
This is a private local project; source provenance does not grant redistribution rights.

Pi strictly rejects some upstream YAML descriptions. Its generated `pi-skill-index` contains
valid metadata entries directing Pi to the unchanged playbooks. It introduces no extra tool or
extension. Native Pi MCP, codemode and tool-search support remain available to Paseo.

Claude loads only the role's user settings, uses strict explicit MCP configuration and disables
cloud-synced/bundled skills and plugins. Codex performs a no-model native metadata check at
launch, disables discovered skills outside the selected role and excludes non-Paseo MCPs.
Project-native configuration is excluded; repository task instructions are still relevant and
must be read. Managed machine policy is not bypassed. Missing or modified managed profile files
fail launch rather than falling back to a daily home.

To update generated homes, run prepare again from this checkout. It replaces only the files it
previously managed and leaves auth/session state alone. Reconcile handwritten changes first.
Changing a profile path is not a transparent migration: logins and sessions belong to that path.

## Verify and operate

```sh
npm run check
npm run test:native
node scripts/smoke-paseo.mjs ws://127.0.0.1:6779/ws
```

The smoke command requires an explicitly selected test daemon; it creates a temporary room and
no-prompt Codex/Claude sessions, checks commands and caller-bound native MCP tools, detaches and reopens history. It makes no model
turns. Native tests require the installed binaries; the default suite reports them as skipped.
A real delegation/handback model run additionally requires authenticating the participating roles.

Use the bundled CLI with an explicit home:

```sh
node node_modules/@getpaseo/cli/bin/paseo plugin logs alliance-work --home "$HOME/.paseo-alliance-work"
node node_modules/@getpaseo/cli/bin/paseo plugin reload alliance-work --home "$HOME/.paseo-alliance-work"
node node_modules/@getpaseo/cli/bin/paseo daemon status --home "$HOME/.paseo-alliance-work" --json
```

Finish active Alliance runs before updating or reloading the plugin. The installer never restarts
a daemon. The selected Alliance home is persisted in native plugin settings. If you explicitly
enable password authentication on this dedicated TCP instance, provide ALLIANCE_PASEO_PASSWORD
when reinstalling so the installer can update those settings. Provider-native profile formats and discovery are version-sensitive; rerun the native
checks after upgrading a harness. Do not enable this plugin on an older Paseo app/daemon merely
because TypeScript compiles.
