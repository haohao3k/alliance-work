# Installation and operation

The `alliance-work` command manages one dedicated Paseo instance and its isolated role homes.
It uses the pinned local Paseo CLI and native plugin lifecycle. It does not install Piggery or
modify the user's ordinary Codex/Claude/Pi configuration.

## Installation

Run `./install.sh --codex-auth-from "$HOME/.codex"` from the checkout, or use the GitHub release
bootstrap shown in the [README](../README.md#install). Release downloads use the current `gh`
account, so private repository access is retained without embedding a GitHub token in scripts.

The bootstrap verifies `checksums.txt`, installs `package-lock.json` dependencies and checks the
candidate before activation. Native Codex and Claude must be on PATH. Pi is installed with the
release. Harness versions affect configuration/discovery; run `npm run test:native` after upgrading one.

This release pins the Paseo `0.12.0` SDK/CLI and validates running daemons `0.11.2` and `0.12.0`; activation does not upgrade or restart
the daemon. Other version mismatches remain blocked. To exercise a different installed
daemon binary in a disposable test instance, set `ALLIANCE_TEST_DAEMON_CLI` to its absolute
`bin/paseo` path when running `npm run test:maintenance`.

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

Every Alliance role uses a 300,000-token auto-compaction ceiling. Codex counts the full
active context; Claude uses a 300k auto-compact window; Pi caps the selected model's
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

## Pi runtime and provider packages

Alliance installs its own Pi **1.0.0** and these explicitly approved npm packages under the
installation's `node_modules`, using `package-lock.json`:

| Package | Version |
| --- | --- |
| `@iznogoudd/pi-devin` | `0.5.1` |
| `pi-antigravity` | `0.9.0` |
| `@iznogoudd/pi-cursor` | `1.4.39` |

Each Pi role loads only these explicit extension entry points and native `mcp`, `codemode` and
`tool-search`. Automatic package/extension, prompt-template and skill discovery stays disabled.
The daily Pi package tree, settings and credentials are never linked or copied. Native Paseo
supplies MCP, so `pi-mcp-adapter` is not installed. The approved packages add provider commands;
`ANTIGRAVITY_NO_EXTRA_TOOLS=1` keeps its optional image/search tools out of the agent tool catalog.

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
| `rollback` | Activate the previous installation root, preserving current rooms and credentials |

Updates do not rewrite the development checkout. Release code lives under
`~/.alliance-work/releases/`; the CLI launcher and native provider commands switch to the
activated root. No release in the private repository means no downloadable update; there is
no fallback to another repository or an unpinned branch.

A maintenance lock prevents competing installer/updater processes. Before mutation and again
before hot reload, native readback must show no running/starting agents and no active workspace
scripts. Unknown status is refused. Finish current work and rerun; updates do not kill agents.
Native sessions reported as `closed` after a daemon restart are inactive and permit maintenance.
Do not start assignments while maintenance is running.

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

Backups/releases are retained until you remove them deliberately. Keep the current and previous
installation roots. For a stale `.maintenance-lock`, read its `owner.json`, verify that process
has exited, then remove that lock directory and rerun the command.

Native diagnostics remain available:

```sh
node node_modules/@getpaseo/cli/bin/paseo plugin logs alliance-work --home "$HOME/.paseo-alliance-work"
node node_modules/@getpaseo/cli/bin/paseo daemon status --home "$HOME/.paseo-alliance-work" --json
```

Run these from the active installation root, shown in `~/.alliance-work/installation.json`.
Source edits need `setup --refresh` after checks; editing files alone does not activate the plugin.

## Releasing

Keep the repository private while vendored skill redistribution rights remain unspecified.
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
runs the portable suite and publishes those assets to this private repository. Native harness, disposable Paseo maintenance
and real model acceptance checks remain local; CI does not claim to have run them.
CI also runs the shipped feature map and retains the per-scenario coverage artifacts. For an
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
as `0.1.4-ryzen.1`. Older launchers cannot parse that suffix. Bootstrap once with the release
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

The key is global to the installation. PID identity includes Linux boot ID and process start time
(or macOS process start time). Reused/exited PIDs cannot appear running. Only registered processes
are observed; this is not discovery of every background task. A controller exit means result
unverified, not successful completion; detached descendants require their own tracking. Archived,
closed or unknown owners are highlighted for reassignment. Ownership writes use the displayed
revision and require an available recipient; recording ownership does not notify or acknowledge
that recipient. Keep the handoff and output paths in the durable assignment.

## Non-interrupting coordination policy

Ordinary progress goes into the assignment/result artifact. Avoid progress pings and duplicate
handbacks. Set native `notifyOnFinish=false` when the owner will continue independent work, then
reconcile at its next task boundary. Use finish notification when the owner is waiting. Urgent
corrections can still intentionally interrupt. This release does not add a mailbox or claim a
native queued-send guarantee: Paseo 0.11.2 exposes interrupt/steer, not atomic idle-only delivery.
The Alliance resume RPC refuses closed, archived, unknown and non-idle agents, but a concurrent
native send can still race its readback. Existing sessions keep already-loaded instructions until
fresh context is created; never restart active work just to replace its instructions.

## Candidate identity

Activation checks required context, coverage, failure-learning and operations files and records a
SHA-256 of shipped runtime source. `doctor` checks those capabilities and compares current bytes
with that installation pin. This is source drift detection, not a proof of model effectiveness or
a replacement for tests. Older records without a pin report `pinned: false`.

Stage and test candidates separately. Activation still requires all native agents and workspace
scripts to be idle, uses the owned installer and preserves daemon/process history. External jobs
must also be observed before/after; if any impact is uncertain, leave the candidate staged.


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
alliance-work wakeups cancel --key KEY --owner OWNER --revision N
alliance-work wakeups owner --key KEY --owner OLD --next-owner NEW --revision N
```

Use `status` to read member `lastTurnId`. Turn triggers bind that exact generation and cancel
when superseded or accepted; job triggers bind boot/process identity and the recorded job owner
revision. Transfer the job first, then its wakeup. A process exit only asks for inspection.
Owner changes are metadata, not acknowledgement by the new owner. CLI owner defaults to
`PASEO_AGENT_ID`; local operators can supply it explicitly, as with existing Alliance CLI actions.

The default `pull` delivery never sends a native prompt. `take` returns at most eight pending
or delivered items; repeated reads keep them available until `ack`. Check durable artifacts and
reconcile side effects before acknowledging. This does not accept any candidate.
For optional automatic delivery, add `--delivery idle` when creating the obligation. Native
readback must be idle, unarchived and free of permissions; missing/busy owners keep pending work.
At most eight items are sent in a batch, with a one-minute cooldown per owner. This mode is best
effort: Paseo 0.11.2 has no atomic idle-only send and its steer fallback can replace a concurrent
turn. Use pull for jobs requiring zero interruption. No closed session is auto-resurrected.

Repeats are time-only: `--every-ms 60000 --max-runs 3` (minimum one minute, maximum 100 runs).
They rearm only after acknowledgement, from the acknowledgement time; missed intervals never
produce a catch-up storm. Default expiry is 30 days, overridable with `--expires ISO_TIME`.
Keys are installation-wide and idempotent for identical input; different input under the same
key is rejected. There is a hard limit of 1000 retained reminders; creation fails explicitly
rather than losing pending work. Terminal records remain as audit history.

States distinguish scheduled, pending, dispatching, delivered, acknowledged, canceled, expired
and uncertain. Dispatch claims are transactional. A crash or failed acknowledgement during
native send leaves `uncertain`; it is never automatically resent, even after restart. Inspect
native history, then acknowledge or cancel explicitly. Native delivery is not exactly-once
execution or proof that the owner read the evidence. The CLI/UI exposes revisions for stale-write
protection. The plugin releases its timer and waits for in-flight observation on unload.

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

Test/analysis reports cannot accept a product journey. Runtime PASS is necessary, not sufficient:
the reviewer must inspect the actual journey and state its limits. The command records this
attestation; it cannot determine whether an invented journey is true. A new turn still reopens
current acceptance; historical product acceptance remains labeled historical. Review depth follows
risk and new evidence, not a fixed number of peers or rounds.


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
Existing sessions are not retroactively enabled. Root chats enable themselves once for a
substantive task, following the room contract; operators can enable an existing assignment:

```sh
alliance-work autonomy start --agent AGENT_ID --max-continuations 20 --max-retries 2
alliance-work autonomy list
alliance-work autonomy checkpoint --agent AGENT_ID --phase paused --reason 'Operator pause'
```

`--agent` defaults to `PASEO_AGENT_ID`. Use the exact CLI and `--home` from room instructions.
`status` includes autonomy phase, reason, counters and delivery state. `start` explicitly resets
the finite budget; do not repeat it each turn. `--auto-archive false` keeps accepted work open.
A start on an existing assignment adopts its retained last turn; archived agents require explicit
native reopening first. A native new turn reopens a prior review, never a deliberate pause.

Before ending a managed turn, agents checkpoint `active` with the next concrete step, `waiting`
for a dependency, `review` with checked results, `blocked` for a decision, or `paused` to stop.
An optional `--turn TURN_ID` rejects stale checkpoints. Waiting work uses child handbacks or an
explicit time/job wakeup. Completion of a model turn alone never means task acceptance.

Every 15 seconds, eligible active work receives a native SDK continuation after at least 15
seconds of idle time following its recorded outcome. Failed turns retry after 30 then 60 seconds,
with a default two retries across the assignment. Limits are 0–5 retries and 1–100 continuations
(default 20). Exhaustion becomes blocked and requests owner review. Cancellation pauses the
assignment; permissions, busy/unknown agents and archived agents are never bypassed. A known
failed turn may resume an error/closed session using the native SDK. Shared-auth renewal still
requires its original auth owner as described above; retries do not renew credentials.

Review/blocked handbacks create one durable idle-delivery wakeup for the current owner and turn.
They reuse the existing wakeup queue and acknowledgement protocol. Disable native finish pings
for managed handbacks to avoid duplicate notifications. The owner must inspect and explicitly
accept candidate-bound evidence. Only then may the plugin archive an idle agent, with no pending
permissions, live native children, unfinished responsibilities, tracked jobs or unresolved owner
wakeups. Native children are archived separately before their parent so native cascade cannot
silently archive unreviewed or unmanaged children. Paused assignments stay open.

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


## Combined lifecycle and obligations (0.1.12)

Version 0.1.12 unifies the two local 0.1.11 candidates. It pins Paseo CLI/client/plugin 0.12.0
and retains tested compatibility with existing 0.11.2 daemons. Installing the Alliance plugin
never restarts a running daemon; a host Paseo upgrade is separate, explicit maintenance.

Bind dependent continuation with `autonomy start --agent ID --obligation KEY`. The obligation
must be open and owned by that agent. Both ordinary continuation and failed-turn retry wait for
all unexpired prerequisite observations; waiting does not consume budget. `waiting` with a bound
condition resumes when it becomes ready. Independent unbound assignments may keep working.
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

New launches use Peer for substantive implementation by instruction; extra coordination roles
are justified by integration, multiple workstreams or cross-project decisions. This is a
responsibility default, not a role quota or capability ban. HQ/Supervisor/Lead omitted models
select Sol/Sonnet; premium models require explicit selection. Omitted worker model/difficulty
uses the standard band and cannot fall through to a frontier route because a cheaper model is
unavailable. Explicit saved room policies remain authoritative. Existing native sessions retain
their model and prompt; use policy read at their next work boundary, with no broadcast or restart.

## AGY role profiles

When `agy` is on the installation PATH, preparation adds `agy-hq`, `agy-supervisor`,
`agy-lead`, `agy-peer` and `agy-lens`. Each has its own `~/.agy-alliance-work/<role>`
home and private HOME/XDG directories. Existing installations retain their other
role homes and saved room policies. A refresh refuses to remove an existing AGY
role set if its executable becomes unavailable.

Sign in through `alliance-work login agy peer` using a dedicated Alliance account.
To share that login across this installation's five roles, run:

```sh
alliance-work auth agy --from ~/.agy-alliance-work/peer/os-home/.gemini/antigravity-cli/antigravity-oauth-token
```

Only the native credential file is linked. Native AGY manages refresh; HOME,
configuration, skills and history remain separate. Existing different role credentials
are never overwritten. No daily configuration, plugins, instructions or skills are imported.
Repeat login independently on each host. To keep accounts separate per role instead,
omit the shared-source command and log in to each role.

The Alliance provider reuses the Antigravity driver from the exact pinned Paseo
0.12.0 dependency, registers each role directly, and creates a private native
agent definition for every session. The definition selects only the role and
explicit project skills. The generated MCP configuration contains the native
Paseo endpoint bound to that agent, and is removed when the session closes.
This is a provider adapter, not another coordination server.

AGY's live model IDs encode effort (for example `claude-sonnet-5-5-medium`). The
catalog exposes only that matching effort; it never translates an unsupported
selection. New rooms include AGY Sonnet medium/high and Opus high routes.
Existing saved policies remain unchanged: add the desired AGY routes in the
room's Model settings before launching a Peer or Lens there.

Before activation, qualify authenticated MCP calls, two simultaneous native agents,
and a real owner → peer → owner handback on each target host with
`scripts/acceptance-agy.mjs NEW_OUTPUT ALLIANCE_TOKEN_PATH`. Steering and exact MCP preapproval are unsupported; explicit
preapproval requests fail rather than being silently ignored. Native AGY owns
compaction; the 300k policy verified for the other harnesses is not claimed for
AGY. Only Full access is exposed, matching the pinned native provider.

The 0.1.14 qualification on macOS and Linux (Ryzen) passed native agent discovery,
concurrent Lead/Peer sessions and a model-driven owner → peer → owner handback on
Paseo 0.11.2. The peer wrote its proof file, notified its owner through native Paseo
MCP, and the owner read the file before writing the reviewed result. The Mac also
passed this flow on 0.12.0. Disposable daemons were stopped after qualification.

## User MCP: Mobbin

The user-level `~/.alliance-work/user-mcp.json` enables the official remote Mobbin
server (`https://api.mobbin.com/mcp`) for all five Claude and Codex roles, across
all projects. Nothing is written to a project. AGY and Pi are unchanged.

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
User configuration and OAuth state survive setup, updates and profile regeneration.
For SSH login, forward loopback port 43159 from your browser machine to the remote
host, then run the login command there; open its authorization URL locally.

Newly opened native sessions pick up the setting. Existing sessions keep their
current MCP inventory until reopened; do not interrupt running assignments just
to refresh tools. To disable, set `mobbin.enabled` to `false` in the user file.

Qualification: `node scripts/acceptance-mobbin.mjs ALLIANCE_HOME NEW_OUTPUT`
checks native Claude/Codex discovery in two unrelated projects and makes one
read-only Mobbin search. It requires a completed login and starts no model turn.
