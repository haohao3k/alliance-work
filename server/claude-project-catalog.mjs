import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { projectClaudeAccountState, selectedClaudeLaunch } from "./claude-accounts.mjs";
import { profileEnvironment } from "./profile-environment.mjs";

const execute = promisify(execFile);
const catalogTtlMs = 60_000;

/** @returns {Promise<import('@getpaseo/protocol/agent-types').AgentModelDefinition[]>} */
async function readNativeModels(sourceRoot, home, profile, credentials) {
  // Paseo 0.15.4 ships this native discovery and manifest through its pinned server package.
  // Its public provider catalog is host-scoped, so bind the selected account only for this probe.
  const nativeRequire = createRequire(join(sourceRoot, "package.json"));
  const native = dirname(nativeRequire.resolve("@getpaseo/server"));
  const load = (file) => import(pathToFileURL(join(native, "agent/providers/claude", file)).href);
  const [{ discoverClaudeModels }, { normalizeClaudeRuntimeModelId, parseClaudeCodeVersion }, models] =
    await Promise.all([load("model-discovery.js"), load("model-manifest.js"), load("models.js")]);

  const env = profileEnvironment(profile, home);
  const [version, advertised] = await Promise.all([
    execute(profile.executable, ["--version"], { env, timeout: 5000, killSignal: "SIGKILL" }).then(
      ({ stdout, stderr }) => {
        const output = `${stdout}\n${stderr}`;
        return /\d+\.\d+\.\d+\s+\(Claude Code\)/i.test(output)
          ? parseClaudeCodeVersion(output)?.join(".")
          : undefined;
      },
      () => undefined,
    ),
    // Bypass the Alliance launch wrapper, which adds room skills/MCP to normal sessions.
    // The native probe uses no prompt, no persistence, no hooks and an empty MCP configuration.
    discoverClaudeModels({
      resolveBinary: async () => profile.executable,
      env: { ...env, ...credentials },
    }).catch(() => null),
  ]);
  const ids = new Set(
    (advertised ?? [])
      .map((model) => normalizeClaudeRuntimeModelId(model.resolvedModel ?? model.value))
      .filter((id) => id !== null),
  );
  const definitions = await models.getClaudeModelsWithSettings({ debug() {} }, profile.home, version, ids);
  return definitions
    .filter((model) => model.isSelectable !== false)
    .map((model) => ({ ...model, provider: `alliance-claude-${profile.role}` }));
}

export class ClaudeProjectCatalog {
  #byProfile = new WeakMap();

  constructor(selectLaunch = selectedClaudeLaunch) {
    this.selectLaunch = selectLaunch;
  }

  /** @returns {Promise<import('@getpaseo/protocol/agent-types').AgentModelDefinition[] | null>} */
  async list(sourceRoot, home, roomId, role, loadProfile) {
    const { account } = await projectClaudeAccountState(home, roomId);
    if (account === "inherit") return null;

    // Recheck credentials even for a warm catalog. An unavailable explicit alias must fail closed.
    const launch = await this.selectLaunch(home, role, undefined, roomId);
    if (launch.account !== account || !launch.credentials?.CLAUDE_CODE_OAUTH_TOKEN)
      throw new Error("Project Claude account changed or is unavailable. Reload project settings and retry.");
    const profile = await loadProfile();
    const fingerprint = createHash("sha256").update(launch.credentials.CLAUDE_CODE_OAUTH_TOKEN).digest("hex");
    let entries = this.#byProfile.get(profile);
    if (!entries) {
      entries = new Map();
      this.#byProfile.set(profile, entries);
    }
    const current = entries.get(account);
    if (current?.fingerprint === fingerprint && current.expiresAt > Date.now()) return current.models;

    // Cache only the account-scoped definitions and share the in-flight probe for the same credential.
    const entry = {
      fingerprint,
      expiresAt: Date.now() + catalogTtlMs,
      models: readNativeModels(sourceRoot, home, profile, launch.credentials).catch(() => {
        if (entries.get(account) === entry) entries.delete(account);
        throw new Error("Project Claude model catalog is unavailable.");
      }),
    };
    entries.set(account, entry);
    return entry.models;
  }
}
