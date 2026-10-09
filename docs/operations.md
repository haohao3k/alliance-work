# Installation and operation

The `alliance-work` command manages one dedicated Paseo instance and its isolated role homes.
It uses the pinned local Paseo CLI and native plugin lifecycle. It does not install Piggery or
modify the user's ordinary Codex/Claude/Pi configuration.

## Installation

Run `./install.sh --codex-auth-from "$HOME/.codex"` from the checkout, or use the GitHub release
bootstrap shown in the [README](../README.md#install). Release downloads use the current `gh`
account, so private repository access is retained without embedding a GitHub token in scripts.

The bootstrap verifies `checksums.txt`, installs `package-lock.json` dependencies and checks the
candidate before activation. All three native harness binaries must be on PATH. Their versions
are sensitive to configuration/discovery changes; run `npm run test:native` after upgrading one.

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
Claude and Pi currently use separate role credentials. Optional owner-only
`credentials.env.json` in a role home accepts explicit provider API-key variables; ambient
provider secrets are not inherited. Never commit or record credential files.

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
npm run release:pack
```

Packaging uses `git archive HEAD` and refuses a dirty checkout. It creates the versioned archive,
`checksums.txt` and `install.sh` in ignored `dist/`. The tag workflow checks package/tag agreement,
runs the portable suite and publishes those assets to this private repository. Native harness
and real model acceptance checks remain local; CI does not claim to have run them.

Push a matching `vMAJOR.MINOR.PATCH` tag when the release is ready. Existing tags are immutable.
The release archive contains no home directories, runtime credentials or generated room state.
