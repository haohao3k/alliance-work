import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginServerContext, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import contribute from "../index.server";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { writeLauncher } from "../scripts/maintenance.mjs";
import { prepareProfiles, projectRoot, verifyProfile } from "../scripts/profiles.mjs";
import { runVerification } from "../server/evidence.mjs";
import { composeInstruction } from "../server/instructions";
import { AllianceRuntime, type DaemonInfo, type SchedulerClient, sendingRule } from "../server/runtime";
import type { AutonomyState } from "../shared/autonomy";
import { roomList } from "../shared/contracts";
import type { WakeRecordValue } from "../shared/wakeups";
import { temporary } from "./temp";

function member(runtime: AllianceRuntime, id: string) {
  const record = runtime.store.member(id);
  assert(record, "Assigned member must exist");
  return record;
}

test("analysis bundle acceptance binds room files without promoting them to product completion", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const { agentId } = await f.runtime.launch(
    { roomId: f.room.id, key: "analysis", role: "peer", harness: "codex", prompt: "Review a report" },
    f.paseo,
  );
  const bundle = join(f.room.artifacts, "analysis-bundle");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "analysis.txt"), "finding with bounded evidence\n");
  const proof = await runVerification({
    cwd: bundle,
    output: join(f.root, "proof"),
    inputs: ["analysis.txt"],
    command: [
      process.execPath,
      "-e",
      "if(!require('fs').readFileSync('analysis.txt','utf8').includes('bounded'))process.exit(1)",
    ],
    scenario: "reviewed analysis bundle",
    kind: "analysis",
  });
  const accept = (root = bundle, product?: unknown) =>
    f.runtime.disposition(
      agentId,
      "accepted",
      proof.report.candidate.digest,
      proof.path,
      product,
      null,
      undefined,
      undefined,
      root,
    );
  await assert.rejects(accept(f.root), /inside this room/);
  await assert.rejects(accept(bundle, { outcome: "invented" }), /technical analysis/);
  const linked = join(f.room.artifacts, "analysis-link");
  await symlink(bundle, linked);
  await assert.rejects(accept(linked), /link/i);
  await writeFile(join(bundle, "analysis.txt"), "changed finding\n");
  await assert.rejects(accept(), /changed|stale/);
  assert.equal(member(f.runtime, agentId).decision, "open");
  await unlink(join(bundle, "analysis.txt"));
  const outside = join(f.root, "external-analysis.txt");
  await writeFile(outside, "finding with bounded evidence\n");
  await symlink(outside, join(bundle, "analysis.txt"));
  await assert.rejects(accept(), /link/i);
  await unlink(join(bundle, "analysis.txt"));
  await writeFile(join(bundle, "analysis.txt"), "finding with bounded evidence\n");
  await accept();
  assert.equal(member(f.runtime, agentId).decisionScope, "technical");
  const decisionEvidence = member(f.runtime, agentId).decisionEvidence;
  assert(decisionEvidence);
  const receipt = JSON.parse(await readFile(decisionEvidence, "utf8"));
  assert.equal(receipt.analysisRoot, bundle);
  assert.equal(receipt.verification.candidate.digest, proof.report.candidate.digest);
  assert.equal(receipt.product, undefined);
  await writeFile(proof.report.artifacts[0].path, "tampered proof");
  await assert.rejects(accept(), /artifact changed/);
});

test("room status bounds simultaneous native reads while retaining every member", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  for (let i = 0; i < 32; i++) {
    f.runtime.store.saveMember({
      id: `memory-${i}`,
      roomId: f.room.id,
      provider: "alliance-claude-peer",
      role: "peer",
      parentId: null,
      assignment: "read-only status fixture",
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  }
  let active = 0;
  let peak = 0;
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          peak = Math.max(peak, ++active);
          await new Promise((resolve) => setImmediate(resolve));
          active--;
          return {
            agent: {
              id,
              title: id,
              status: "idle",
              archivedAt: null,
              model: "claude-opus-5-5",
              runtimeInfo: { model: "claude-opus-4-8" },
            },
          };
        },
      }),
    },
  } as unknown as PaseoApi;
  const status = await f.runtime.list(api);
  assert.equal(status.members.length, 32);
  assert.equal(new Set(status.members.map((m) => m.id)).size, 32);
  assert.ok(status.members.every((m) => m.title === m.id && m.status === "idle"));
  assert.ok(
    status.members.every(
      (m) => m.selectedModel === "claude-opus-5-5" && m.runtimeModel === "claude-opus-4-8",
    ),
  );
  assert.ok(peak <= 8, `status opened ${peak} simultaneous native reads`);
});

async function fixture() {
  const root = await temporary("alliance-test-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  const runtime = await new AllianceRuntime(home).ready();
  let creates = 0,
    sends = 0,
    status = "idle";
  let archivedAt: string | null = null;
  let sendError: Error | null = null;
  const identities = new Set<string>();
  const launchConfigs: { modeId?: string; thinkingOptionId?: string }[] = [];
  const sent: { text: string; options?: { activeTurnBehavior?: string } }[] = [];
  const workspace = {
    id: "workspace-1",
    refresh: async () => ({ title: null }),
    setTitle: async () => ({}),
    agents: {
      create: async (input: { agentId: string; config: { modeId?: string } }) => {
        launchConfigs.push(input.config);
        if (!identities.has(input.agentId)) {
          creates++;
          identities.add(input.agentId);
        }
        return { id: input.agentId };
      },
    },
  };
  const paseo = {
    providers: {
      listModels: async (provider: string) => ({
        models: ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5", "claude-sonnet-5-5"].map((id) => ({
          provider,
          id,
          label: id,
          thinkingOptions: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
        })),
      }),
    },
    workspaces: { open: async () => workspace, ref: (id: string) => ({ ...workspace, id }) },
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status, archivedAt, pendingPermissions: [], lastError: null } }),
        send: async (text: string, options?: { activeTurnBehavior?: string }) => {
          if (sendError) throw sendError;
          sends++;
          sent.push({ text, options });
        },
      }),
    },
  } as unknown as PaseoApi;
  const room = await runtime.createRoom(
    { cwd, title: "Example", mission: "Deliver a verified result" },
    paseo,
  );
  return {
    root,
    home,
    cwd,
    manifest,
    runtime,
    paseo,
    room,
    count: () => ({ creates, sends }),
    sent,
    launchConfigs,
    archived: (value: boolean) => {
      archivedAt = value ? new Date().toISOString() : null;
    },
    status: (next: string) => {
      status = next;
    },
    /** The daemon answers sends with this error (null: it accepts them again). */
    failSends: (error: Error | null) => {
      sendError = error;
    },
  };
}

/**
 * Claude members of one host on a mocked clock (UTC times on `day`), driven through the runtime's
 * turn hooks; the scheduler sees each member idle unless one of its turns runs.
 */
async function claudeHost(
  t: TestContext,
  day: string,
  start: string,
  shape: [string, "hq" | "supervisor" | "lead" | "peer", string | null][],
) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${day}T${start}Z`) });
  const f = await fixture();
  const running = new Set<string>();
  const sent: { id: string; text: string; messageId: string; at: number }[] = [];
  const roles = new Map(shape.map(([id, role]) => [id, role]));
  const nativeTimelines = new Map<
    string,
    { item: AgentTimelineItem; turnId?: string; timestamp: string }[]
  >();
  for (const [id, role, parentId] of shape)
    f.runtime.store.saveMember({
      id,
      roomId: f.room.id,
      role,
      provider: `alliance-claude-${role}`,
      parentId,
      assignment: join(f.room.artifacts, "assignments", `${id}.md`),
      cwd: f.cwd,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: { status: running.has(id) ? "running" : "idle", archivedAt: null, pendingPermissions: [] },
        }),
        send: async (text: string, options: { messageId: string }) => {
          sent.push({ id, text, messageId: options.messageId, at: Date.now() });
        },
        timeline: { refetch: async () => ({ entries: nativeTimelines.get(id) ?? [], hasOlder: false }) },
      }),
    },
  } as unknown as SchedulerClient;
  const agent = (id: string) =>
    ({
      id,
      provider: `alliance-claude-${roles.get(id)}`,
      cwd: f.cwd,
      workspaceId: "workspace-1",
      parentAgentId: shape.find(([member]) => member === id)?.[2] ?? null,
      title: null,
    }) as PluginHookAgent;
  const at = (time: string) => t.mock.timers.setTime(Date.parse(`${day}T${time}Z`));
  return {
    ...f,
    api,
    sent,
    at,
    /** Scheduler rounds every 15 s up to `time`; Wakeups delivers too when `wakes`. */
    rounds: async (time: string, wakes = false) => {
      while (Date.now() + 15000 <= Date.parse(`${day}T${time}Z`)) {
        t.mock.timers.setTime(Date.now() + 15000);
        await f.runtime.autonomy.tick(api);
        if (wakes) await f.runtime.wakeups.tick(api);
      }
      at(time);
    },
    begin: async (id: string, turnId: string, time: string) => {
      at(time);
      running.add(id);
      await f.runtime.startTurn(agent(id), turnId);
    },
    end: async (
      id: string,
      turnId: string,
      time: string,
      timeline: AgentTimelineItem[],
      outcome: PluginTurnOutcome = { kind: "completed" },
      nativeEntries?: { item: AgentTimelineItem; turnId?: string; timestamp: string }[],
    ) => {
      at(time);
      running.delete(id);
      nativeTimelines.set(
        id,
        nativeEntries ??
          timeline.map((item) => ({
            item,
            turnId: turnId ?? undefined,
            timestamp: new Date().toISOString(),
          })),
      );
      await f.runtime.endTurn(agent(id), turnId, outcome, timeline, api);
    },
  };
}

/** Records a member the way the session hook does, owned by `parentId` (null: the Human). */
function seat(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  role: "lead" | "peer",
  parentId: string | null,
) {
  f.runtime.store.saveMember({
    id,
    roomId: f.room.id,
    role,
    provider: `alliance-codex-${role}`,
    parentId,
    assignment: "brief.md",
    lastOutcome: null,
    resultPath: null,
    decision: "open",
    decisionEvidence: null,
    launchKey: null,
    launchHash: null,
  });
}
type Live = {
  status: string;
  /** Paseo's last activity time and the running turn, in epoch ms. */
  updatedAt?: number;
  turn?: { id: string; startedAt: number };
  permissions?: number;
  /** Approval requests it waits on: their id and the shell command they ask to run. */
  approvals?: { id: string; command: string }[];
  /** A shell command the agent's turn is still running. */
  command?: string;
};
/** The daemon the plugin's scheduler connects to: one state per agent, and the prompts it received. */
function schedulerDaemon(home: string, agents: Map<string, Live>, version = "0.12.0") {
  const sent: { id: string; text: string }[] = [];
  /** Answers to approval requests; Paseo then drops the request from the agent's pending list. */
  const answers: { id: string; requestId: string; behavior: string; message?: string; at: number }[] = [];
  const snapshot = (id: string, a: Live) => ({
    id,
    status: a.status,
    updatedAt: a.updatedAt === undefined ? undefined : new Date(a.updatedAt).toISOString(),
    activeTurn: a.turn && { turnId: a.turn.id, startedAt: new Date(a.turn.startedAt).toISOString() },
    pendingPermissions: [
      ...Array.from({ length: a.permissions ?? 0 }, () => ({})),
      ...(a.approvals ?? []).map(({ id, command }) => ({
        id,
        name: "Bash",
        kind: "tool",
        detail: { type: "shell", command },
      })),
    ],
    archivedAt: null,
  });
  const api = {
    agents: {
      list: async ({ filter }: { filter?: { statuses?: string[]; includeBackground?: boolean } } = {}) => {
        // Paseo 0.11 has no background workspaces; the client refuses to ask it for them.
        if (filter?.includeBackground && version.startsWith("0.11."))
          throw new Error("Update the host to use background workspaces.");
        return {
          entries: [...agents]
            .filter(([, a]) => !filter?.statuses || filter.statuses.includes(a.status))
            .map(([id, a]) => ({ agent: snapshot(id, a) })),
        };
      },
      ref: (id: string) => ({
        refresh: async () => {
          const a = agents.get(id);
          return a ? { agent: snapshot(id, a) } : null;
        },
        send: async (text: string) => {
          sent.push({ id, text });
        },
        respondToPermission: async ({
          requestId,
          response,
        }: {
          requestId: string;
          response: { behavior: string; message?: string };
        }) => {
          answers.push({ id, requestId, ...response, at: Date.now() });
          const a = agents.get(id);
          if (a?.approvals) a.approvals = a.approvals.filter((request) => request.id !== requestId);
        },
        timeline: {
          refetch: async () => {
            const command = agents.get(id)?.command;
            const item = {
              type: "tool_call",
              status: "running",
              name: "Bash",
              detail: { type: "shell", command },
            };
            return { entries: command ? [{ item }] : [] };
          },
        },
      }),
    },
    close: async () => {},
  } as unknown as SchedulerClient;
  return {
    api,
    sent,
    answers,
    /** One scheduler round of a freshly loaded plugin, so every round also crosses a reload. */
    round: async () => {
      const plugin = await new AllianceRuntime(home, async (_home, seen) => {
        seen({ version, agentMessageProvenance: !version.startsWith("0.11.") });
        return api;
      }).ready();
      try {
        await plugin.startWakeups();
      } finally {
        await plugin.close();
      }
    },
  };
}
test("role homes own exact Seatwork bytes and never inherit ambient credentials or instructions", async () => {
  const f = await fixture();
  try {
    const profile = f.manifest.profiles["codex-peer"];
    await verifyProfile(profile);
    assert.equal(profile.skillDirectories.length, 9);
    const env = profileEnvironment(profile, f.home, {
      HOME: "/daily",
      CODEX_HOME: "/daily/codex",
      ANTHROPIC_API_KEY: "daily-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "daily-oauth",
      PI_CODING_AGENT_DIR: "/daily/pi",
      PATH: "/bin",
      PASEO_AGENT_ID: "agent",
    });
    assert.equal(env.HOME, profile.osHome);
    assert.equal(env.CODEX_HOME, profile.home);
    assert(!("ANTHROPIC_API_KEY" in env));
    assert(!("CLAUDE_CODE_OAUTH_TOKEN" in env));
    const explicit = { CLAUDE_CODE_OAUTH_TOKEN: "explicit-test-token" };
    assert.equal(
      profileEnvironment(f.manifest.profiles["claude-peer"], f.home, {}, explicit).CLAUDE_CODE_OAUTH_TOKEN,
      explicit.CLAUDE_CODE_OAUTH_TOKEN,
    );
    assert.throws(() => profileEnvironment(profile, f.home, {}, explicit), /Unsupported/);
    assert.equal(env.PASEO_AGENT_ID, "agent");
    const skill = join(profile.home, "skills/slp-evidence-report/SKILL.md");
    const expected = await readFile(
      join(import.meta.dirname, "../vendor/seatwork/skills/peer/slp-evidence-report/SKILL.md"),
    );
    assert.deepEqual(await readFile(skill), expected);
    await writeFile(skill, "modified");
    await assert.rejects(verifyProfile(profile), /changed/);
  } finally {
    f.runtime.close();
  }
});
test("role credentials reject shared permissions, links and malformed JSON without leaking bytes", async () => {
  const f = await fixture();
  try {
    const path = join(f.manifest.profiles["claude-peer"].home, "credentials.env.json");
    await writeFile(path, '{"CLAUDE_CODE_OAUTH_TOKEN":"test-secret"}', { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(launchPlan(f.home, "claude-peer", ["auth", "status"]), /owner-only/);
    await chmod(path, 0o600);
    const plan = await launchPlan(f.home, "claude-peer", ["auth", "status"]);
    assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, "test-secret");
    await writeFile(path, '{"CLAUDE_CODE_OAUTH_TOKEN":"test-secret"');
    await assert.rejects(
      launchPlan(f.home, "claude-peer", ["auth", "status"]),
      (error: Error) => error.message.includes("invalid") && !error.message.includes("test-secret"),
    );
    const linked = join(f.manifest.profiles["claude-lens"].home, "credentials.env.json");
    await symlink(path, linked);
    await assert.rejects(launchPlan(f.home, "claude-lens", ["auth", "status"]), /Symlink/);
  } finally {
    f.runtime.close();
  }
});
test("agent sessions run tools with input prompts off; the Human's own launches and logins keep them", async () => {
  const f = await fixture();
  try {
    const session = {
      PATH: process.env.PATH,
      PASEO_AGENT_ID: "agent",
      ALLIANCE_BOUND_ROOM: f.room.id,
      ALLIANCE_WORKSPACE_CWD: f.cwd,
    };
    // Nobody answers a prompt inside an agent turn. Turns in the audit hung on Corepack's download
    // prompt and on git asking for credentials; these are the tools' own switches for them.
    const quiet = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", GIT_TERMINAL_PROMPT: "0" };
    for (const id of ["claude-peer", "pi-lead"]) {
      const plan = await launchPlan(f.home, id, ["-p"], session, f.cwd);
      assert.deepEqual(
        Object.keys(quiet).map((key) => plan.env[key]),
        Object.values(quiet),
        id,
      );
    }
    const human = await launchPlan(f.home, "claude-peer", ["-p"], { PATH: process.env.PATH }, f.cwd);
    const login = await launchPlan(f.home, "claude-peer", ["auth", "login"], session, f.cwd);
    for (const plan of [human, login])
      assert.deepEqual(
        Object.keys(quiet).filter((key) => key in plan.env),
        [],
      );
  } finally {
    f.runtime.close();
  }
});

test("symlink skill additions are rejected instead of falling back to a shared home", async () => {
  const f = await fixture();
  try {
    const profile = f.manifest.profiles["pi-peer"];
    await symlink(f.cwd, join(profile.home, "skills", "daily"));
    await assert.rejects(verifyProfile(profile), /Unmanaged skill/);
  } finally {
    f.runtime.close();
  }
});
test("a retried launch keeps one native agent and the durable assignment", async () => {
  const f = await fixture();
  try {
    const input = {
      roomId: f.room.id,
      key: "one-assignment",
      role: "peer" as const,
      harness: "codex" as const,
      model: "gpt-6.1-sol",
      prompt: "Produce an artifact and verification.",
    };
    const first = await f.runtime.launch(input, f.paseo);
    const settings = f.runtime.store.modelPolicy(f.room.id);
    for (const route of settings.policy.routes) {
      if (route.model === "gpt-6.1-sol") {
        route.difficulties = route.effort === "medium" ? ["routine", "standard"] : ["complex"];
      }
    }
    f.runtime.store.saveModelPolicy(f.room.id, settings.policy, settings.revision);
    const second = await f.runtime.launch(input, f.paseo);
    assert.equal(first.agentId, second.agentId);
    assert.equal(f.count().creates, 1);
    assert.equal(f.launchConfigs[0].thinkingOptionId, "high");
    assert.equal(
      f.launchConfigs[1].thinkingOptionId,
      "high",
      "Retries retain their resolved route despite changed preferences",
    );
    assert.equal(
      f.launchConfigs[0].modeId,
      "auto",
      "Fresh Codex homes need an explicit workspace-write mode",
    );
    assert.match(await readFile(member(f.runtime, first.agentId).assignment, "utf8"), /Produce an artifact/);
    await assert.rejects(
      f.runtime.launch({ ...input, prompt: "Different work" }, f.paseo),
      /different assignment/,
    );
  } finally {
    f.runtime.close();
  }
});
test("an explicit Codex permission mode survives Alliance launch", async () => {
  const f = await fixture();
  try {
    await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "explicit-mode",
        role: "peer",
        harness: "codex",
        model: "gpt-6.1-sol",
        prompt: "Inspect only",
        mode: "read-only",
      },
      f.paseo,
    );
    assert.equal(f.launchConfigs[0].modeId, "read-only");
  } finally {
    f.runtime.close();
  }
});
test("Lead can explicitly choose a worker model and effort", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "flexible-lead",
        role: "lead",
        harness: "codex",
        model: "gpt-6.1-sol",
        thinking: "xhigh",
        prompt: "Own this workstream",
      },
      f.paseo,
    );
    assert.equal(f.count().creates, 1);
    assert.equal(f.runtime.store.member(result.agentId)?.launchModel, "gpt-6.1-sol");
    assert.equal(f.launchConfigs[0].thinkingOptionId, "xhigh");
  } finally {
    f.runtime.close();
  }
});

test("canceled/failed/completed turns preserve ownership and never accept their own artifact, across restart", async () => {
  const f = await fixture();
  const { agentId } = await f.runtime.launch(
    { roomId: f.room.id, key: "work", role: "peer", harness: "codex", model: "gpt-6.1-sol", prompt: "Task" },
    f.paseo,
  );
  const agent = {
    id: agentId,
    provider: "alliance-codex-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: "Peer",
  };
  for (const outcome of [
    { kind: "canceled" as const, reason: "interrupted" },
    { kind: "failed" as const, error: { message: "offline" } },
    { kind: "completed" as const },
  ]) {
    await f.runtime.endTurn(agent, outcome.kind, outcome, []);
    assert.equal(member(f.runtime, agentId).decision, "open");
  }
  f.runtime.close();
  const reopened = await new AllianceRuntime(f.home).ready();
  try {
    assert.equal(member(reopened, agentId).lastOutcome, "completed");
    assert.equal(member(reopened, agentId).decision, "open");
    execFileSync("git", ["init", "-q", f.cwd]);
    const proof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "proof"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "disposition-persistence",
    });
    await reopened.disposition(
      agentId,
      "accepted",
      proof.report.candidate.digest,
      proof.path,
      undefined,
      null,
    );
    assert.equal(member(reopened, agentId).decision, "accepted");
    const disposition = member(reopened, agentId).decisionEvidence;
    assert(disposition);
    await reopened.startTurn(agent, "next-turn");
    assert.equal(member(reopened, agentId).decision, "open");
    assert.equal(member(reopened, agentId).resultPath, null);
    const display = (await reopened.list(f.paseo)).members.find((m) => m.id === agentId);
    assert.equal(display?.decision, "open");
    assert.equal(display?.lastAcceptance?.kind, "test");
    assert.equal(display?.lastAcceptance?.candidate, proof.report.candidate.digest);
    assert.equal(JSON.parse(await readFile(disposition, "utf8")).candidate, proof.report.candidate.digest);
  } finally {
    reopened.close();
  }
});
test("resume refuses to interrupt active work and late turn receipts cannot overwrite the current run", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "work",
        role: "peer",
        harness: "codex",
        model: "gpt-6.1-sol",
        prompt: "Task",
      },
      f.paseo,
    );
    f.status("running");
    await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /already working/);
    assert.equal(f.count().sends, 0);
    f.runtime.store.updateMember(agentId, { lastTurnId: "new", lastOutcome: null });
    await f.runtime.endTurn(
      {
        id: agentId,
        provider: "alliance-codex-peer",
        cwd: f.cwd,
        workspaceId: "workspace-1",
        parentAgentId: null,
        title: null,
      },
      "old",
      { kind: "completed" },
      [],
    );
    assert.equal(member(f.runtime, agentId).lastOutcome, null);
    f.status("idle");
    await f.runtime.resume(agentId, "Continue", f.paseo);
    assert.equal(f.count().sends, 1);
    // A turn that starts between the readback and the send is steered, not interrupted.
    assert.equal(f.sent[0].options?.activeTurnBehavior, "steer");
  } finally {
    f.runtime.close();
  }
});

test("native inheritance replaces the generated role without duplicating it or losing caller instructions", () => {
  const supervisor = composeInstruction("SUPERVISOR_ROLE", "HUMAN_CONSTRAINT");
  const peer = composeInstruction("PEER_ROLE", supervisor);
  assert(!peer.includes("SUPERVISOR_ROLE"));
  assert(peer.includes("PEER_ROLE"));
  assert(peer.includes("HUMAN_CONSTRAINT"));
  assert.equal(composeInstruction("PEER_ROLE", peer), peer);
});

test("native Alliance launch creates a missing room once and reuses it across concurrent starts and restart", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "new-project");
    await mkdir(cwd);
    const alias = join(f.root, "project-alias");
    await symlink(cwd, alias);
    const instructions = await Promise.all([
      f.runtime.instruction("alliance-codex-hq", cwd, f.paseo),
      f.runtime.instruction("alliance-codex-hq", alias, f.paseo),
    ]);
    const first = await f.runtime.roomFor(cwd);
    const second = await f.runtime.roomFor(alias);
    assert.equal(first.id, second.id);
    assert(instructions.every((instruction) => instruction.includes(first.id)));
    assert.equal(f.runtime.store.rooms().length, 2);
    const instruction = await f.runtime.instruction("alliance-codex-hq", cwd, f.paseo);
    assert(instruction.includes(first.id));
    assert.equal(f.runtime.store.rooms().length, 2);
    // Re-adding a known path cannot replace the original mission or workspace.
    const known = await f.runtime.createRoom(
      { cwd: f.cwd, title: "Overwrite", mission: "Overwrite" },
      f.paseo,
    );
    assert.deepEqual(known, f.room);
    const reopened = await new AllianceRuntime(f.home).ready();
    try {
      assert.equal((await reopened.ensureRoom(cwd, f.paseo)).id, first.id);
      assert.equal(reopened.store.rooms().length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.runtime.close();
  }
});

test("a resumed native session binds a missing room to its existing workspace", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "resumed-project");
    await mkdir(cwd);
    const room = await f.runtime.ensureRoom(cwd, f.paseo, "existing-workspace");
    // A reference to the actual workspace must be used rather than opening another one.
    assert.equal(room.workspaceId, "existing-workspace");
    await assert.rejects(f.runtime.ensureRoom(join(cwd, "missing"), f.paseo));
    assert.equal(f.runtime.store.rooms().length, 2);
  } finally {
    f.runtime.close();
  }
});

test("a linked Git worktree reuses its project's room; ambiguous roots never create another room", async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.cwd, stdio: "pipe" });
    git("init");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    const worktree = join(f.root, "worktree");
    git("worktree", "add", "-b", "worker", worktree);
    assert.equal((await f.runtime.ensureRoom(worktree, f.paseo)).id, f.room.id);
    assert.equal(f.runtime.store.rooms().length, 1);
    // An explicit separate room is allowed; it makes a third linked checkout ambiguous.
    await f.runtime.createRoom({ cwd: worktree, title: "Separate", mission: "Separate scope" }, f.paseo);
    const third = join(f.root, "third");
    git("worktree", "add", "-b", "other", third);
    await assert.rejects(f.runtime.ensureRoom(third, f.paseo), /Several rooms/);
    assert.equal(f.runtime.store.rooms().length, 2);
    assert.equal((await f.runtime.ensureRoom(worktree, f.paseo)).title, "Separate");
  } finally {
    f.runtime.close();
  }
});

test("acceptance refuses invented candidate and evidence identities", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "proof", role: "peer", harness: "codex", prompt: "Verify an outcome" },
      f.paseo,
    );
    await assert.rejects(
      f.runtime.disposition(agentId, "accepted", "invented", "not-a-report", undefined, null),
    );
  } finally {
    f.runtime.close();
  }
});

test("agents are told this home's launcher; old CLIs are refused and pointed to it", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "old-cli", role: "peer", harness: "codex", prompt: "Verify an outcome" },
      f.paseo,
    );
    // A pre-0.1.16 CLI sends no actor: refused, nothing recorded, and told a command that works.
    const legacy = () => f.runtime.disposition(agentId, "accepted", "c", "e", undefined, undefined);
    await assert.rejects(
      legacy(),
      (error: Error) =>
        /older than 0\.1\.16/.test(error.message) && error.message.includes("scripts/cli.mjs"),
    );
    const launcher = join(f.root, "bin dir", "alliance-work");
    await mkdir(join(f.root, "bin dir"));
    await writeLauncher(launcher, f.home, projectRoot);
    await writeFile(join(f.home, "installation.json"), JSON.stringify({ home: f.home, binPath: launcher }));
    const current = `'${launcher}' --home ${f.home}`;
    await assert.rejects(legacy(), (error: Error) => error.message.includes(current));
    assert.ok((await f.runtime.instruction("alliance-codex-peer", f.cwd, f.paseo)).includes(current));
    assert.equal(member(f.runtime, agentId).decision, "open");
    // A plugin started on this home names the launcher in prompts to sessions created earlier.
    const sent: string[] = [];
    const api = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { status: "idle", archivedAt: null, pendingPermissions: [] } }),
          send: async (text: string) => {
            sent.push(text);
          },
        }),
      },
    } as unknown as PaseoApi;
    const plugin = await new AllianceRuntime(f.home).ready();
    try {
      plugin.wakeups.add({
        key: "reminder",
        roomId: f.room.id,
        ownerId: agentId,
        reason: "Review the handback",
        trigger: { kind: "time", at: Date.now() - 1000 },
        delivery: "idle",
      });
      await plugin.wakeups.tick(api);
      assert.equal(sent.length, 1);
      assert.ok(sent[0]?.includes(current));
    } finally {
      plugin.close();
    }
    // A launcher retargeted to another home is not this instance's CLI: use the release path.
    await writeLauncher(launcher, join(f.root, "other-home"), projectRoot);
    const instruction = await f.runtime.instruction("alliance-codex-peer", f.cwd, f.paseo);
    assert.ok(!instruction.includes(launcher) && instruction.includes("scripts/cli.mjs"));
  } finally {
    f.runtime.close();
  }
});

test("new agents learn how sends behave on the Paseo daemon the plugin last connected to", async () => {
  const f = await fixture();
  let report = (_daemon: DaemonInfo) => {};
  const plugin = await new AllianceRuntime(f.home, async (_home, seen) => {
    report = seen;
    seen({ version: "0.11.2", agentMessageProvenance: false });
    return { ...f.paseo, close: async () => {} } as SchedulerClient;
  }).ready();
  try {
    const old = sendingRule({ version: "0.11.2", agentMessageProvenance: false });
    const steering = sendingRule({ version: "0.12.0", agentMessageProvenance: true });
    assert.notEqual(old, steering, "0.11.2 interrupts any running receiver; 0.12 steers");
    const instruction = () => plugin.instruction("alliance-codex-lead", f.cwd, f.paseo);
    const told = async () => {
      const text = await instruction();
      return [old, steering].filter((rule) => text.includes(rule));
    };
    assert.deepEqual(await told(), [], "an unknown daemon gets no version-specific rule");
    await plugin.startWakeups();
    const status = roomList.output.parse(await plugin.list(f.paseo));
    assert.deepEqual(status.wakeupHealth.daemon, { version: "0.11.2", agentMessageProvenance: false });
    assert.deepEqual(await told(), [old]);
    report({ version: "0.12.0", agentMessageProvenance: true }); // reconnected after a daemon upgrade
    assert.deepEqual(await told(), [steering]);
  } finally {
    await plugin.close();
    f.runtime.close();
  }
});

test("a running member silent for 20 minutes wakes its idle owner once on Paseo 0.11 and 0.12, with how to interrupt it there; tracked jobs and the Human's own work only show in status", async () => {
  for (const version of ["0.11.2", "0.12.0"]) {
    const f = await fixture();
    try {
      const now = Date.now();
      seat(f, "lead", "lead", null);
      for (const id of ["peer", "waiter"]) seat(f, id, "peer", "lead");
      seat(f, "solo", "peer", null);
      const silent = (turn: string): Live => ({
        status: "running",
        updatedAt: now - 21 * 60000,
        turn: { id: turn, startedAt: now - 30 * 60000 },
      });
      const daemon = schedulerDaemon(
        f.home,
        new Map<string, Live>([
          ["lead", { status: "idle", updatedAt: now }],
          ["peer", { ...silent("p1"), command: "pnpm install" }],
          ["waiter", silent("w1")],
          ["solo", silent("s1")],
        ]),
        version,
      );
      // A long command its agent tracks as a job is an announced wait.
      await f.runtime.trackJob({
        key: "build",
        roomId: f.room.id,
        ownerId: "waiter",
        title: "Build",
        pid: process.pid,
      });
      await daemon.round();
      assert.deepEqual(
        daemon.sent.map((s) => s.id),
        ["lead"],
      );
      assert.match(
        daemon.sent[0].text,
        /peer[\s\S]*pnpm install/,
        "the owner learns which command is still running",
      );
      // A steer waits for the stuck command, so the owner is told how this daemon interrupts.
      if (version === "0.12.0") assert.match(daemon.sent[0].text, /activeTurnBehavior "interrupt"/);
      else assert.doesNotMatch(daemon.sent[0].text, /activeTurnBehavior/);
      await daemon.round();
      assert.equal(daemon.sent.length, 1, "once per incident, also after a reload");
      const status = roomList.output.parse(await f.runtime.list(daemon.api));
      const silence = (id: string) => status.members.find((m) => m.id === id)?.silence;
      assert.equal(silence("solo")?.key, null, "the Human's own work is reported, not prompted");
      assert.ok(silence("peer")?.key);
      assert.equal(silence("waiter"), undefined);
    } finally {
      f.runtime.close();
    }
  }
});

test("an approval request still pending 5 minutes after Alliance first saw it is denied with how to redo the step, never allowed; its owner is not woken", async (t) => {
  // Mac mini, 2026-10-21: Claude peer 3d285d1d (bypassPermissions) asked to run the first command at
  // 16:46:31Z (its Lead c3f72b0b allowed it 29.7 min later) and the second at 17:20:37Z, which waited
  // 8 h 40 min until the operator canceled the turn; the Lead sat idle. Here the plugin first loads
  // at 16:47:00Z, so a sweep first sees the earlier request; Paseo's hook reports the later one.
  // Every scheduler round is a fresh plugin load (Paseo 0.11.2, as on the fleet).
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-21T16:46:31Z") });
  const f = await fixture();
  const hooks = new Map<string, (event: unknown) => Promise<void>>();
  const dispose = contribute({
    registerProvider() {},
    registerUsageSource() {},
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { home: f.home } }),
      subscribe: () => () => {},
    }),
    handle() {},
    addHook: (event: string, handler: (event: unknown) => Promise<void>) => hooks.set(event, handler),
  } as unknown as PluginServerContext);
  try {
    for (const [id, role, parentId] of [
      ["c3f72b0b", "lead", null],
      ["3d285d1d", "peer", "c3f72b0b"],
    ] as const)
      f.runtime.store.saveMember({
        id,
        roomId: f.room.id,
        role,
        provider: `alliance-claude-${role}`,
        parentId,
        assignment: "brief.md",
        cwd: f.cwd,
        lastOutcome: null,
        resultPath: null,
        decision: "open",
        decisionEvidence: null,
        launchKey: null,
        launchHash: null,
      });
    const first = "cd /tmp && rm -rf stubk && mkdir stubk";
    const second = "mkdir -p /tmp/stub2 && cd /tmp/stub2 && rm -rf *";
    const asking = (id: string, command: string): Live => ({
      status: "running",
      updatedAt: Date.now(),
      turn: { id: "foreground-turn-8", startedAt: Date.now() - 60000 },
      approvals: [{ id, command }],
    });
    const agents = new Map<string, Live>([
      ["c3f72b0b", { status: "idle", updatedAt: Date.now() }],
      ["3d285d1d", asking("request-1", first)],
      // An agent that is not an Alliance member keeps its request.
      ["daily-claude", asking("request-9", second)],
    ]);
    const daemon = schedulerDaemon(f.home, agents, "0.11.2");
    const until = async (time: string) => {
      while (Date.now() + 15000 <= Date.parse(`2026-10-21T${time}Z`)) {
        t.mock.timers.setTime(Date.now() + 15000);
        await daemon.round();
      }
    };
    t.mock.timers.setTime(Date.parse("2026-10-21T16:47:00Z"));
    await daemon.round();
    await until("16:51:45");
    assert.equal(daemon.answers.length, 0, "it waits 5 minutes from the first sight");
    await until("16:52:00");
    assert.deepEqual(
      daemon.answers.map((a) => [a.id, a.requestId, a.behavior, a.at]),
      [["3d285d1d", "request-1", "deny", Date.parse("2026-10-21T16:52:00Z")]],
    );
    assert.ok(daemon.answers[0].message, "the denial says how to go on");
    agents.set("3d285d1d", { status: "idle", updatedAt: Date.now() }); // its turn went on and ended
    t.mock.timers.setTime(Date.parse("2026-10-21T17:20:37Z"));
    agents.set("3d285d1d", asking("request-2", second));
    await hooks.get("agent.permission.before")?.({
      agent: {
        id: "3d285d1d",
        provider: "alliance-claude-peer",
        cwd: f.cwd,
        workspaceId: "workspace-1",
        parentAgentId: "c3f72b0b",
        title: null,
      },
      request: {
        id: "request-2",
        provider: "claude",
        name: "Bash",
        kind: "tool",
        detail: { type: "shell", command: second },
      },
    });
    await until("17:25:37");
    assert.deepEqual(
      daemon.answers.map((a) => [a.id, a.requestId, a.behavior, a.at]),
      [
        ["3d285d1d", "request-1", "deny", Date.parse("2026-10-21T16:52:00Z")],
        ["3d285d1d", "request-2", "deny", Date.parse("2026-10-21T17:25:37Z")],
      ],
      "5 minutes after the hook reported it; nothing is ever allowed, and only members are answered",
    );
    assert.deepEqual(daemon.sent, [], "no owner is woken");
    assert.deepEqual(
      f.runtime.wakeups.list().map((w) => [w.ownerId, w.delivery, w.state]),
      [
        ["c3f72b0b", "pull", "pending"],
        ["c3f72b0b", "pull", "pending"],
      ],
      "the owner finds each denial among its pull items",
    );
    const status = roomList.output.parse(await f.runtime.list(daemon.api));
    assert.deepEqual(status.members.find((m) => m.id === "3d285d1d")?.denied, {
      requestId: "request-2",
      tool: "Bash",
      command: second,
      at: "2026-10-21T17:25:37.000Z",
    });
  } finally {
    await dispose();
    f.runtime.close();
  }
});

test("a silence notice the busy owner has not received yet is withdrawn when the member works again or its turn ends", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    seat(f, "lead", "lead", null);
    for (const id of ["peer", "sibling"]) seat(f, id, "peer", "lead");
    const agents = new Map<string, Live>([
      ["lead", { status: "running", updatedAt: now }],
      ["peer", { status: "running", updatedAt: now - 21 * 60000 }],
      ["sibling", { status: "running", updatedAt: now - 21 * 60000 }],
    ]);
    const daemon = schedulerDaemon(f.home, agents);
    const notices = () => f.runtime.wakeups.list().filter((w) => w.key.startsWith("silent-"));
    await daemon.round();
    assert.deepEqual(
      notices().map((w) => [w.ownerId, w.state]),
      [
        ["lead", "pending"],
        ["lead", "pending"],
      ],
      "the busy owner's notices wait",
    );
    agents.set("peer", { status: "running", updatedAt: Date.now() }); // it printed again
    agents.set("sibling", { status: "idle", updatedAt: Date.now() }); // its turn ended
    agents.set("lead", { status: "idle", updatedAt: Date.now() });
    await daemon.round();
    assert.deepEqual(daemon.sent, []);
    assert.deepEqual(
      notices().map((w) => w.state),
      ["canceled", "canceled"],
    );
    assert.equal(member(f.runtime, "peer").silence, undefined);
    assert.equal(member(f.runtime, "sibling").silence, undefined);
  } finally {
    f.runtime.close();
  }
});

test("resume refuses unknown, archived and permission-blocked recipients without a prompt; a closed one reopens", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "safe-resume", role: "peer", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    for (const status of ["unknown", "unavailable", "stopped", "awaiting_permission"]) {
      f.status(status);
      await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /idle|unavailable|permission/i);
    }
    f.status("closed");
    f.archived(true);
    await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /unarchived/);
    assert.equal(f.count().sends, 0);
    // Paseo loads a closed session (e.g. after a daemon restart) when it receives the prompt.
    f.archived(false);
    await assert.doesNotReject(f.runtime.resume(agentId, "Continue", f.paseo));
    assert.equal(f.count().sends, 1);
    // An AGY agent on Paseo 0.11 that started a turn meanwhile refuses the steer: nothing was sent.
    f.failSends(new Error("Provider does not support prompt.steer"));
    await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /already working/);
  } finally {
    f.runtime.close();
  }
});

test("resume prompts and recovery snapshots list the agent's pending pull reminders", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "pull-owner", role: "peer", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    f.runtime.wakeups.add({
      key: "ci-result",
      roomId: f.room.id,
      ownerId: agentId,
      reason: "Read the CI result",
      trigger: { kind: "time", at: Date.now() - 1000 },
      delivery: "pull",
    });
    await f.runtime.wakeups.tick();
    await f.runtime.resume(agentId, "Continue", f.paseo);
    assert.match(f.sent[0].text, /\[ci-result\] Read the CI result/);
    const snapshot = await readFile(await f.runtime.recoveryContext(agentId), "utf8");
    assert.match(snapshot, /\[ci-result\] Read the CI result/);
  } finally {
    f.runtime.close();
  }
});

test("an owner assigned after a session started receives its handback", async () => {
  const f = await fixture();
  try {
    const { agentId: hq } = await f.runtime.launch(
      { roomId: f.room.id, key: "hq", role: "hq", harness: "codex", prompt: "Own outcomes" },
      f.paseo,
    );
    const chat = {
      id: "lead-chat",
      provider: "alliance-codex-lead",
      cwd: f.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    };
    await f.runtime.startTurn(chat, "c1");
    await f.runtime.endTurn(chat, "c1", { kind: "completed" }, []);
    assert.equal(f.runtime.autonomy.get(chat.id), undefined, "the Human's own chat is not managed");
    const evidence = join(f.root, "assign.md");
    await writeFile(evidence, "HQ owns this lead's outcome.");
    await f.runtime.changeMemberOwner(chat.id, hq, 0, evidence, f.paseo);
    assert.equal(f.runtime.autonomy.get(chat.id)?.phase, "review", "its undecided handback goes to HQ");
    // A session that already ran and then reports a native parent waits to hand back to it.
    const worker = { ...chat, id: "native-worker" };
    await f.runtime.startTurn(worker, "w1");
    await f.runtime.bind({ ...worker, parentAgentId: hq });
    assert.equal(f.runtime.autonomy.get(worker.id)?.phase, "waiting");
    // Paseo opens a new child's session before it reports the parent: a new child is managed as usual.
    const child = { ...chat, id: "native-child" };
    await f.runtime.bind(child);
    await f.runtime.bind({ ...child, parentAgentId: hq });
    assert.equal(f.runtime.autonomy.get(child.id)?.phase, "active");
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("tracked processes survive reload, expose missing owners and refuse stale ownership edits", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "job-owner", role: "lead", harness: "codex", prompt: "Own the job" },
      f.paseo,
    );
    await f.runtime.trackJob({
      key: "long-run",
      roomId: f.room.id,
      ownerId: agentId,
      title: "External controller",
      pid: process.pid,
    });
    const first = (await f.runtime.list(f.paseo)).jobs[0];
    assert.equal(first.state, "running");
    assert.equal(first.ownerStatus, "available");
    f.status("closed");
    assert.equal((await f.runtime.list(f.paseo)).jobs[0].ownerStatus, "needs-owner");
    await assert.rejects(f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo), /unavailable/);
    f.status("idle");
    await f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo);
    await assert.rejects(f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo), /changed/);
    assert.equal(f.count().sends, 0, "Tracking never dispatches work or interrupts an owner");
    const reopened = await new AllianceRuntime(f.home).ready();
    try {
      assert.equal((await reopened.list(f.paseo)).jobs[0].revision, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.runtime.close();
  }
});

test("explicit ownership survives native rebinding and rejects stale or cyclic handoffs", async () => {
  const f = await fixture();
  try {
    const create = async (key: string) =>
      (
        await f.runtime.launch(
          { roomId: f.room.id, key, role: "lead", harness: "codex", prompt: "Own outcome" },
          f.paseo,
        )
      ).agentId;
    const lead = await create("lead"),
      hq = await create("hq");
    const evidence = join(f.root, "handoff.md");
    await writeFile(evidence, "Human assigns HQ to own Lead acceptance.");
    await f.runtime.changeMemberOwner(lead, hq, 0, evidence, f.paseo);
    await f.runtime.bind({
      id: lead,
      provider: "alliance-codex-lead",
      cwd: f.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    });
    const current = (await f.runtime.list(f.paseo)).members.find((m) => m.id === lead);
    assert(current);
    assert.equal(current.ownerId, hq);
    assert.equal(current.ownerRevision, 1);
    await assert.rejects(f.runtime.changeMemberOwner(lead, null, 0, evidence, f.paseo), /changed/);
    await assert.rejects(f.runtime.changeMemberOwner(hq, lead, 0, evidence, f.paseo), /cycle/);
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("policy acknowledgement is revision-bound and never starts or changes a native turn", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "policy", role: "lead", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    const policy = await f.runtime.readPolicy(agentId);
    assert.equal(policy.acknowledged, false);
    await assert.rejects(f.runtime.acknowledgePolicy(agentId, "0".repeat(64)), /changed/);
    await f.runtime.acknowledgePolicy(agentId, policy.digest);
    assert.equal((await f.runtime.readPolicy(agentId)).acknowledged, true);
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("session recovery restores open obligations under the current common policy without prompting owners", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "recover", role: "peer", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    const evidence = join(f.root, "handoff.md");
    await writeFile(evidence, "Human now owns the next decision.");
    await f.runtime.obligations.add(
      {
        key: "future-work",
        roomId: f.room.id,
        ownerId: agentId,
        assignment: member(f.runtime, agentId).assignment,
        authority: "Human brief",
        nextAction: "Review accepted scope",
        closeWhen: "Review recorded",
        conditions: [{ id: "permission", requires: "Human decides scope" }],
      },
      f.paseo,
    );
    const first = await f.runtime.recoveryContext(agentId);
    assert((await readFile(first, "utf8")).includes("future-work"));
    const policy = await f.runtime.readPolicy(agentId);
    assert.equal(policy.obligations.length, 1);
    assert.equal(policy.obligations[0].blockedOn.length, 1);
    f.archived(true);
    assert.equal((await f.runtime.list(f.paseo)).obligations[0].ownerStatus, "needs-owner");
    await f.runtime.obligations.action(
      { key: "future-work", ownerId: agentId, revision: 1, action: "handoff", nextOwnerId: null, evidence },
      f.paseo,
    );
    await f.runtime.recoveryContext(agentId);
    assert(!(await readFile(first, "utf8")).includes('"key": "future-work"'));
    assert.equal((await f.runtime.list(f.paseo)).obligations[0].ownerStatus, "human");
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("product acceptance needs runtime proof and retains the observed journey separately from technical PASS", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "product", role: "lead", harness: "codex", prompt: "Deliver product" },
      f.paseo,
    );
    execFileSync("git", ["init", "-q", f.cwd]);
    const proof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "technical"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "check",
      kind: "test",
    });
    const product = {
      outcome: "Operator reads a saved result",
      journey: "Open saved run, inspect result and limitations",
      reviewer: "Human",
      remaining: ["External integration untested"],
    };
    await assert.rejects(
      f.runtime.disposition(agentId, "accepted", proof.report.candidate.digest, proof.path, product, null),
      /runtime/,
    );
    const runtimeProof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "runtime"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "fixture journey",
      kind: "runtime",
    });
    await f.runtime.disposition(
      agentId,
      "accepted",
      runtimeProof.report.candidate.digest,
      runtimeProof.path,
      product,
      null,
    );
    const decisionEvidence = member(f.runtime, agentId).decisionEvidence;
    assert(decisionEvidence);
    const record = JSON.parse(await readFile(decisionEvidence, "utf8"));
    assert.deepEqual(record.product, product);
    assert.equal(
      (await f.runtime.list(f.paseo)).members.find((m) => m.id === agentId)?.lastAcceptance?.product?.outcome,
      product.outcome,
    );
  } finally {
    await f.runtime.close();
  }
});

test("launched work keeps an active autonomous assignment after a completed turn", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "long-task",
        role: "peer",
        harness: "codex",
        model: "gpt-6.1-sol",
        prompt: "Deliver three verified stages",
      },
      f.paseo,
    );
    const agent = {
      id: agentId,
      provider: "alliance-codex-peer",
      cwd: f.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: "Worker",
    };
    await f.runtime.startTurn(agent, "first");
    await f.runtime.endTurn(agent, "first", { kind: "completed" }, []);
    const snapshot = await f.runtime.list(f.paseo);
    const assignment = snapshot.autonomy?.find((r) => r.agentId === agentId);
    assert.equal(assignment?.phase, "active", "completed turn retains enabled continuation policy");
    assert.equal(assignment?.outcome, "completed");
    assert.equal(member(f.runtime, agentId).decision, "open");
  } finally {
    await f.runtime.close();
  }
});

test("a decision covers the turn it reviewed: running work and turns started during validation are refused", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "turn-bound", role: "peer", harness: "codex", prompt: "Deliver" },
      f.paseo,
    );
    execFileSync("git", ["init", "-q", f.cwd]);
    const proof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "turn-bound"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "check",
      kind: "test",
    });
    const decide = (actor: string | null, paseo = f.paseo) =>
      f.runtime.disposition(
        agentId,
        "accepted",
        proof.report.candidate.digest,
        proof.path,
        undefined,
        actor,
        paseo,
      );
    await assert.rejects(decide(agentId), /own work/);
    f.status("running");
    await assert.rejects(decide(null), /mid-turn/);
    f.status("idle");
    let reads = 0;
    const racing = {
      ...f.paseo,
      agents: {
        ref: () => ({
          refresh: async () => {
            // The second readback happens after evidence validation: a turn starts in between.
            if (++reads === 2)
              await f.runtime.startTurn(
                { id: agentId, provider: "alliance-codex-peer", cwd: f.cwd, parentAgentId: null } as never,
                "turn-2",
              );
            return { agent: { status: "idle", archivedAt: null, pendingPermissions: [] } };
          },
        }),
      },
    } as unknown as PaseoApi;
    await assert.rejects(decide(null, racing), /new turn/);
    assert.equal(f.runtime.store.member(agentId)?.decision, "open");
    await decide(null);
    assert.equal(f.runtime.store.member(agentId)?.decisionTurnId, "turn-2");
  } finally {
    f.runtime.close();
  }
});

test("a coordinator waiting on its worker's turn is not continued meanwhile and is woken when that turn ends", async () => {
  const root = await temporary("alliance-wait-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  // The plugin as the daemon runs it: RPC input validated before each handler, hooks by event.
  type Handler = (input: unknown, context?: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();
  const hooks = new Map<string, Handler>();
  const dispose = contribute({
    registerProvider() {},
    registerUsageSource() {},
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { home } }),
      subscribe: () => () => {},
    }),
    handle: (rpc: { name: string; input: { parse(value: unknown): unknown } }, handler: Handler) =>
      handlers.set(rpc.name, (input, context) => handler(rpc.input.parse(input), context)),
    addHook: (event: string, handler: Handler) => hooks.set(event, handler),
  } as unknown as PluginServerContext);
  const paseo = {
    workspaces: {
      open: async () => ({
        id: "wait-workspace",
        refresh: async () => ({ title: null }),
        setTitle: async () => ({}),
      }),
    },
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle", archivedAt: null, pendingPermissions: [] } }),
        timeline: { refetch: async () => ({ epoch: "fixture", entries: [], hasOlder: false }) },
      }),
    },
  };
  const rpc = (method: string, input: unknown) => handlers.get(method)?.(input, { paseo }) as Promise<never>;
  const agent = (id: string, role: string, parentAgentId: string | null) => ({
    agent: { id, provider: `alliance-codex-${role}`, cwd, parentAgentId, workspaceId: "wait-workspace" },
  });
  const turn = (event: string, id: string, role: string, parent: string, turnId: string) =>
    hooks.get(event)?.(
      { ...agent(id, role, parent), turnId, outcome: { kind: "completed" }, timeline: [] },
      { paseo },
    );
  try {
    const room: { id: string } = await rpc("rooms.create", { cwd });
    await hooks.get("agent.create.after")?.(agent("hq", "hq", null));
    await hooks.get("agent.create.after")?.(agent("lead", "lead", "hq"));
    await hooks.get("agent.create.after")?.(agent("peer", "peer", "lead"));
    await turn("agent.turn.before", "lead", "lead", "hq", "lead-1");
    await turn("agent.turn.before", "peer", "peer", "lead", "peer-1");
    const request = {
      roomId: room.id,
      ownerId: "lead",
      self: "lead",
      reason: "Review the result",
      agent: "peer",
    };
    // Loaded here: 0.1.19 adds it, and the rest of this file still runs against older releases.
    const { registerWait } = await import("../scripts/wait.mjs");
    const key = await registerWait(rpc, request);
    assert.equal(await registerWait(rpc, request), key, "repeating the command registers nothing new");
    const phase = async () =>
      ((await rpc("autonomy.list", {})) as AutonomyState[]).find((r) => r.agentId === "lead")?.phase;
    const reminder = async () =>
      ((await rpc("wakeups.list", {})) as WakeRecordValue[]).find((w) => w.key === key);
    // Ending its turn now is neither a handback to the HQ nor a reason to continue it.
    await turn("agent.turn.after", "lead", "lead", "hq", "lead-1");
    assert.equal(await phase(), "waiting");
    assert.equal((await reminder())?.state, "scheduled");
    await turn("agent.turn.after", "peer", "peer", "lead", "peer-1");
    const due = await reminder();
    assert.deepEqual(due && [due.ownerId, due.delivery, due.state], ["lead", "idle", "pending"]);
  } finally {
    await dispose();
  }
});

test("a coordinator waiting on its worker's turn acks the reminder when that turn handed nothing back, not when it handed back", async (t) => {
  // Mac mini, 2026-10-22: Lead c3f72b0b's 03:05:00 message started peer b3a45374's foreground-turn-7 (U2).
  // The peer checkpointed waiting at 03:40:49 while its own rig ran and ended the turn at 03:41:02; its
  // Monitor started autonomous-turn-8 at 03:41:19. The Lead's 04:27:23 rework started foreground-turn-11,
  // which handed back at 04:30:43. 0.1.18 had no `wait`; 0.1.19's contract has the Lead run `wait --agent`
  // after such a message. Nothing is kept, as on ryzen (a keep would release the ack anyway).
  const [hq, lead, peer] = ["d34294ec", "c3f72b0b", "b3a45374"];
  const h = await claudeHost(t, "2026-10-22", "03:05:00.233", [
    [hq, "hq", null],
    [lead, "lead", hq],
    [peer, "peer", lead],
  ]);
  try {
    for (const id of [lead, peer]) h.runtime.autonomy.start(id);
    const { registerWait } = await import("../scripts/wait.mjs");
    // biome-ignore lint/suspicious/noExplicitAny: RPC inputs are validated by the plugin
    const rpc = async (method: string, input: any) => {
      if (method === "wakeups.add") return h.runtime.wakeups.add(input);
      if (method === "autonomy.list") return h.runtime.autonomy.list();
      if (method === "autonomy.checkpoint")
        return h.runtime.autonomy.checkpoint(input.agentId, input.phase, input.reason, input.turnId);
      if (method === "rooms.list") return { members: h.runtime.store.members() };
      throw new Error(`Unexpected RPC ${method}`);
    };
    const request = { roomId: h.room.id, ownerId: lead, self: lead, reason: "Review U2", agent: peer };
    const ack = (key: string) => {
      const w = h.runtime.wakeups.list().find((w) => w.key === key);
      return h.runtime.wakeups.action(key, lead, Number(w?.revision), "ack");
    };
    await h.begin(peer, "foreground-turn-7", "03:05:00.233");
    const waiting = await registerWait(rpc, request, () => {});
    await h.rounds("03:40:49.261", true);
    h.runtime.autonomy.checkpoint(
      peer,
      "waiting",
      "U2: đang chạy rig offline để xác nhận các bản sửa của U2; sau đó docs, handback",
    );
    await h.end(peer, "foreground-turn-7", "03:41:02.017", []);
    await h.rounds("03:41:19.667", true);
    // The next round pushed the reminder to the Lead, which acks it while the peer's Monitor turn runs.
    await h.begin(peer, "autonomous-turn-8", "03:41:19.667");
    assert.equal(ack(waiting).state, "acknowledged", "a turn that handed nothing back needs no decision");
    h.at("03:58:53.270");
    h.runtime.autonomy.checkpoint(
      peer,
      "review",
      "U2 handback offline xong: results/pilot/u2.md, commit local; rig đạt, chờ Lead chạy bộ test runtime",
    );
    await h.end(peer, "autonomous-turn-8", "03:59:08.593", []);
    await h.rounds("04:27:23.548", true);
    await h.begin(peer, "foreground-turn-11", "04:27:23.548");
    const handback = await registerWait(rpc, request, () => {});
    await h.rounds("04:30:43.282", true);
    h.runtime.autonomy.checkpoint(
      peer,
      "review",
      "Case 12 đã sửa, commit local; chờ Lead chạy lại case 12 trên box",
    );
    await h.end(peer, "foreground-turn-11", "04:30:54.994", []);
    await h.rounds("04:31:10", true);
    assert.throws(
      () => ack(handback),
      /Decide on b3a45374 turn foreground-turn-11/,
      "a handback needs a decision",
    );
    // Not in that sequence: the Lead's next message starts foreground-turn-12, and a blocker the peer
    // records in it needs a decision too (HQ acked Lead c3f72b0b's real one, 2026-10-21 15:55:34Z).
    await h.rounds("04:32:00", true);
    await h.begin(peer, "foreground-turn-12", "04:32:00");
    const blocker = await registerWait(rpc, request, () => {});
    h.runtime.autonomy.checkpoint(peer, "blocked", "U2: cần Lead quyết trước khi chạy tiếp");
    await h.end(peer, "foreground-turn-12", "04:32:30", []);
    await h.rounds("04:33:00", true);
    assert.throws(
      () => ack(blocker),
      /Decide on b3a45374 turn foreground-turn-12/,
      "a blocker needs a decision",
    );
  } finally {
    await h.runtime.close();
  }
});

test("the 48h reminder about an older handback that a handback-only record waits on needs a decision, not an ack", async (t) => {
  // ryzen's first 0.1.19 load, replayed at 2026-10-24T20:00Z: Lead 2f2afb70, owned by Supervisor 07c84a80,
  // last completed codex-turn-34 undecided, before turn ends were recorded (0.1.18 started its clock at
  // 2026-10-21T13:15:42.644Z). ensure() gives it a record that waits, with no checkpoint of its own.
  const [supervisor, lead] = ["07c84a80", "2f2afb70"];
  const h = await claudeHost(t, "2026-10-24", "20:00:00", [
    [supervisor, "supervisor", null],
    [lead, "lead", supervisor],
  ]);
  try {
    h.runtime.store.updateMember(lead, {
      lastTurnId: "codex-turn-34",
      lastOutcome: "completed",
      resultPath: "codex-turn-34.json",
      staleSince: Date.parse("2026-10-21T13:15:42.644Z"),
    });
    await h.rounds("20:00:15", true);
    const r = h.runtime.autonomy.get(lead);
    assert.deepEqual(
      [r?.phase, r?.turnId, r?.checkpointTurnId === r?.turnId],
      ["waiting", "codex-turn-34", false],
    );
    await h.runtime.lifecycle.sweep(h.api);
    await h.rounds("20:00:30", true);
    const [reminder] = h.runtime.wakeups.list().filter((w) => w.ownerId === supervisor);
    assert.throws(
      () => h.runtime.wakeups.action(reminder.key, supervisor, reminder.revision, "ack"),
      /Decide on 2f2afb70 turn codex-turn-34/,
      "an older handback needs a decision",
    );
  } finally {
    await h.runtime.close();
  }
});

test("ryzen's 2026-10-21 Claude session limit: nothing is sent before its reset, then one retry per member whose own turn it cut", async (t) => {
  // The real limit turns of ryzen's 96 (turn ids, outcomes, end times and text from the plugin's own
  // turn records), without the continuations and review pushes 0.1.18 caused. Reconstructed, as the
  // store keeps no history: one room; turn starts where only ends were recorded; a086bd67 handed back
  // at 13:53:37 and 6b1b2874, waiting on it, was reviewing that handback when the limit hit.
  const notice = "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)";
  const h = await claudeHost(t, "2026-10-21", "13:45:00", [
    ["09965fb3", "hq", null],
    ["0797f638", "lead", null],
    ["7f6471fb", "lead", null],
    ["ccd9ee38", "lead", "09965fb3"],
    ["5e3d3284", "lead", "0797f638"],
    ["6b1b2874", "lead", "7f6471fb"],
    ["5ea0e42d", "peer", "ccd9ee38"],
    ["3122c64c", "peer", "ccd9ee38"],
    ["101b90b1", "peer", "5e3d3284"],
    ["a086bd67", "peer", "6b1b2874"],
  ]);
  try {
    // Each owner created its assignments; ccd9ee38 had none, so the plugin gives it a handback-only one.
    for (const id of ["5e3d3284", "6b1b2874", "5ea0e42d", "3122c64c", "101b90b1", "a086bd67"])
      h.runtime.autonomy.start(id);
    const prompted = (id: string, turnId: string, messageId = `${id}-${turnId}`): AgentTimelineItem[] => [
      { type: "user_message", text: `Prompt of ${turnId}`, clientMessageId: messageId },
      { type: "assistant_message", text: notice },
    ];
    const selfStarted: AgentTimelineItem[] = [
      { type: "user_message", text: "Earlier prompt", clientMessageId: "earlier" },
      { type: "assistant_message", text: "Earlier reply" },
      { type: "assistant_message", text: notice },
    ];
    await h.begin("6b1b2874", "foreground-turn-7", "13:45:00");
    h.runtime.autonomy.checkpoint("6b1b2874", "waiting", "Waiting for peer a086bd67", "foreground-turn-7");
    await h.end("6b1b2874", "foreground-turn-7", "13:45:10", []);
    await h.begin("5e3d3284", "foreground-turn-9", "13:47:00");
    await h.begin("5ea0e42d", "foreground-turn-1", "13:50:00");
    await h.begin("3122c64c", "foreground-turn-1", "13:52:00");
    await h.rounds("13:53:30", true);
    await h.begin("a086bd67", "autonomous-turn-54", "13:53:30");
    h.runtime.autonomy.checkpoint("a086bd67", "review", "Peer R's work is done", "autonomous-turn-54");
    await h.end("a086bd67", "autonomous-turn-54", "13:53:37", []);
    await h.rounds("13:55:00", true);
    await h.begin("101b90b1", "foreground-turn-3", "13:55:00");
    await h.rounds("13:56:00", true);
    const batch = h.sent.find((s) => s.id === "6b1b2874");
    assert.ok(batch, "the handback was pushed to its owner");
    await h.begin("6b1b2874", "foreground-turn-8", "13:56:00");
    await h.rounds("14:03:16", true);
    await h.end("5ea0e42d", "foreground-turn-1", "14:03:16", prompted("5ea0e42d", "foreground-turn-1"));
    await h.rounds("14:03:29", true);
    await h.end("3122c64c", "foreground-turn-1", "14:03:29", prompted("3122c64c", "foreground-turn-1"));
    await h.rounds("14:06:13", true);
    await h.end("6b1b2874", "foreground-turn-8", "14:06:13", prompted("6b1b2874", "", batch.messageId));
    await h.rounds("14:06:40", true);
    await h.end("101b90b1", "foreground-turn-3", "14:06:40", prompted("101b90b1", "foreground-turn-3"));
    await h.end("5e3d3284", "foreground-turn-9", "14:06:41", prompted("5e3d3284", "foreground-turn-9"));
    for (const [id, turnId, start, end] of [
      ["a086bd67", "autonomous-turn-55", "14:08:30", "14:08:33"],
      ["a086bd67", "autonomous-turn-60", "14:10:38", "14:10:41"],
      ["ccd9ee38", "autonomous-turn-11", "14:20:23", "14:20:26"],
      ["09965fb3", "autonomous-turn-7", "14:25:58", "14:26:01"],
    ]) {
      await h.rounds(start, true);
      await h.begin(id, turnId, start);
      await h.end(
        id,
        turnId,
        end,
        selfStarted,
        { kind: "completed" },
        selfStarted.map((item, index) => ({
          item,
          // The hook repeats session history; canonical metadata keeps that earlier prompt
          // outside this autonomous generation. Only the provider notice belongs to this turn.
          turnId: index === 2 ? turnId : "earlier-turn",
          timestamp: `2026-10-21T${index === 2 ? end : "13:00:00"}Z`,
        })),
      );
    }
    const reset = Date.parse("2026-10-21T14:41:00Z"); // 9:40pm in Asia/Ho_Chi_Minh, plus a minute
    await h.rounds("14:45:00", true);
    const own = h.sent.filter((s) => /^Alliance (?:continue|retry)/.test(s.text));
    assert.deepEqual(
      own.filter((s) => s.at < reset),
      [],
      "nothing is sent before the reset",
    );
    assert.deepEqual(
      own.map((s) => [s.id, s.text.split(" [", 1)[0]]).sort(),
      [
        ["101b90b1", "Alliance retry after failed turn"],
        ["3122c64c", "Alliance retry after failed turn"],
        ["5e3d3284", "Alliance retry after failed turn"],
        ["5ea0e42d", "Alliance retry after failed turn"],
        ["ccd9ee38", "Alliance retry after failed turn"],
      ],
      "one retry for each member whose own turn the limit cut",
    );
    for (const id of ["5ea0e42d", "3122c64c", "101b90b1", "5e3d3284"])
      assert.deepEqual(
        [h.runtime.autonomy.get(id)?.retries, h.runtime.autonomy.get(id)?.continuations],
        [0, 0],
        `${id} used no budget`,
      );
    const during = Date.parse("2026-10-21T14:26:01Z");
    assert.equal(h.runtime.store.heldUntil("7f6471fb", during), reset, "every Claude member waited");
    // A handback stands; the review batch the limit cut short is Wakeups' to send again.
    assert.equal(h.runtime.autonomy.get("a086bd67")?.phase, "review");
    assert.equal(h.runtime.autonomy.get("6b1b2874")?.phase, "waiting");
    assert.deepEqual(h.runtime.store.member("6b1b2874")?.limited, {
      until: reset,
      messageId: batch.messageId,
    });
    assert.deepEqual(
      h.sent.filter((s) => s.at >= Date.parse("2026-10-21T14:03:16Z") && s.at < reset),
      [],
      "no prompt of any kind, owners' notices included, reaches a Claude member while the limit holds",
    );
    // a086bd67's own Monitor turns after its handback leave that review standing.
    const again = h.sent.filter((s) => s.id === "6b1b2874" && s.at >= reset);
    assert.equal(again.length, 1, "after the reset its owner is asked about a086bd67's handback, once");
    assert.deepEqual(
      h.runtime.wakeups
        .list()
        .filter((w) => w.messageId === again[0].messageId)
        .map((w) => w.trigger.kind === "turn" && w.trigger.agentId),
      ["a086bd67"],
    );
    // 15:42-15:43:42: the Lead's resume prompt started foreground-turn-22, and its next message
    // canceled it before Claude replied. The timeline Paseo passed still ended on the old notice.
    await h.begin("5ea0e42d", "foreground-turn-22", "15:42:00");
    await h.end(
      "5ea0e42d",
      "foreground-turn-22",
      "15:43:42",
      [
        ...prompted("5ea0e42d", "foreground-turn-21"),
        {
          type: "user_message",
          text: "Lead ccd9ee38: you stopped on the account session limit…",
          clientMessageId: "resume",
        },
      ],
      { kind: "canceled", reason: "interrupted" },
    );
    assert.equal(h.runtime.autonomy.get("5ea0e42d")?.pausedBy, "cancel", "a cancellation, not another limit");
    assert.equal(h.runtime.store.member("5ea0e42d")?.limited, undefined);
  } finally {
    await h.runtime.close();
  }
});

test("a review batch whose turn ended on ryzen's session limit is sent to its owner again once the limit lifts", async (t) => {
  // ryzen, 2026-10-21: the plugin pushed a086bd67's handback (13:53:37Z) to its waiting Lead 6b1b2874,
  // whose turn reading it (foreground-turn-8, 13:56Z) ended at 14:06:13Z on Claude's session-limit
  // notice; Paseo reported it completed. 0.1.18 left such reviews "delivered" for 14 h (6b1b2874's and
  // 5e3d3284's at 14:17-14:18Z, with the peers at rest). The peer's later Monitor turns are left out
  // here; the replay above covers them.
  const notice = "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)";
  const h = await claudeHost(t, "2026-10-21", "13:45:00", [
    ["7f6471fb", "lead", null],
    ["6b1b2874", "lead", "7f6471fb"],
    ["a086bd67", "peer", "6b1b2874"],
  ]);
  try {
    for (const id of ["6b1b2874", "a086bd67"]) h.runtime.autonomy.start(id);
    await h.begin("6b1b2874", "foreground-turn-7", "13:45:00");
    h.runtime.autonomy.checkpoint("6b1b2874", "waiting", "Waiting for peer a086bd67", "foreground-turn-7");
    await h.end("6b1b2874", "foreground-turn-7", "13:45:10", []);
    await h.begin("a086bd67", "autonomous-turn-54", "13:53:30");
    h.runtime.autonomy.checkpoint("a086bd67", "review", "Peer R's work is done", "autonomous-turn-54");
    await h.end("a086bd67", "autonomous-turn-54", "13:53:37", []);
    await h.rounds("13:56:00", true);
    const [batch] = h.sent;
    assert.equal(batch?.id, "6b1b2874", "the handback was pushed to its owner");
    const review = h.runtime.wakeups.list().find((w) => w.messageId === batch.messageId);
    await h.begin("6b1b2874", "foreground-turn-8", "13:56:00");
    await h.rounds("14:06:13", true);
    await h.end("6b1b2874", "foreground-turn-8", "14:06:13", [
      { type: "user_message", text: batch.text, clientMessageId: batch.messageId },
      { type: "assistant_message", text: notice },
    ]);
    await h.rounds("14:45:00", true);
    const reset = Date.parse("2026-10-21T14:41:00Z");
    assert.deepEqual(
      h.sent.slice(1).map((s) => [s.id, s.at >= reset]),
      [["6b1b2874", true]],
      "nothing before the reset, then that batch again",
    );
    assert.ok(review && h.sent[1].text.includes(`[${review.key}]`));
    assert.equal(h.runtime.wakeups.list().find((w) => w.key === review.key)?.messageId, h.sent[1].messageId);
    assert.equal(h.runtime.autonomy.get("6b1b2874")?.phase, "waiting");
  } finally {
    await h.runtime.close();
  }
});

test("a Claude API error that Paseo reports as a completed turn is retried within the retry budget, not continued", async (t) => {
  // fix2 acceptance, Paseo 0.12.0 and a real Claude Sonnet peer with an invalid OAuth token: every
  // turn completed on this message with zero usage, and the plugin continued the peer until its
  // continuation budget ran out.
  const h = await claudeHost(t, "2026-10-22", "05:10:29", [
    ["3f96ef8a", "lead", null],
    ["5e2719a2", "peer", "3f96ef8a"],
  ]);
  try {
    h.runtime.autonomy.start("5e2719a2");
    await h.begin("5e2719a2", "foreground-turn-1", "05:10:29");
    await h.end("5e2719a2", "foreground-turn-1", "05:10:33", [
      {
        type: "user_message",
        text: "Write hello.txt containing hello, then end your turn.",
        clientMessageId: "m1",
      },
      {
        type: "assistant_message",
        text: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
      },
    ]);
    await h.rounds("05:11:30");
    assert.deepEqual(
      h.sent.map((s) => s.text.split(" [", 1)[0]),
      ["Alliance retry after failed turn"],
    );
    assert.equal(h.runtime.autonomy.get("5e2719a2")?.continuations, 0);
    assert.equal(h.runtime.store.member("5e2719a2")?.limited, undefined, "no reset, so nothing is held");
  } finally {
    await h.runtime.close();
  }
});

test("a Claude limit notice recorded inside its printed reset minute holds until a minute later, not the next day", async (t) => {
  // ryzen, 2026-10-21: "resets 9:40pm (Asia/Ho_Chi_Minh)" is 14:40Z, and Claude Code prints that minute
  // without its seconds until the reset second inside it. a086bd67's Monitor turns kept ending on the
  // notice through the limit (14:08:33, 14:10:41); its next one here ends on it at 14:40:20, inside
  // that minute (the fleet shows no turn in it). The owners' own owners are left out.
  const notice = "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)";
  const h = await claudeHost(t, "2026-10-21", "13:50:46.933", [
    ["ccd9ee38", "lead", null],
    ["6b1b2874", "lead", null],
    ["5ea0e42d", "peer", "ccd9ee38"],
    ["a086bd67", "peer", "6b1b2874"],
  ]);
  try {
    for (const id of ["5ea0e42d", "a086bd67"]) h.runtime.autonomy.start(id);
    await h.begin("5ea0e42d", "foreground-turn-1", "13:50:46.933");
    await h.begin("a086bd67", "autonomous-turn-54", "13:53:30");
    h.at("13:53:31.590");
    h.runtime.autonomy.checkpoint(
      "a086bd67",
      "review",
      "Peer R handback ready: handback-R.md; Part 1 and Part 2 checks pass; npm check and build exit 0; dev servers stopped.",
    );
    await h.end("a086bd67", "autonomous-turn-54", "13:53:37.869", []);
    await h.rounds("14:03:16.870", true);
    await h.end("5ea0e42d", "foreground-turn-1", "14:03:16.870", [
      { type: "user_message", text: "Prompt of foreground-turn-1", clientMessageId: "5ea0e42d-create" },
      { type: "assistant_message", text: notice },
    ]);
    for (const [turnId, start, end] of [
      ["autonomous-turn-55", "14:08:32.485", "14:08:33.637"],
      ["autonomous-turn-60", "14:10:40.512", "14:10:41.270"],
      ["autonomous-turn-61", "14:40:19", "14:40:20"],
    ]) {
      await h.rounds(start, true);
      await h.begin("a086bd67", turnId, start);
      await h.end("a086bd67", turnId, end, [{ type: "assistant_message", text: notice }]);
    }
    assert.equal(h.runtime.store.member("a086bd67")?.limited?.until, Date.parse("2026-10-21T14:41:20Z"));
    await h.rounds("14:45:00", true);
    const retry = h.sent.find((s) => s.id === "5ea0e42d" && s.text.startsWith("Alliance retry"));
    assert.ok(
      retry &&
        retry.at >= Date.parse("2026-10-21T14:41:20Z") &&
        retry.at < Date.parse("2026-10-21T14:42:00Z"),
      "the member whose turn the limit cut is retried right after the reset, not a day later",
    );
  } finally {
    await h.runtime.close();
  }
});

test("a limit in a turn Claude Code starts by itself does not send again the batch an earlier turn read", async (t) => {
  // ryzen, 2026-10-21: lane A peer 71983338 handed back in foreground-turn-2 (review checkpoint 13:48:28),
  // and Lead ccd9ee38 read the review the plugin pushed (its foreground-turn-8, ended 13:53:15) without
  // deciding. Its background suite then finished: Claude Code started autonomous-turn-11 at 14:20:26.074,
  // which ended at 14:20:26.771 on the session limit. Paseo records that task notification as a tool
  // call, so the last user message in the turn's timeline is still the batch.
  const notice = "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)";
  const h = await claudeHost(t, "2026-10-21", "11:36:54.166", [
    ["09965fb3", "hq", null],
    ["ccd9ee38", "lead", "09965fb3"],
    ["71983338", "peer", "ccd9ee38"],
  ]);
  try {
    h.runtime.autonomy.start("71983338");
    await h.begin("71983338", "foreground-turn-2", "11:36:54.166");
    // Its handback prompt starts the Lead's foreground-turn-7; then it records its review.
    await h.begin("ccd9ee38", "foreground-turn-7", "13:48:27.851");
    h.at("13:48:28.195");
    h.runtime.autonomy.checkpoint(
      "71983338",
      "review",
      "a-r1 lane A done: RESULT-a-r1.md written in lead/lane-a",
    );
    await h.end("71983338", "foreground-turn-2", "13:48:35.595", [
      {
        type: "assistant_message",
        text: "Lane A is finished. I wrote `RESULT-a-r1.md`, sent the single handback to Lead ccd9ee38, and recorded the `review` checkpoint. I'm stopping here.",
      },
    ]);
    await h.rounds("13:52:50.325", true);
    await h.end("ccd9ee38", "foreground-turn-7", "13:52:50.325", [
      {
        type: "user_message",
        text: "a-r1 (lane A) handback. Result: RESULT-a-r1.md",
        clientMessageId: "ja",
      },
      { type: "assistant_message", text: "The full suite is running. Wave 1 work is integrated." },
    ]);
    await h.rounds("13:53:06", true);
    const batch = h.sent.find((s) => s.id === "ccd9ee38");
    assert.ok(batch, "the review is pushed to the Lead");
    const read: AgentTimelineItem[] = [
      { type: "user_message", text: batch.text, clientMessageId: batch.messageId },
      {
        type: "assistant_message",
        text: "I've acknowledged the lane A review reminder. It needed nothing new: I had already accepted lane A for analysis and used its results to frame lanes B and C.",
      },
    ];
    await h.begin("ccd9ee38", "foreground-turn-8", "13:53:06");
    await h.end("ccd9ee38", "foreground-turn-8", "13:53:15.651", read);
    await h.rounds("14:20:26.074", true);
    await h.begin("ccd9ee38", "autonomous-turn-11", "14:20:26.074");
    await h.end("ccd9ee38", "autonomous-turn-11", "14:20:26.771", [
      ...read,
      {
        type: "tool_call",
        callId: "task_notification_bsy703r6n",
        name: "task_notification",
        detail: { type: "plain_text", label: "Background task completed", icon: "wrench" },
        metadata: { synthetic: true, source: "claude_task_notification", taskId: "bsy703r6n" },
        status: "completed",
        error: null,
      },
      { type: "assistant_message", text: notice },
    ]);
    await h.rounds("14:45:00", true);
    assert.deepEqual(
      h.sent
        .filter((s) => s.id === "ccd9ee38" && s.at > Date.parse("2026-10-21T14:20:26Z"))
        .map((s) => s.text.split(/ \[|:\n/, 1)[0]),
      ["Alliance retry after failed turn"],
      "after the reset the Lead gets its own retry, not the batch it already read",
    );
  } finally {
    await h.runtime.close();
  }
});

test("Claude's 'Not logged in' notice in a turn Paseo reports completed is a failed turn", async (t) => {
  // i5: HQ 02f6afb7's first turn (2026-10-21 09:54:38-09:54:43) and peer 793826f7's (10-20) completed on
  // exactly this text from a role home without a Claude login; so did 3 turns in the Mac mini role
  // transcripts on 10-20. Status showed each as a finished turn awaiting acceptance.
  const h = await claudeHost(t, "2026-10-21", "09:54:38.488", [["02f6afb7", "hq", null]]);
  try {
    await h.begin("02f6afb7", "foreground-turn-1", "09:54:38.488");
    await h.end("02f6afb7", "foreground-turn-1", "09:54:43.013", [
      {
        type: "user_message",
        text: "Điều phối giúp một lane research thật kỹ.",
        clientMessageId: "m1",
      },
      { type: "assistant_message", text: "Not logged in · Please run /login" },
    ]);
    assert.equal(h.runtime.store.member("02f6afb7")?.lastOutcome, "failed");
  } finally {
    await h.runtime.close();
  }
});

/**
 * Mac mini, 2026-10-22: Lead c3f72b0b, owned by HQ d34294ec, on the plugin's own hooks. Claude Code
 * starts autonomous-turn-N by itself on a task notification or a Monitor event; Paseo gives such a turn
 * no prompt of its own. `turn` runs one real turn with (an excerpt of) its final message, and `inside`
 * acts at a time within it.
 */
async function macMiniLead(t: TestContext, start: string) {
  const [hq, lead] = ["d34294ec", "c3f72b0b"];
  const h = await claudeHost(t, "2026-10-22", start, [
    [hq, "hq", null],
    [lead, "lead", hq],
  ]);
  h.runtime.autonomy.start(lead);
  execFileSync("git", ["init", "-q", h.cwd]);
  const turn = async (
    turnId: string,
    from: string,
    to: string,
    final: string,
    inside?: [string, () => unknown],
  ) => {
    await h.rounds(from, true);
    await h.begin(lead, turnId, from);
    if (inside) {
      await h.rounds(inside[0], true);
      await inside[1]();
    }
    await h.rounds(to, true);
    await h.end(lead, turnId, to, [{ type: "assistant_message", text: final }]);
    return h.runtime.store.member(lead)?.resultPath;
  };
  const checkpoint = (at: string, phase: "review" | "waiting", reason: string): [string, () => unknown] => [
    at,
    () => h.runtime.autonomy.checkpoint(lead, phase, `pilot: ${reason}`),
  ];
  /** HQ accepts the Lead's handback as its `accept` does, with a report verify wrote. */
  const accept = async (scenario: string) => {
    const proof = await runVerification({
      cwd: h.cwd,
      output: join(h.root, scenario),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario,
      kind: "test",
    });
    const report = proof.report.candidate.digest;
    return h.runtime.disposition(lead, "accepted", report, proof.path, undefined, hq, h.api);
  };
  /** HQ's batches: the first word of each handback it asks about, and the text. */
  const asks = () =>
    h.sent
      .filter((s) => s.id === hq)
      .map((s) => ({ about: /Review c3f72b0b: pilot: (\S+)/.exec(s.text)?.[1], text: s.text }));
  return { ...h, lead, turn, checkpoint, accept, asks };
}

test("a handback stands through turns Claude Code starts by itself: one ask each, its decision carries, a checkpoint there is a new handback", async (t) => {
  // Mac mini, 2026-10-22 02:05-03:10Z: the Lead checkpointed four handbacks inside turns Claude Code
  // started by itself, with only such turns in between (its real turn ids, times, reasons and finals).
  // 0.1.18 continued it after three of them (turns 29, 34 and 37, left out: nothing continues a record in
  // review). Reconstructed: it was waiting from its checkpoint at 00:39:14, recorded here in the turn HQ's
  // 02:05:53 message started. HQ decides about a minute after an ask, as it did that morning (40-100 s).
  const SANDBOX =
    "SANDBOX run2 đã chạy xong, kết quả và evidence ghi trong handback — HQ quyết accept U4; Lead tiếp tục L2 run4 đang chạy";
  const L2 =
    "L2 run4 đã chạy xong, kết quả và evidence ghi trong handback + SANDBOX run2 — HQ quyết; Lead đang chạy L3a";
  const L3A =
    "L3a đã chạy xong, kết quả và evidence ghi trong handback — HQ quyết U1; cùng SANDBOX run2 + L2 run4 đang chờ. Lead đang chạy registry U7c+legacy";
  const REGISTRY =
    "registry U7c + legacy đã chạy xong, kết quả và evidence ghi trong handback — HQ quyết U7/U7c. Lead đã giao U2 + U3 offline, chờ handback ~13:30";
  const h = await macMiniLead(t, "02:05:53.865");
  const { turn, checkpoint } = h;
  try {
    await turn(
      "foreground-turn-25",
      "02:05:53.865",
      "02:12:13.312",
      "Tôi đang chờ SANDBOX run2 chạy xong.",
      checkpoint("02:06:00", "waiting", "chờ Peer offline (U7c, U7b tích hợp) + máy test bật lại"),
    );
    await turn("autonomous-turn-26", "02:13:33.551", "02:14:51.838", "Đang chờ lượt chạy lại SANDBOX run2.");
    const files = [
      await turn(
        "autonomous-turn-27",
        "02:18:08.625",
        "02:19:57.585",
        "Đang theo dõi L2 run4 qua Monitor.",
        checkpoint("02:19:35.774", "review", SANDBOX),
      ),
    ];
    await turn(
      "autonomous-turn-28",
      "02:19:57.600",
      "02:20:00.114",
      "Bước build image của L2 run4 vẫn đang chạy.",
    );
    await turn("autonomous-turn-30", "02:21:59.257", "02:22:02.040", "L2 run4 đã build xong image.");
    await turn("autonomous-turn-31", "02:23:01.424", "02:23:14.677", "Bước dựng L2 chạy xong (exit 0).");
    files.push(
      await turn(
        "autonomous-turn-32",
        "02:33:41",
        "02:34:56.633",
        "Cấu hình đã sẵn sàng trên box.",
        checkpoint("02:34:22.594", "review", L2),
      ),
    );
    await turn("autonomous-turn-33", "02:37:44", "02:39:35.886", "Tôi đã sửa script L3a và chạy lại L3a.", [
      "02:37:59",
      () => assert.doesNotReject(h.accept("l2-run4"), "HQ decides while a turn the Lead started itself runs"),
    ]);
    files.push(
      await turn(
        "autonomous-turn-35",
        "02:40:34",
        "02:41:16.043",
        "L3a đã xong và đã ghi handback.",
        checkpoint("02:41:09.225", "review", L3A),
      ),
    );
    await h.rounds("02:44:16", true);
    await h.accept("l3a");
    await turn("autonomous-turn-36", "02:50:35", "02:51:15.230", "Giờ chờ lượt legacy.");
    assert.equal(h.runtime.store.member(h.lead)?.decision, "accepted", "the L3a acceptance stands");
    files.push(
      await turn(
        "autonomous-turn-38",
        "03:01:13",
        "03:05:30.231",
        "Lượt registry đã xong và ghi vào handback.",
        checkpoint("03:05:19.478", "review", REGISTRY),
      ),
    );
    await h.rounds("03:10:00", true);
    const asks = h.asks();
    assert.deepEqual(
      asks.map((a) => a.about),
      ["SANDBOX", "L2", "L3a", "registry"],
      "HQ is asked once about each handback",
    );
    assert.equal(h.runtime.store.member(h.lead)?.decision, "open", "an earlier acceptance covers no new one");
    // Each ask names the file of the turn that handed back, not a later turn's that only kept it.
    for (const [i, a] of asks.entries())
      assert.ok(a.text.includes(`Read ${files[i]}.`), `${a.about} names its handback's file`);
    assert.equal(JSON.parse(await readFile(String(files[0]), "utf8")).turnId, "autonomous-turn-27");
  } finally {
    await h.runtime.close();
  }
});

test("a review names the turn that handed back, not the Monitor turns that followed", async (t) => {
  // Mac mini, 2026-10-22 03:59-04:16Z: the Lead waited from foreground-turn-48 (checkpoint 03:59:40),
  // checkpointed U3 in autonomous-turn-52 while its U2 chain ran, and Monitor events started turns 53
  // and 55-59 by themselves. Round 3 asked HQ at 04:13:45 to read turn 59's file.
  const h = await macMiniLead(t, "03:59:34.923");
  const { turn, checkpoint } = h;
  try {
    await turn(
      "foreground-turn-48",
      "03:59:34.923",
      "03:59:48.559",
      "U2 đã xong offline.",
      checkpoint("03:59:40.453", "waiting", "U2 + U3 xong offline; box đang chạy L2/L3a"),
    );
    for (const [turnId, from, to, final] of [
      ["autonomous-turn-49", "04:00:23.539", "04:00:36.708", "Đã lưu kết quả L2."],
      ["autonomous-turn-50", "04:01:31.719", "04:01:39.751", "L3a chạy lại cũng giữ nguyên kết quả."],
      ["autonomous-turn-51", "04:01:57.288", "04:02:00.329", "Chuỗi U3 đã kết thúc lúc 11:01."],
    ])
      await turn(turnId, from, to, final);
    const file = await turn(
      "autonomous-turn-52",
      "04:04:41.224",
      "04:06:14.584",
      "U3 đã đạt runtime.",
      checkpoint("04:06:00.872", "review", "U3 runtime xong + hồi quy L2, L3a — HQ quyết"),
    );
    for (const [turnId, from, to, final] of [
      ["autonomous-turn-53", "04:06:14.600", "04:06:17.084", "Chuỗi U2 đang build image."],
      ["autonomous-turn-55", "04:07:16.464", "04:07:19.275", "Build U2 đã xong."],
      ["autonomous-turn-56", "04:07:47.493", "04:07:53.419", "Ba bước đầu của U2 đều exit 0."],
      ["autonomous-turn-57", "04:09:22.298", "04:09:24.980", "Bước dựng L2 đã build xong image."],
      ["autonomous-turn-58", "04:09:53.238", "04:10:00.450", "Bước dựng L2 exit 0."],
      ["autonomous-turn-59", "04:11:27.824", "04:11:30.775", "L2 trên image U2 đã bắt đầu lúc 11:10:57."],
    ])
      await turn(turnId, from, to, final);
    await h.rounds("04:16:00", true);
    const asks = h.asks();
    assert.deepEqual(
      asks.map((a) => a.about),
      ["U3"],
    );
    assert.ok(asks[0].text.includes(`Read ${file}.`), "it names the handback's turn file");
  } finally {
    await h.runtime.close();
  }
});

test("a failed turn Claude Code starts by itself is not retried: the waiting peer keeps its turn and decision", async (t) => {
  // ryzen, 2026-10-21: Supervisor 34bc8484's 12:26:33 message started peer 8f0cbadb's foreground-turn-5,
  // which checkpointed waiting on its A/A lanes at 12:35:41 and ended at 12:45:59. Its background waits
  // started autonomous-turn-6 to -10 (completed; left out) and autonomous-turn-11, which ended on this
  // error at 15:11:56; Paseo reported it completed. The Supervisor's next message came at 15:41:24.
  const [supervisor, peer] = ["34bc8484", "8f0cbadb"];
  const h = await claudeHost(t, "2026-10-21", "12:26:33.404", [
    [supervisor, "supervisor", null],
    [peer, "peer", supervisor],
  ]);
  try {
    h.runtime.autonomy.start(peer);
    await h.begin(peer, "foreground-turn-5", "12:26:33.404");
    h.at("12:35:41.496");
    h.runtime.autonomy.checkpoint(
      peer,
      "waiting",
      "A/A both lanes running as units eval-aa-a and eval-aa-b (harness and order seed pinned); tracked as jobs aa-a-r1 and aa-b-r1; wakeups aa-a-exit, aa-b-exit. Next: bounded polls via a status script, then AA-REPORT-r1.md",
    );
    await h.end(peer, "foreground-turn-5", "12:45:59.824", []);
    await h.begin(peer, "autonomous-turn-11", "15:10:23.632");
    await h.end(peer, "autonomous-turn-11", "15:11:56.349", [
      {
        type: "assistant_message",
        text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.",
      },
    ]);
    await h.rounds("15:41:24.816", true);
    assert.deepEqual(
      h.sent.filter((s) => s.id === peer),
      [],
      "no retry or continuation",
    );
    assert.equal(h.runtime.autonomy.get(peer)?.phase, "waiting");
    const member = h.runtime.store.member(peer);
    assert.deepEqual(
      [member?.lastTurnId, member?.decision],
      ["foreground-turn-5", "open"],
      "its turn stands",
    );
  } finally {
    await h.runtime.close();
  }
});

// These are component regressions against Paseo's documented timeline metadata, not model E2E runs.
// No-text autonomous turns exist in the captured fleet data; the stale-quota conjunction below is
// constructed to exercise attribution without waiting for a real account to hit a provider limit.
test("a textless Claude autonomous turn cannot extend an earlier turn's quota hold", async (t) => {
  const h = await claudeHost(t, "2026-10-23", "01:00:00", [
    ["peer", "peer", null],
    ["sibling", "peer", null],
  ]);
  try {
    h.runtime.autonomy.start("peer");
    const prompt: AgentTimelineItem = { type: "user_message", text: "Continue", messageId: "prompt-1" };
    const old: AgentTimelineItem = {
      type: "assistant_message",
      text: "You've hit your session limit · resets 9am (Asia/Ho_Chi_Minh)",
      messageId: "notice-1",
    };
    await h.begin("peer", "foreground-turn-1", "01:00:00");
    await h.end("peer", "foreground-turn-1", "01:00:01", [prompt, old]);
    assert.equal(h.runtime.store.heldUntil("sibling", Date.now()), Date.parse("2026-10-23T02:01:00Z"));
    await h.begin("peer", "autonomous-turn-2", "03:00:00");
    await h.end("peer", "autonomous-turn-2", "03:00:01", [prompt, old], { kind: "completed" }, [
      { item: prompt, turnId: "foreground-turn-1", timestamp: "2026-10-23T01:00:00Z" },
      { item: old, turnId: "foreground-turn-1", timestamp: "2026-10-23T01:00:01Z" },
    ]);
    assert.equal(h.runtime.store.member("peer")?.lastOutcome, "completed");
    assert.equal(h.runtime.store.heldUntil("sibling", Date.now()), null);
    assert.equal(h.runtime.autonomy.get("peer")?.quotaRetry, undefined);
  } finally {
    await h.runtime.close();
  }
});

test("a genuine Claude notice in an autonomous turn still holds its harness", async (t) => {
  const h = await claudeHost(t, "2026-10-23", "01:00:00", [["peer", "peer", null]]);
  try {
    h.runtime.autonomy.start("peer");
    const old: AgentTimelineItem = {
      type: "assistant_message",
      text: "You've hit your session limit · resets 9am (Asia/Ho_Chi_Minh)",
      messageId: "old-notice",
    };
    const current: AgentTimelineItem = { ...old, messageId: "new-notice" };
    await h.begin("peer", "autonomous-turn-2", "01:00:00");
    await h.end("peer", "autonomous-turn-2", "01:00:01", [old, current], { kind: "completed" }, [
      { item: old, turnId: "foreground-turn-1", timestamp: "2026-10-23T00:59:00Z" },
      { item: current, turnId: "autonomous-turn-2", timestamp: "2026-10-23T01:00:01Z" },
    ]);
    assert.equal(h.runtime.store.member("peer")?.lastOutcome, "failed");
    assert.equal(h.runtime.store.heldUntil("peer", Date.now()), Date.parse("2026-10-23T02:01:00Z"));
    assert.equal(h.runtime.autonomy.get("peer")?.quotaRetry, true);
  } finally {
    await h.runtime.close();
  }
});

test("canceling a Claude turn preserves the cancellation even when its last text is a provider notice", async (t) => {
  const h = await claudeHost(t, "2026-10-23", "01:00:00", [["peer", "peer", null]]);
  try {
    h.runtime.autonomy.start("peer");
    await h.begin("peer", "autonomous-turn-1", "01:00:00");
    await h.end(
      "peer",
      "autonomous-turn-1",
      "01:00:01",
      [
        {
          type: "assistant_message",
          text: "You've hit your session limit · resets 9am (Asia/Ho_Chi_Minh)",
          messageId: "notice",
        },
      ],
      { kind: "canceled", reason: "Human canceled" },
    );
    assert.equal(h.runtime.store.member("peer")?.lastOutcome, "canceled");
    assert.equal(h.runtime.autonomy.get("peer")?.phase, "paused");
    assert.equal(h.runtime.store.heldUntil("peer", Date.now()), null);
    await h.rounds("02:05:00");
    assert.equal(h.sent.length, 0, "an explicit cancellation is never resumed at a quota reset");
  } finally {
    await h.runtime.close();
  }
});

test("Claude notice attribution survives a plugin reload and rejects a reused provider turn ordinal", async (t) => {
  const h = await claudeHost(t, "2026-10-23", "01:00:00", [["peer", "peer", null]]);
  let reopened: AllianceRuntime | undefined;
  const warnings = t.mock.method(console, "warn", () => {});
  try {
    h.runtime.autonomy.start("peer");
    const notice: AgentTimelineItem = {
      type: "assistant_message",
      text: "You've hit your session limit · resets 9am (Asia/Ho_Chi_Minh)",
      messageId: "old-notice",
    };
    await h.begin("peer", "autonomous-turn-1", "01:00:00");
    await h.end("peer", "autonomous-turn-1", "01:00:01", [notice]);
    // A native session reload restarts the ordinal while preserving its old timeline. The
    // plugin then reloads during that new turn; its observed start must survive on disk.
    await h.begin("peer", "autonomous-turn-1", "03:00:00");
    await h.runtime.close();
    reopened = await new AllianceRuntime(h.home).ready();
    const chat: PluginHookAgent = {
      id: "peer",
      provider: "alliance-claude-peer",
      cwd: h.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    };
    let nativeFinal = notice;
    let timestamp = "2026-10-23T01:00:01Z";
    let turnId = "autonomous-turn-1";
    const api = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: async () => ({
              entries: [{ item: nativeFinal, turnId, timestamp }],
              hasOlder: false,
            }),
          },
        }),
      },
    } as unknown as PaseoApi;
    h.at("03:00:01");
    await reopened.endTurn(chat, turnId, { kind: "completed" }, [notice], api);
    assert.equal(reopened.store.member("peer")?.lastOutcome, "completed");
    assert.equal(reopened.store.heldUntil("peer", Date.now()), null);
    assert.equal(warnings.mock.callCount(), 1);
    const receipt = JSON.parse(await readFile(String(reopened.store.member("peer")?.resultPath), "utf8"));
    assert.match(receipt.warning, /predates the observed turn start/);
    // A genuinely new notice remains classifiable on the same reloaded runtime.
    h.at("03:01:00");
    turnId = "foreground-turn-2";
    await reopened.startTurn(chat, turnId);
    nativeFinal = {
      ...notice,
      text: "You've hit your session limit · resets 11am (Asia/Ho_Chi_Minh)",
      messageId: "fresh-notice",
    };
    timestamp = "2026-10-23T03:01:01Z";
    h.at("03:01:01");
    await reopened.endTurn(chat, turnId, { kind: "completed" }, [nativeFinal], api);
    assert.equal(reopened.store.member("peer")?.lastOutcome, "failed");
    assert.equal(reopened.store.heldUntil("peer", Date.now()), Date.parse("2026-10-23T04:01:00Z"));
  } finally {
    await (reopened ?? h.runtime).close();
  }
});

test("Claude notice attribution pages to the hook's message and reports missing native attribution", async (t) => {
  const h = await claudeHost(t, "2026-10-23", "01:00:00", [["peer", "peer", null]]);
  const warnings = t.mock.method(console, "warn", () => {});
  try {
    h.runtime.autonomy.start("peer");
    const chat: PluginHookAgent = {
      id: "peer",
      provider: "alliance-claude-peer",
      cwd: h.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    };
    const notice: AgentTimelineItem = {
      type: "assistant_message",
      text: "You've hit your session limit · resets 9am (Asia/Ho_Chi_Minh)",
      messageId: "quota-notice",
    };
    let turnId = "foreground-turn-1";
    const api = {
      agents: {
        ref: () => ({
          timeline: {
            refetch: async (request: { cursor?: { epoch: string; seq: number } }) => {
              return request.cursor
                ? {
                    epoch: "native-session",
                    entries: [{ item: notice, turnId, timestamp: new Date().toISOString() }],
                    hasOlder: false,
                  }
                : {
                    epoch: "native-session",
                    entries: [],
                    hasOlder: true,
                    startCursor: { epoch: "native-session", seq: 101 },
                  };
            },
          },
        }),
      },
    } as unknown as PaseoApi;
    await h.begin("peer", turnId, "01:00:00");
    h.at("01:00:01");
    await h.runtime.endTurn(chat, turnId, { kind: "completed" }, [notice], api);
    assert.equal(h.runtime.store.member("peer")?.lastOutcome, "failed");
    assert.equal(h.runtime.store.heldUntil("peer", Date.now()), Date.parse("2026-10-23T02:01:00Z"));

    for (const fault of ["missing identity", "read failure", "changed epoch"]) {
      turnId = `autonomous-${fault}`;
      await h.begin("peer", turnId, "03:00:00");
      const unavailable = {
        agents: {
          ref: () => ({
            timeline: {
              refetch: async (request: { cursor?: { epoch: string; seq: number } }) => {
                if (fault === "read failure") throw new Error("Native timeline unavailable");
                if (fault === "missing identity")
                  return {
                    entries: [{ item: notice, timestamp: new Date().toISOString() }],
                    hasOlder: false,
                  };
                return request.cursor
                  ? {
                      epoch: "replacement",
                      entries: [{ item: notice, turnId, timestamp: new Date().toISOString() }],
                      hasOlder: false,
                    }
                  : {
                      epoch: "original",
                      entries: [],
                      hasOlder: true,
                      startCursor: { epoch: "original", seq: 101 },
                    };
              },
            },
          }),
        },
      } as unknown as PaseoApi;
      h.at("03:00:01");
      await h.runtime.endTurn(chat, turnId, { kind: "completed" }, [notice], unavailable);
      assert.equal(h.runtime.store.member("peer")?.lastOutcome, "completed", fault);
      assert.equal(h.runtime.store.heldUntil("peer", Date.now()), null, fault);
      assert.match(String(h.runtime.wakeupHealth.error), /was not attributed/, fault);
      const receipt = JSON.parse(await readFile(String(h.runtime.store.member("peer")?.resultPath), "utf8"));
      assert.match(receipt.warning, /Native outcome retained/, fault);
    }
    assert.equal(warnings.mock.callCount(), 3, "every unclassified notice is visible in the plugin log");
  } finally {
    await h.runtime.close();
  }
});

test("Claude resume keeps the session model when the native launcher omits --model", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const env = {
    PASEO_AGENT_ID: "pinned",
    ALLIANCE_BOUND_ROOM: f.room.id,
    ALLIANCE_WORKSPACE_CWD: f.cwd,
    ALLIANCE_SESSION_MODEL: "claude-opus-5-5",
  };
  const resumed = await launchPlan(f.home, "claude-hq", ["--resume", "session"], env, f.cwd);
  assert.equal(resumed.args[resumed.args.indexOf("--model") + 1], "claude-opus-5-5");
  const changed = await launchPlan(
    f.home,
    "claude-hq",
    ["--resume", "session", "--model=claude-sonnet-5-5"],
    env,
    f.cwd,
  );
  assert.ok(changed.args.includes("--model=claude-sonnet-5-5"));
  assert.ok(!changed.args.includes("claude-opus-5-5"), "an explicit native model change wins");
  const human = await launchPlan(
    f.home,
    "claude-hq",
    ["--resume", "session"],
    { ALLIANCE_SESSION_MODEL: "claude-opus-5-5" },
    f.cwd,
  );
  assert.ok(!human.args.includes("--model"), "a Human terminal does not inherit session hints");
});

test("native empty hooks retain only this turn's handback and reject uncertain history", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const agent = {
    id: "native-readback",
    provider: "alliance-codex-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: null,
  };
  await f.runtime.startTurn(agent, "turn-1");
  const startedAt = f.runtime.store.member(agent.id)?.turnStartedAt as number;
  const stamp = new Date(startedAt).toISOString();
  let uncertain = false;
  let missingIdentity = false;
  let active = false;
  let currentTurn = "turn-1";
  const calls: unknown[] = [];
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({
          agent: { status: active ? "running" : "idle", activeTurn: active ? { turnId: currentTurn } : null },
        }),
        timeline: {
          refetch: async (query: { cursor?: unknown }) => {
            calls.push(query);
            if (uncertain) return { error: "history unavailable", entries: [] };
            if (currentTurn !== "turn-1")
              return {
                epoch: "one",
                hasOlder: false,
                entries: [
                  {
                    turnId: missingIdentity ? null : currentTurn,
                    timestamp: new Date(f.runtime.store.member(agent.id)!.turnStartedAt!).toISOString(),
                    item: { type: "assistant_message", text: "recovered handback" },
                  },
                ],
              };
            return query.cursor
              ? {
                  epoch: "one",
                  hasOlder: false,
                  entries: [
                    {
                      turnId: "turn-1",
                      timestamp: new Date(startedAt - 60000).toISOString(),
                      item: { type: "assistant_message", text: "stale reused ordinal" },
                    },
                    {
                      turnId: "turn-1",
                      timestamp: stamp,
                      item: { type: "user_message", text: "deliver", messageId: "work-1" },
                    },
                  ],
                }
              : {
                  epoch: "one",
                  hasOlder: true,
                  startCursor: { epoch: "one", seq: 100 },
                  entries: [
                    {
                      turnId: "turn-1",
                      timestamp: stamp,
                      item: { type: "assistant_message", text: "verified handback" },
                    },
                    {
                      turnId: "another-turn",
                      timestamp: stamp,
                      item: { type: "assistant_message", text: "unrelated newer result" },
                    },
                  ],
                };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  await f.runtime.endTurn(agent, "turn-1", { kind: "completed" }, undefined, api);
  const result = f.runtime.store.member(agent.id)?.resultPath;
  assert(result);
  assert.equal(JSON.parse(await readFile(result, "utf8")).final.text, "verified handback");
  assert.equal(calls.length, 2, "fetch older pages to identify the same turn's prompt");
  await f.runtime.startTurn(agent, "turn-2");
  currentTurn = "turn-2";
  uncertain = true;
  await assert.rejects(
    f.runtime.endTurn(agent, "turn-2", { kind: "completed" }, undefined, api),
    /history unavailable/,
  );
  assert.equal(
    f.runtime.store.member(agent.id)?.resultPath,
    null,
    "unreadable history cannot publish a handback",
  );
  const pending = f.runtime.store.member(agent.id)?.turnReadbackPending;
  assert(pending, "failed history is durable and blocks premature acceptance");
  await assert.rejects(
    f.runtime.disposition(agent.id, "rejected", "test", "test", undefined, null),
    /awaits readback/,
  );
  const reopened = await new AllianceRuntime(f.home).ready();
  assert.equal(
    reopened.store.member(agent.id)?.turnReadbackPending?.id,
    pending.id,
    "receipt survives runtime reload",
  );
  await reopened.close();
  uncertain = false;
  missingIdentity = true;
  await assert.rejects(f.runtime.reconcileTurnReadback(agent.id, api), /no turn identity/);
  assert.equal(
    f.runtime.store.member(agent.id)?.turnReadbackPending?.endedAt,
    pending.endedAt,
    "retry retains original completion cutoff",
  );
  missingIdentity = false;
  await f.runtime.reconcileTurnReadback(agent.id, api);
  assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending, undefined);
  assert.equal(
    JSON.parse(await readFile(f.runtime.store.member(agent.id)!.resultPath!, "utf8")).final.text,
    "recovered handback",
  );
  await f.runtime.startTurn(agent, "turn-3");
  currentTurn = "turn-3";
  active = true;
  await assert.rejects(
    f.runtime.endTurn(agent, "turn-3", { kind: "completed" }, undefined, api),
    /active native turn/,
  );
  active = false;
  await assert.rejects(
    f.runtime.reconcileTurnReadback(agent.id, api),
    /active native turn/,
    "a delayed completion cannot finish a newly active generation without its own end event",
  );
  await f.runtime.endTurn(agent, "turn-3", { kind: "completed" }, undefined, api);
  assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending, undefined);
  assert.equal(f.runtime.store.member(agent.id)?.lastOutcome, "completed");
});

test("overlapping native handbacks keep the newest receipt and immutable result", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const agent = {
    id: "overlap",
    provider: "alliance-codex-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: null,
  };
  await f.runtime.startTurn(agent, "turn-1");
  let text = "older completion";
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
        timeline: {
          refetch: async () => ({
            epoch: "epoch",
            hasOlder: false,
            entries: [
              {
                turnId: "turn-1",
                timestamp: new Date(f.runtime.store.member(agent.id)!.turnStartedAt!).toISOString(),
                item: { type: "assistant_message", text },
              },
            ],
          }),
        },
      }),
    },
  } as unknown as PaseoApi;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reconcile = f.runtime["reconcileTurnInput"].bind(f.runtime);
  let first = true;
  f.runtime["reconcileTurnInput"] = async (...args) => {
    if (first) {
      first = false;
      reached();
      await gate;
    }
    return reconcile(...args);
  };
  const older = f.runtime.endTurn(agent, "turn-1", { kind: "completed" }, undefined, api);
  await paused;
  const oldReceipt = f.runtime.store.member(agent.id)!.turnReadbackPending!;
  assert(oldReceipt, "handback remains held during input reconciliation");
  await assert.rejects(
    f.runtime.disposition(agent.id, "rejected", "test", "test", undefined, null),
    /awaits readback/,
  );
  text = "newer completion";
  await f.runtime.endTurn(agent, "turn-1", { kind: "completed" }, undefined, api);
  const newest = f.runtime.store.member(agent.id)!.resultPath!;
  const bytes = await readFile(newest, "utf8");
  assert.equal(JSON.parse(bytes).final.text, "newer completion");
  release();
  await older;
  await f.runtime.endTurn(agent, oldReceipt.turnId, oldReceipt.outcome, undefined, api, oldReceipt);
  assert.equal(
    f.runtime.store.member(agent.id)?.resultPath,
    newest,
    "stale retry and old continuation cannot overwrite the winner",
  );
  assert.equal(await readFile(newest, "utf8"), bytes);
  assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending, undefined);
});

test("native empty hooks classify only this generation's provider notice and preserve cancellation", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const agent = {
    id: "notice-readback",
    provider: "alliance-claude-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: null,
  };
  const notice = "Failed to authenticate. API Error: 401 OAuth access token is invalid.";
  let nativeTurn = "autonomous-1";
  let stale = false;
  let reads = 0;
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "idle", activeTurn: null } }),
        timeline: {
          refetch: async () => {
            reads++;
            return {
              epoch: "one",
              hasOlder: false,
              entries: [
                {
                  turnId: nativeTurn,
                  timestamp: new Date(
                    f.runtime.store.member(agent.id)!.turnStartedAt! - (stale ? 60000 : 0),
                  ).toISOString(),
                  item: { type: "assistant_message", text: notice },
                },
              ],
            };
          },
        },
      }),
    },
  } as unknown as PaseoApi;
  await f.runtime.startTurn(agent, nativeTurn);
  await f.runtime.endTurn(agent, nativeTurn, { kind: "completed" }, undefined, api);
  assert.equal(
    f.runtime.store.member(agent.id)?.lastOutcome,
    "failed",
    "a promptless native provider notice is not success",
  );
  assert.equal(
    reads,
    1,
    "canonical attribution does not depend on a second, potentially unavailable history read",
  );
  nativeTurn = "autonomous-2";
  await f.runtime.startTurn(agent, nativeTurn);
  await f.runtime.endTurn(agent, nativeTurn, { kind: "canceled", reason: "Human stopped" }, undefined, api);
  assert.equal(f.runtime.store.member(agent.id)?.lastOutcome, "canceled");
  nativeTurn = "autonomous-3";
  await f.runtime.startTurn(agent, nativeTurn);
  stale = true;
  await f.runtime.endTurn(agent, nativeTurn, { kind: "completed" }, undefined, api);
  const member = f.runtime.store.member(agent.id)!;
  assert.equal(member.lastOutcome, "completed");
  assert.equal(
    JSON.parse(await readFile(member.resultPath!, "utf8")).final,
    null,
    "a stale reused ordinal cannot create a provider failure or final response",
  );
});

test("native readback hold clears on a proven later reused turn generation only", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const agent = {
    id: "reused-start",
    provider: "alliance-codex-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: null,
  };
  await f.runtime.bind(agent);
  f.runtime.autonomy.start(agent.id);
  await f.runtime.startTurn(agent, "reused");
  const started = f.runtime.store.member(agent.id)!.turnStartedAt!;
  f.runtime.autonomy.checkpoint(agent.id, "review", "old generation checkpoint", "reused");
  let nativeStart: string | undefined = new Date(started).toISOString();
  let unavailable = false;
  const api = {
    agents: {
      ref: () => ({
        refresh: async () => {
          if (unavailable) throw new Error("offline");
          return { agent: { status: "running", activeTurn: { turnId: "reused", startedAt: nativeStart } } };
        },
      }),
    },
  } as unknown as PaseoApi;
  await assert.rejects(
    f.runtime.endTurn(agent, "reused", { kind: "completed" }, undefined, api),
    /active native turn/,
  );
  const receipt = f.runtime.store.member(agent.id)!.turnReadbackPending!;
  for (const value of [new Date(started).toISOString(), undefined, "invalid"]) {
    nativeStart = value;
    await f.runtime.startTurn(agent, "reused", api);
    assert.equal(f.runtime.store.member(agent.id)?.turnStartedAt, started);
    assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending?.id, receipt.id);
  }
  unavailable = true;
  await f.runtime.startTurn(agent, "reused", api);
  assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending?.id, receipt.id);
  unavailable = false;
  nativeStart = new Date(started + 1000).toISOString();
  await f.runtime.startTurn(agent, "reused", api);
  assert.equal(f.runtime.store.member(agent.id)?.turnStartedAt, started + 1000);
  assert.equal(f.runtime.store.member(agent.id)?.turnReadbackPending, undefined);
  assert.equal(
    f.runtime.autonomy.get(agent.id)?.checkpointTurnId,
    undefined,
    "old same-ID checkpoint is not attributed to the new generation",
  );
  assert.equal(f.runtime.autonomy.get(agent.id)?.outcome, null);
});

test("new room names reach native workspace and later native rename reaches the room", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const cwd = join(f.root, "naming-project");
  await mkdir(cwd);
  let title: string | null = null;
  let writes = 0;
  const native = {
    id: "naming-workspace",
    refresh: async () => ({ title }),
    setTitle: async (next: string) => {
      title = next;
      writes++;
      return { title };
    },
  };
  const api = {
    ...f.paseo,
    workspaces: { open: async () => native, ref: () => native },
  } as unknown as PaseoApi;
  const room = await f.runtime.createRoom({ cwd, title: "Sleek Radar", mission: "" }, api);
  assert.equal(title, "Sleek Radar");
  assert.equal(writes, 1);
  f.runtime.store.addRoom({
    ...room,
    id: "manual-local-room",
    cwd: join(f.root, "manual-room"),
    title: "Manual local room",
    nativeTitle: "Earlier native title",
  });
  title = "Human renamed project";
  await f.runtime.list(api);
  assert.equal(f.runtime.store.room("manual-local-room").title, "Manual local room");
  assert.equal(f.runtime.store.room(room.id).title, title);
  assert.equal(writes, 1, "status never writes over a native Human rename");
});

test("joining a named native workspace preserves its Human title", async (t) => {
  const f = await fixture();
  t.after(() => f.runtime.close());
  const cwd = join(f.root, "existing-project");
  await mkdir(cwd);
  const native = {
    id: "named-workspace",
    refresh: async () => ({ title: "Human project title" }),
    setTitle: async () => {
      throw new Error("must not overwrite a named workspace");
    },
  };
  const api = { ...f.paseo, workspaces: { open: async () => native } } as unknown as PaseoApi;
  const room = await f.runtime.createRoom({ cwd, title: "Suggested name", mission: "" }, api);
  assert.equal(room.title, "Human project title");
});
