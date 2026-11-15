# Installation and operation

The `alliance-work` command manages one dedicated Paseo instance and its isolated role homes.
It uses the pinned local Paseo CLI and native plugin lifecycle. It does not install Piggery or
modify the user's ordinary Codex/Claude/Pi configuration.

## Installation

Run `./install.sh --codex-auth-from "$HOME/.codex"` from the checkout, or use the GitHub release
bootstrap shown in the [README](../README.md#install). Release downloads use the public
`haohao3k/alliance-work` repository through `gh`, without embedding a GitHub token in scripts.

The bootstrap verifies `checksums.txt`, installs `package-lock.json` dependencies and checks the
candidate before activation. Native Codex and Claude must be on PATH. Pi is installed with the
release. Harness versions affect configuration/discovery; run `npm run test:native` after upgrading one.

This release pins Paseo CLI/client/plugin `0.15.4` and requires a running `0.15.4` daemon.
Activation does not upgrade or restart the daemon. Other versions remain blocked. The disposable
maintenance tests use the pinned daemon; an alternate binary is selected explicitly with
`ALLIANCE_TEST_DAEMON_CLI`.

### Hold tasks while updating the runtime

Run the maintenance CLI outside an agent session. Stage and verify the candidate first, then:

```sh
alliance-work maintenance run --reason "Upgrade the native runtime" \
  --timeout-ms 60000 --interrupt --evidence /absolute/process-custody.json \
  -- node /absolute/verified-update-worker.mjs
```

The command records the currently running native sessions and their original provider, model,
effort, conversation, responsibilities, budgets and background evidence before notifying any task.
Originally idle, archived and parked sessions receive no prompt. Running tasks are asked to write
`checkpoint.md` in their recorded maintenance directory and end the turn. Without `--interrupt`,
a checkpoint timeout leaves the operation held. With it, native interruption is allowed after the
bounded grace period. Providers that cannot steer receive their checkpoint instruction in a new
turn of the same conversation after that interruption, followed by a bounded checkpoint window.

The update command runs directly, without a shell, under `ALLIANCE_PARENT_MAINTENANCE` and
`ALLIANCE_MAINTENANCE_HOLD`. It must perform and verify the requested update or return nonzero.
It must retain the native sessions, product services, terminals, credentials and rollback runtime.
Before comparing task state after activating this plugin, the worker invokes the owned
`maintenance.reconcile` RPC with `{holdId: process.env.ALLIANCE_MAINTENANCE_HOLD}`. This restores
maintenance-induced changes made by older plugin hooks to the captured task phases, counters and
deadlines. It checks task custody and exact native user-message identities; changed Human input or
ownership stops reconciliation. Original and observed states remain in the ledger audit.

`maintenance-hold.json` and `maintenance-holds/ID/` retain the exact target set and delivery receipts
through daemon restart and controller failure. The supervisor keeps older schedulers paused while
the new plugin reads the durable hold directly. `maintenance status` reads the ledger. On supported
plugins, `maintenance hold` performs only the checkpoint stage and leaves the pause in place; use
`maintenance run` for the first upgrade from a plugin without this support.

Before dispatch, the ledger registers each control message's exact body SHA256, dispatch UUID and
native conversation identity; the native acknowledgement is retained afterward. If Claude history
hydration exposes its provider UUID instead of the submitted UUID, only a canonical user row with
the exact registered body, owned dispatch, acknowledgement and conversation qualifies as an alias.
Assistant quotes and changed user input do not qualify. These receipts carry across maintenance
cycles; the immediately previous acknowledged legacy ledger is reconstructed from its owned control
bodies. The pre-hold user baseline also covers the native prompt index at the frozen hold boundary,
including older user messages outside a tool-heavy tail window.

A successful update is followed by native health verification and a resume prompt to each held
session. Native canonical user-message receipts and session readback prove delivery. A lost or
ambiguous acknowledgement never causes a duplicate prompt. Other sessions remain untouched.
Use a stable `--key OPERATION_ID` when retrying the same operation. A new task that starts during
the hold blocks the update and is reported for reconciliation.
To include that newly running work under the same authorized operation, repeat `maintenance run`
with `--include-new --key ID` and the verified update command. Only newly running sessions are
notified; earlier held tasks, checkpoints and their original state baselines are retained.

If an update or resume fails, the durable hold remains; work is not accepted or canceled. Verify
the restored or updated native runtime and supply the recovery evidence:

```sh
alliance-work maintenance status
alliance-work maintenance resume --reason "Verified rollback; continue retained work" \
  --evidence /absolute/recovery-receipt.json
```

Recovery adopts only its own hold after the prior controller exits. It verifies native health
before resuming and uses the same ledger and message identities. If delivery or custody remains
uncertain, inspect that session's saved timeline and ledger instead of sending another prompt.

### Paseo 0.15.4 upgrade

Fable 5.2 uses the native Paseo 0.15.4 model catalog and requires Claude Code 2.1.321+.
Upgrade the executable selected by the isolated Claude profiles, then refresh provider discovery.
Existing model defaults, worker allowlists and active conversations are preserved.

Before upgrading an existing host, record native running agents, their model/effort, scripts,
terminal jobs, daemon identity and service configuration. Hold the Alliance scheduler with the
owned maintenance workflow, then stop only active agents through native Paseo. Idle sessions stay
idle. Preserve terminal programs and editor buffers explicitly: terminal survival is a capability
of the outgoing daemon, so installing a new CLI does not make a `0.14` shutdown preserve them.

With work stopped, back up the existing runtime and native state, upgrade the owned daemon service
to `0.15.4`, and activate Alliance through `update` or `setup --refresh`. Verify daemon identity,
plugin health, retained sessions/settings and restored terminal jobs before resuming precisely the
agents that were interrupted, in their retained conversations and original model/effort. Restore the
previous runtime and state if verification fails; never use an unqualified daemon with this release.

Lifecycle registration now uses `addHook`. Paseo no longer sends transcript items with a turn-end
hook, so Alliance reads canonical native history for that turn and observed start time. Unavailable,
changed or incomplete history leaves a durable pending receipt. The scheduler retries it while
autonomy, wake delivery, acceptance and archival remain held for that member. A completion observed
during a newer active turn waits for that turn’s own end event. Receipts retain their original
time boundary through retry and reload; an in-flight read cannot replace newer work or its evidence.
The upstream end event has no generation timestamp: an event delayed until a later generation with
a reused turn ID is already idle cannot be distinguished completely. An active-turn hold therefore
requires a fresh end event or explicit new work; it is never automatically treated as completion. The bundled AGY driver remains byte-pinned to its
`0.12.0` source, which is identical to the corresponding `0.15.3` upstream driver.

Runtime dependencies also pin MCP SDK `1.32.2`, Pi `1.5.0`, pi-antigravity `0.12.0`,
mcp-remote `0.16.1` and Zod `4.6.6`. The restricted stdio MCP adapter rejects individual
frames beyond the SDK's 10 MiB buffer limit and closes the connection; split oversized tool
payloads at their source before reconnecting.
The Mobbin transport retains its existing loopback callback and owner-private auth directory.
Pi's Azure provider was renamed upstream: installations using `azure-openai-responses` need
explicit provider-key/model reconciliation before upgrading; other retained model routes must
be verified through the native configuration. No authentication re-login or token rotation is
part of this upgrade.

Paseo `0.15.4` still ships its own exact MCP SDK `1.29.0` dependency. Updating Alliance's direct
SDK does not patch that nested daemon dependency; do not claim a daemon-wide security fix or
force overrides without separate native qualification.

Custom locations are explicit:

```sh
./install.sh \
  --home "$HOME/.alliance-work" \
  --paseo-home "$HOME/.paseo-alliance-work" \
  --bin-dir "$HOME/.local/bin" \
  --port 6771 \
  --codex-auth-from "$HOME/.codex"
```

`--port` sets the initial listener only. An existing owned instance retains its listener, relay,
password and WebUI settings. An unrelated Paseo home or provider registration is refused.
`--isolated-root /absolute/path` puts role homes beneath that root, for disposable test installs;
otherwise each harness uses its documented system-level Alliance home. Subsequent refreshes
retain the recorded layout. Profile relocation is not an implicit migration.

The installer enables trusted plugin execution only for this dedicated instance. Plugin code
runs with the daemon user's filesystem/network access. The command starts an absent dedicated
daemon and hot reloads an idle existing one; it never restarts a running daemon. If a password
was explicitly configured, supply `ALLIANCE_PASEO_PASSWORD` for the installer connection.

## Profile loading

Paseo binds the room working directory before launching a native harness. The launcher uses
that same directory for discovery and the child process, even when Paseo itself started in a
different directory. Each role receives a private HOME/XDG and its own harness configuration.
Repository task instructions remain relevant, but project skill/plugin/MCP discovery cannot
extend the managed role's selected catalog.

Codex's `apps`, `plugins`, `remote_plugin` and `tool_suggest` features are disabled in role
config and enforced before the authenticated app-server starts. This prevents account sync
from reintroducing integrations after a successful home-only discovery check. Selected
Seatwork skills and native Codex tools stay available. See the native
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Existing sessions retain already-loaded context. After upgrading from a version with a
loading defect, start a new assignment/session to verify clean context; resuming old history
cannot remove instructions or tools that were previously visible.

## Context budget

Alliance roles default to a 300,000-token auto-compaction ceiling. Codex counts the full
active context; Claude has a separate auto-compact window; Pi caps the selected model's
window at 300k and retains its native compaction reserve. Smaller model windows remain
smaller. Pi provider extensions, including Cursor, Devin and Antigravity, share this policy.
The native harness creates the summary and continues the session. Large tool results can
cross the threshold between native checks; this is a compaction budget, not a per-request
token rejection limit. The model catalog may still report its physical 1M capacity.

The policy applies when the harness is launched, including resumed sessions. Refresh idle
existing sessions to adopt it; a running process retains its launch configuration.
Keep Pi's `compaction.enabled` on. Generated Alliance homes enable it automatically.
Ordinary Paseo providers can use `scripts/context-launch.mjs HARNESS EXECUTABLE` as their
configured command and must also have native auto-compaction enabled. This does not
change the executable or model used by those providers.

The Human can opt a room's Claude Peers into the measured 232K-window pilot from a terminal
outside an agent session:

```sh
alliance-work context show --room ROOM_ID
alliance-work context set --room ROOM_ID --role peer --claude-window 232000
alliance-work context reset --room ROOM_ID --role peer
```

Omit `--role` to set the room default; role overrides take precedence. Reset without `--role`
restores the room's release default and clears overrides. Only 300000 and the 232000 pilot
window are supported. Codex and Pi budgets do not change. The pilot's approximately 200K
compaction trigger is an estimate from prior observations; its effect on handback quality
still needs measurement. A running Claude process keeps its launch window. A future fresh
process, including a resumed session, reads the room's latest setting.

These settings are separate files under the Alliance home's `context-settings/` directory;
older releases ignore them and retain their own defaults. The CLI rejects agent-session
writes, and the server requires an explicit Human actor (`actorId: null`). Paseo 0.15.4's
plugin RPC context has no authenticated caller identity, so this actor convention is not
a transport authentication boundary.

Managed Claude profiles disable dynamic Workflows. A disposable-home trial on Claude Code
2.1.325 verified that this removes Workflow from `api-request-shape.tools` and the API request.
Existing processes keep their previously loaded tools until their next launch.

## Authentication

`alliance-work auth codex --from "$HOME/.codex"` selects a regular, owner-only `auth.json` as the
source for every Codex role. Only its path is saved in `~/.alliance-work/auth-source.json`.
Tokens are sent to the native app-server over its private stdin and kept in memory, using
`cli_auth_credentials_store="ephemeral"`. Existing role auth files are left intact but ignored
in this mode. Metadata checks also use ephemeral storage.

The original Codex remains the OAuth owner. Alliance never uses or writes the source refresh
token. A refresh request rereads the source; unchanged, expired or different-account tokens
fail with a recovery instruction. A source account change requires reopening the agent session.
The implementation adds no agent tools or MCP server. See the official
[external-token contract](https://learn.chatgpt.com/docs/app-server#3c-log-in-with-externally-managed-chatgpt-tokens-chatgptauthtokens).

Check without displaying credentials:

```sh
alliance-work auth status
alliance-work doctor
```

If the access token expired, run the original Codex so it renews its session, or sign in there
with `codex login`. Then resume the Alliance agent. Alliance does not promise unattended token
renewal while the original auth owner is unavailable. Do not copy the same refresh-token cache
into every role: concurrent refreshes can invalidate another copy, as described in
[OpenAI's auth guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

For separate role logins, including standalone interactive Codex:

```sh
alliance-work auth codex --separate
alliance-work login codex supervisor
alliance-work login codex lead
alliance-work login codex peer
alliance-work login claude peer
alliance-work login pi peer
# Pi: use /login inside the native session.
```

Use any of `hq`, `supervisor`, `lead`, `peer`, `lens`. Only participating roles need credentials.
Claude and Pi use explicit role credentials. An optional owner-only `credentials.env.json` in a
role home accepts provider API-key variables. Claude roles also accept `CLAUDE_CODE_OAUTH_TOKEN`
for an existing `claude setup-token` credential. Only put the selected credential in this file;
never copy a complete daily settings or Keychain record. Ambient provider secrets are not inherited.
The launcher rejects symlinks, shared file permissions and malformed credential JSON without
printing its contents. Keep the file mode at `600`; updates preserve it and exclude it from backups.
Never commit, record or pass credentials as command-line arguments.

### Claude accounts and quota

Open **Alliance Work → Claude accounts** on the selected Paseo host. **Host default** selects
5x/20x; HQ, Supervisor, Lead, Peer and Lens can override it. **Existing role login** keeps
its previous credential mechanism. The panel shows each session's **In use** and **Selected**
accounts separately. In-use labels come from a launch receipt checked against the live process
identity; older processes are shown as unknown, never inferred from the selection.

In **Models → This project → Claude account**, select **Claude 5x** or **Claude 20x** for all
Claude roles in that project. **Inherit** restores the host role selection, followed by the host
default. Account and model settings save independently, so a project can pick an account while
inheriting Global Models. The selected account must be provisioned on the daemon that runs the project.

A selection change is reconciled within 15 seconds, including changes made through the CLI.
An existing process is retired only after native Paseo confirms no foreground turn, queued
message, permission, provider background task or active descendant remains. Tracked Alliance
jobs also block retirement. Prompt admission and final revalidation share the native lifecycle
lock, so a racing message keeps the old process. The session ID, history and ownership remain;
its next message resumes the same conversation with the latest selected account. Saving sends
no prompt and never cancels work. Switching again while pending uses the latest selection.

Automatic retirement requires the private qualified `idleAccountSwitch` daemon capability
(see `patches/README.md`). An older running daemon reports **Daemon update required** and is
never given an ordinary reload request. Installing new plugin code does not retrofit that daemon;
activation must wait for a separately idle native daemon maintenance window. Unknown provider
background safety keeps the switch pending.

Provision each account on each execution host using a local terminal:

```sh
alliance-work accounts import 5x
alliance-work accounts import 20x
alliance-work accounts status
```

Paste the matching `claude setup-token` value into the hidden prompt. Piped stdin is also
supported; never put a token in arguments, shell history, chat or plugin settings. The import
does not select the account. Labels are operator-assigned, not subscription identity checks.
For terminal selection use `alliance-work accounts select default 20x` or
`alliance-work accounts select peer 5x`; `select peer inherit` restores the host default.

Account selection is a desired state, not proof that a running process has switched. The panel
shows **In use** separately from **Selected**. Idle sessions retire through native guarded
lifecycle and reopen with the selected account in the same conversation. Jobs belonging to
reporting Leads/Peers do not block an idle HQ; tracked jobs with verified process dependency and actual native
background work still protect their runtime.

**Switch now · stop turn and resume** is an explicit interruption of that session. Alliance checks
credentials first, saves the turn and recent history in `claude-switch-checkpoints/`, stops the
native turn, retires only at a safe idle boundary, verifies the new launch account and sends one
continuation. It does not recreate the workspace or erase history. The continuation checks existing
tool results before repeating actions. A job dependent on that runtime must finish or be checkpointed
first; the button never kills it. Unknown resume delivery remains visible for readback and is not
automatically resent. Selecting another account never bypasses that account's quota or invalid
credentials, and a quota error does not prohibit selecting a different account.

macOS stores tokens in Keychain, namespaced by Alliance home and account. Linux requires
`systemd-creds` with user-scoped `host+tpm2` encryption; encrypted blobs are owner-only under
`claude-secrets/`. No plaintext or null-key fallback is permitted. TPM/host changes can require
reimport. These stores protect credentials at rest, not against a compromised owner/root or
the Claude process that needs the token. Existing role credential files are preserved and
are not silently migrated or relabeled. Account selection JSON contains no tokens; secret
imports stay out of plugin RPCs and browser storage. Provisioning one host does not copy
secrets to other hosts.

Quota uses separate CLI OAuth logins, never setup-token. On the personal MBP, run
`python3 scripts/setup-personal-claude.py` once, then `claude-5x auth login` and
`claude-20x auth login` in a terminal. The wrappers use `~/.claude-5x` and `~/.claude-20x`,
remove conflicting auth environment variables, and preserve normal Claude permissions.
They neither copy the daily profile nor change the `claude` command.

The non-secret registry `~/.config/paseo/claude-accounts.json` contains version 1 and an
`accounts` array of `{id, label, configDir}` with absolute paths. The plugin quota panel reads
only registered profiles on the selected host and caches results for one minute. It displays
errors independently and never refreshes or rewrites OAuth credentials. Use the matching CLI
login when credentials expire. Open the MBP host to see its two accounts, including usage from
remote machines on those accounts. Other hosts do not receive these credentials or quota
snapshots automatically. Alliance registers the profiles through Paseo's native usage-source API,
so they also appear in the global Usage tracker without patching Paseo core. Login errors are
reported per account. After editing the registry, refresh Usage; no daemon restart is needed.

## Pi runtime and provider packages

Alliance installs its own Pi **1.5.0** and these explicitly approved npm packages under the
installation's `node_modules`, using `package-lock.json`:

| Package | Version |
| --- | --- |
| `@iznogoudd/pi-devin` | `0.5.1` |
| `pi-antigravity` | `0.12.0` |
| `@iznogoudd/pi-cursor` | `1.4.39` |

Each Pi role loads only these explicit extension entry points and native `mcp`, `codemode` and
`tool-search`. Automatic package/extension, prompt-template and skill discovery stays disabled.
The daily Pi package tree, settings and credentials are never linked or copied. Native Paseo
supplies MCP, so `pi-mcp-adapter` is not installed. The approved packages add provider commands;
`ANTIGRAVITY_NO_EXTRA_TOOLS=1` keeps its optional image/search tools out of the agent tool catalog.

Pi's native theme, last-changelog marker and default provider/model/thinking preferences survive
profile refresh. These preferences may change during normal use without blocking a verified
launch. Package, extension, MCP and compaction settings remain managed and must not drift.

The same release bytes serve all five roles, while each role's HOME/XDG, auth, sessions and caches
stay separate. `PI_CURSOR_SYSTEM_CREDENTIALS=0` disables Cursor's automatic Keychain/IDE credential
reuse. Devin's CLI/Desktop paths resolve inside the private role HOME.

Start `alliance-work login pi peer`, then use `/login devin`, `/login antigravity` or `/login cursor`.
Only sign in the roles/providers you intend to use. Package installation and model discovery do
not imply authentication or a successful model turn. Package upgrades are explicit Alliance
dependency changes, verified by native tests and shipped with a new release.

## Updates and recovery

| Command | Effect |
| --- | --- |
| `setup` / `doctor` | Check profile integrity, executables, selected auth source and live plugin/health |
| `setup --refresh` | Rebuild managed assets from the current version, preserving private state |
| `update --check` | Read latest stable release from `haohao3k/alliance-work`; no file changes |
| `update` | Verify/download a release, check it, then activate it when idle |
| `update --wait-idle MIN` | Stage and check now; activate as soon as readback is idle, for at most MIN minutes. Scheduled prompts keep running until each activation attempt |
| `update --wait-idle MIN --hold` | The same, but scheduled prompts stay paused from the end of staging until activation, so agents you stop are not woken: for a busy host |
| `update --bundle DIR` | Same staged update from a release `deploy` copied here; needs no GitHub access |
| `deploy --host H …` | From a machine with `gh`, push the release over SSH and run `update --bundle` on each host |
| `fleet status [--host H …]` | Read-only table of this host and the remembered hosts: versions, disk, unarchived sessions/members, plugin state |
| `rollback` | Activate the previous installation root, preserving current rooms and credentials |
| `cleanup releases [--apply]` | List the releases under `<home>/releases` that nothing needs, and why each other one is kept; Human-only `--apply` rechecks safety under the maintenance lock and deletes eligible releases |

### Deploy to other machines (0.1.16)

Only the controller needs GitHub access. Targets need SSH (key-based, non-interactive) and an
existing installation; nvm or `~/.local/bin` need not be on the SSH `PATH` because the remote side
uses the Node recorded in the Alliance launcher and the harness paths of the installed profiles.

```sh
alliance-work deploy --host host-alpha --host host-beta --host host-gamma --remember
alliance-work deploy --wait-idle 240 --detach   # later: reuse the remembered fleet
```

`deploy` downloads the latest stable release (or `--version-tag vX.Y.Z`) once, verifies its
checksum, copies the archive and `checksums.txt` to a temporary directory on each host and runs
`alliance-work update --bundle` there under `nohup`, logging to `deploy.log` in that directory.
Installations older than 0.1.16 cannot read bundles; for them the remote side verifies the
archive and runs the candidate's own CLI once to perform the same staged update. Each host
still verifies the checksum, runs `npm ci` and `npm run check`, and activates only when idle.
Without `--detach` the controller follows each log until the host records its exit status, then
removes the temporary directory on success. Interrupting the controller does not stop a remote
update; its log stays on the host. `--remember` saves the host list to `~/.alliance-work/fleet.json`.

`--wait-idle MIN` stages and checks first, then waits for idleness instead of failing. Since
0.1.19 scheduled prompts (continuations, retries, handback reminders) keep running while it
stages and waits, and pause only for each activation attempt. An attempt starts once readback is
idle: it takes the scheduler pause, waits up to two minutes for a plugin round that began after
the pause (or finds no plugin running), re-reads the installation and stops if the same or a
newer release is already active, then runs the candidate's installer. If an agent started
meanwhile, the attempt releases the pause and the update keeps waiting until the deadline. A
staged copy that never became active is removed, including after Ctrl-C during the wait; if
activation itself was interrupted or failed after switching, the copy is kept and the command
says to run `doctor`. Over SSH (`--bundle`) a stopped daemon is refused rather than started with
the remote shell's environment: start Paseo on that host normally, then rerun. An agent cannot
run a non-detached wait (it would wait for itself). Ctrl-C or a hang-up removes only the locks
the command holds; a lock whose process has died on the same host is treated as stale.

Since 0.1.25 plugin reload commands may take up to 180 seconds, allowing larger installed fleets
to finish loading. Other native maintenance commands retain their 60-second timeout.

With `--hold` (only with `--wait-idle`; `deploy` passes it on) the update takes the scheduler
pause as soon as staging and checks end, logs that scheduled prompts are paused, and keeps the
pause through the wait and every activation attempt; a busy attempt no longer releases it. If an
older release's maintenance command holds the pause at that moment, the update waits until it can
take it.

An installed CLI older than 0.1.19 holds the pause for the whole wait, so for a waiting deploy
to such a host the remote side runs the candidate's own CLI instead (one extra `npm ci`), with
`--hold` when given. Update the controller first. That older CLI knows only the scheduler pause:
while the candidate holds just `.maintenance-mutex` (while it stages, and while it waits without
`--hold`), the older CLI's `update`, `rollback`, `setup --refresh` and `auth` still run. Do not run
them on that host while `~/.alliance-work/.maintenance-mutex` exists. Because assignments keep
running during the wait, a busy host may not become idle in time: choose a quiet window, or empty
the host as below.

To activate on a busy host without waiting for its work to finish:

1. Start a held waiting update: `alliance-work deploy --host H --wait-idle 120 --hold --detach` on
   the controller, or `alliance-work update --wait-idle 120 --hold` on the host. Agents keep working
   while it stages and checks the release.
2. Once its log says scheduled prompts are paused and `alliance-work status` on the host shows
   `wakeupHealth.error` "Maintenance lock held…", stop the running agents with the Paseo CLI of the
   active release, addressed to the Alliance instance. Use Node 24 (the one named in the launcher),
   and pass `--home`: without it the CLI addresses `~/.paseo`.

   ```sh
   I="$HOME/.alliance-work/installation.json"
   ROOT=$(node -p "require('$I').root"); PASEO_HOME=$(node -p "require('$I').paseoHome")
   ap() { node "$ROOT/node_modules/@getpaseo/cli/bin/paseo" "$@" --home "$PASEO_HOME"; }
   ap agent ls --json            # note which agents are running
   ap agent stop AGENT_ID        # repeat until agent ls shows none running
   ```

   A parent woken by a child's stop notice starts a turn; stop it the same way. No continuation,
   retry or reminder starts meanwhile.
3. The update starts activating within about 20 seconds of idleness and releases the pause when it
   ends. Only after `alliance-work doctor` reports the new version, send each stopped agent a short
   message saying why it was stopped and what to check; a turn sent after a cancellation resumes its
   assignment:

   ```sh
   ap agent send AGENT_ID --prompt-file resume.md --no-wait
   ```

Do not stop agents before the pause is held. Without `--hold` a waiting update leaves scheduled
prompts running while it waits, and an update without `--wait-idle` pauses them only when it
starts: in both cases an idle assignment may be continued, or an owner reminded, into an agent
you just stopped, and an update without a wait then refuses the busy host.

### Check the fleet without logging in to each host

```sh
alliance-work fleet status                 # this host + the hosts saved by deploy --remember
alliance-work fleet status --host host-alpha    # only the named hosts (plus this one); --json for scripts
```

One row per host: Alliance version (from `installation.json`), Paseo daemon version, whether the
Alliance plugin is running (and healthy, and the installed release), disk used on the volumes
holding the Alliance home, the Paseo home and scratch space (`df` on those directories, so macOS
reports its Data volume), Paseo sessions not archived (with how many run) and Alliance members
not archived (`rooms.sqlite`, opened read-only). Differing Alliance versions are called out.

It only reads: SSH runs a probe from stdin (nothing is installed or written on the host) that
uses the host's own launcher Node and its release's pinned `paseo daemon status`, `plugin ls` and
`agent ls`; no daemon state changes. It works on hosts from 0.1.49 on. Hosts are probed in
parallel; one that is down or silent for `--timeout-ms` (default 30000) is listed with its reason
and the command exits 1, so a dead host never hangs the others. `--remote-home` names a
non-default Alliance home on the hosts. Output holds no tokens or conversation text.

### Long-lived sessions after an update (0.1.17)

A session's instructions are fixed when it is created, so an agent created before an update still
names the old release directory. Agents are pointed at the managed launcher with this instance's
home (`~/.local/bin/alliance-work --home ~/.alliance-work` by default), which always runs the
active release. New sessions get it in their instructions, and every continuation, wakeup and
reminder the plugin sends ends with the current command, so an older session switches at its next
prompt. The launcher is used only when it is this home's own managed launcher and its Node and
release exist; otherwise the running release's path is named, without promising it stays current.
A CLI older than 0.1.16 does not say who is deciding; its accept or reject is refused with the
current command instead of being treated as the Human.

Updates do not rewrite the development checkout. Release code lives under
`~/.alliance-work/releases/`; the CLI launcher and native provider commands switch to the
activated root. No release in the public repository means no downloadable update; there is
no fallback to another repository or an unpinned branch.

One maintenance command runs per home: it holds `.maintenance-mutex` for its whole run, which
pauses nothing. `.maintenance-lock` is the scheduler pause running plugins read; every command
except a waiting update holds it for its whole run (a waiting update holds it for each activation
attempt, or from the end of staging with `--hold`), and a 0.1.19 CLI refuses to start while an
older release's command holds it. Before mutation and again before hot reload, native readback
must show no running/starting agents and no active workspace scripts. Unknown status is refused.
Finish current work and rerun; updates do not kill agents. Native sessions reported as `closed`
after a daemon restart are inactive and permit maintenance. Do not start assignments while
maintenance is running.

Managed profiles, the installation record, CLI launcher and dedicated Paseo configuration are
saved beneath `~/.alliance-work/backups/` before activation. Handwritten changes to managed
profile files cause a refusal; reconcile those changes before refreshing. Native Codex project
trust entries are preserved separately; they do not relax launch-time exclusion of project
configuration. Credentials, session
history and room artifacts are not regenerated or included in managed-file backups.

A failed candidate restores managed files and attempts to reload the previous runtime. If live
recovery fails, the command reports the backup path and requires `doctor` before continuing.
The first installation has no prior runtime to roll back to; inspect native plugin logs if its
activation fails. Room model settings use an additive `room_model_policies` table in the existing
room database, with optimistic revisions to reject stale settings saves. Existing rooms use
defaults until explicitly saved. Older code ignores this table; rollback preserves its values.
`rollback` is a code
and generated-profile rollback, not a rollback of work the agents have performed. A source
installation uses the current checkout bytes; rollback does not undo edits to that checkout.
Rolling back below 0.1.19 also removes the handback-only assignment records 0.1.19 created,
because older releases would continue them; their undecided handbacks fall to the 48-hour
reminder. Each assignment that turns keeping its phase moved past its member's last turn is set
back on that turn, which older releases review. A reminder 0.1.19 stored without `--delivery` is
idle, so an older CLI re-adds that key
only with `--delivery idle`. The pull-reminder migration runs once per home: reminders an older
release stores pull after a rollback stay pull when 0.1.19 returns. Sessions created on 0.1.19 keep instructions that use `alliance-work
wait`, `reject` and `wakeups defer`, which older CLIs refuse: after such a rollback, send those
agents a short note (instead of `wait`, add a reminder with `wakeups add … --delivery idle` and end
the turn; decide with `accept` or a rework prompt), or recreate them.

#### Store level: a store newer than the running code (0.1.52)

Hosts run mixed versions during a rollout, so a release that changes `rooms.sqlite` in a way an
older release would misread or damage must say so, and the older release must not write it.
Releases 0.1.52 and later compare the **store level** they support (`STORE_LEVEL` in
`server/store-compat.mjs`; level 1 is the layout of 0.1.19-0.1.52) with a marker in table
`store_compat` (`write_level`, optional `read_level`, `marked_by` = the marking release's
version). No table means level 1.

- Marked above what this code supports: the plugin does not write. With only `write_level` raised,
  reads and `status` still work, the scheduler runs no sweep, `status` shows the reason in
  `wakeupHealth.error`, writes (hooks, RPCs) fail with the message, and `doctor` has a failing
  `store` finding. With `read_level` raised (or a value that is not a number), the plugin refuses to
  open the store at all, with the same message. `rollback` below 0.1.19 does not rewrite such a
  store. The message names the marking release, the level this release supports and the way out:
  update (`alliance-work update`), or run `alliance-work rollback` from the release that marked it,
  whose rollback converts the store and lowers the marker. Nothing is deleted. The marker is read
  again before every write, so a release that marks the store while this one runs stops its next
  write.
- Why not `user_version`: it is the one-time migration counter (1 since 0.1.19) and releases
  0.1.19-0.1.51 treat any value >= 1 as done, so they ignore a higher one; using it as "readers
  need >= N" would also make every additive migration lock out the previous release after a
  rollback. `store_compat` is a table those releases never open, and 0.1.52 itself writes no
  marker, so a store 0.1.52 touched is byte-compatible with 0.1.49-0.1.51 and rolling back to them
  needs no step (`tests/store-compat.test.ts` opens it with the 0.1.51 sources from git).
- Rules for a later release: raise the marker (`setStoreMarker`) only when an older release would
  misread or damage the store after rolling back to it. Additive changes (a new table, a JSON field
  older releases ignore, a counter bump in `user_version`) must not. A release that does raise it
  ships, in its `rollback`, the conversion back to the target's layout and then lowers the marker
  with `setStoreMarker` to the target's level (level 1 removes the table, how every older store
  looks). Rolling back onto 0.1.49-0.1.51 ignores the marker, so the conversion must come first;
  a store left marked is refused by 0.1.52 and later until the marking release returns or lowers it.
- Last resort, when the marker is wrong or its release is gone: stop the plugin, back up
  `rooms.sqlite` with its WAL, and delete the marker table (`DROP TABLE store_compat`). Only do
  this after checking that the store really has the older layout.

Backups are retained until you remove them deliberately. Each release is about 1G
(`node_modules`), so a successful activation (`install`, which `update` and `deploy` run from the
new release, and `setup --refresh`) then collects old ones from `<home>/releases`: it keeps the
current and previous installation (rollback), every release named by the Paseo config, launcher,
`profiles.json`/`providers.json` or a managed profile file, every release your own harness
configuration names (in your OS home, not a role's: `~/.claude.json`, `~/.claude/settings.json`,
`~/.claude/settings.local.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`,
`~/.gemini/settings.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/mcp.json`; the absolute path, or
`releases/<name>` as in `~/.alliance-work/releases/<name>`, counts; a missing file is normal), every
release holding a `.keep` file (create one to pin a release by hand), and every release a running
process uses by command line or working directory; it removes the other Alliance releases and
leftover `.download-*`/`install.*` staging directories. Anything changed in the last hour is left
alone, since another installer may be staging it. When the installation record, the process list or
one of those files cannot be read (or a harness config is over 16 MiB), nothing is deleted, and
`install`/`update` print `releasesRemoved.heldAll: "Kept every release: <why>"` (the dry run prints
the same line first). Session and agent records that still name an old release (AGY
`~/.agy-alliance-work/*/sessions/*/.agents/mcp_config.json`, Paseo `agents/*.json`) are not read; they
only matter if such a session is resumed after its release was collected. An update from 0.1.49–0.1.51 already collects, because the new
release's own `install` does it; the first collection removes every old release that no process uses.
`alliance-work cleanup releases` shows the same decision as a dry run, with the reason for each
release; Human-only `--apply` takes the maintenance lock, rechecks safety before each deletion, and deletes eligible releases. It never follows symlinks and never
touches anything outside `<home>/releases`. `doctor` and `status` warn (never fail) when a
filesystem holding the Alliance home, the Paseo home or `/` is above 80% used or has under 5G free,
or when `releases` holds more than three directories. On macOS the working directories come from
`lsof`; when working-directory detection is unavailable, every release is kept with a reason.
A `.keep` inspection error other than a missing file also keeps that release with a reason.
For a stale `.maintenance-mutex` or `.maintenance-lock`, read its
`owner.json`, verify that process has exited, then remove that lock directory and rerun the command.

Native diagnostics remain available:

```sh
node node_modules/@getpaseo/cli/bin/paseo plugin logs alliance-work --home "$HOME/.paseo-alliance-work"
node node_modules/@getpaseo/cli/bin/paseo daemon status --home "$HOME/.paseo-alliance-work" --json
```

Run these from the active installation root, shown in `~/.alliance-work/installation.json`.
Source edits need `setup --refresh` after checks; editing files alone does not activate the plugin.

## Peer concurrency

Alliance delegation uses native Paseo agents. Managed Codex profiles and their launcher set
`agents.enabled=false` to disable Codex's separate collaboration pool, whose slot count used to
be mistaken for a room peer budget. This does not disable Paseo `create_agent`, PI workers or
their finish notifications. The Human sets the concurrent-peer budget for an assignment; the
Lead counts active Paseo peers and uses that budget, excluding itself. There is no fixed
three-peer Alliance limit or need to allocate sixteen Codex slots for fifteen PI peers.
Refresh existing idle Codex agents after activation so their next turn loads the new launch
configuration; retain their native conversation and unfinished assignment.

## Releasing

Publish this edition only to the public `haohao3k/alliance-work` repository, verifying
`private=false` before publishing. Build from reviewed public history and the approved feature
scope in [the public candidate](public-candidate.md). Do not import private history, tags, host
data, personal helpers or unpublished skill adaptations. The private edition releases separately.
Bump `package.json` and the lockfile together. Check the candidate and commit it before packaging:

```sh
npm run check
npm run lint
npm run test:native
npm run test:maintenance
npm run test:coverage
npm run release:pack
```

Packaging uses `git archive HEAD` and refuses a dirty checkout. It creates the versioned archive,
`checksums.txt` and `install.sh` in ignored `dist/`. The tag workflow checks package/tag agreement,
runs the portable suite and publishes those assets to this public repository. Native harness, disposable Paseo maintenance
and real model acceptance checks remain local; CI does not claim to have run them.
CI also runs the shipped feature map and retains the per-scenario coverage artifacts.
Every pull request and branch push also runs `npm run check` and `npm run lint` (`.github/workflows/ci.yml`);
it publishes nothing and does not replace the tag workflow. For an
opt-in real Codex Lead handback plus a with/without-lesson model eval, run:

```sh
node scripts/acceptance-model.mjs /absolute/fresh-output ~/.codex
```

This uses a disposable Paseo, isolated role homes and the existing read-only auth bridge. It
runs real model turns and stops only its own test daemon. Reports remain in the selected output
folder; no daily daemon is changed. A NO_CHANGE skill eval is reported as no measured benefit.

Push a matching `vMAJOR.MINOR.PATCH` tag when the release is ready. Existing tags are immutable.
If the tag event did not start a run, dispatch the same tagged source explicitly:

```sh
gh workflow run release.yml --repo haohao3k/alliance-work --ref main -f tag=v0.1.1
```

The manual workflow also checks out and validates the requested tag before packaging.
The release archive contains no home directories, runtime credentials or generated room state.

## Upgrading host builds with a prerelease suffix

From v0.1.6, `alliance-work update` compares stable releases with installed host versions such
as `0.1.4-host-alpha.1`. Older launchers cannot parse that suffix. Bootstrap once with the release
installer, which preserves the recorded Alliance/Paseo home, credentials, rooms and native settings:

```sh
mkdir -p /tmp/alliance-upgrade
gh release download --repo haohao3k/alliance-work --pattern install.sh --dir /tmp/alliance-upgrade --clobber
sh /tmp/alliance-upgrade/install.sh
alliance-work doctor
```

Run on the destination host with Node 24+, npm, gh and the native harnesses on PATH. It verifies
the release checksum and candidate before activation. Busy or unknown agent/script state refuses
activation; retry when work is idle. No running daemon is restarted. Later releases use ordinary
`alliance-work update --check` / `alliance-work update`. Project skill selections live in projects;
project skill caches and evidence live outside managed role assets and survive refresh/update.

## Ownership and background jobs

`alliance-work status` reads native member state and durable acceptance history. Each member
shows its parent owner (or Human), whether that owner is available, current acceptance, and the
last disposition's analysis/test/runtime scope. Historical acceptance does not accept a new turn
or prove the current checkout unchanged; rerun the relevant verification before a new acceptance.

Register an already-running controller without sending messages, restarting it, or changing its limits:

```sh
alliance-work jobs track --room ROOM_ID --owner AGENT_ID --pid 12345 --key stable-run-id --title 'Benchmark controller'
alliance-work jobs list
alliance-work jobs owner --key stable-run-id --owner NEXT_AGENT_ID --revision 1
```

Inside an agent session `--room` and `--owner` default to that session's room and agent.
The key is global to the installation. PID identity includes Linux boot ID and process start time
(or macOS process start time). Reused/exited PIDs cannot appear running. Only registered processes
are observed; this is not discovery of every background task. A controller exit means result
unverified, not successful completion; detached descendants require their own tracking. Archived,
closed or unknown owners are highlighted for reassignment. Ownership writes use the displayed
revision and require an available recipient; recording ownership does not notify or acknowledge
that recipient. Keep the handoff and output paths in the durable assignment.

Archive and idle are native session states, not process exits: neither proves that the session's
child processes have stopped. Inspect tracked jobs and any untracked children before treating
its work as stopped.

macOS process timestamps are read in the C locale, independently of the daemon or CLI language.
The caller's locale stays unchanged. Existing C-locale identities continue to match. An older
localized identity that cannot be compared stays `unknown` while its PID exists; its job reminder
does not fire on that uncertainty. Reconcile the original controller and its evidence before
registering a verified run under a new key. The old record is retained, never rebound to a PID
that may have been reused. A missing process observer also reports `unknown`, not an exit.

## Work in a safe place

`alliance-work status` starts with `workSafety`: `warnings` lists every room still in use (any
unarchived member, or no member yet) whose results exist only on one disk, and `checked` is the
number of project paths inspected. Each warning has a `kind`, the `path`, the `rooms` it concerns
and a `message` with the fact to act on:

- `no-vcs`: the project directory is not under version control.
- `no-remote`: the Git repository has no remote; the message gives its commit and branch counts.
- `unpushed`: local branches carry commits that no remote branch holds (counts, how many have no
  upstream, and up to three branch names). A remote that was configured but never pushed to counts.
- `detached`: commits held only by a detached worktree HEAD.
- `core-bare`: `core.bare` is true in a normal `.git` checkout. Git then refuses `status`, `add` and
  `checkout` there. A deliberate bare repository is not flagged.
- `path-missing`, `git-missing`, `check-incomplete`: the check could not run; the message says why.

The check is read-only: it reads repository files and runs `git config`, `for-each-ref` and `log`,
never fetches, pushes or changes configuration, and a failure becomes a warning rather than a
failed `status`. "On a remote" means a remote-tracking ref known locally, so a push made from
another clone shows after the next `git fetch`. Fix a warning by pushing the branches (or merging
them into a pushed branch), adding a remote, or setting `core.bare` back with
`git config core.bare false` in that checkout. Rooms sharing a repository share one warning. Rooms whose project
lies inside the Alliance home (`--home`, default `~/.alliance-work`, e.g. room artifacts and candidates) are
scratch and are not checked.

## Wrong CLI calls

When a call is wrong, the error keeps its first line and adds the correction. An unknown command
or option names the nearest real one (`Did you mean --title?`), a missing flag or value shows the
syntax of that command, and the plugin's rejections of well-formed calls (for example a stale
`--revision`, or an `--evidence` file that is not the JSON a job needs) add what to change. The
syntax is read from `alliance-work --help`, so a command added there is covered. Exit codes do not
change.

## Non-interrupting coordination policy

Ordinary progress goes into the assignment/result artifact. Avoid progress pings and duplicate
handbacks: a worker hands back by saving its result, checkpointing `review` or `blocked` and
ending its turn, and Alliance wakes its responsible owner (see
[Handback, waiting and reminders](#handback-waiting-and-reminders-0119)). Agents wait with
`alliance-work wait` instead of polling and keep native `notifyOnFinish` on: Paseo's notice also
reports the child's permission requests during the turn it watches. Nobody approves commands for
Alliance members: Alliance denies a request left pending for 5 minutes, and owners never answer one
(see [Stuck members](#stuck-members-0119)). Urgent
corrections can still intentionally interrupt: Paseo 0.12 steers a running Claude, Codex or Pi
turn by default and interrupts AGY, while 0.11.2 aborts the running turn. New agents get the rule
for the daemon the plugin last connected to (`status` shows it in `wakeupHealth.daemon`) and keep
it: after moving a daemon back from 0.12 to 0.11.2, tell older agents that a send aborts a running
turn. There is no mailbox or queued-send guarantee. The Alliance resume RPC refuses unknown,
archived, permission-blocked and running agents and reopens a closed session; a turn that starts
during its readback is steered, except on AGY, which cannot steer (0.12 interrupts it, 0.11.2
refuses the send). Existing sessions keep already-loaded instructions until fresh context is
created; never restart active work just to replace its instructions.

## Memory and disconnected commands (0.1.24)

One-shot Alliance CLI and installer connections make one connection attempt, bounded by ten
seconds, and close on failure. They no longer inherit the SDK's indefinite reconnect policy;
retry the command after restoring the connection. The plugin scheduler bounds its first
connection attempt to five seconds so an offline daemon cannot trap a round or shutdown;
later rounds retry. Once connected, it enables the SDK's reconnect policy. Already-running
commands from an older release retain their old code.

Evidence and candidate hashing stream regular files in 64 KiB chunks and compute the SHA-256
and Git blob digest in one pass. A file changed during that read is refused; retry verification
after it stops changing. Status limits each batch of native reads, lifecycle checks and job
observations to eight concurrent tasks. Single-record wakeup, job, obligation and autonomy
lookups query their SQLite keys instead of parsing every saved record. Turn completion reads a
bounded canonical history window for the observed turn. Durable history and lifecycle decisions are
preserved.

These changes reduce temporary allocations and prevent new reconnecting CLI processes from
waiting indefinitely. They do not establish that a large plugin RSS is a memory leak, or that
all of it will be reclaimed. Paseo owns native Claude/Codex session lifetimes. The pinned API has no idle-session hibernate operation;
an idle session can retain its runtime. Existing archive eligibility still checks ownership,
pending work and native state. Do not use idle age alone to archive agents or terminate their
subprocesses; inspect tracked jobs and any untracked children first.

## Candidate identity

Activation checks required context, coverage, failure-learning and operations files and records a
SHA-256 of shipped runtime source. `doctor` checks those capabilities and compares current bytes
with that installation pin. This is source drift detection, not a proof of model effectiveness or
a replacement for tests. Older records without a pin report `pinned: false`.

Stage and test candidates separately. Activation still requires all native agents and workspace
scripts to be idle, uses the owned installer and preserves daemon/process history. External jobs
must also be observed before/after; if any impact is uncertain, leave the candidate staged.


## Disk hygiene

Role instructions tell members to keep scratch (builds, clones, installs, test data) in the
session's `$TMPDIR` (`$ALLIANCE_SCRATCH`) and, before handback, to delete what is rebuildable
(`alliance-work scratch clean`) while keeping what their manifest or report names until the
decision is final. A candidate holds reports, manifests, hashes and short logs; large data stays in
scratch with its path and sha256 in the manifest. Briefs name the scratch location and how long
the data is kept. After acceptance, [rebuildable bytes may be cleaned](verification.md#proof-of-integrated-contributions).

Alliance deletes nothing by age. Scratch and worktrees of archived sessions are only listed as
cleanable (`alliance-work disk`, `alliance-work cleanup worktrees`); deleting needs `--apply`. A
worktree is removed only when clean and merged, never with `--force`. Release retention is in
[Updates and recovery](#updates-and-recovery).

## Durable wakeups (0.1.9)

Wakeups persist in the installation's SQLite database and are evaluated every 15 seconds while
the plugin is running, including after reload without an open UI. A stopped daemon performs no
checks; overdue work is reconciled after startup. The previous release ignores the additive table.
Nothing is registered or enabled automatically for existing assignments or jobs.

```sh
alliance-work wakeups add --room ROOM --owner OWNER --key review-deadline --reason 'Reconcile outstanding evidence' --at '2026-11-01T09:00:00+07:00'
alliance-work wakeups add --room ROOM --owner OWNER --key benchmark-result --reason 'Inspect benchmark output and exit status' --job RUN_KEY
alliance-work wakeups add --room ROOM --owner OWNER --key child-result --reason 'Review child result' --agent CHILD --turn TURN_ID
alliance-work wakeups list
alliance-work wakeups take --owner OWNER
alliance-work wakeups ack --key KEY --owner OWNER --revision N
alliance-work wakeups defer --key KEY --owner OWNER --revision N --minutes 30
alliance-work wakeups cancel --key KEY --owner OWNER --revision N
alliance-work wakeups owner --key KEY --owner OLD --next-owner NEW --revision N
```

Use `status` to read member `lastTurnId`. Turn triggers bind that exact generation and cancel
when superseded or decided (accepted or rejected); job triggers bind boot/process identity and
the recorded job owner revision. Transfer the job first, then its wakeup. A process exit only
asks for inspection.
Owner changes are metadata, not acknowledgement by the new owner. CLI owner defaults to
`PASEO_AGENT_ID`; local operators can supply it explicitly, as with existing Alliance CLI actions.

Since 0.1.19 a reminder wakes its owner when idle unless it is added with `--delivery pull`;
obligation-linked reminders stay pull-only, and re-adding a key stored as pull before 0.1.19
without `--delivery` keeps it pull. Older releases stored every reminder pull unless it asked
otherwise, and nothing pushes a pull reminder, so owners waiting on one stalled. The first load of
0.1.19 therefore migrates those once (recorded as SQLite `user_version` 1 in `rooms.sqlite`): each
open one that is not linked to an obligation becomes idle and wakes its owner once, batched with
its other items, unless it was created and came due more than 72 hours earlier (a job reminder
comes due when its job exits); that one is canceled with a note saying so. A reminder still
waiting for its time, job or child turn counts as recent. Reminders added later keep the delivery
they ask for.
Idle delivery needs native readback idle or closed (Paseo reopens a closed session), unarchived
and free of permissions, and an owner neither paused by a cancellation nor held by a provider
limit (see [Autonomous assignments](#autonomous-assignments-0112)); other owners keep pending
work. At most eight items are sent in a batch, with a one-minute cooldown per owner. This
is best effort: Paseo has no atomic idle-only send, so a concurrent turn can be steered or
interrupted. `pull` never sends a native prompt; every prompt the plugin sends an owner lists its
pending pull items, and `take` returns at most eight pending or delivered items, unread ones
first, keeping them until `ack`. Check durable artifacts and reconcile side effects before
acknowledging. This does not accept any candidate. `defer` postpones a due or delivered reminder
by 1–1440 minutes, at most three times. A review of a child's turn closes when its owner decides,
and an `ack` before that is refused (see [0.1.19](#handback-waiting-and-reminders-0119)). An
archived owner's reminders and reviews are canceled, also when Paseo archived the owner natively;
none moves up the chain. A later handback of its child asks the nearest live owner.

Repeats are time-only: `--every-ms 60000 --max-runs 3` (minimum one minute, maximum 100 runs).
They rearm only after acknowledgement, from the acknowledgement time; missed intervals never
produce a catch-up storm. Default expiry is 30 days, overridable with `--expires ISO_TIME`.
Keys are installation-wide and idempotent for identical input while the record is retained;
different input under the same key is rejected. At most 1000 unfinished reminders may exist;
creation fails explicitly rather than losing pending work. Finished records remain as audit
history for seven days (see 0.1.16 below).

States distinguish scheduled, pending, dispatching, delivered, acknowledged, canceled, expired
and uncertain. Dispatch claims are transactional. A crash or failed acknowledgement during
native send leaves `uncertain`; it is never automatically resent, even after restart. Inspect
native history, then acknowledge or cancel explicitly. One exception: a send to a closed owner
whose session failed to load delivered nothing (Paseo loads the session before it records the
prompt), so that batch stays pending for when the owner is idle, or is tried again an hour later.
A timeout or a lost connection during that load is `uncertain` like any other ambiguous send.
Native delivery is not exactly-once execution or proof that the owner read the evidence. The
CLI/UI exposes revisions for stale-write protection. The plugin releases its timer and waits for
in-flight observation on unload.

## Responsibility and policy adoption (0.1.10)

`alliance-work status` exposes the responsible owner, `ownerRevision`, handoff evidence and
`policyAcknowledged`. The native parent remains separate. Existing members fall back to their
native parent until an explicit handoff is recorded; a null parent is not evidence that a human
has taken over a detached job.

```sh
alliance-work members owner --agent LEAD_ID --owner HQ_ID --revision 0 --evidence /absolute/handoff.md
alliance-work policy read --agent AGENT_ID
alliance-work policy ack --agent AGENT_ID --digest DIGEST_FROM_READ
```

Ownership changes use revision checks and refuse cycles. A handoff records the source file's
hash. It sends no prompt, changes no native parent or permissions, and transfers neither jobs
nor wakeups automatically. Cross-room time/turn wakeups require a responsibility link; job
wakeups follow the explicitly tracked job owner. Reconcile waiting obligations after a transfer.

Policy acknowledgement means the agent reports reading that digest. It does not change the
saved native system prompt or prove behavior. New policy is applied at the next natural task
boundary; updating files alone does not update existing session context. If an operator explicitly
authorizes a one-time idle adoption prompt, use fresh native status and reconcile its result;
never broadcast to busy/archived/permission-blocked agents. There is still no atomic idle-only
send in Paseo 0.11.2. Pending policy must remain visible rather than force a turn or restart.

## Product acceptance

Existing `accept --report` remains technical acceptance. For a verified product journey, use a
runtime report bound to the current candidate and a JSON statement:

```json
{
  "outcome": "An operator can reopen a saved run and act on its result",
  "journey": "Observed login, saved run selection, result and limitations, then reopen after restart",
  "reviewer": "responsible reviewer agent ID or Human",
  "remaining": ["External tenant integration was not exercised"]
}
```

```sh
alliance-work accept --agent LEAD_ID --report /absolute/runtime/report.json --product /absolute/journey.json
```

A live HQ in the member's responsible owner chain can record a Human-authorized member decision:

```sh
alliance-work accept --agent MEMBER_ID --report /absolute/report.json --for-human --source NATIVE_MESSAGE_ID --at 2026-11-14T08:00:00.000Z
alliance-work reject --agent MEMBER_ID --reason 'Needs revision' --for-human --source NATIVE_MESSAGE_ID --at 2026-11-14T08:00:00.000Z
```

Use the exact user-message ID and timestamp from HQ's native chat. HQ remains the decider and
attests Human authorization; the plugin checks that the source exists and excludes known agent
and control messages. Paseo does not expose trusted Human-origin metadata for this check. Evidence
requirements still apply. A caller without an agent identity is recorded as unknown. The CLI
refuses an older plugin before sending the decision. If a plugin reload between that check and
the decision loses attribution support, the CLI reports that attribution was not confirmed;
inspect the saved disposition before retrying after an upgrade.

Test/analysis reports cannot accept a product journey. Runtime PASS is necessary, not sufficient:
the reviewer must inspect the actual journey and state its limits. The command records this
attestation; it cannot determine whether an invented journey is true. New work still reopens
current acceptance; historical product acceptance remains labeled historical. Review depth follows
risk and new evidence, not a fixed number of peers or rounds.

Product acceptance also verifies how accepted direct children contributed to the final candidate,
including children already archived. Use `verify --base BASE_SHA` for each Git contribution and
verify the final integrated runtime. Ordinary merges are checked automatically; use
`accept --integration plan.json --product journey.json` for squash, cherry-pick, copied files or
non-code review. The [integration proof workflow](verification.md#proof-of-integrated-contributions)
defines mappings, supersession and evidence limits. A later child decision or changed final evidence
holds automatic archive until the parent is reviewed again.


## Durable obligations (0.1.11)

The shared [engineering laws](../room/policies/engineering-laws.md) apply to every role.
They guide decisions; the ledger enforces revision checks, waiting prerequisites for linked
reminders, explicit closure and transactional handoff. It does not intercept every native tool
call, verify arbitrary external claims or grant new authority. Stop only the action dependent
on a violated condition; continue unrelated authorized work. No mandatory council or extra reviewer.

Record material future work once, using an installation-wide key independent of session/turn ID:

```json
{
  "key": "adopt-release",
  "roomId": "ROOM",
  "ownerId": "OWNER",
  "assignment": "/absolute/brief.md",
  "authority": "Human's assignment: activate at an idle boundary; no interruption",
  "nextAction": "Verify the loaded version and changed behavior",
  "closeWhen": "The requested version and behavior are verified in the target environment",
  "conditions": [{"id": "activation", "requires": "Target version actually loaded, not merely staged"}]
}
```

```sh
alliance-work obligations add --file obligation.json
alliance-work obligations list --owner OWNER
alliance-work wakeups add --room ROOM --owner OWNER --key adoption-notice --obligation adopt-release --reason 'Verify adoption after activation' --at '2026-11-01T09:00:00+07:00'
alliance-work obligations history --key adopt-release
```

`ownerId: null` means the Human owns the next decision, not ownerless automatic work. The
assignment and authority are references to the actual brief/permission; they are not new grants.
Existing wakeups are not migrated from prose. Linked reminders require pull delivery because
Paseo 0.11.2 cannot atomically guarantee idle-only sends. Their timer becoming due, expiry,
acknowledgement, job exit or child acceptance never fulfills the obligation. `status` and the
room UI retain open obligations and expose missing/archived owners. There is no automatic resurrection.

An action JSON passed to `obligations action --file action.json` always carries `key`, current
`ownerId`, current `revision`, `action` and an absolute regular `evidence` file (at most 4 MiB).
The record preserves its SHA-256 digest and observation time. Supported actions:

| Action | Additional fields | Effect |
|---|---|---|
| `observe` | `conditionId`, `validUntil` (Unix milliseconds) | Accountable evidence that this condition holds until the stated deadline; expired observations block again. |
| `reconcile` | Optional `nextAction`, `authority`, `conditions` | Update the premise and invalidate old observations, including reused condition IDs. |
| `handoff` | `nextOwnerId` (agent ID or null for Human) | Transfer the obligation without sending a prompt or changing native sessions. |
| `fulfill` | None | Require unexpired condition observations and evidence for `closeWhen`; does not create product acceptance. |
| `cancel` | None | Explicitly retire the obligation with its reason/evidence retained. |

```json
{
  "key": "adopt-release", "ownerId": "OWNER", "revision": 1,
  "action": "observe", "conditionId": "activation",
  "evidence": "/absolute/runtime-readback.md", "validUntil": 1793527200000
}
```

Use a validity deadline appropriate to the external fact and refresh before dependent side
effects. The example timestamp must be replaced with a future deadline. Evidence should name
the candidate, environment, observed predicate, time and limits. The engine checks presence,
identity and expiry of the observation; it cannot prove the file's semantic truth or detect an
external runtime changing early. Native permissions remain authoritative. This API follows the
existing trusted-host RPC model; supplied owner IDs are concurrency metadata, not authentication.

Handoff commits the obligation, history, pending linked reminders and any exclusively linked
tracked jobs together. It preserves waiting conditions and valid observations. Shared/changed
jobs or ambiguous delivery fail without partial transfer. The handoff receipt reconciles an
already pulled reminder in the same transaction; no separate acknowledgement step is required.
Expired/acknowledged reminders retain their history and do not erase job associations. Handoff to Human
cancels pending reminders and retains the open obligation; it does not transfer a running
process's tracking record to a nonexistent agent. Old terminal notification records stay historical.
The `members owner` command changes supervisory responsibility, not execution ownership of an
obligation. Use obligation handoff for material future work; no per-turn ledger entry is needed.

`policy read --agent ID` returns current policy plus that owner's open obligations and blockers.
New agent creation injects the common laws. Each native session open regenerates a recovery
snapshot at `$ALLIANCE_CONTEXT`, containing current policy and open obligations; harness env
preserves that path. The role instruction asks the model to read it and refresh before acting.
This does not rewrite a saved native prompt, guarantee that a model reads the file, or supply a
universal compaction hook. Existing sessions adopt policy at their next natural recovery read;
there is no broadcast to running agents. `policy ack` remains optional audit metadata.

SQLite keeps every obligation revision and its evidence receipt. No session end, archive, restart
or notification TTL deletes it. Updates use compare-and-swap after asynchronous evidence reads;
a stale writer must reread and reconcile. Back up `rooms.sqlite` consistently, including its WAL
when live; recovery snapshots are derived, not the source of truth. New tables are additive and
old fields/notifications remain compatible, but older plugins cannot enforce the new ledger:
the current installer refuses targets missing the durable core. Do not bypass that check with
an older installer; preserve and reconcile the ledger before any manually managed downgrade.
## Autonomous assignments (0.1.12)

The plugin owns a durable assignment policy; Paseo still owns execution, sessions, permissions
and transport. New Alliance launches and native Alliance children are enabled automatically.
Other sessions are not: since 0.1.19 an owned one gets a handback-only record that is never
continued and is retried only once at each provider limit's reset (see 0.1.19 below). Root chats
enable themselves once for a substantive task, following the room contract; operators can enable
an existing assignment:

```sh
alliance-work autonomy start --agent AGENT_ID --max-continuations 20 --max-retries 2
alliance-work autonomy list
alliance-work autonomy checkpoint --agent AGENT_ID --phase paused --reason 'Operator pause'
```

`--agent` defaults to `PASEO_AGENT_ID`. Use the exact CLI and `--home` from room instructions.
`status` includes autonomy phase, reason, counters and delivery state. `start` explicitly resets
the finite budget; do not repeat it each turn. `--auto-archive false` keeps accepted work open.
A start on an existing assignment adopts its retained last turn; archived agents require explicit
native reopening first. A new turn sent by an owner, the Human or Paseo's finish notice reopens a
prior review as active work and ends a cancellation pause. It never ends a deliberate pause or
`blocked`: only a checkpoint (`active`, `waiting` or `review`) or `autonomy start` does, so an
unblocked agent checkpoints `active` itself, except after an exhausted run budget (see below). A
turn the plugin starts on an idle or closed agent to deliver its own wake batch (reminders,
reviews, notices) changes no phase; unless the agent is `active`, its end is neither taken as a
handback nor continued. A checkpoint made in that turn still counts, and if the turn fails, the
failure is handled like any other. The same holds for a turn Claude Code starts by itself when a
background task or Monitor event finishes (Paseo names it `autonomous-…`): unless the agent is
`active` it changes no phase, its end is neither a handback nor continued nor retried (a provider
limit it ended on is still waited out, see below), and it does not end a cancellation pause; only a
checkpoint in it counts. Since 0.1.19 either turn also leaves the agent's handback standing: its
review is not asked again and still names the handback's turn file, the owner's decision on it
stands, and a decision may be recorded while the turn runs. A checkpoint in such a turn is a new
handback that needs its own decision; a canceled one is new work, and so is a wake batch's turn
that fails while the agent is waiting, unless it failed on a provider limit.

Before ending a managed turn, agents checkpoint `active` with the next concrete step, `waiting`
for a dependency, `review` with checked results, `blocked` for a decision, or `paused` to stop.
An optional `--turn TURN_ID` rejects stale checkpoints. Waiting work ends its turn and is woken
by a child's handback or by `alliance-work wait` (see 0.1.19 below). Completion of a model turn
alone never means task acceptance.

Every 15 seconds, eligible active work receives a native SDK continuation after at least 15
seconds of idle time following its recorded outcome. Failed turns retry after 30 then 60 seconds,
with a default two retries across the assignment. Limits are 0–5 retries and 1–100 continuations
(default 20). Exhaustion becomes blocked and requests owner review. Only `autonomy start` renews
the budget, and that is the owner's or the Human's decision: an `active` checkpoint is blocked
again at the next round. Since 0.1.19 two continuations in a row that end without a checkpoint
hand the last final message to the owner as a review instead of a third.

A provider that is signed out ("Antigravity authentication failed", "Not logged in", "Failed to
authenticate", 401) fails every prompt the same way. After three such failures of one member Alliance
stops prompting it (autonomy retries, wakeups) for 30 minutes, then 1 h, 2 h up to 6 h each time a later
try fails again. The member's `signIn.reason` in `status` (and the Rooms panel) names the harness, the
host and the login command, and its nearest live owner gets one notice per streak. A completed turn of
the same harness on that host lifts every such hold at once. This does not stop Paseo 0.15.4's own
finish-subscription retry, which resends a notice to a signed-out caller every ~7 s without limit: only
signing in again or archiving that agent ends it.

Since 0.1.19 a failure that names a provider quota or a reset time waits for that time instead (30
minutes for a quota that names none): one retry at the reset plus a minute, without using the budget, at most
three waits in a row before it is blocked. Claude Code answers a refused request with a notice as
the turn's final message, and Paseo 0.11.2 and 0.12.0 report that turn completed; Alliance treats
a Claude turn ending on one ("You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)",
"API Error: …", "Failed to authenticate. …", "There's an issue with the selected model (…)",
"Not logged in · Please run /login") as failed with that text, and gives back a continuation or
retry that such a limit cut short. Notice attribution checks the native message identity, turn ID
and timestamp against the observed turn start; a notice left by an earlier turn cannot create a
new hold, and cancellation is never reclassified. Missing native metadata or a start hook received
after the notice leaves the native outcome unchanged, with a warning in the turn artifact and
plugin log for inspection. Claude prints a reset less than a day away as its minute alone,
so a printed time up to five minutes past is that reset (retried a minute later), not tomorrow's.
Until a limit lifts, Alliance prompts no member of that harness on the host: no continuation, retry
or wake batch. A Claude limit records the account its turn ran on (the launch receipt, checked
against the live process) and holds only members known to run the other named account free: a
5x limit does not hold a 20x agent. Members whose account is unknown (no verified receipt, an
older process) or `legacy`, and limits that recorded none, still hold the whole harness. Since
0.1.52 a member record carries `limited.account` and `claudeAccounts`; older releases ignore
both and keep holding everyone, so a mixed-version rollout or rollback only loses the narrowing.
When one named account is limited for five minutes or more, the other is provisioned and Alliance
has recorded no limit on it, the Human's contact (the room's HQ, else the highest live owner not
held by the same limit) gets one idle notice per limit and host: which account is spent until
when, the members held, and how to switch (`alliance-work accounts select ...` or the project
Claude account setting). The other account's quota is never read and nothing is switched. A wake batch whose turn ended on the limit is sent again after it lifts; a turn
Claude Code started by itself has no prompt of its own, so its limit sends no earlier batch again.
The owner hears once per limit, owner and harness, only for a wait of five minutes or longer; that
notice lapses at the retry time, so an owner held by the same limit never gets it. Cancellation
pauses the assignment; permissions, busy/unknown agents and archived agents are never bypassed. A
known failed turn may resume an error/closed session using the native SDK. Shared-auth renewal
still requires its original auth owner as described above; retries do not renew credentials.

If a reminder's turn fails while the owner already has a `review` or `blocked` handback,
Alliance preserves that handback and its decision and retries the still-current reminders.
The failed prompt's message ID identifies the batch; each reminder uses the owner's `maxRetries`
limit, independently of the completed assignment's counters, and keeps its retry count across
reloads. A retry may reopen a known failed session. Cancellation, an explicit pause and uncertain
delivery prevent automatic replay. After the limit, the unresolved reminders remain readable
with a failure note and the next available owner is notified once; failure notices do not
escalate themselves. Acknowledging a repeating reminder starts a fresh budget for its next run.

Review/blocked handbacks create one durable idle-delivery wakeup for the nearest live owner and
that turn; since 0.1.19 it is due two minutes after the turn ends and closes when the owner
decides, so an owner that decides on Paseo's own finish notice first is not woken again. A blocker
asks its owner once, whatever later turns end without a checkpoint; it asks again when its reason
changes, when the owner decides, or after the agent leaves `blocked` and blocks again. The owner
must inspect and explicitly accept candidate-bound evidence. Only then may the plugin archive an
idle agent, with no pending permissions, live native children, unfinished responsibilities,
tracked jobs or unresolved owner wakeups. Native children are archived separately before their
parent so native cascade cannot silently archive unreviewed or unmanaged children. Paused
assignments stay open.

### Closing work by decision (0.1.16)

Archive follows the owner's decision for every Alliance agent, including sessions created before
autonomy existed; continuation remains opt-in for those. The rules:

- Only an agent in the member's responsible owner chain, or the Human, may accept or reject. The
  CLI sends the caller's `PASEO_AGENT_ID`; a terminal caller without one retains terminal decision
  authority but has unknown attribution. An agent cannot accept itself, and a sibling or child
  cannot accept its owner.
- A Peer or Lens closes on its owner's technical acceptance. A Lead, Supervisor or HQ closes on
  product acceptance (`accept --product` with a runtime report) by its owner, or on the Human's
  decision. Decisions recorded before 0.1.16 count by role and by whether their disposition file
  carries a product journey.
- A decision binds to the turn it reviewed. `accept` is refused while the agent is running, when
  its state cannot be read, and when a new turn starts during evidence validation. A later turn
  reopens the decision; so does any newer message Paseo records for the agent, even if the
  turn's start hook was lost. Since 0.1.19 a turn that only keeps the agent's phase (see
  [Autonomous assignments](#autonomous-assignments-0112)) is not later work: the handback and the
  decision stand through it, and `accept` may be recorded while it runs.
- A cancellation pauses continuation; the next turn sent to that agent resumes it. Acceptance
  recorded after a cancellation closes it. A deliberate `checkpoint --phase paused` keeps the
  agent open until it is started again. While an owner is paused by a cancellation, until its next
  turn, the plugin pushes it no reminders; they wait for `wakeups take`. A `paused` checkpoint or
  an obligation handoff stops only the owner's own continuation; its reminders still reach it.
- `alliance-work members keep --agent ID --reason TEXT [--hours N]` keeps an agent open whatever
  its decision, for follow-up work handed to it; `--off` clears it. Its owner chain, the Human or
  the agent itself may set it. From 0.1.52 a keep lapses after 24 hours (`--hours`, up to 720) or
  when its keeper is archived, and `accept` lifts a keep the accepting agent set earlier unless it
  says `accept --keep` (which keeps an agent with no keep of its own for 24 hours); a keep set by
  the Human or by another owner, or set after the accept, stays. `accept` also cancels the
  accepted agent's own reminders that already fired and were never acknowledged (a delivered
  `wait`, an unread `hq` item); obligation reminders, running jobs, reminders not yet due, repeats
  with runs left and unknown sends are untouched. Keeps recorded by 0.1.49-0.1.51 have no lifetime
  and hold until the keeper is archived or lifts them; an older release reads any keep as
  permanent. `autonomy start` without `--auto-archive` keeps the previously recorded choice.
- Children archived or deleted natively no longer hold their parent open. An agent restored
  natively after an earlier auto-archive stays open until it gets new work or a new decision.
- A completed turn nobody decides on for 48 hours wakes the responsible owner, and again every 24
  hours until that owner was reminded three times; then the next owner up the chain that is not
  archived is reminded the same way. A review reminder for that turn that is still to be sent or
  was sent less than a day ago counts as the reminder. Undecided work that no owner can be asked
  about (Human-owned, or no unambiguous living room coordinator can review an archived owner
  chain), or whose reviewers were all reminded, is flagged: `lifecycle.needsHuman` in `alliance-work status` (with `since`, `ageHours` and the
  reason) and a "Needs the Human" line on the board. The plugin only reminds and flags; it never
  accepts or archives. A rejection that no new turn followed for 24 hours reminds its owner once.
  At most four such reminders go out per ten-minute scan, and records already more than three days
  overdue when this first runs (and rejections more than two days old) start their schedule at a
  point spread over the following day. Records from before 0.1.16 start that clock after upgrade,
  spread over the following day.
- A prompt the plugin itself sent to an accepted agent (a wakeup batch) does not count as new work
  after the decision: the sweep reads the agent's native messages since the decision and ignores
  them only when every one carries the ID of a prompt the plugin recorded sending. Any other
  message, or a timeline it cannot read, still holds the archive.
- Terminal decision authority remains available outside an agent session (no `PASEO_AGENT_ID`, no
  Alliance role variables). That absence does not prove Human identity; the recorded decider is
  unknown. An agent that deliberately strips its session identity could claim terminal authority.
  Treat agent instructions, not the CLI, as that boundary.

`alliance-work status` shows `lifecycle.state` (`archivable`, `held`, `awaiting-decision`,
`rejected`, `archived`) and the blockers for each member, plus `decisionBy` and `decisionScope`.
Blockers include native children that are not Alliance members and each blocking wakeup with its
key, age and expiry. `lifecycleSummary` counts open members by state and held ones by cause
(`keep`, `wakeup`, `child`, `job`, `obligation`, `agent-state`, `new-work`, `paused`,
`product-acceptance`, `permission`, `other`).

Finished wakeups (acknowledged, canceled, expired) are removed seven days after their last change,
except a reminder that still names the member's current turn and anything linked to an open
obligation. The 1000-record cap applies to unfinished wakeups only. While the scheduler pause is
held (a maintenance command, a waiting update while it activates, or from the end of staging
with `--hold`), the plugin starts no
continuation, retry or reminder turns and denies no approval request, and `status` reports the
pause in `wakeupHealth`. A lock
whose process died, or that predates a reboot, is ignored by the plugin and replaced by the next
maintenance command.

State and counters survive plugin reload and daemon restart. Dispatch is claimed before send;
a crash or ambiguous response is quarantined as `uncertain` and never automatically replayed.
Inspect native history and side effects, then checkpoint/resume deliberately. Paseo hooks are
best effort with no replay; if both the native hook and its durable outcome were lost, Alliance
holds the assignment rather than inventing an outcome. Inspect and resume via a native turn.
A stopped daemon runs no scheduler. These bounds prevent an unattended infinite retry loop;
they do not guarantee arbitrary work will finish without a human decision.

Paseo 0.11.2 has no atomic idle-only send/archive. Fresh status and revision checks reduce races,
but a concurrent human/native action can still race an SDK mutation. Native `steer` is not a
queue guarantee. No Paseo core modification, extra daemon or coordination MCP is installed.

Real-model acceptance, including plugin reload between turns, owner wake, evidence-gated archive
and recovery from an actual provider rejection:

```sh
node scripts/acceptance-autonomy.mjs /absolute/new-output "$HOME/.codex"
```

It uses isolated homes and a disposable native daemon with read-only shared auth, sends one
initial worker prompt, and checks generated artifacts across three turns. The receipt records
measured outcomes; portable fixture tests additionally exercise cancellation, permission holds,
ambiguous dispatch, stale events and native-child archive protection.


### Handback, waiting and reminders (0.1.19)

A worker hands back by saving its result, recording `autonomy checkpoint --phase review` (or
`blocked`) and ending its turn; it sends no handback prompt. Every member whose responsible owner
is an Alliance agent has an assignment record, including members given an owner with `members
owner` after their session started. A completed turn of a `waiting` assignment that recorded no
checkpoint and was not started by the plugin to deliver its own wake batch or by Claude Code
itself, with no obligation,
no reminder of its own that still applies and no child running or just created to wake it, is
treated as its handback. A record created only for this is handback-only: each such turn goes to
the owner for review, and any failed turn, a wake batch's included, as `blocked`, unless a provider
limit ended it (that is waited out as described above); its next turn makes it wait again (a wake
batch's turn leaves it as it is), and until `autonomy start` or an `active` checkpoint makes it an
assignment it is never continued and is retried only once at each limit's reset.
The review reminder goes to the nearest unarchived owner up the decision chain and is due two
minutes after the turn ends, so an owner that already acted on Paseo's own finish notice is not
woken again. A review about a child that is archived, by Alliance or natively in Paseo, is
canceled instead of sent. A review ends with a decision on that turn:

```sh
alliance-work accept --agent ID --report /absolute/report.json   # the report verify printed
alliance-work reject --agent ID --reason 'What the handback lacks' [--rework 'What to change']
alliance-work wakeups defer --key KEY --owner OWNER --revision N --minutes 30
```

`accept` takes the report `alliance-work verify` wrote for the candidate, never the turn file the
review names; anything else is refused with that advice. Rework is a prompt to the agent; its new
turn replaces the review. `reject --rework TEXT` records the rejection and sends the agent the
reason and that rework as an ordinary prompt in one step (not a wakeup, so its turn reopens the
handback); if the agent cannot take it now the rejection stands and the command says so. A
rejection never archives. A decision on that turn (`accept` or `reject`) closes the review by
itself; an archived owner's reviews are canceled. An `ack` after the decision succeeds without changing anything and says the
decision closed it; wake batches say that only their other items need an ack. Before a decision,
a newer turn, or the agent being archived, kept or re-owned, `ack` on a review is refused and
names these choices. `wakeups cancel` stays available, with the 48-hour reminder as the backstop.

For a non-Git analysis bundle outside the worker's checkout, put the deliverable in a dedicated
directory under that room's artifacts. Verify there with `--kind analysis --input FILE` for every
file in the reviewed scope, with the verification output outside the bundle. Then use
`accept --agent ID --report /absolute/report.json --analysis-root /absolute/room/artifacts/bundle`.
This explicit technical acceptance checks the bundle path, file digests, command output and
project skills. A different room, symlink, changed artifact, Git-root substitution or product
claim is refused. It does not establish semantic correctness beyond the chosen verification or
complete the parent's product outcome. Do not relabel runtime evidence to bypass a failed gate.

Paseo 0.12 may accept rework as a steer inside an existing maintenance/background turn without
another turn-start hook. Alliance checks canonical native message identity and the current turn
generation before a decision, during reconciliation and at turn end. Its own reminder messages
keep the earlier handback; another user prompt makes the turn new work, clears the earlier decision
and publishes its final result even without a checkpoint. This also applies when rework fails or
is canceled. A failed native read holds acceptance and automatic archive until reconciliation
succeeds; it does not treat missing identity evidence as proof that the turn was maintenance.
If an outage exceeds the retained receipt bound, status reports it and keeps the decision held;
inspect the native chat before explicitly starting or checkpointing the replacement work.

Agents wait by ending the turn, never by sleeping or polling inside it:

```sh
alliance-work wait --agent CHILD --reason 'Review its result'
alliance-work wait --pid 12345 --title 'Benchmark controller' --reason 'Read the benchmark output'
alliance-work wait --minutes 30 --reason 'Check the deployment'   # or --job RUN_KEY, --at ISO_TIME
```

`wait` takes exactly one trigger. It registers an idle reminder for the owner (`--owner` and
`--room` default to the agent session), tracks `--pid` as a job first, and records a `waiting`
checkpoint when the owner is the caller; then the agent ends its turn and is woken. It never
withdraws a handback, a blocker or a pause: when the caller's assignment is in `review`, `blocked`
or `paused`, whichever turn set it, it registers the reminder without a checkpoint and says so.
`--agent` waits for the child's running turn and is refused when the child is not running one (a
turn that only keeps its phase does not count). A turn whose own checkpoint was `waiting` or
`active` handed nothing back: its reminder asks for an ack, not a decision.

From 0.1.30, new `wait --minutes` and `wait --at` reminders end at the owner's next acceptance or
rejection. A later rework cannot revive them. Jobs, obligation reminders and explicit standing
reminders made with `wakeups add` retain their own conditions. Older time reminders have no such
binding: reconcile their evidence and cancel obsolete ones explicitly, without closing obligations.

Native archive does not retire open obligations: status retains their blockers. Reopening a native
session restores its recorded custody; an archived managed assignment remains paused with its
original budget and counters until explicitly resumed under its existing authority and conditions.
Opening it alone sends no work prompt and does not declare its outcome complete.

Claude session opens now pass the current native model selection to the managed launcher as a
session-specific fallback when the native command omits `--model`. An explicit native model argument
wins. Status exposes `selectedModel` and `runtimeModel` separately; the latter is last reported,
not necessarily a fresh model turn. The UI flags differences for inspection, including possible
aliases. This does not prove every upstream provider honors a selected model or repair historical
drift; verify the actual resumed output before claiming that drift is resolved.
Repeating the same request returns the same key; for `--minutes`, within the same turn.

### Stuck members (0.1.19)

Nobody approves commands for Alliance members, so Alliance answers their approval requests itself.
It records when it first sees each request: from Paseo's `agent.permission_requested` hook, or
from the first sweep that lists it (a request already pending when the plugin loads). Five
minutes later it denies the request through Paseo (`respondToPermission`, `behavior` `deny`);
it never allows one. The message tells the member to redo the step without anything that needs
approval, for example to clean its scratch with `alliance-work scratch clean` instead of running
`rm -rf` with a glob, and to go on; Claude reads it as the denied call's result and its turn continues.
This covers every Alliance member, root chats included, and no other Paseo agent. `status` shows
the last denial (`members[].denied`: request id, tool, command and time). The nearest live member
owner is not woken: it gets a pull item, listed in its next Alliance prompt, that lapses after six
hours. A request still pending after its denial is denied again at the next sweep, every 15
seconds while the scheduler runs.

A running member whose turn has shown no activity for 20 minutes, with no approval request
pending, gets one notice to its nearest available owner (idle delivery, lapsing after six hours);
a member without a live member owner gets none. A long command the member tracks with
`alliance-work jobs track` is not reported. The notice names the command still running and how to
interrupt the member on that daemon: on Paseo 0.12 send with `activeTurnBehavior` `interrupt`,
because a steer reaches a Claude turn only after the running tool call returns; on 0.11.2 any send
interrupts; on either, `cancel_agent` first also works. Inspect its activity, then let it run or
interrupt it and tell it what to do instead.

## Combined lifecycle and obligations (0.1.12)

Version 0.1.12 unifies the two local 0.1.11 candidates. It pins Paseo CLI/client/plugin 0.12.0
and retains tested compatibility with existing 0.11.2 daemons. Installing the Alliance plugin
never restarts a running daemon; a host Paseo upgrade is separate, explicit maintenance.

Bind dependent continuation with `autonomy start --agent ID --obligation KEY`. The obligation
must be open and owned by that agent. Both ordinary continuation and failed-turn retry wait for
all unexpired prerequisite observations; waiting does not consume budget. `waiting` with a bound
condition resumes when it becomes ready. Independent unbound assignments may keep working. An
assignment bound to an obligation that was fulfilled, canceled or handed off is not continued.
Linked pull reminders remain informational; their expiry or ACK never authorizes execution.

A managed obligation handoff transfers the binding and remaining retry/continuation budget in
the same transaction as the obligation, history, linked notifications and exclusively owned jobs.
The old owner is paused. The successor must be idle, without pending permissions or another
managed assignment; in-flight or uncertain deliveries must be reconciled first. Handoff to Human
pauses the old owner and sends nothing. An explicit paused assignment remains paused on transfer.
All open obligations prevent auto-archive, including obligations with expired/ACKed reminders.
Evidence-based obligation fulfillment and candidate acceptance remain separate checks.

Run `scripts/acceptance-autonomy.mjs` for real-agent verification of prerequisite holds across
reload, readiness-gated provider retries, handoff/reload preserving budgets, and acceptance held
until the obligation closes. Source fingerprints bind these receipts to the tested implementation.

## Cost-aware roles (0.1.13)

HQ is the Human's point of contact and delegates substantive implementation, investigation,
test execution and integration to Leads or Peers. Use HQ → Peer for bounded work, or HQ → Lead →
Peer when a workstream needs technical integration ownership. Supervisor is optional for coordinating
independent workstreams. HQ retains scope, priorities, product critique and acceptance; a bounded
implementation exception requires an explicit Human assignment and a recorded scope and reason.
Reuse existing owners and preserve WIP, model restrictions, budgets and acceptance conditions.
New launches use Peer for substantive implementation by instruction; extra coordination roles
are justified by integration, multiple workstreams or cross-project decisions. This is a
responsibility default, not a role quota or capability ban. HQ/Supervisor/Lead omitted models
select Sol/Sonnet; premium models require explicit selection. Omitted worker model/difficulty
uses the standard band and cannot fall through to a frontier route because a cheaper model is
unavailable. Explicit saved room policies remain authoritative. Existing native sessions retain
their model and prompt; use policy read at their next work boundary, with no broadcast or restart.

## Token usage and estimated cost (`usage`)

```bash
alliance-work usage                       # last 7 days, by provider and role
alliance-work usage --days 14 --by provider,role,model
alliance-work usage --days 14 --by gap       # Claude main-chain cold-wake estimates
alliance-work usage --since 2026-11-01 --until 2026-11-08 --by day --json
```

`usage` reads this host's Claude Code, Codex, agy and Pi usage records and Paseo agent records,
then prints requests, input-side tokens, cache read/write, output, cache hit and estimated cost. It is
read-only, uses no network and never reads conversation text into its output: only usage
counters, model, time and ids are taken from a log line. It does not touch the daemon and writes
nothing, including under the Alliance home.

- Input side is Claude input + cache read + cache write; for Codex it is `input_tokens`, which
  already includes cached tokens. Cache hit is cache read divided by input side for both.
- Claude lines that repeat one response (same message id and request id, in any file) count once, with the
  copy that has the largest output. Codex counts one request per response id, compaction calls included;
  cumulative totals are never added.
- The cost is a conversion at public API list prices of the tokens counted. It is not an invoice
  or a subscription charge. Models without a listed price are named in the output and left out of
  the cost, which is then shown with `≥`.
- A session gets its role from the Paseo agent record (provider `alliance-<harness>-<role>` and
  the native session id), otherwise from the Alliance profile directory it sits in. Sessions that
  match neither are not Alliance work: they are listed as excluded (`--include-other` counts them)
  and the output states how much of the requests each source covered.
- agy counters come from conversation databases; Pi counters include assistant, compaction and branch
  records. Missing timestamps, unknown model prices and unreadable files are reported as coverage gaps.
  Alliance supports Node 24.0+; full SQLite usage reporting needs Node 24.16+ and a stable
  database/WAL snapshot no larger than 256 MiB per file. Older Node still reports other usage,
  names each unavailable SQLite section with the running Node version in JSON/text, and exits 2.
  Unsupported, changing or corrupt snapshots are unavailable; the command never opens source SQLite
  files through SQLite, changes SHM bytes, or copies their contents to disk.
- Cold wakes and rebuild tokens/USD estimate Claude main-chain cache loss, excluding subagents,
  model changes and large context shrink. `--by gap` separates the idle intervals. These are list-price
  estimates, not measured subscription savings.
- Weekly friction reports `review.wait`, `review.superseded`, `review.reject`, `review.defer` and
  `human.waiting` with the basis and coverage for each. Terminal wakeups are retained for seven days;
  older missing history is unavailable. Defer counts are retained cumulative counters grouped by
  latest update, and Human waiting is a current stored-state estimate, not historical or live readback.
- Wake-source counts use recorded turn markers refined by native readback. They are not joined to
  token costs without verified transcript identities; `native.plain` does not identify a Human.
- Windows are `[since, until)` on the record's own time, dates in UTC (`--tz` shifts day buckets).
  Defaults: `--home` the Alliance home, `--user-home` the user's home, `--paseo-home` from the
  installation.

Prices are in `server/usage-pricing.json` with the date they were fetched; a release ships a
refreshed copy. To correct or add a model on one host without editing managed files, create
`<alliance home>/usage-pricing.json` (or pass `--pricing FILE`) with the same layout, for example
`{"anthropic": {"claude-new-1": {"input": 3, "cache_write_5m": 3.75, "cache_write_1h": 6, "cache_read": 0.3, "output": 15}}}`
(USD per million tokens; Codex models under `openai` take `input`, `cache_read`, `output`). Entries replace the
bundled entry of the same model. Batch, fast-mode, regional and long-context surcharges are not modelled
beyond what a table entry lists.

## Peer and Lens model lists (0.1.18)

Each route now names its role. Peer and Lens have separate ordered lists; every release-default
route serves all four difficulties, so the order alone expresses the Human's preference.
The release-default routes are listed once, in the [Vietnamese quickstart](quickstart.vi.md#model-theo-room);
`alliance-work models show` prints what a room uses.

The Human can opt a room into Claude owner keepwarm with
`alliance-work keepwarm --room ROOM on [--max N]` (default 3, maximum 5).
Use `alliance-work keepwarm --room ROOM status` or `alliance-work status` to inspect it,
and `alliance-work keepwarm --room ROOM off` to stop it. A safety stop appears with its
reason; only the Human can enable the room again. Existing rooms start with keepwarm off.

The gate matches the target role's list exactly. An omitted model takes the harness's first
standard route that the live catalog offers, so a missing Pi provider falls to the next Pi route
and never to another harness. A refusal lists the routes the room allows for that harness and role.
Pi routes need the corresponding provider credentials in the Pi role's `auth.json`.
Operator-added API providers also need an explicit entry in that role's unmanaged `models.json`;
this release does not configure a personal endpoint or placeholder provider by default.

A policy saved before 0.1.18 has no roles; each of its routes applies to both Peer and Lens and is
written in the per-role form on the next save. `alliance-work models show [--room ID]` prints each
room's lists and whether they are saved or the release default. `alliance-work models reset
--room ID|--all` (Human only, refused inside an agent session) deletes the saved row so the room
follows the release defaults, including later releases. Since 0.1.19 each deleted list is kept
verbatim in `rooms.sqlite`, table `room_model_policy_removed`, and the command prints its id and
revision; the Models page reset keeps it too. There is no restore command. Revisions keep counting
through a reset (`room_model_policy_resets`), so a settings page opened before the reset cannot
overwrite a later save. The Models page offers the same reset as **Follow release defaults**.

Rollback: releases before 0.1.18 read routes without roles. A saved list that names the same
harness/model/effort for both Peer and Lens (for example an upgraded pre-0.1.18 list after any
save) is invalid there: every Alliance launch in that room, owners included, would fail and the
old Models page could not open it. `alliance-work rollback` therefore refuses while such a room
exists and names it; reset it or remove the duplicate first. Release defaults and reset rooms stay
readable by older releases. Running sessions keep the list in their system prompt, while the gate
always reads the current list.

To edit a room's routes from the CLI, export its current revision and policy, edit the JSON,
then save outside an agent session:

```sh
alliance-work models show --room ROOM_ID --json | jq '.[0] | {revision, policy}' > room-models.json
alliance-work models save --room ROOM_ID --file room-models.json
```

Saving checks the exported revision; reload after another editor changes it. For a Hydrogen
pilot, add a route with `harness: "agy"`, the exact Hydrogen ID from that role's live Models
catalog (for example `gemini-4-hydrogen-medium`), `role: "peer"`, `effort: "medium"`,
an explicit priority and the desired `difficulties` array. Save only the pilot room. To select
it by default for that room's standard AGY Peer launches, include `"standard"` and put its
priority ahead of other standard AGY Peer routes. The release defaults stay unchanged.

Fable needs an explicit selection, a frontier-only worker route, and a nonempty
`policy.fable.rationale` written by the Human in the same settings file. The rationale applies
to the room; it is not evidence of a separate assessment for each launch. `models show` and
`status` report refused saved routes, including Carbon, without removing them. Use the Models
page or this edit/save flow to remove those routes; reset replaces the entire saved list.

## AGY role profiles

When `agy` is on the installation PATH, preparation adds `agy-hq`, `agy-supervisor`,
`agy-lead`, `agy-peer` and `agy-lens`. Each has its own `~/.agy-alliance-work/<role>`
home and private HOME/XDG directories. Existing installations retain their other
role homes and saved room policies. A refresh refuses to remove an existing AGY
role set if its executable becomes unavailable.

Sign in through `alliance-work login agy peer` using a dedicated Alliance account.
This opens the native interactive CLI in the isolated Peer home. After `/logout`,
reopen the same source role to authenticate again: only that interactive source
profile may start with its credential missing. Other roles and agent launches
continue to require the shared credential.
To share that login across this installation's five roles, run:

```sh
alliance-work auth agy --from ~/.agy-alliance-work/peer/os-home/.gemini/antigravity-cli/antigravity-oauth-token
```

Only the native credential file is linked. Native AGY manages refresh; HOME,
configuration, skills and history remain separate. Existing different role credentials
are never overwritten. No daily configuration, plugins, instructions or skills are imported.
On macOS, Alliance launches that use the selected file block AGY's Keychain helper
for the lifetime of that process, including catalog queries, new sessions, and
resumes. This keeps OAuth refresh on the selected file. For an interactive login
over SSH, AGY prints a URL and accepts the browser's authorization code in the
same terminal. Plain `agy` uses the macOS user's normal Keychain.
Repeat login independently on each host. On headless Linux, AGY uses its native
file fallback when no session D-Bus keyring is available.

The Alliance provider reuses the Antigravity driver from the exact pinned Paseo
0.12.0 dependency, registers each role directly, and creates a private native
agent definition for every session. The definition selects only the role and
explicit project skills. The generated MCP configuration contains the native
Paseo endpoint bound to that agent, and is removed when the session closes.
This is a provider adapter, not another coordination server.

AGY's live model IDs encode effort (for example `gemini-4-argon-medium`). The
catalog exposes only that matching effort; it never translates an unsupported
selection. AGY runs only Gemini models (0.1.19): owners default to
`gemini-4-argon-medium`, a launch naming another AGY model is refused for every role,
a saved AGY route naming one is passed over, and the Models page neither offers nor
saves one. Running sessions keep their model. Since 0.1.23 the release defaults use
Pi Antigravity Gemini routes for new Peer and Lens launches. Existing saved policies
remain unchanged: add any desired AGY routes in the room's Model settings before
launching a Peer or Lens there.

Before activation, qualify authenticated MCP calls, two simultaneous native agents,
and a real owner → peer → owner handback on each target host with
`scripts/acceptance-agy.mjs NEW_OUTPUT ALLIANCE_TOKEN_PATH`. Steering and exact MCP preapproval are unsupported; explicit
preapproval requests fail rather than being silently ignored. Native AGY owns
compaction; the 300k policy verified for the other harnesses is not claimed for
AGY. Only Full access is exposed, matching the pinned native provider.

Qualification on another machine or release does not establish current-host readiness.
Use a disposable instance for native discovery and a separately authorized model-driven
owner → peer → owner handback, retaining receipts and cleaning up the owned test daemon.

## User MCP: Mobbin

The user-level `~/.alliance-work/user-mcp.json` enables the official remote Mobbin
server (`https://api.mobbin.com/mcp`) for all five Claude, Codex and AGY roles, across
all projects. Nothing is written to a project. Pi is unchanged.

```sh
alliance-work mcp add mobbin
alliance-work mcp login mobbin
alliance-work mcp list
```

Authenticate once per host in the browser. The pinned `mcp-remote` transport shares
only Mobbin OAuth state under `~/.alliance-work/mcp-auth/mobbin`, with owner-only
permissions. Each session starts its own transport to Mobbin's hosted server;
there is no additional coordination service. Role HOME, native logins, skills,
plugins and history remain separate. Authorization tokens are never embedded in
project files or command arguments. Mobbin's account/plan restrictions still apply.

The launcher merges this explicit user entry with the native, agent-bound Paseo
endpoint. Project MCP entries and saved session overrides cannot replace Mobbin.
For new Codex agents, the creation hook also puts the approved server into Paseo's
per-thread configuration, which otherwise overrides the launcher's MCP table.
AGY adds the approved Mobbin stdio transport to its private generated session MCP
configuration while retaining the validated, caller-bound native Paseo endpoint.
On an installation previously enabled only for Claude/Codex, rerun `mcp add mobbin`
to include AGY; the existing Mobbin login is retained.
User configuration and OAuth state survive setup, updates and profile regeneration.
For SSH login, forward loopback port 43159 from your browser machine to the remote
host, then run the login command there; open its authorization URL locally.

Newly opened native sessions pick up the setting. Existing sessions keep their
current MCP inventory until reopened; do not interrupt running assignments just
to refresh tools. To disable, set `mobbin.enabled` to `false` in the user file.

Qualification: `node scripts/acceptance-mobbin.mjs ALLIANCE_HOME NEW_OUTPUT`
checks native Claude/Codex discovery in two unrelated projects and makes one
read-only Mobbin search. It requires a completed login and starts no model turn.


## Managing project skills

Open **Alliance Work → project → Skills**. Installed skills are discovered only in that
project's `.agents/skills/<name>` directory; check the desired skills and **Save selection**.
The Git repository root is the scope when opening a subdirectory. A separate Git worktree has
its own selection. For a non-Git project, the selected directory is the root.

Expand **Bundled skills** to manage the 23 playbooks shipped with Alliance: 18 Seatwork and
5 Alliance skills. Each row shows its description, source and eligible roles. Selection applies
to this project across Codex, Claude, Pi and AGY, including HQ, Supervisor, Lead, Peer and Lens
where the skill is assigned. **Disable all bundled skills** and **Restore bundled defaults**
change the selection; **Save selection** persists it. Other projects retain their own settings.
The manifest records disabled bundle names in `disabledBundled`; omission means bundled defaults.
CLI project-skill edits and GitHub imports preserve that bundled selection.

The public edition ships the existing pinned Seatwork resources without the fourteen
unpublished same-name adaptations. The 23 catalog names, role assignments and toggle keys remain.
Optional operator-authored overrides are supported when a manifest is supplied; without one,
profiles install the pinned resources. Tests exercise replacement, rollback and edit protection
with locally authored synthetic fixtures. Updating or rolling back refuses to overwrite modified
managed assets. Provenance verification checks the pinned source bytes in either mode.

Assess skill changes with comparable real tasks, unchanged model, effort and acceptance. Record
outputs, tool use, usage and failures alongside quality; source validation alone does not prove
efficiency or product delivery. Preserve original results when correcting a scorer.

Fresh runtimes use one effective selection for their instruction catalog and native discovery.
Claude disables implicit setting-source discovery and loads a selected-only skill plugin;
Pi disables automatic skill discovery and receives explicit selected paths; Codex disables
unselected native-discovered paths; AGY receives selected skill directories with customization
inheritance disabled. This controls automatic loading, not filesystem access: an agent with file
access can still read a skill explicitly. Existing conversation context cannot be revoked by a
toggle. Core operating policies remain separate from optional skills.

`npm run test:native` checks ON, OFF, fresh-OFF and restored discovery for all five roles on
Codex, Claude and Pi, including stale caller arguments. For a disposable plugin RPC end-to-end
check run `node scripts/acceptance-skill-toggles.mjs /absolute/empty-output-directory` on Node 24.
It starts/stops its own daemon and records native inventories without model turns. AGY tests
verify generated session configuration; they do not prove model-visible discovery. After changing
bundled source metadata, regenerate its UI catalog with `node scripts/update-bundled-skill-catalog.mjs`;
tests require the catalog to match the pinned source without modifying vendored bytes.

**Add from GitHub** accepts `owner/repo`, an HTTPS GitHub repository/tree/SKILL.md URL, or
`npx skills add owner/repo [--skill NAME ...]` (also `skills@latest`). Preview lists descriptions,
instructions, paths and the resolved commit. Select skills, then **Install & enable** to copy
resources into the project and register them together. Pasted commands are parsed as source
information; the installer uses Git objects and does not execute npm, hooks or skill scripts.
GitHub authentication uses the daemon host's existing Git credentials, without interactive prompts.
Use an immutable commit URL if a branch name containing slashes is ambiguous in a tree URL.
Global/agent flags, arbitrary npm packages, non-GitHub hosts and skills.sh pack URLs are unsupported.

Installation uses the exact previewed commit, records `.alliance-source.json` inside each skill,
rejects symlinks/submodules and existing destination directories, and preserves resource paths and
executable bits. Missing/invalid local skills are shown with an error and can be disabled.
The combined selected bundle is limited to 16 MiB; individual skills to 1000 files.
Import is additive; updating or deleting existing skill files is a separate deliberate action.

The UI and CLI share a project lock and content revision. A stale editor must reload before
saving, including when source skill files changed. Previous selection files are backed up in
`.alliance/skill-backups/`. If a writer crashes, first establish that no skill writer is running
before removing `.alliance/.skills-lock`; inspect any newly copied but unregistered skill files.
A malformed `.alliance/skills.json` must be repaired from a backup before editing through the UI.

```sh
alliance-work skills settings --project /path/to/project
alliance-work skills add .agents/skills/design-review --project /path/to/project
alliance-work skills remove .agents/skills/design-review --project /path/to/project --revision HASH
alliance-work skills save --file selection.json --project /path/to/project --revision HASH
```

`selection.json` is an array of paths such as `[".agents/skills/design-review"]`; `[]` disables
all project skills while retaining their files. `skills list` still lists the selected runtime
bundle; `skills settings` also lists disabled/invalid skills and the editing revision.
Selections take effect on fresh sessions. Existing agents are neither restarted nor stripped
of instructions they have already received. No daily profile or unrelated project is imported.

## Project MCP settings

`ALLIANCE_HOME/scoped-mcp.json` is an operator-owned, additive configuration. It is never
read from a project. It must be a regular file without group/world write access; Alliance
home and configuration symlinks are rejected. It contains no credentials:

```json
{
  "version": 1,
  "projects": [{
    "root": "/absolute/canonical/project",
    "harnesses": ["codex", "claude", "agy", "pi"],
    "servers": {
      "approved-tool": {"command": "/absolute/executable", "args": ["/absolute/helper", "--stdio"]}
    }
  }]
}
```

Session cwd is canonicalized before matching the root or descendants. Prefix siblings and
symlinks escaping a root do not match. An inbound alias resolves to its canonical project.
Each stdio command is wrapped with the selected canonical root and session cwd; the wrapper
rechecks containment and starts the helper in that cwd even when the MCP client starts it
from a role HOME. `paseo` and `mobbin` names are reserved, overlapping duplicate names fail,
and project/caller MCP definitions still cannot replace approved servers. Existing Mobbin
behavior is unchanged. This is configuration isolation, not an OS security boundary against
a full-access shell agent. Browser and remote-system read-only policies remain the helper
and project instructions' responsibility. Do not put credentials in this file.

Claude merges the selected servers under strict MCP config. Codex needs both the launcher
table and the plugin's agent-create per-thread table. AGY merges into its disposable session
config. Pi loads a dedicated extension only for an approved canonical cwd. The extension uses
`registerMcpServer()` during loading, before builtin MCP connects on session start. These registrations
are session-local and do not modify role or project `mcp.json`. Generic project trust stays disabled.

Activation requires a reviewed source release, an owner-controlled allowlist in Alliance HOME
(back up any existing file), and the normal idle-only installer/plugin reload. Never edit a
pinned installed release or restart a busy daemon. Only fresh sessions created by the new
plugin/launcher are qualified; existing sessions and saved per-thread MCP tables are not
retrofitted. Validate fresh sessions after activation. Removal of this allowlist disables
selection for future sessions; it does not revoke tools already loaded in a running session.


### Managing project MCP

In Alliance Work, choose **MCP** on a project. Add the server name, absolute executable path
and arguments (JSON array), choose harnesses, optionally restrict tools, then Save project MCP.
Edit/remove server entries locally before saving. The effective saved preview includes parent
project entries and global Mobbin. Removing a project override does not remove inherited entries.
Writes compare the revision and use a process lock; reload after another editor saves. Previous
nonempty settings are backed up under `configuration-backups/`. A crashed edit may leave
`.scoped-mcp-lock`; verify no configuration writer is active before removing that lock.

The equivalent Human CLI workflow is:

```sh
alliance-work mcp projects
alliance-work mcp save --file /absolute/project-mcp.json --revision HASH_FROM_PROJECTS
alliance-work mcp preview --project /absolute/canonical/project --harness codex
alliance-work mcp remove --project /absolute/canonical/project --revision CURRENT_HASH
```

The save file is **one project object**, with `root`, `harnesses`, and `servers`, as shown above.
Save replaces that project's entry and preserves every other project. `mcp list` remains the
legacy global Mobbin command; `mcp projects` returns project settings and their revision.
Executable paths refer to the daemon host. Stdio MCP is supported directly; a remote HTTP MCP
can use an operator-installed stdio bridge, with authentication owned by that bridge. This
release does not add an OAuth manager or store credentials in project configuration.

A server may include an optional exact-name tool policy:

```json
"tools": { "allow": ["jira_get_issue", "jira_search"], "deny": ["jira_create_issue"] }
```

Omitted `allow` means all tools except denied names; `allow: []` means no tools. Deny wins.
Names are the upstream MCP names, before harness prefixes. Both paginated `tools/list` and
`tools/call` enforce the policy: calling a hidden/denied tool directly never reaches upstream.
Restricted servers expose tools only; resources, prompts, sampling, elicitation and experimental
MCP tasks are not proxied. Omit `tools` to preserve the original server's complete protocol.
This adapter enforces session tool routing, not containment of an agent with full shell access.

Configuration selection happens when launchers open. Policies are snapshots for that runtime;
editing/removing a server does **not** revoke an existing connection. Finish and recreate the
agent to guarantee new policy, especially for Codex's saved per-thread MCP configuration.
No save interrupts agents or reloads the daemon. A detached worktree outside the approved root
must be explicitly added; repository identity alone never grants it project tools.

### Paseo 0.15 compatibility

The initial MCP release kept SDK/CLI pins at 0.12.0; the 0.1.32 upgrade above supersedes those pins. AGY retains its byte-identical pinned native driver.
Paseo 0.15.2 still adapts `server.before`/`server.on`. Upstream's `addHook` replacement renames
`agent.session_open` to `agent.open.before` and the create/turn/archive events. The tagged SDK
marks legacy methods for removal after 2027-04-30; a future SDK upgrade must migrate them together
with the AGY driver rather than replacing dependency versions alone.

Paseo 0.15 adds worktree before/awaited-after hooks, terminal persistence and opt-in agent recovery.
The first upgrade from 0.14 still closes terminals; Alliance does not perform that daemon upgrade.
Recovery remains operator-controlled to avoid duplicate continuation with Alliance wakeups.
Qualification uses a disposable daemon and the native install/rollback test, including project
MCP read/save/preview and stale-revision rejection; it does not prove a paid model turn.


### Daemon-wide model defaults and project overrides

In Models, choose **Global · this daemon** to edit the defaults inherited by projects on that host. A project with no saved override reads the current global policy; without a saved global policy it reads release defaults. Existing saved project policies remain overrides. Choose **Inherit global settings** to remove a project override (the previous policy is retained in the policy audit table). Global changes affect future launches, not running sessions.

Choose **This project** and save to customize that project's complete policy. Global settings are local to one daemon, not synchronized between machines. In the live catalog, select multiple supported reasoning efforts and use **Add selected**; existing routes and their difficulty restrictions are preserved. Peer release defaults include Pi Antigravity Gemini 3.8 Flash high alongside medium.

## Job results and archive

`jobs settle` records an explicit `succeeded`, `failed`, `superseded`, or `unverified` outcome. Supply `--key`, `--revision`, `--outcome`, `--reason`, and `--evidence` (absolute JSON file). The proof must bind `key`, `pid`, `processIdentity`, `outcome`, and matching `reason`. Verified outcomes require nonempty `artifacts` with absolute `path` and `sha256`; the operator remains responsible for interpreting their result. Unverified means no success claim. Running and unknown processes are refused. Only the recorded owner chain or Human may write. Revisions reject stale changes.

`jobs archive --key KEY --revision N` requires settlement and a freshly observed exit. `jobs restore` makes history visible again without restarting anything. Both preserve the result; changed settlements retain their previous record. Archived jobs are hidden by default and visible with the existing archive toggle; any running/unknown observation remains visible regardless. `jobs list` retains the complete history. Archival does not close obligations, accept a product, stop services or erase artifacts. Historical cleanup must preserve results needed by unfinished assignments and their pending wakeups.

## Session scratch and disk cleanup

Each Alliance session opens with its own scratch directory under `/var/tmp/alliance-<uid>/<installation>/<room>/<agent>` (owner-only; `ALLIANCE_SCRATCH_ROOT` moves the root, which must be absolute). The plugin sets `TMPDIR` and `ALLIANCE_SCRATCH` to it for every harness on each open, so a resumed session gets the same directory back. If the directory cannot be prepared the session still opens, without it. Nothing is stored: the path follows from the installation home, room and agent IDs, so older releases ignore it.

- `alliance-work scratch clean [PATH]` runs inside an agent session and empties only that session's own scratch, or removes the one subpath PATH of it (relative to the scratch or absolute inside it; a link at PATH is removed, never followed). Before deletion, it checks evidence references and refuses with a reason when evidence still binds the target or the scan cannot establish that removal is safe. There is no override. It recomputes the directory from the session's identity, needs no approval, and refuses (removing nothing) when `ALLIANCE_SCRATCH` is missing or names anything else, including a symlink or a path that resolves elsewhere. Links inside scratch are removed, never followed.
- `alliance-work disk [--json]` reads scratch size per room and member, marks the scratch of archived members cleanable, lists scratch no member record explains, and lists the worktrees of archived members with their clean, merged and in-use state. It deletes nothing.
- `alliance-work cleanup worktrees [--base REF]` and `cleanup scratch` list what they would remove. `--apply`, for the Human outside an agent session, removes only items of archived members, each judged again right before removal. A worktree goes only when it is a linked worktree registered with its repository and not locked, `git status --porcelain` is empty, HEAD is an ancestor of the merge target, no member that is not archived uses it, and no process has its working directory inside or names it on its command line; the removal is `git worktree remove` without `--force`. The merge target is the shared default branch (`origin/HEAD`, else `origin/main` or `origin/master`) and the local `main` or `master` only when the repository has no remote default; `--base REF` overrides it. Branches and commits stay. Ignored files (for example `.env`) are not tracked by Git and go with the worktree; `disk` shows how many each has. Scratch of an archived member goes only when no process uses it. Nothing is deleted by age or timer; a member that is reopened stops being cleanable.

- `alliance-work cleanup artifacts [--scope own-scratch|archived|archived-scratch|archived-worktrees] [--older 1d] [--include-primary] [--apply]` finds rebuildable directories (`node_modules`, `.next` and similar caches next to a `package.json`; `.venv`, `.tox`, `.nox` next to a Python manifest; `__pycache__` and tool caches; `target` next to `Cargo.toml` or `pom.xml`; Gradle `build` and `.gradle`; Swift `.build`; Zig caches) by name and manifest, never by guessing. It lists by default. A session's scope is its own scratch and it may `--apply` there; the Human's default is the scratch and worktrees of archived members, and `--include-primary` adds the rooms' primary checkouts. `--older` (default `1d`) is the age of the newest write inside the directory. A directory stays when it is a symlink, when any process has its working directory in it or in its project directory or names either on its command line (or that cannot be told), when it lies in or above the Alliance home, an installation or the running code, or, in a checkout, when Git tracks files in it or does not ignore it. Everything is judged again right before removal. Alliance does not use `kondo` (v0.9): it has no process check and no way to limit it to a scope.
- Evidence protection: acceptance, integration proofs and the archive recheck re-hash every artifact a verification report names. The Human-run `cleanup scratch|worktrees|artifacts --apply` read each room's `evidence/*/report.json` and `dispositions/*.json` and keep anything under the target that a pending member, or a member whose owner chain is not archived yet, names (or a document no member claims), and the listing says which file and whose evidence. Documents elsewhere (a `verify --output` outside the room, or a report not yet saved by `verify`) are not visible to it.
