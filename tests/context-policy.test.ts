import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js";
import { contextPolicy } from "../scripts/context-policy.mjs";
import contextLimit from "../scripts/pi-context-limit.mjs";
import { temporary } from "./temp";

test("Claude's launch overrides a stale window and disabled compaction without dropping credentials", () => {
  const original = {
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    DISABLE_AUTO_COMPACT: "1",
    ANTHROPIC_API_KEY: "synthetic",
  };
  const plan = contextPolicy("claude", [], original);
  assert.equal(plan.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  assert.equal(plan.env.DISABLE_AUTO_COMPACT, "0");
  assert.equal(plan.env.ANTHROPIC_API_KEY, "synthetic");
  assert.equal(original.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1000000");
});

test("Pi native compaction fires below 300k for extension providers and preserves smaller windows", async () => {
  const cwd = await temporary("alliance-context-");
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "context-fixture",
    defaultModel: "large",
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1000 },
  });
  const reasons: string[] = [];
  let registry: ExtensionContext["modelRegistry"];
  const fixture = (pi: ExtensionAPI) => {
    pi.registerProvider("context-fixture", {
      api: "context-fixture",
      baseUrl: "https://invalid.example",
      apiKey: "synthetic",
      models: [
        {
          id: "large",
          name: "Large",
          contextWindow: 1000000,
          maxTokens: 4096,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        {
          id: "small",
          name: "Small",
          contextWindow: 128000,
          maxTokens: 4096,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "fixture response ".repeat(1000) }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 285000,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 285001,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop",
              timestamp: Date.now(),
            },
          });
          stream.end();
        });
        return stream;
      },
    });
    pi.on("session_start", (_event, ctx) => {
      registry = ctx.modelRegistry;
    });
    pi.on("session_before_compact", (event) => {
      reasons.push(event.reason);
      return {
        compaction: {
          summary: "Fixture continuity summary",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    });
  };
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    extensionFactories: [fixture, contextLimit],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
  });
  try {
    await session.bindExtensions({});
    const initial = registry!.find("context-fixture", "large");
    assert(initial);
    await session.setModel(initial);
    assert.equal(session.model?.contextWindow, 300000);
    await session.prompt("Exercise the native automatic compaction boundary. ".repeat(1000));
    assert.deepEqual(reasons, ["threshold"]);
    const small = registry!.find("context-fixture", "small");
    assert(small);
    await session.setModel(small);
    assert.equal(session.model?.contextWindow, 128000);
    const large = { ...small, id: "large", contextWindow: 1000000 };
    await session.setModel(large);
    assert.equal(session.model?.contextWindow, 300000);
  } finally {
    session.dispose();
  }
});
