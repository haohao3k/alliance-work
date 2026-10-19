import type { PluginServerContext } from "@getpaseo/plugin/server";
import { directorySuggestions } from "./server/directories";
import { composeInstruction } from "./server/instructions";
import { AllianceRuntime, allianceProvider } from "./server/runtime";
import {
  directoryList,
  jobOwner,
  jobTrack,
  memberDisposition,
  memberLaunch,
  memberOwner,
  memberResume,
  policyAck,
  policyRead,
  profileStatus,
  roomCreate,
  roomList,
  roomModelCatalog,
  roomModelPolicy,
  roomModelPolicySave,
  settings,
} from "./shared/contracts";
import { obligationAction, obligationAdd, obligationHistory, obligationList } from "./shared/obligations";
import { wakeAction, wakeAdd, wakeList, wakeTake } from "./shared/wakeups";

export default function contribute(server: PluginServerContext) {
  const configuration = server.registerSettings(settings);
  let runtime: Promise<AllianceRuntime> | undefined;
  const get = () =>
    (runtime ??= (async () => {
      const state = await configuration.read();
      if (state.status !== "ready") throw new Error(state.error);
      if (!state.values.home) throw new Error("Set the Alliance home before starting wakeups");
      const instance = new AllianceRuntime(state.values.home);
      try {
        await instance.ready();
        instance.startWakeups();
        return instance;
      } catch (error) {
        await instance.close();
        runtime = undefined;
        throw error;
      }
    })().catch((error) => {
      runtime = undefined;
      throw error;
    }));
  // Recover durable obligations even before the UI is opened after plugin reload.
  const unsubscribe = configuration.subscribe(() => {
    void get().catch(() => undefined);
  });
  void get().catch(() => undefined);
  server.handle(obligationList, async ({ ownerId }) => (await get()).obligations.list(ownerId));
  server.handle(obligationHistory, async ({ key }) => (await get()).store.obligationHistory(key));
  server.handle(obligationAdd, async (input, { paseo }) => (await get()).obligations.add(input, paseo));
  server.handle(obligationAction, async (input, { paseo }) => (await get()).obligations.action(input, paseo));
  server.handle(wakeList, async () => {
    const r = await get();
    await r.wakeups.tick();
    return r.wakeups.list();
  });
  server.handle(wakeAdd, async (input) => (await get()).wakeups.add(input));
  server.handle(wakeTake, async ({ ownerId }) => (await get()).wakeups.take(ownerId));
  server.handle(wakeAction, async (input) =>
    (await get()).wakeups.action(input.key, input.ownerId, input.revision, input.action, input.nextOwnerId),
  );
  server.handle(jobTrack, async (input) => (await get()).trackJob(input));
  server.handle(jobOwner, async (input, { paseo }) =>
    (await get()).changeJobOwner(input.key, input.ownerId, input.revision, paseo),
  );
  server.handle(memberOwner, async (input, { paseo }) =>
    (await get()).changeMemberOwner(input.agentId, input.ownerId, input.revision, input.evidence, paseo),
  );
  server.handle(policyRead, async ({ agentId }) => (await get()).readPolicy(agentId));
  server.handle(policyAck, async ({ agentId, digest }) => (await get()).acknowledgePolicy(agentId, digest));
  server.handle(profileStatus, async () => (await get()).profiles());
  server.handle(roomList, async (_input, { paseo }) => (await get()).list(paseo));
  server.handle(roomCreate, async (input, { paseo }) => (await get()).createRoom(input, paseo));
  server.handle(roomModelPolicy, async ({ roomId }) => (await get()).store.modelPolicy(roomId));
  server.handle(roomModelPolicySave, async ({ roomId, policy, revision }) =>
    (await get()).store.saveModelPolicy(roomId, policy, revision),
  );
  server.handle(roomModelCatalog, async ({ roomId, harness, role }, { paseo }) => ({
    models: (await (await get()).modelCatalog(roomId, harness, role, paseo))
      .filter((model) => model.isSelectable !== false)
      .map((model) => ({
        id: model.id,
        label: model.label,
        efforts: (model.thinkingOptions ?? []).map((option) => option.id),
      })),
  }));
  server.handle(directoryList, async ({ query }, { paseo }) => {
    const workspaces = await paseo.workspaces.list();
    return directorySuggestions(
      query,
      workspaces.entries.map((workspace) => workspace.workspaceDirectory),
    );
  });
  server.handle(memberLaunch, async (input, { paseo }) => (await get()).launch(input, paseo));
  server.handle(memberResume, async (input, { paseo }) =>
    (await get()).resume(input.agentId, input.prompt, paseo),
  );
  server.handle(memberDisposition, async (input) =>
    (await get()).disposition(input.agentId, input.decision, input.candidate, input.evidence, input.product),
  );
  server.before("agent.create", async ({ request }, { paseo }) => {
    if (!allianceProvider(request.config.provider)) return;
    const instance = await get();
    const instruction = await instance.instruction(request.config.provider, request.config.cwd, paseo);
    const room = await instance.roomFor(request.config.cwd);
    const selected = await instance.selectModel(
      room.id,
      request.config.provider,
      paseo,
      request.config.model,
      request.config.thinkingOptionId,
    );
    return {
      ...request,
      config: {
        ...request.config,
        ...selected,
        mcpServers: {},
        systemPrompt: composeInstruction(instruction, request.config.systemPrompt),
      },
    };
  });
  server.before("agent.session_open", async ({ request }, { paseo }) => {
    if (!allianceProvider(request.provider)) return;
    const instance = await get();
    const profile = await instance.profile(request.provider);
    const room = await instance.ensureRoom(request.cwd, paseo, request.workspaceId);
    await instance.bind({
      id: request.agentId,
      workspaceId: request.workspaceId,
      parentAgentId: null,
      provider: request.provider,
      cwd: request.cwd,
      title: null,
    });
    const recovery = await instance.recoveryContext(request.agentId);
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
        ALLIANCE_ARTIFACTS: room.artifacts,
        ALLIANCE_ASSIGNMENT: instance.store.member(request.agentId)?.assignment ?? "",
        ALLIANCE_CONTEXT: recovery,
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
    unsubscribe();
    if (runtime) await (await runtime.catch(() => undefined))?.close();
  };
}
