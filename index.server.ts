import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAllianceAgyProvider } from "./server/agy-provider";
import {
  claudeAccountsState,
  projectClaudeAccountState,
  selectClaudeAccount,
  selectProjectClaudeAccount,
} from "./server/claude-accounts.mjs";
import { claudeQuota } from "./server/claude-quota.mjs";
import { createClaudeUsageSource } from "./server/claude-usage-source";
import { contextSettings, saveContextSettings } from "./server/context-settings.mjs";
import { directorySuggestions } from "./server/directories";
import { composeInstruction } from "./server/instructions";
import { archiveJob, settleJob } from "./server/job-lifecycle";
import { readMaintenanceHold } from "./server/maintenance-hold.mjs";
import { AllianceRuntime, allianceProvider } from "./server/runtime";
import { saveScopedProject, scopedMcpState } from "./server/scoped-mcp.mjs";
import { scratchEnvironment } from "./server/scratch.mjs";
import { installProjectSkills, previewSkillImport } from "./server/skill-imports.mjs";
import { projectSkillSettings, saveProjectSkills } from "./server/skill-settings.mjs";
import { autonomyCheckpoint, autonomyList, autonomyStart } from "./shared/autonomy";
import {
  claudeAccountsRead,
  claudeAccountsSelect,
  claudeAccountsSwitchNow,
  claudeQuotaRead,
  projectClaudeAccountRead,
  projectClaudeAccountSelect,
} from "./shared/claude-account-contracts";
import { contextRead, contextSave } from "./shared/context-contracts";
import {
  directoryList,
  jobArchive,
  jobOwner,
  jobSettle,
  jobTrack,
  maintenanceReconcile,
  maintenanceStatus,
  memberDisposition,
  memberKeep,
  memberLaunch,
  memberOwner,
  memberResume,
  policyAck,
  policyRead,
  profileStatus,
  roomCreate,
  roomKeepwarm,
  roomKeepwarmSave,
  roomList,
  roomModelCatalog,
  roomModelPolicy,
  roomModelPolicyReset,
  roomModelPolicySave,
  settings,
} from "./shared/contracts";
import { mcpPreview, mcpRead, mcpSave } from "./shared/mcp-contracts";
import { allowedModel } from "./shared/model-policy";
import { agentTitle } from "./shared/naming";
import { obligationAction, obligationAdd, obligationHistory, obligationList } from "./shared/obligations";
import { skillsInstall, skillsPreview, skillsRead, skillsSave } from "./shared/skill-contracts";
import { wakeAction, wakeAdd, wakeList, wakeTake } from "./shared/wakeups";

export default function contribute(server: PluginServerContext) {
  server.registerUsageSource(createClaudeUsageSource());
  for (const role of ["hq", "supervisor", "lead", "peer", "lens"])
    server.registerProvider(createAllianceAgyProvider(role));
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
  server.handle(maintenanceReconcile, async ({ holdId }, { paseo }) =>
    (await get()).reconcileMaintenance(holdId, paseo),
  );
  server.handle(maintenanceStatus, async () => ({
    durablePause: true as const,
    humanDecisionAttribution: true as const,
    hold: await readMaintenanceHold((await get()).home),
  }));
  server.handle(mcpRead, async () => scopedMcpState((await get()).home));
  server.handle(claudeAccountsRead, async () => {
    const instance = await get();
    return {
      ...(await claudeAccountsState(instance.home)),
      sessions: await instance.claudeAccountSessions(),
    };
  });
  let quotaRequest: ReturnType<typeof claudeQuota> | undefined;
  let quotaAt = 0;
  server.handle(claudeQuotaRead, async () => {
    if (!quotaRequest || Date.now() - quotaAt > 60000) {
      quotaAt = Date.now();
      quotaRequest = claudeQuota().catch((error) => {
        quotaRequest = undefined;
        throw error;
      });
    }
    return quotaRequest;
  });
  server.handle(claudeAccountsSelect, async ({ role, account, revision }) =>
    selectClaudeAccount((await get()).home, role, account, revision),
  );
  server.handle(projectClaudeAccountRead, async ({ roomId }) => {
    const instance = await get();
    return projectClaudeAccountState(instance.home, instance.store.room(roomId).id);
  });
  server.handle(projectClaudeAccountSelect, async ({ roomId, account, revision }) => {
    const instance = await get();
    return selectProjectClaudeAccount(instance.home, instance.store.room(roomId).id, account, revision);
  });
  server.handle(claudeAccountsSwitchNow, async ({ agentId, selected }) =>
    (await get()).switchClaudeNow(agentId, selected),
  );
  server.handle(skillsRead, async ({ cwd }) => projectSkillSettings(cwd));
  server.handle(skillsSave, async ({ cwd, selected, revision, disabledBundled }) =>
    saveProjectSkills(cwd, selected, revision, disabledBundled),
  );
  server.handle(skillsPreview, async ({ source }) => previewSkillImport(source));
  server.handle(skillsInstall, async ({ cwd, source, commit, requested, revision }) =>
    installProjectSkills(cwd, source, commit, requested, revision),
  );
  server.handle(mcpSave, async ({ root, project, revision }) =>
    saveScopedProject((await get()).home, root, project, revision),
  );
  server.handle(mcpPreview, async ({ cwd, harness }) => ({
    servers: await (await get()).previewMcp(harness, cwd),
  }));
  server.handle(obligationList, async ({ ownerId }) => (await get()).obligations.list(ownerId));
  server.handle(obligationHistory, async ({ key }) => (await get()).store.obligationHistory(key));
  server.handle(obligationAdd, async (input, { paseo }) => (await get()).obligations.add(input, paseo));
  server.handle(obligationAction, async (input, { paseo }) => (await get()).obligations.action(input, paseo));
  server.handle(autonomyList, async () => (await get()).autonomy.list());
  server.handle(autonomyStart, async ({ agentId, ...options }, { paseo }) => {
    const r = await get();
    return r.startAutonomy(agentId, options, paseo);
  });
  server.handle(autonomyCheckpoint, async ({ agentId, phase, reason, turnId }, { paseo }) => {
    const r = await get();
    return r.checkpoint(agentId, phase, reason, turnId, paseo);
  });
  server.handle(wakeList, async () => {
    const r = await get();
    await r.wakeups.tick();
    return r.wakeups.list();
  });
  server.handle(wakeAdd, async (input) => (await get()).wakeups.add(input));
  server.handle(wakeTake, async ({ ownerId }) => (await get()).wakeups.take(ownerId));
  server.handle(wakeAction, async (input) =>
    (await get()).wakeups.action(
      input.key,
      input.ownerId,
      input.revision,
      input.action,
      input.nextOwnerId,
      input.minutes,
    ),
  );
  server.handle(jobSettle, async (input) => {
    const r = await get();
    return settleJob(r.store, input);
  });
  server.handle(jobArchive, async (input) => {
    const r = await get();
    return archiveJob(r.store, input);
  });
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
  server.handle(roomKeepwarm, async ({ roomId }) => (await get()).store.keepwarm(roomId));
  server.handle(roomKeepwarmSave, async ({ roomId, enabled, actorId, maxPings }) =>
    (await get()).store.setKeepwarm(roomId, enabled, actorId, maxPings),
  );
  server.handle(contextRead, async ({ roomId }) => {
    const instance = await get();
    return contextSettings(instance.home, instance.store.room(roomId).id);
  });
  server.handle(contextSave, async ({ roomId, policy, revision, actorId }) => {
    const instance = await get();
    return saveContextSettings(instance.home, instance.store.room(roomId).id, policy, revision, actorId);
  });
  server.handle(roomModelPolicySave, async ({ roomId, policy, revision }) =>
    (await get()).store.saveModelPolicy(roomId, policy, revision),
  );
  server.handle(roomModelPolicyReset, async ({ roomId, revision }) =>
    (await get()).store.resetModelPolicy(roomId, revision),
  );
  server.handle(roomModelCatalog, async ({ roomId, harness, role, scope }, { paseo }) => ({
    models: (await (await get()).modelCatalog(roomId, harness, role, paseo, scope))
      .filter((model) => model.isSelectable !== false && allowedModel(harness, model.id))
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
  server.handle(memberKeep, async ({ agentId, keep, actorId, reason, hours }) =>
    (await get()).keep(agentId, keep, actorId, { reason, hours }),
  );
  server.handle(memberDisposition, async (input, { paseo }) =>
    (await get()).disposition(
      input.agentId,
      input.decision,
      input.candidate,
      input.evidence,
      input.product,
      input.actorId,
      paseo,
      input.integration,
      input.analysisRoot,
      { keep: input.keep, rework: input.rework, forHuman: input.forHuman, source: input.source },
    ),
  );
  server.addHook("agent.create.before", async ({ request }, { paseo }) => {
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
        title: agentTitle(
          room.title,
          allianceProvider(request.config.provider)!.role,
          request.config.title ?? "",
          instance.store.rooms().map((entry) => entry.title),
        ),
        ...selected,
        mcpServers: await instance.sessionMcpServers(request.config.provider, request.config.cwd),
        systemPrompt: composeInstruction(instruction, request.config.systemPrompt),
      },
    };
  });
  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
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
    const member = instance.store.member(request.agentId);
    const recovery = await instance.recoveryContext(request.agentId);
    const selectedModel =
      profile.harness === "claude"
        ? (await paseo.agents.ref(request.agentId).refresh())?.agent.model
        : undefined;
    return {
      ...request,
      env: {
        ...request.env,
        // Read the current native selection on every open, including resumed sessions.
        ALLIANCE_SESSION_MODEL: selectedModel ?? "",
        ALLIANCE_CLAUDE_ROOM: profile.harness === "claude" ? (member?.roomId ?? room.id) : "",
        ALLIANCE_BOUND_ROOM: room.id,
        ALLIANCE_WORKSPACE_CWD: request.cwd,
        // Temporary data of this session dies here: its own directory, emptied by `scratch clean`.
        ...scratchEnvironment(instance.home, member?.roomId ?? room.id, request.agentId),
        HOME: profile.osHome,
        XDG_CONFIG_HOME: `${profile.osHome}/.config`,
        XDG_DATA_HOME: `${profile.osHome}/.local/share`,
        XDG_CACHE_HOME: `${profile.osHome}/.cache`,
        ALLIANCE_WORK_HOME: instance.home,
        ALLIANCE_ROLE: profile.role,
        ALLIANCE_ARTIFACTS: room.artifacts,
        ALLIANCE_ASSIGNMENT: member?.assignment ?? "",
        ALLIANCE_CONTEXT: recovery,
        CODEX_HOME: profile.harness === "codex" ? profile.home : `${profile.osHome}/.codex`,
        CLAUDE_CONFIG_DIR: profile.harness === "claude" ? profile.home : `${profile.osHome}/.claude`,
        PI_CODING_AGENT_DIR: profile.harness === "pi" ? profile.home : `${profile.osHome}/.pi`,
      },
    };
  });
  server.addHook("agent.create.after", async ({ agent }) => {
    if (allianceProvider(agent.provider)) {
      const instance = await get();
      await instance.bind(agent);
      if (agent.parentAgentId && !instance.autonomy.get(agent.id)) instance.autonomy.start(agent.id);
    }
  });
  server.addHook("agent.turn.before", async ({ agent, turnId }, { paseo }) => {
    if (!allianceProvider(agent.provider)) return;
    await (await get()).startTurn(agent, turnId, paseo);
  });
  server.addHook("agent.turn.after", async (event, { paseo }) => {
    if (allianceProvider(event.agent.provider))
      await (await get()).endTurn(event.agent, event.turnId, event.outcome, undefined, paseo);
  });
  // Nobody approves a member's commands: the plugin denies a request 5 minutes after this.
  server.addHook("agent.permission.before", async ({ agent, request }) => {
    if (allianceProvider(agent.provider)) (await get()).liveness.requested(agent.id, request.id);
  });
  // Without this the scheduler learns of an archive only when it next reads the agent.
  server.addHook("agent.archive.after", async ({ agent }) => {
    if (allianceProvider(agent.provider)) await (await get()).lifecycle.archived(agent.id);
  });
  return async () => {
    unsubscribe();
    if (runtime) await (await runtime.catch(() => undefined))?.close();
  };
}
