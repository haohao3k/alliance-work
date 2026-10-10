import type { PluginServerContext } from "@getpaseo/plugin/server";
import { composeInstruction } from "./server/instructions";
import { AllianceRuntime, allianceProvider } from "./server/runtime";
import {
  memberDisposition,
  memberLaunch,
  memberResume,
  profileStatus,
  roomCreate,
  roomList,
  settings,
} from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const configuration = server.registerSettings(settings);
  let runtime: Promise<AllianceRuntime> | undefined;
  const get = () =>
    (runtime ??= (async () => {
      const state = await configuration.read();
      if (state.status !== "ready") throw new Error(state.error);
      const instance = new AllianceRuntime(state.values.home);
      try {
        return await instance.ready();
      } catch (error) {
        instance.close();
        runtime = undefined;
        throw error;
      }
    })());
  server.handle(profileStatus, async () => (await get()).profiles());
  server.handle(roomList, async (_input, { paseo }) => (await get()).list(paseo));
  server.handle(roomCreate, async (input, { paseo }) => (await get()).createRoom(input, paseo));
  server.handle(memberLaunch, async (input, { paseo }) => (await get()).launch(input, paseo));
  server.handle(memberResume, async (input, { paseo }) =>
    (await get()).resume(input.agentId, input.prompt, paseo),
  );
  server.handle(memberDisposition, async (input) =>
    (await get()).disposition(input.agentId, input.decision, input.candidate, input.evidence),
  );
  server.before("agent.create", async ({ request }) => {
    if (!allianceProvider(request.config.provider)) return;
    const instance = await get();
    const instruction = await instance.instruction(request.config.provider, request.config.cwd);
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {},
        systemPrompt: composeInstruction(instruction, request.config.systemPrompt),
      },
    };
  });
  server.before("agent.session_open", async ({ request }) => {
    if (!allianceProvider(request.provider)) return;
    const instance = await get();
    const profile = await instance.profile(request.provider);
    const room = await instance.roomFor(request.cwd);
    await instance.bind({
      id: request.agentId,
      workspaceId: request.workspaceId,
      parentAgentId: null,
      provider: request.provider,
      cwd: request.cwd,
      title: null,
    });
    return {
      ...request,
      env: {
        ...request.env,
        ALLIANCE_BOUND_ROOM: room.id,
        ALLIANCE_WORKSPACE_CWD: request.cwd,
        HOME: profile.osHome,
        XDG_CONFIG_HOME: `${profile.osHome}/.config`,
        XDG_DATA_HOME: `${profile.osHome}/.local/share`,
        XDG_CACHE_HOME: `${profile.osHome}/.cache`,
        ALLIANCE_WORK_HOME: instance.home,
        ALLIANCE_ROLE: profile.role,
        CODEX_HOME: profile.harness === "codex" ? profile.home : `${profile.osHome}/.codex`,
        CLAUDE_CONFIG_DIR: profile.harness === "claude" ? profile.home : `${profile.osHome}/.claude`,
        PI_CODING_AGENT_DIR: profile.harness === "pi" ? profile.home : `${profile.osHome}/.pi`,
      },
    };
  });
  server.on("agent.created", async ({ agent }) => {
    if (allianceProvider(agent.provider)) await (await get()).bind(agent);
  });
  server.on("agent.turn_started", async ({ agent, turnId }) => {
    if (!allianceProvider(agent.provider)) return;
    await (await get()).startTurn(agent, turnId);
  });
  server.on("agent.turn_ended", async (event) => {
    if (allianceProvider(event.agent.provider))
      await (await get()).endTurn(event.agent, event.turnId, event.outcome, event.timeline);
  });
  return async () => {
    if (runtime) (await runtime.catch(() => undefined))?.close();
  };
}
