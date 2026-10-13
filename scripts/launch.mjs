import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeSkillPlugin, projectSkills } from "../server/project-skills.mjs";
import { authSource, authStatus, bridgeCodexAuth } from "./auth.mjs";
import { discoverCodex } from "./codex-discovery.mjs";
import { contextPolicy } from "./context-policy.mjs";
import { assertNoLinks, codexIsolationFeatures, loadManifest, verifyProfile } from "./profiles.mjs";

export function profileEnvironment(profile, home, ambient = process.env, credentials = {}) {
  /** @type {Record<string,string>} */
  const env = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined &&
      /^(PATH|LANG|LC_.*|TZ|TERM|COLORTERM|TMPDIR|TMP|TEMP|USER|LOGNAME|PASEO_.*|ALLIANCE_BOUND_ROOM|ALLIANCE_ASSIGNMENT|ALLIANCE_ARTIFACTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  for (const [key, value] of Object.entries(credentials)) {
    if (
      typeof value !== "string" ||
      (key === "CLAUDE_CODE_OAUTH_TOKEN" && profile.harness !== "claude") ||
      !/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|GEMINI_API_KEY|GOOGLE_API_KEY)$/.test(
        key,
      )
    )
      throw new Error(`Unsupported Alliance credential variable: ${key}`);
    env[key] = value;
  }
  Object.assign(env, {
    HOME: profile.osHome,
    XDG_CONFIG_HOME: join(profile.osHome, ".config"),
    XDG_DATA_HOME: join(profile.osHome, ".local/share"),
    XDG_CACHE_HOME: join(profile.osHome, ".cache"),
    ALLIANCE_WORK_HOME: home,
    ALLIANCE_ROLE: profile.role,
    CODEX_HOME: profile.harness === "codex" ? profile.home : join(profile.osHome, ".codex"),
    CLAUDE_CONFIG_DIR: profile.harness === "claude" ? profile.home : join(profile.osHome, ".claude"),
    PI_CODING_AGENT_DIR: profile.harness === "pi" ? profile.home : join(profile.osHome, ".pi"),
  });
  if (profile.harness === "pi") {
    env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
    env.ANTIGRAVITY_NO_EXTRA_TOOLS = "1";
  }
  return env;
}

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
) {
  cwd = resolve(cwd);
  const manifest = await loadManifest(home);
  const profile = manifest.profiles[id];
  if (!profile) throw new Error(`Unknown Alliance profile: ${id}`);
  await verifyProfile(profile);
  const credentialPath = join(profile.home, "credentials.env.json");
  await assertNoLinks(credentialPath);
  const info = await lstat(credentialPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && (!info.isFile() || info.mode & 0o077))
    throw new Error("Role credentials must be a regular owner-only file (chmod 600).");
  let credentials = {};
  if (info) {
    try {
      credentials = JSON.parse(await readFile(credentialPath, "utf8"));
    } catch {
      throw new Error("Role credential JSON is invalid. Its content was not logged.");
    }
  }
  const env = profileEnvironment(profile, home, ambient, credentials);
  const source = profile.harness === "codex" ? await authSource(home) : undefined;
  // Account/setup/help commands still use the isolated home, but need no session flags.
  const metadataCommand = args.some((arg) => ["--version", "--help", "-h"].includes(arg));
  const accountCommand = ["login", "logout", "auth", "setup-token"].includes(args[0]);
  if (ambient.PASEO_AGENT_ID && (!ambient.ALLIANCE_BOUND_ROOM || !ambient.ALLIANCE_WORKSPACE_CWD))
    throw new Error(
      "Alliance plugin did not bind this session to a room and workspace. Enable the plugin before launching.",
    );
  if ((metadataCommand && profile.harness !== "pi") || accountCommand)
    return { executable: profile.executable, args, env, cwd, authSource: source };
  const bundle = await projectSkills(cwd);
  if (profile.harness === "claude") {
    args = replaceFlag(args, "--setting-sources", "user");
    args = replaceFlag(args, "--settings", join(profile.home, "settings.json"));
    if (!args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
    const plugin = await claudeSkillPlugin(home, bundle);
    if (plugin) args.push("--plugin-dir", plugin);
    // Only the caller-bound native Paseo endpoint may survive an explicit MCP argument.
    for (let i = 0; i < args.length; i++)
      if (args[i] === "--mcp-config") {
        const raw = args[i + 1];
        const config = JSON.parse(raw.startsWith("{") ? raw : await readFile(raw, "utf8"));
        const paseo = config.mcpServers?.paseo;
        args[i + 1] = JSON.stringify({ mcpServers: paseo ? { paseo } : {} });
      }
  } else if (profile.harness === "pi") {
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
    for (const extension of profile.extensionPaths ?? []) args.push("-e", extension);
    for (const skill of profile.skillEntries) args.push("--skill", skill);
    for (const skill of bundle.skills) args.push("--skill", join(skill.directory, "SKILL.md"));
    args = replaceFlag(args, "--session-dir", join(profile.home, "sessions"));
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
    configArgs.push(...isolationArgs);
    // Skip project-native config, preserving repository task instructions and native capabilities.
    const trust = `projects=${toml({ [resolve(cwd)]: { trust_level: "untrusted" } })}`;
    configArgs.push("-c", trust);
    const discovered = await discoverCodex(profile.executable, env, cwd, configArgs);
    const selected = new Set(
      [...profile.skillDirectories, ...bundle.skills.map((skill) => skill.directory)].map((path) =>
        resolve(path),
      ),
    );
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
    // Override complete TOML tables: Codex CLI dotted keys do not unquote path/server names.
    args.push("-c", `mcp_servers=${toml(servers)}`);
  }
  return {
    executable: profile.executable,
    ...contextPolicy(profile.harness, args, env),
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
