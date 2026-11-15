import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { type TestContext, test } from "node:test";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { Session } from "../server/agy-native/internal/session";

const interrupted = "The stream was interrupted. Please continue the task you were working on.";
type Step = [
  index: number,
  type: string,
  state: "ACTIVE" | "DONE" | "ERROR",
  text?: string,
  outputTokens?: number,
];
type TurnEvent = Extract<ProviderEvent, { type: "session.turn" }>;

const nativeFixture = `
  const { createInterface } = require('node:readline');
  const conversation = process.argv[process.argv.indexOf('--conversation') + 1];
  const emit = (event, data) => console.log(JSON.stringify({event, [event]: data}));
  console.log(JSON.stringify({event:'init', conversation_id:conversation, init:{model:null}}));
  (async () => {
    for await (const line of createInterface({input:process.stdin})) {
      const { steps, error, response, conversationId = conversation } = JSON.parse(JSON.parse(line).message.content);
      const text = (value) => value?.replaceAll('{pid}', String(process.pid));
      for (const [step_index, step_type, state, delta, output_tokens] of steps) {
        emit('step_update', { conversation_id: conversationId, step_index, step_type, state,
          text_delta: text(delta), usage: output_tokens ? {input_tokens: 1, output_tokens} : null });
      }
      emit('result', { conversation_id: conversationId, status: error ? 'ERROR' : 'SUCCESS', error, response: text(response) });
    }
  })();
`;

async function fixture(t: TestContext) {
  const signal = new EventEmitter();
  const events: ProviderEvent[] = [];
  const session = new Session({
    id: "fixture",
    config: { cwd: process.cwd(), env: {}, mcpServers: {}, persist: true, settings: {} },
    launch: { command: process.execPath, args: ["-e", nativeFixture, "--"], env: {} },
    catalog: () => ({
      models: [],
      modes: [
        {
          id: "full-access",
          label: "Full access",
          icon: "ShieldOff",
          colorTier: "dangerous",
          description: "Fixture mode",
        },
      ],
      thinkingOptions: [],
    }),
    persistence: { version: 1, data: { conversationId: "retained" } },
    emit(event) {
      events.push(event);
      if (event.type === "session.turn" && event.state !== "started") signal.emit("finished", event);
    },
  });
  t.after(() => session.close());
  await session.open("open", []);
  let messages = 0;
  return {
    events,
    async prompt(steps: Step[], error?: string, response?: string, conversationId?: string) {
      const finished = once(signal, "finished");
      await session.prompt({
        clientMessageId: String(++messages),
        delivery: "auto",
        input: {
          type: "message",
          content: [{ type: "text", text: JSON.stringify({ steps, error, response, conversationId }) }],
        },
      });
      return (await finished)[0] as TurnEvent;
    },
  };
}

// Synthetic native steps model a stale interruption crossing the current-step boundary.
// The fixture process supplies the response; no captured transcript or answer is distributed.
const answer = "Completed response from fixture process {pid}";
const current: Step[] = [
  [174, "user_input", "DONE"],
  [175, "system_message", "DONE"],
  [176, "agent_response", "DONE"],
  [177, "unknown", "DONE"],
  [178, "unknown", "DONE"],
  [179, "agent_response", "DONE"],
  [180, "unknown", "DONE"],
  [181, "agent_response", "DONE"],
  [182, "unknown", "DONE"],
  [183, "agent_response", "ACTIVE", answer],
  [183, "agent_response", "DONE", undefined, 8],
];

test("AGY preserves a completed restored turn and its driver after the stale interruption", {
  timeout: 5000,
}, async (t) => {
  const { events, prompt } = await fixture(t);
  assert.equal((await prompt(current, interrupted, answer)).state, "completed");
  assert.equal(
    events.filter((event) => event.type === "session.notice" && event.notice.severity === "warning").length,
    2,
  );
  assert.equal(
    (
      await prompt([
        [184, "user_input", "DONE"],
        [185, "agent_response", "DONE", answer, 8],
      ])
    ).state,
    "completed",
  );
  const replies = events.flatMap((event) =>
    event.type === "timeline.item" && event.item.type === "assistant_message" ? [event.item.text] : [],
  );
  assert.equal(replies.length, 2);
  assert.match(replies[0], /fixture process \d+$/);
  assert.equal(replies[0], replies[1], "the next prompt must reach the same process");
});

const incomplete = current.slice(0, -1);
const negative: [label: string, steps: Step[], error: string, expected?: "canceled", response?: string][] = [
  ["503", current, "503 Service Unavailable"],
  ["timeout", current, "context deadline exceeded"],
  ["canceled", current, "interrupted", "canceled"],
  ["partial response", incomplete, interrupted],
  ["missing current input boundary", current.slice(1), interrupted],
  ["empty final response", [...current, [184, "agent_response", "DONE", "", 8]], interrupted],
  ["unfinished tool", [current[0], [175, "tool", "ACTIVE"], ...current.slice(2)], interrupted],
  ["failed tool", [current[0], [175, "tool", "ERROR"], ...current.slice(2)], interrupted],
  ["current error step", [current[0], [175, "error_message", "DONE"], ...current.slice(2)], interrupted],
  ["conflicting result text", current, interrupted, undefined, "Unrelated response"],
];

for (const [label, steps, error, expected = "failed", response = answer] of negative) {
  test(`AGY retains a ${label} terminal failure`, { timeout: 5000 }, async (t) => {
    const { prompt } = await fixture(t);
    assert.equal((await prompt(steps, error, response)).state, expected);
  });
}

test("AGY cannot use a prior user boundary or answer to complete a later failed turn", {
  timeout: 5000,
}, async (t) => {
  const { prompt } = await fixture(t);
  assert.equal((await prompt(current)).state, "completed");
  assert.equal((await prompt(current, interrupted, answer)).state, "failed");
});
