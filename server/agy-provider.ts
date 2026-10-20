import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type {
  ProviderEvent,
  ProviderModel,
  ProviderRegistration,
  ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
// Keep the pinned Paseo wire protocol, process supervision and transcript implementation.
import { createAntigravityProvider } from "./agy-native/provider";
import { assertNoLinks, verifyProfile } from "./profile-integrity.mjs";
import { projectSkills } from "./project-skills.mjs";
import { userMcpServers } from "./user-mcp.mjs";

export function agyEffort(model: string) {
  return /-(low|medium|high|xhigh|max)$/.exec(model)?.[1];
}

export async function prepareAgySession(config: ProviderSessionConfig) {
  const home = config.env.ALLIANCE_WORK_HOME;
  const role = config.env.ALLIANCE_ROLE;
  if (!home || !role) throw new Error("AGY requires an Alliance role binding");
  await assertNoLinks(home);
  const manifest = JSON.parse(await readFile(join(home, "profiles.json"), "utf8"));
  const profile = manifest.profiles[`agy-${role}`];
  if (!profile || config.env.HOME !== profile.osHome)
    throw new Error("AGY role HOME does not match its managed profile");
  await verifyProfile(profile);
  if (config.toolPolicy?.preapproved.length)
    throw new Error("AGY exact MCP preapproval is not yet qualified; no policy was silently discarded");
  const servers = Object.entries(config.mcpServers);
  if (servers.length !== 1) throw new Error("AGY requires one native Paseo MCP endpoint");
  for (const [name, server] of servers) {
    if (name !== "paseo" || server.type !== "http")
      throw new Error("Alliance AGY only accepts the native Paseo MCP endpoint");
    const url = new URL(server.url);
    if (
      url.pathname !== "/mcp/agents" ||
      !config.env.PASEO_AGENT_ID ||
      url.searchParams.get("callerAgentId") !== config.env.PASEO_AGENT_ID
    )
      throw new Error("AGY MCP endpoint is not bound to this native agent");
  }
  const parent = join(profile.home, "sessions");
  await assertNoLinks(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(parent, "native-"));
  const name = `alliance-${basename(path)}`;
  const agentDirectory = join(profile.osHome, ".gemini/config/agents", name);
  try {
    await assertNoLinks(agentDirectory);
    const selected = await projectSkills(config.cwd);
    const skills = [...profile.skillDirectories, ...selected.skills.map((skill) => skill.directory)];
    const instructions =
      config.systemPrompt ?? (await readFile(join(profile.home, "root-instructions.md"), "utf8"));
    const agent = join(agentDirectory, "agent.md");
    await mkdir(dirname(agent), { recursive: true, mode: 0o700 });
    // JSON is a YAML subset; paths and instruction text cannot alter frontmatter.
    const frontmatter = {
      name,
      description: "Isolated Alliance role with native Paseo coordination",
      inheritCustomizations: false,
      commandExecutionPolicy: "eager",
      tools: ["run_command", "view_file", "replace_file_content", "grep_search"],
      skills,
    };
    await writeFile(agent, `---\n${JSON.stringify(frontmatter, null, 2)}\n---\n\n${instructions}\n`, {
      mode: 0o600,
    });
    await mkdir(join(path, ".agents"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(path, ".agents/mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          ...(await userMcpServers(home, "agy", manifest.root)),
          ...Object.fromEntries(
            servers.map(([name, server]) => {
              if (server.type !== "http") throw new Error("Expected HTTP MCP");
              return [
                name,
                { serverUrl: server.url, ...(server.headers ? { headers: server.headers } : {}) },
              ];
            }),
          ),
        },
      }),
      { mode: 0o600 },
    );
    return {
      path,
      name,
      agentDirectory,
      dispose: async () => {
        await rm(path, { recursive: true, force: true });
        await rm(agentDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    await rm(agentDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function createAllianceAgyProvider(
  role: string,
  base = createAntigravityProvider(),
): ProviderRegistration {
  return {
    ...base,
    id: `alliance-agy-${role}`,
    requiresConfiguration: true,
    label: `Alliance · agy · ${role}`,
    icon: undefined,
    async connect(request) {
      const inner = await base.connect(request);
      const sessions = new Map<string, Awaited<ReturnType<typeof prepareAgySession>>>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      const unsubscribe = inner.onEvent((event) => {
        if (event.type === "catalog")
          event = {
            ...event,
            catalog: {
              ...event.catalog,
              models: event.catalog.models.map((model): ProviderModel => {
                const effort = agyEffort(model.id);
                return effort
                  ? {
                      ...model,
                      thinkingOptions: [{ id: effort, label: effort }],
                      defaultThinkingOptionId: effort,
                    }
                  : model;
              }),
            },
          };
        if (event.type === "session.config") {
          const effort = agyEffort(event.config.model ?? "");
          if (effort)
            event = {
              ...event,
              config: {
                ...event.config,
                thinkingOption: effort,
                thinkingOptions: [{ id: effort, label: effort }],
              },
            };
        }
        for (const listener of listeners) listener(event);
      });
      return {
        version: inner.version,
        capabilities: inner.capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async send(input) {
          if (input.type === "session.open") {
            if (sessions.has(input.sessionId)) throw new Error("Duplicate AGY session");
            if (
              input.config.thinkingOption &&
              input.config.thinkingOption !== agyEffort(input.config.model ?? "")
            )
              throw new Error("AGY effort must match the selected live model ID");
            const session = await prepareAgySession(input.config);
            sessions.set(input.sessionId, session);
            input = {
              ...input,
              config: {
                ...input.config,
                thinkingOption: undefined,
                env: { ...input.config.env, ALLIANCE_AGY_SESSION_DIR: session.path },
              },
            };
          } else if (input.type === "session.configure" && input.changes.thinkingOption) {
            throw new Error("Select the desired AGY model ID to change effort");
          }
          await inner.send(input);
          if (input.type === "session.close") {
            await sessions.get(input.sessionId)?.dispose();
            sessions.delete(input.sessionId);
          }
        },
        async close() {
          try {
            await inner.close();
          } finally {
            unsubscribe();
            await Promise.all([...sessions.values()].map((session) => session.dispose()));
            sessions.clear();
          }
        },
      };
    },
  };
}
