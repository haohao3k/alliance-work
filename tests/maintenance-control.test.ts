import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { qualifyControlAlias, registerControlAliases } from "../server/maintenance-control.mjs";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const agent = {
    id: "owner",
    provider: "alliance-claude-hq",
    model: "claude-fable-5-2",
    thinkingOptionId: "high",
    effectiveThinkingOptionId: "high",
    cwd: "/workspace/project",
    persistence: { sessionId: "retained-conversation" },
  };
  const holdBody =
    "[Alliance maintenance hold-123 hold owner; dispatch 11111111-1111-4111-8111-111111111111]\nCheckpoint the unfinished task and preserve its obligations.";
  const resumeBody =
    "[Alliance maintenance hold-123 resume owner; dispatch 22222222-2222-4222-8222-222222222222]\nContinue the retained task with the same constraints.";
  const fallbackBody =
    "[Alliance maintenance hold-123 hold owner; dispatch 33333333-3333-4333-8333-333333333333]\nWrite the checkpoint after the authorized interruption.";
  const task = {
    id: agent.id,
    phase: "held",
    original: structuredClone(agent),
    notice: {
      state: "acknowledged",
      messageId: "11111111-1111-4111-8111-111111111111",
      bodySha256: sha256(holdBody),
      acknowledgedAt: "2026-11-10T10:00:05.000Z",
    },
    resume: {
      state: "acknowledged",
      messageId: "22222222-2222-4222-8222-222222222222",
      bodySha256: sha256(resumeBody),
      acknowledgedAt: "2026-11-10T10:00:05.000Z",
    },
  };
  const ledger = {
    id: "hold-123",
    phase: "held",
    createdAt: "2026-11-10T10:00:00.000Z",
    controls: { [task.id]: [task.notice.messageId, task.resume.messageId] },
    targets: [task],
    controlAliasQualifications: [],
  };
  const row = {
    timestamp: "2026-11-10T10:00:04.000Z",
    item: { type: "user_message", text: holdBody, messageId: "44444444-4444-4444-8444-444444444444" },
  };
  return { agent, task, ledger, row, holdBody, resumeBody, fallbackBody };
}

test("a hydrated Claude user row qualifies only through the complete owned dispatch, body digest and retained conversation", () => {
  const f = fixture();
  assert.ok(qualifyControlAlias(f.ledger, f.task, f.row, f.agent));
  const proofs = registerControlAliases(f.ledger, f.task, { entries: [f.row] }, f.agent);
  assert.equal(proofs.length, 1);
  assert.ok(f.ledger.controls.owner.includes(f.row.item.messageId));
  assert.ok(
    JSON.stringify(f.ledger.controlAliasQualifications).includes(f.row.item.messageId),
    "the ledger retains its qualification audit",
  );
  const ledger = structuredClone(f.ledger);
  assert.deepEqual(registerControlAliases(f.ledger, f.task, { entries: [f.row] }, f.agent), []);
  assert.deepEqual(f.ledger, ledger, "re-reading the same native alias records nothing twice");
});

test("resume and fallback hold dispatches use their own pre-recorded digest and acknowledgement", () => {
  const f = fixture();
  const resumed = {
    ...f.row,
    item: { ...f.row.item, text: f.resumeBody, messageId: "55555555-5555-4555-8555-555555555555" },
  };
  assert.ok(qualifyControlAlias(f.ledger, f.task, resumed, f.agent));
  const fallbackTask = {
    ...f.task,
    notice: {
      ...f.task.notice,
      state: "checkpoint-acknowledged",
      fallbackMessageId: "33333333-3333-4333-8333-333333333333",
      fallbackBodySha256: sha256(f.fallbackBody),
      fallbackAcknowledgedAt: "2026-11-10T10:00:05.000Z",
    },
  };
  f.ledger.controls.owner.push("33333333-3333-4333-8333-333333333333");
  const fallback = {
    ...f.row,
    item: { ...f.row.item, text: f.fallbackBody, messageId: "66666666-6666-4666-8666-666666666666" },
  };
  assert.ok(qualifyControlAlias(f.ledger, fallbackTask, fallback, f.agent));
});

test("assistant messages, tool output and quoted or altered user text cannot become owned maintenance controls", () => {
  const f = fixture();
  for (const item of [
    { ...f.row.item, type: "assistant_message" },
    { ...f.row.item, type: "tool_call" },
    { ...f.row.item, text: `> ${f.holdBody}` },
    { ...f.row.item, text: `${f.holdBody}\nA different product instruction.` },
  ])
    assert.equal(qualifyControlAlias(f.ledger, f.task, { ...f.row, item }, f.agent), null);
  assert.deepEqual(f.ledger.controls.owner, [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
});

test("another client, an unowned dispatch, missing acknowledgement or missing registered digest is refused", () => {
  const f = fixture();
  const foreign = { ...f.row, item: { ...f.row.item, clientMessageId: "another-client" } };
  assert.equal(qualifyControlAlias(f.ledger, f.task, foreign, f.agent), null);
  assert.equal(qualifyControlAlias({ ...f.ledger, controls: { owner: [] } }, f.task, f.row, f.agent), null);
  for (const notice of [
    { ...f.task.notice, state: "sending" },
    { ...f.task.notice, acknowledgedAt: undefined },
    { ...f.task.notice, acknowledgedAt: "invalid-time" },
    { ...f.task.notice, bodySha256: undefined },
  ])
    assert.equal(qualifyControlAlias(f.ledger, { ...f.task, notice }, f.row, f.agent), null);
  const predatesHold = { ...f.row, timestamp: "2026-11-10T09:59:59.999Z" };
  assert.equal(qualifyControlAlias(f.ledger, f.task, predatesHold, f.agent), null);
});

test("aliases cannot cross native sessions, providers, models, effort settings or task identities", () => {
  const f = fixture();
  for (const current of [
    { ...f.agent, id: "different-owner" },
    { ...f.agent, provider: "alliance-claude-peer" },
    { ...f.agent, model: "claude-sonnet-5-5" },
    { ...f.agent, thinkingOptionId: "medium" },
    { ...f.agent, effectiveThinkingOptionId: "medium" },
    { ...f.agent, cwd: "/workspace/different-project" },
    { ...f.agent, persistence: { sessionId: "another-conversation" } },
  ])
    assert.equal(qualifyControlAlias(f.ledger, f.task, f.row, current), null);
});
