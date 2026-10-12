import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { chooseModel } from "../server/model-policy";
import { RoomStore } from "../server/store";
import { defaultModelPolicy } from "../shared/model-policy";
import { temporary } from "./temp";

const catalog: AgentModelDefinition[] = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
].map((id) => ({
  id,
  provider: "fixture",
  label: id,
  aliases: id === "claude-opus-5-5" ? ["opus"] : undefined,
  thinkingOptions: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
}));

test("worker selection respects allowlist, difficulty, availability and owner choice over priority", () => {
  const policy = defaultModelPolicy();
  assert.deepEqual(chooseModel(policy, "peer", "codex", catalog), {
    model: "gpt-6.1-sol",
    thinkingOptionId: "high",
  });
  assert.deepEqual(chooseModel(policy, "peer", "codex", catalog, undefined, undefined, "routine"), {
    model: "gpt-6.1-sol",
    thinkingOptionId: "medium",
  });
  assert.throws(
    () => chooseModel(policy, "peer", "codex", catalog, "gpt-6-astra", "high", "routine"),
    /No allowed/,
  );
  // Native creation has no structured difficulty: it checks the union, retaining owner's escalation.
  assert.equal(chooseModel(policy, "peer", "codex", catalog, "gpt-6-astra", "high").model, "gpt-6-astra");
  assert.equal(
    chooseModel(policy, "lens", "claude", catalog, "claude-sonnet-5-5", "xhigh", "complex").thinkingOptionId,
    "xhigh",
  );
  assert.throws(() => chooseModel(policy, "peer", "codex", catalog, "gpt-6.1-sol", "xhigh"), /No allowed/);
  assert.throws(() => chooseModel(policy, "peer", "codex", [], "gpt-6.1-sol", "high"), /unavailable/);
  assert.throws(
    () =>
      chooseModel(
        policy,
        "peer",
        "claude",
        catalog.map((model) => ({ ...model, thinkingOptions: [{ id: "high", label: "high" }] })),
        "claude-sonnet-5-5",
        "xhigh",
      ),
    /No allowed/,
  );
  assert.throws(() => chooseModel(policy, "peer", "pi", catalog), /No allowed/);
});

test("Lead preferences permit deliberate overrides and fall back to available provider defaults", () => {
  const policy = defaultModelPolicy();
  assert.deepEqual(chooseModel(policy, "lead", "codex", catalog, "gpt-6.1-sol", "xhigh"), {
    model: "gpt-6.1-sol",
    thinkingOptionId: "xhigh",
  });
  assert.deepEqual(chooseModel(policy, "lead", "codex", catalog), {
    model: "gpt-6-astra",
    thinkingOptionId: "medium",
  });
  assert.deepEqual(chooseModel(policy, "lead", "claude", catalog, "opus", "high"), {
    model: "claude-opus-5-5",
    thinkingOptionId: "high",
  });
  const alternative = [
    {
      ...catalog[0],
      defaultThinkingOptionId: "low",
      isDefault: true,
      thinkingOptions: [{ id: "low", label: "low" }],
    },
  ];
  assert.deepEqual(chooseModel(policy, "lead", "codex", alternative), {
    model: "gpt-6.1-sol",
    thinkingOptionId: "low",
  });
  assert.deepEqual(
    chooseModel(policy, "lead", "pi", [{ ...catalog[0], id: "other/model", thinkingOptions: [] }]),
    {
      model: "other/model",
      thinkingOptionId: undefined,
    },
  );
  assert.throws(
    () => chooseModel(policy, "lead", "codex", alternative, "gpt-6.1-sol", "high"),
    /no silent effort fallback/,
  );
  assert.throws(() => chooseModel(policy, "lead", "codex", catalog, "missing-model"), /unavailable/);
  assert.throws(() => chooseModel(policy, "lead", "codex", []), /No available/);
});

test("room policy persists independently, validates coverage and rejects stale editors", async () => {
  const home = await temporary("alliance-policy-");
  let store = new RoomStore(home);
  try {
    for (const id of ["one", "two"])
      store.addRoom({
        id,
        title: id,
        cwd: `/fixture/${id}`,
        workspaceId: id,
        mission: "",
        artifacts: `${home}/${id}`,
        createdAt: "2026-10-12",
      });
    const original = store.modelPolicy("one");
    assert.equal(original.revision, 0);
    const changed = { ...original.policy, leadEffort: "high" as const };
    assert.equal(store.saveModelPolicy("one", changed, 0).revision, 1);
    assert.throws(() => store.saveModelPolicy("one", original.policy, 0), /changed elsewhere/);
    assert.throws(() => store.saveModelPolicy("one", { ...changed, routes: [] }, 1), /at least one/i);
    assert.equal(store.modelPolicy("two").policy.leadEffort, "medium");
    store.close();
    store = new RoomStore(home);
    assert.deepEqual(store.modelPolicy("one"), { policy: changed, revision: 1 });
    assert.equal(store.saveModelPolicy("one", original.policy, 1).revision, 2);
    assert.throws(() => store.modelPolicy("missing"), /Unknown room/);
  } finally {
    store.close();
  }
});
