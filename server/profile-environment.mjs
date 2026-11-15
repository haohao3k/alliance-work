import { join } from "node:path";

export function profileEnvironment(profile, home, ambient = process.env, credentials = {}) {
  /** @type {Record<string,string>} */
  const env = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (
      value !== undefined &&
      /^(PATH|LANG|LC_.*|TZ|TERM|COLORTERM|TMPDIR|TMP|TEMP|USER|LOGNAME|PASEO_.*|ALLIANCE_AGY_SESSION_DIR|ALLIANCE_BOUND_ROOM|ALLIANCE_WORKSPACE_CWD|ALLIANCE_ASSIGNMENT|ALLIANCE_ARTIFACTS|ALLIANCE_SCRATCH|ALLIANCE_CONTEXT|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS?_PROXY|NO_PROXY)$/i.test(
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
