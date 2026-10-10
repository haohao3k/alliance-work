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
activation fails. These releases do not migrate the room database schema. `rollback` is a code
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
npm run release:pack
```

Packaging uses `git archive HEAD` and refuses a dirty checkout. It creates the versioned archive,
`checksums.txt` and `install.sh` in ignored `dist/`. The tag workflow checks package/tag agreement,
runs the portable suite and publishes those assets to this private repository. Native harness, disposable Paseo maintenance
and real model acceptance checks remain local; CI does not claim to have run them.

Push a matching `vMAJOR.MINOR.PATCH` tag when the release is ready. Existing tags are immutable.
If the tag event did not start a run, dispatch the same tagged source explicitly:

```sh
gh workflow run release.yml --repo haohao3k/alliance-work --ref codex/bootstrap -f tag=v0.1.1
```

The manual workflow also checks out and validates the requested tag before packaging.
The release archive contains no home directories, runtime credentials or generated room state.
