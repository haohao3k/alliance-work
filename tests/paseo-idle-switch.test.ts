import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Exercise the pinned native lifecycle owner, including its real admission lock and final guard.
const require = createRequire(import.meta.url);
const nativeRoot = dirname(require.resolve("@getpaseo/server"));
const { AgentManager } = await import(
  process.env.ALLIANCE_TEST_NATIVE_MANAGER ?? pathToFileURL(join(nativeRoot, "agent/agent-manager.js")).href
);
const logger: any = new Proxy(() => {}, {
  get: (_target, key) => (key === "child" ? () => logger : () => {}),
});
function fixture() {
  const manager = new AgentManager({ logger, registry: {} });
  const session = { canStopRuntime: async () => true };
  const agent = {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "alliance-claude-hq",
    updatedAt: new Date(),
    session,
    lifecycle: "idle",
    internal: false,
    activeForegroundTurnId: null,
    pendingReplacement: null,
    pendingPermissions: new Map(),
    inFlightPermissionResponses: new Map(),
    labels: {},
    persistence: { sessionId: "same-history" },
  };
  manager.agents.set(agent.id, agent);
  manager.getAgent = () => agent;
  let closed = 0;
  manager.closeAgentRuntime = async (_id: string, eligible: () => boolean) => {
    assert(manager.collectingRuntimes.has(agent.id), "prompt admission is blocked during retirement");
    if (!eligible()) return false;
    closed++;
    return true;
  };
  return {
    manager,
    agent,
    session,
    closed: () => closed,
    retire: () => manager.retireIdleRuntime(agent.id, agent.updatedAt.toISOString()),
  };
}

test("native retirement retains persistence and rejects running turns, background work and stale observations", async () => {
  const f = fixture();
  f.agent.lifecycle = "running";
  assert.equal(await f.retire(), false);
  f.agent.lifecycle = "idle";
  f.session.canStopRuntime = async () => false;
  assert.equal(await f.retire(), false);
  f.session.canStopRuntime = async () => true;
  assert.equal(await f.manager.retireIdleRuntime(f.agent.id, "stale"), false);
  assert.equal(await f.retire(), true);
  assert.equal(f.closed(), 1);
  assert.equal(f.agent.persistence.sessionId, "same-history");
  assert.equal(f.manager.collectingRuntimes.size, 0);
});

test("a new turn racing the provider probe vetoes close", async () => {
  const f = fixture();
  f.session.canStopRuntime = async () => {
    f.agent.lifecycle = "running";
    return true;
  };
  assert.equal(await f.retire(), false);
  assert.equal(f.closed(), 0);
});

test("native lifecycle lane revalidates after a queued mutation, with no interrupt fallback", async () => {
  const f = fixture();
  const original = f.manager.runLifecycleMutation.bind(f.manager);
  f.manager.runLifecycleMutation = async (id: string, work: () => Promise<boolean>) => {
    f.agent.lifecycle = "running";
    return original(id, work);
  };
  assert.equal(await f.retire(), false);
  assert.equal(f.closed(), 0);
});

test("native close persists the same conversation and retains transcript rows and ownership", async () => {
  const f = fixture();
  let persisted: Record<string, any> | undefined;
  let processClosed = false;
  Object.assign(f.agent, {
    config: { title: "Preserved title", provider: f.agent.provider },
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    owner: "same-owner",
    workspaceId: "same-workspace",
  });
  Object.assign(f.session, {
    close: async () => {
      processClosed = true;
    },
  });
  f.manager.registry.applySnapshot = async (snapshot: Record<string, any>) => {
    persisted = snapshot;
  };
  f.manager.closeAgentRuntime = AgentManager.prototype.closeAgentRuntime.bind(f.manager);
  f.manager.timelineStore.initialize(f.agent.id);
  f.manager.recordAndDispatchTimelineItem(
    f.agent.id,
    { type: "assistant_message", text: "Earlier answer" },
    f.agent.provider,
  );
  const before = f.manager.timelineStore.getItems(f.agent.id);
  assert.equal(before.length, 1);
  assert.equal(await f.retire(), true);
  assert.equal(processClosed, true);
  assert.equal(persisted?.lifecycle, "closed");
  assert.equal(persisted?.persistence.sessionId, "same-history");
  assert.equal(persisted?.owner, "same-owner");
  assert.equal(persisted?.workspaceId, "same-workspace");
  assert.deepEqual(f.manager.timelineStore.getItems(f.agent.id), before);
});
