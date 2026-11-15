import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSkills } from "../server/bundled-skills.mjs";
import { selectedClaudeLaunch } from "../server/claude-accounts.mjs";
import { recordClaudeRuntime } from "../server/claude-runtime.mjs";
import { contextSettings } from "../server/context-settings.mjs";
import { profileEnvironment } from "../server/profile-environment.mjs";
import { claudeSkillPlugin } from "../server/project-skills.mjs";
import { scopedMcpServers } from "../server/scoped-mcp.mjs";
import { claudeWindowFor } from "../shared/context-settings.mjs";
import { linkAgyAuth } from "./agy-auth.mjs";
import { authSource, authStatus, bridgeCodexAuth } from "./auth.mjs";
import { discoverCodex } from "./codex-discovery.mjs";
import { contextPolicy } from "./context-policy.mjs";
import { assertNoLinks, codexIsolationFeatures, loadManifest, verifyProfile } from "./profiles.mjs";
import { userMcpServers } from "./user-mcp.mjs";

export { profileEnvironment };

/**
 * Agent turns have no terminal to answer a prompt, so a tool that asks would hang the turn. These
 * make common tools fail or proceed instead. Not CI, which changes how tools behave.
 */
const nonInteractive = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  PIP_NO_INPUT: "1",
  DEBIAN_FRONTEND: "noninteractive",
  npm_config_yes: "true",
};

function replaceFlag(args, flag, value) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++;
      continue;
    }
    if (args[i].startsWith(`${flag}=`)) continue;
    result.push(args[i]);
  }
  return [...result, flag, value];
}

function removeFlag(args, flag) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      i++;
      continue;
    }
    if (!args[i].startsWith(`${flag}=`)) result.push(args[i]);
  }
  return result;
}
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function launchPlan(
  home,
  id,
  args,
  ambient = process.env,
  cwd = ambient.ALLIANCE_WORKSPACE_CWD ?? process.cwd(),
  platform = process.platform,
) {
  cwd = resolve(cwd);
  const manifest = await loadManifest(home);
  const profile = manifest.profiles[id];
  if (!profile) throw new Error(`Unknown Alliance profile: ${id}`);
  await verifyProfile(profile);
  if (ambient.PASEO_AGENT_ID && (!ambient.ALLIANCE_BOUND_ROOM || !ambient.ALLIANCE_WORKSPACE_CWD))
    throw new Error(
      "Alliance plugin did not bind this session to a room and workspace. Enable the plugin before launching.",
    );
  const roomId = ambient.PASEO_AGENT_ID
    ? (ambient.ALLIANCE_CLAUDE_ROOM ?? ambient.ALLIANCE_BOUND_ROOM)
    : undefined;
  const claudeLaunch =
    profile.harness === "claude" ? await selectedClaudeLaunch(home, profile.role, undefined, roomId) : null;
  const selected = claudeLaunch?.credentials;
  const credentialPath = join(profile.home, "credentials.env.json");
  await assertNoLinks(credentialPath);
  const info = selected
    ? null
    : await lstat(credentialPath).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
  if (info && (!info.isFile() || info.mode & 0o077))
    throw new Error("Role credentials must be a regular owner-only file (chmod 600).");
  let credentials = selected ?? {};
  if (info) {
    try {
      credentials = JSON.parse(await readFile(credentialPath, "utf8"));
    } catch {
      throw new Error("Role credential JSON is invalid. Its content was not logged.");
    }
  }
  const env = profileEnvironment(profile, home, ambient, credentials);
  const interactiveAgy = args.length === 0 && !ambient.PASEO_AGENT_ID;
  const agyFileAuth =
    profile.harness === "agy" && (await linkAgyAuth(home, profile, { allowSourceLogin: interactiveAgy }));
  // AGY can migrate the selected file into the macOS user's shared Keychain on refresh.
  const isolateAgyKeychain = platform === "darwin" && agyFileAuth;
  const executable = isolateAgyKeychain ? "/usr/bin/sandbox-exec" : profile.executable;
  const nativeArgs = () =>
    isolateAgyKeychain
      ? [
          "-p",
          '(version 1) (allow default) (deny process-exec (literal "/usr/bin/security"))',
          profile.executable,
          ...args,
        ]
      : args;
  if (isolateAgyKeychain && interactiveAgy) {
    for (const key of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) if (ambient[key]) env[key] = ambient[key];
  }
  const source = profile.harness === "codex" ? await authSource(home) : undefined;
  // Account/setup/help commands still use the isolated home, but need no session flags.
  const metadataCommand = args.some((arg) => ["--version", "--help", "-h"].includes(arg));
  const accountCommand = ["login", "logout", "auth", "setup-token"].includes(args[0]);
  if ((metadataCommand && profile.harness !== "pi") || accountCommand)
    return { executable, args: nativeArgs(), env, cwd, authSource: source };
  // Only agent sessions (Paseo sets PASEO_AGENT_ID); the Human's own launches keep their prompts.
  if (ambient.PASEO_AGENT_ID) for (const [key, value] of Object.entries(nonInteractive)) env[key] ??= value;
  const bundle = await effectiveSkills(cwd, profile);
  const userServers = await userMcpServers(home, profile.harness, undefined, cwd);
  if (profile.harness === "claude") {
    // Resume paths can omit --model. Use the native session's selected model, never a
    // role-wide default; an explicit native argument (including a later change) wins.
    if (
      ambient.PASEO_AGENT_ID &&
      ambient.ALLIANCE_SESSION_MODEL &&
      !args.some((arg) => arg === "--model" || arg.startsWith("--model="))
    )
      args = [...args, "--model", ambient.ALLIANCE_SESSION_MODEL];
    // Disable implicit user/project skill discovery; explicitly load only this selection.
    // Keep the original role HOME/config dir for credentials and native session history.
    args = replaceFlag(removeFlag(args, "--plugin-dir"), "--setting-sources", "");
    args = replaceFlag(args, "--settings", join(profile.home, "settings.json"));
    if (!args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
    const plugin = await claudeSkillPlugin(home, bundle);
    if (plugin) args.push("--plugin-dir", plugin);
    // Merge the user-approved tools with the caller-bound native endpoint. Project
    // and saved session MCP definitions cannot replace either source.
    const servers = { ...userServers };
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--mcp-config" || args[i].startsWith("--mcp-config=")) {
        const raw = args[i] === "--mcp-config" ? args[++i] : args[i].slice(13);
        const config = JSON.parse(raw.startsWith("{") ? raw : await readFile(raw, "utf8"));
        if (config.mcpServers?.paseo) servers.paseo = config.mcpServers.paseo;
      } else filtered.push(args[i]);
    }
    args = [...filtered, "--mcp-config", JSON.stringify({ mcpServers: servers })];
  } else if (profile.harness === "pi") {
    args = removeFlag(args, "--skill");
    args = [
      ...args,
      "--no-approve",
      "--no-context-files",
      "--no-skills",
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "-e",
      "builtin:mcp",
      "-e",
      "builtin:codemode",
      "-e",
      "builtin:tool-search",
    ];
    if (
      Object.keys(await scopedMcpServers(home, "pi", fileURLToPath(new URL("../", import.meta.url)), cwd))
        .length
    )
      args.push("-e", fileURLToPath(new URL("./scoped-mcp-pi.mjs", import.meta.url)));
    for (const extension of profile.extensionPaths ?? []) args.push("-e", extension);
    for (const skill of bundle.skills) {
      const index = profile.skillEntries.find((entry) => basename(dirname(entry)) === skill.name);
      args.push("--skill", index ?? join(skill.directory, "SKILL.md"));
    }
    args = replaceFlag(args, "--session-dir", join(profile.home, "sessions"));
  } else if (profile.harness === "agy") {
    if (["models", "agent", "agents"].includes(args[0]) || args.length === 0)
      return { executable, args: nativeArgs(), env, cwd };
    const sessionDir = ambient.ALLIANCE_AGY_SESSION_DIR;
    if (!sessionDir) throw new Error("AGY requires its Alliance provider session configuration");
    await assertNoLinks(sessionDir);
    if (!resolve(sessionDir).startsWith(`${resolve(profile.home)}/sessions/`))
      throw new Error("AGY session directory is outside the role home");
    args.push("--add-dir", sessionDir, "--agent", `alliance-${basename(sessionDir)}`);
  } else {
    const configArgs = [];
    if (source) configArgs.push("-c", 'cli_auth_credentials_store="ephemeral"');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c" || args[i] === "--config") configArgs.push("-c", args[++i]);
      else if (args[i].startsWith("--config=")) configArgs.push("-c", args[i].slice(9));
    }
    const isolationArgs = Object.entries(codexIsolationFeatures).flatMap(([name, value]) => [
      "-c",
      `features.${name}=${value}`,
    ]);
    // Alliance delegates through Paseo; Codex's separate subagent pool must not govern room peers.
    isolationArgs.push("-c", "agents.enabled=false");
    configArgs.push(...isolationArgs);
    // Skip project-native config, preserving repository task instructions and native capabilities.
    const trust = `projects=${toml({ [resolve(cwd)]: { trust_level: "untrusted" } })}`;
    configArgs.push("-c", trust);
    const discovered = await discoverCodex(profile.executable, env, cwd, configArgs);
    const selected = new Set(bundle.skills.map((skill) => skill.directory).map((path) => resolve(path)));
    const skillConfig = discovered.skills
      .filter((skill) => !selected.has(resolve(dirname(skill.path))))
      .map((skill) => ({ path: skill.path, enabled: false }));
    args = [
      "--no-daemon",
      ...args,
      ...isolationArgs,
      "-c",
      trust,
      "-c",
      `skills.config=${toml(skillConfig)}`,
    ];
    if (source) args.push("-c", 'cli_auth_credentials_store="ephemeral"');
    const servers = Object.fromEntries(
      Object.entries(discovered.config.mcp_servers ?? {}).map(([name, configuration]) => [
        name,
        name === "paseo" ? configuration : { ...configuration, enabled: false },
      ]),
    );
    for (const [name, server] of Object.entries(userServers))
      servers[name] = { ...server, enabled: true, startup_timeout_sec: 60 };
    // Override complete TOML tables: Codex CLI dotted keys do not unquote path/server names.
    args.push("-c", `mcp_servers=${toml(servers)}`);
  }
  const context =
    profile.harness === "claude" && ambient.PASEO_AGENT_ID
      ? {
          claudeWindow: claudeWindowFor(
            (await contextSettings(home, ambient.ALLIANCE_BOUND_ROOM)).policy,
            profile.role,
          ),
        }
      : {};
  return {
    executable,
    claudeAccount: claudeLaunch?.account,
    ...contextPolicy(profile.harness, nativeArgs(), env, context),
    cwd,
    authSource: source,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [home, id, ...args] = process.argv.slice(2);
    if (!home || !id) throw new Error("Usage: launch.mjs ALLIANCE_HOME HARNESS-ROLE [native arguments]");
    const plan = await launchPlan(home, id, args);
    if (plan.authSource && ["login", "logout"].includes(args[0])) {
      if (args[0] === "login" && args[1] === "status") {
        const status = await authStatus(home);
        console.log(JSON.stringify(status, null, 2));
        process.exit(status.ready ? 0 : 1);
      }
      throw new Error(
        "Shared Codex auth is enabled. Manage login in the original profile; alliance-work auth codex --separate restores role logins.",
      );
    }
    const shared =
      plan.authSource &&
      args.includes("app-server") &&
      !args.some((arg) => ["--version", "--help", "-h"].includes(arg));
    if (plan.authSource && !shared && !args.some((arg) => ["--version", "--help", "-h"].includes(arg)))
      throw new Error(
        "Shared Codex auth supports native Paseo app-server sessions. Use a separate role login for standalone interactive Codex.",
      );
    const child = spawn(plan.executable, plan.args, {
      env: plan.env,
      cwd: plan.cwd,
      stdio: shared ? ["pipe", "pipe", "inherit"] : "inherit",
    });
    if (plan.claudeAccount && plan.env.PASEO_AGENT_ID)
      child.once("spawn", () => {
        void recordClaudeRuntime(home, plan.env.PASEO_AGENT_ID, plan.claudeAccount, child.pid).catch(() => {
          console.error("Claude account observation unavailable; account will be shown as unknown");
        });
      });
    if (shared) bridgeCodexAuth({ child, source: plan.authSource });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    child.on("error", (error) => {
      console.error(`Alliance launch failed: ${error.message}`);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  } catch (error) {
    console.error(`Alliance launch refused: ${error.message}`);
    process.exitCode = 1;
  }
}
