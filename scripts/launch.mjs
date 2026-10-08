import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { discoverCodex } from "./codex-discovery.mjs";
import { loadManifest, verifyProfile } from "./profiles.mjs";

export function profileEnvironment(profile, home, ambient = process.env, credentials = {}) {
  /** @type {Record<string,string>} */
  const env = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined &&
      /^(PATH|LANG|LC_.*|TZ|TERM|COLORTERM|TMPDIR|TMP|TEMP|USER|LOGNAME|PASEO_.*|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY)$/i.test(
        key,
      )
    )
      env[key] = value;
  }
  for (const [key, value] of Object.entries(credentials)) {
    if (
      typeof value !== "string" ||
      !/^(ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|OPENAI_API_KEY|OPENAI_BASE_URL|GEMINI_API_KEY|GOOGLE_API_KEY)$/.test(
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
      .map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export async function launchPlan(home, id, args, ambient = process.env, cwd = process.cwd()) {
  const manifest = await loadManifest(home);
  const profile = manifest.profiles[id];
  if (!profile) throw new Error(`Unknown Alliance profile: ${id}`);
  await verifyProfile(profile);
  const credentials = await readFile(join(profile.home, "credentials.env.json"), "utf8")
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === "ENOENT") return {};
      throw e;
    });
  const env = profileEnvironment(profile, home, ambient, credentials);
  // Account/setup/help commands still use the isolated home, but need no session flags.
  const metadataCommand = args.some((arg) => ["--version", "--help", "-h"].includes(arg));
  const accountCommand = ["login", "logout", "auth", "setup-token"].includes(args[0]);
  if (ambient.PASEO_AGENT_ID && !ambient.ALLIANCE_BOUND_ROOM)
    throw new Error(
      "Alliance plugin did not bind this session to a room. Enable the plugin before launching.",
    );
  if ((metadataCommand && profile.harness !== "pi") || accountCommand)
    return { executable: profile.executable, args, env };
  if (profile.harness === "claude") {
    args = replaceFlag(args, "--setting-sources", "user");
    args = replaceFlag(args, "--settings", join(profile.home, "settings.json"));
    if (!args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
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
    for (const skill of profile.skillEntries) args.push("--skill", skill);
    args = replaceFlag(args, "--session-dir", join(profile.home, "sessions"));
  } else {
    const configArgs = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-c" || args[i] === "--config") configArgs.push("-c", args[++i]);
      else if (args[i].startsWith("--config=")) configArgs.push("-c", args[i].slice(9));
    }
    // Skip project-native config, preserving repository task instructions and native capabilities.
    const trust = `projects.${JSON.stringify(resolve(cwd))}.trust_level="untrusted"`;
    configArgs.push("-c", trust);
    const discovered = await discoverCodex(profile.executable, env, cwd, configArgs);
    const selected = new Set(profile.skillDirectories.map((path) => resolve(path)));
    const skillConfig = discovered.skills
      .filter((skill) => !selected.has(resolve(dirname(skill.path))))
      .map((skill) => ({ path: skill.path, enabled: false }));
    args = ["--no-daemon", ...args, "-c", trust, "-c", `skills.config=${toml(skillConfig)}`];
    for (const name of Object.keys(discovered.config.mcp_servers ?? {}))
      if (name !== "paseo") args.push("-c", `mcp_servers.${JSON.stringify(name)}.enabled=false`);
  }
  return { executable: profile.executable, args, env };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    const [home, id, ...args] = process.argv.slice(2);
    if (!home || !id) throw new Error("Usage: launch.mjs ALLIANCE_HOME HARNESS-ROLE [native arguments]");
    const plan = await launchPlan(home, id, args);
    const child = spawn(plan.executable, plan.args, { env: plan.env, stdio: "inherit" });
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
