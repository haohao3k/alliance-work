import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import { roomsUnreadableBefore0118, sharesRouteAcrossRoles } from "../scripts/model-compat.mjs";
import { chooseModel } from "../server/model-policy";
import { RoomStore } from "../server/store";
import {
  Difficulty,
  defaultModelPolicy,
  ModelPolicy,
  policyInstruction,
  upgradeModelPolicy,
} from "../shared/model-policy";
import { temporary } from "./temp";

const model = (id: string, efforts = ["low", "medium", "high", "xhigh"]): AgentModelDefinition => ({
  id,
  provider: "fixture",
  label: id,
  aliases: id === "claude-opus-5-5" ? ["opus"] : undefined,
  thinkingOptions: efforts.map((effort) => ({ id: effort, label: effort })),
});
const catalog: AgentModelDefinition[] = [
  "gpt-6.1-sol",
  "gpt-6-astra",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "zai/glm-5.3",
  "izno-vps/ds/deepseek-v4.1-flash",
].map((id) => model(id));
// AGY model IDs carry their only effort.
const agy = ["low", "medium", "high"].map((effort) => model(`gemini-4-argon-${effort}`, [effort]));
const ranked = (policy: ReturnType<typeof defaultModelPolicy>, role: "peer" | "lens") =>
  policy.routes
    .filter((route) => route.role === role)
    .sort((a, b) => a.priority - b.priority)
    .map((route) => `${route.priority} ${route.harness}/${route.model} ${route.effort}`);

test("release defaults give Peer and Lens separate lists in the Human's order", () => {
  const policy = defaultModelPolicy();
  assert.deepEqual(ranked(policy, "peer"), [
    "1 claude/claude-sonnet-5-5 high",
    "2 claude/claude-sonnet-5-5 medium",
    "3 codex/gpt-6.1-sol high",
    "4 agy/gemini-4-argon-medium medium",
    "5 pi/zai/glm-5.3 high",
    "6 pi/izno-vps/ds/deepseek-v4.1-flash high",
  ]);
  assert.deepEqual(ranked(policy, "lens"), [
    "1 claude/claude-opus-5-5 medium",
    "2 codex/gpt-6-astra medium",
    "3 agy/gemini-4-argon-high high",
  ]);
  for (const route of policy.routes) assert.deepEqual(route.difficulties, Difficulty.options);
  assert.equal(ModelPolicy.safeParse(policy).success, true);
  const instruction = policyInstruction(policy, 0);
  assert.match(
    instruction,
    /Peer:\n- 1\. claude\/claude-sonnet-5-5, high\n- 2\. claude\/claude-sonnet-5-5, medium\n/,
  );
  assert.match(
    instruction,
    /Lens:\n- 1\. claude\/claude-opus-5-5, medium\n- 2\. codex\/gpt-6-astra, medium\n/,
  );
});

test("omitted worker models take the harness's first choice for that role", () => {
  const policy = defaultModelPolicy();
  const pick = (role: "peer" | "lens", harness: string, models = catalog) =>
    chooseModel(policy, role, harness, models);
  assert.deepEqual(pick("peer", "claude"), { model: "claude-sonnet-5-5", thinkingOptionId: "high" });
  assert.deepEqual(pick("lens", "claude"), { model: "claude-opus-5-5", thinkingOptionId: "medium" });
  assert.deepEqual(pick("peer", "codex"), { model: "gpt-6.1-sol", thinkingOptionId: "high" });
  assert.deepEqual(pick("lens", "codex"), { model: "gpt-6-astra", thinkingOptionId: "medium" });
  assert.deepEqual(pick("peer", "agy", agy), { model: "gemini-4-argon-medium", thinkingOptionId: "medium" });
  assert.deepEqual(pick("lens", "agy", agy), { model: "gemini-4-argon-high", thinkingOptionId: "high" });
  assert.deepEqual(pick("peer", "pi"), { model: "zai/glm-5.3", thinkingOptionId: "high" });
  // A route missing from this host's catalog is skipped for the next one, never substituted.
  assert.deepEqual(
    pick(
      "peer",
      "pi",
      catalog.filter((entry) => entry.id !== "zai/glm-5.3"),
    ),
    { model: "izno-vps/ds/deepseek-v4.1-flash", thinkingOptionId: "high" },
  );
  assert.deepEqual(
    pick(
      "peer",
      "claude",
      catalog.map((entry) => model(entry.id, ["medium"])),
    ),
    { model: "claude-sonnet-5-5", thinkingOptionId: "medium" },
  );
  assert.throws(() => pick("lens", "pi"), /No allowed.*no pi lens routes/);
  assert.throws(
    () =>
      pick(
        "lens",
        "claude",
        catalog.filter((entry) => entry.id !== "claude-opus-5-5"),
      ),
    /No allowed/,
  );
});

test("explicit worker choices must match that role's list exactly", () => {
  const policy = defaultModelPolicy();
  // The 0.1.17 default refused this Human-requested route.
  assert.deepEqual(chooseModel(policy, "peer", "claude", catalog, "claude-sonnet-5-5", "high"), {
    model: "claude-sonnet-5-5",
    thinkingOptionId: "high",
  });
  assert.equal(
    chooseModel(policy, "peer", "claude", catalog, "claude-sonnet-5-5", "medium").thinkingOptionId,
    "medium",
  );
  assert.equal(
    chooseModel(policy, "peer", "claude", catalog, "claude-sonnet-5-5").thinkingOptionId,
    "high",
    "an omitted effort takes the model's first-choice route",
  );
  assert.equal(chooseModel(policy, "lens", "claude", catalog, "opus", "medium").model, "claude-opus-5-5");
  // Each role's list is its own: a Lens route does not open the Peer list, or the reverse.
  assert.throws(
    () => chooseModel(policy, "peer", "claude", catalog, "claude-opus-5-5", "medium"),
    /No allowed/,
  );
  assert.throws(
    () => chooseModel(policy, "lens", "claude", catalog, "claude-sonnet-5-5", "high"),
    /No allowed/,
  );
  assert.throws(() => chooseModel(policy, "lens", "codex", catalog, "gpt-6.1-sol", "high"), /No allowed/);
  assert.throws(() => chooseModel(policy, "peer", "codex", catalog, "gpt-6-astra", "medium"), /No allowed/);
  assert.throws(() => chooseModel(policy, "peer", "codex", catalog, "gpt-6.1-sol", "medium"), /No allowed/);
  assert.throws(
    () => chooseModel(policy, "peer", "claude", catalog, "claude-sonnet-5-5", "xhigh"),
    (error: Error) =>
      error.message.includes("requested claude-sonnet-5-5 xhigh") &&
      error.message.includes("This room allows claude-sonnet-5-5 high; claude-sonnet-5-5 medium.") &&
      error.message.includes("Alliance Work → Models"),
  );
  assert.throws(
    () =>
      chooseModel(
        policy,
        "peer",
        "claude",
        catalog.map((entry) => model(entry.id, ["xhigh"])),
        "claude-sonnet-5-5",
        "high",
      ),
    /claude-sonnet-5-5 high \(not in the live catalog\)/,
  );
  assert.throws(() => chooseModel(policy, "peer", "codex", [], "gpt-6.1-sol", "high"), /unavailable/);
  // A route limited to some difficulties applies only there; native creation (no difficulty) checks all.
  const limited = {
    ...policy,
    routes: policy.routes.map((route) =>
      route.role === "peer" && route.effort === "medium" && route.harness === "claude"
        ? { ...route, difficulties: ["routine" as const] }
        : route,
    ),
  };
  assert.throws(
    () => chooseModel(limited, "peer", "claude", catalog, "claude-sonnet-5-5", "medium", "complex"),
    /No allowed.*for complex/,
  );
  assert.equal(
    chooseModel(limited, "peer", "claude", catalog, "claude-sonnet-5-5", "medium").thinkingOptionId,
    "medium",
  );
});

test("pre-0.1.18 saved routes apply to both Peer and Lens; reset returns a room to the release defaults", async () => {
  const home = await temporary("alliance-policy-legacy-");
  let store = new RoomStore(home);
  try {
    store.addRoom({
      id: "legacy",
      title: "legacy",
      cwd: "/fixture/legacy",
      workspaceId: "legacy",
      mission: "",
      artifacts: `${home}/legacy`,
      createdAt: "2026-10-12",
    });
    store.close();
    // Exactly the shape the 0.1.17 HQ saved for MBASC: one route, no role.
    const legacy = {
      leadEffort: "medium",
      routes: [
        {
          harness: "claude",
          model: "claude-sonnet-5-5",
          effort: "high",
          priority: 1,
          difficulties: ["routine", "standard", "complex", "frontier"],
        },
      ],
    };
    const db = new DatabaseSync(join(home, "rooms.sqlite"));
    db.prepare("INSERT INTO room_model_policies(roomId,revision,data) VALUES(?,?,?)").run(
      "legacy",
      1,
      JSON.stringify(legacy),
    );
    db.close();
    store = new RoomStore(home);
    const saved = store.modelPolicy("legacy");
    assert.equal(saved.revision, 1);
    assert.deepEqual(ranked(saved.policy, "peer"), ["1 claude/claude-sonnet-5-5 high"]);
    assert.deepEqual(ranked(saved.policy, "lens"), ["1 claude/claude-sonnet-5-5 high"]);
    assert.equal(
      chooseModel(saved.policy, "lens", "claude", catalog, "claude-sonnet-5-5", "high").model,
      "claude-sonnet-5-5",
    );
    // Saving the upgraded value writes the explicit per-role form.
    assert.equal(store.saveModelPolicy("legacy", saved.policy, 1).revision, 2);
    assert.deepEqual(
      upgradeModelPolicy(store.modelPolicy("legacy").policy),
      store.modelPolicy("legacy").policy,
    );
    const stale = store.modelPolicy("legacy");
    const { removed: _kept, ...reset } = store.resetModelPolicy("legacy");
    // Revisions keep counting through a reset; only the saved row is gone.
    assert.deepEqual(reset, { policy: defaultModelPolicy(), revision: 3, saved: false });
    assert.throws(() => store.saveModelPolicy("legacy", stale.policy, stale.revision), /changed elsewhere/);
    const fresh = store.saveModelPolicy("legacy", { ...reset.policy, leadEffort: "high" }, reset.revision);
    assert.deepEqual([fresh.revision, fresh.saved], [4, true]);
    // An editor opened before the reset still cannot overwrite the newer save (no revision reuse).
    assert.throws(() => store.saveModelPolicy("legacy", stale.policy, stale.revision), /changed elsewhere/);
    assert.throws(() => store.saveModelPolicy("legacy", reset.policy, reset.revision), /changed elsewhere/);
    assert.equal(store.resetModelPolicy("legacy").revision, 5);
    store.close();
    // Older releases read only room_model_policies: after a reset they see no row and use their defaults.
    const old = new DatabaseSync(join(home, "rooms.sqlite"));
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM room_model_policies").get()?.n, 0);
    old.close();
    store = new RoomStore(home);
    assert.deepEqual(store.modelPolicy("legacy"), {
      policy: defaultModelPolicy(),
      revision: 5,
      saved: false,
    });
    assert.throws(() => store.resetModelPolicy("missing"), /Unknown room/);
  } finally {
    store.close();
  }
});

test("every role must cover every difficulty and keys are unique per role", () => {
  const policy = defaultModelPolicy();
  const noLens = { ...policy, routes: policy.routes.filter((route) => route.role === "peer") };
  assert.match(
    ModelPolicy.safeParse(noLens).error?.message ?? "",
    /Allow at least one lens route for routine/,
  );
  const duplicate = { ...policy, routes: [...policy.routes, { ...policy.routes[0], priority: 9 }] };
  assert.match(ModelPolicy.safeParse(duplicate).error?.message ?? "", /only once/);
  // The same model/effort may appear once in each list.
  const both = { ...policy, routes: [...policy.routes, { ...policy.routes[0], role: "lens" as const }] };
  assert.equal(ModelPolicy.safeParse(both).success, true);
  // ...but releases before 0.1.18 cannot read that list, so rollback checks for it first.
  assert.equal(sharesRouteAcrossRoles(both), true);
  assert.equal(sharesRouteAcrossRoles(policy), false, "release defaults stay readable by 0.1.17");
});

test("Lead preferences permit deliberate overrides and fall back to available provider defaults", () => {
  const policy = defaultModelPolicy();
  assert.deepEqual(chooseModel(policy, "lead", "codex", catalog, "gpt-6.1-sol", "xhigh"), {
    model: "gpt-6.1-sol",
    thinkingOptionId: "xhigh",
  });
  assert.deepEqual(chooseModel(policy, "lead", "codex", catalog), {
    model: "gpt-6.1-sol",
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
    chooseModel(
      policy,
      "lead",
      "pi",
      [{ ...catalog[0], id: "other/model", thinkingOptions: [] }],
      "other/model",
    ),
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
    assert.deepEqual(store.modelPolicy("one"), { policy: changed, revision: 1, saved: true });
    assert.equal(store.saveModelPolicy("one", original.policy, 1).revision, 2);
    assert.throws(() => store.modelPolicy("missing"), /Unknown room/);
  } finally {
    store.close();
  }
});

test("omitted owner models stay economical; premium owners need an explicit choice", () => {
  const policy = defaultModelPolicy();
  // The live AGY catalog also lists Claude models; AGY owners still default to Gemini.
  const agyLive = [
    ...agy,
    ...["medium", "high"].map((effort) => model(`claude-sonnet-5-5-${effort}`, [effort])),
  ];
  for (const role of ["hq", "supervisor", "lead"] as const) {
    assert.equal(chooseModel(policy, role, "codex", catalog).model, "gpt-6.1-sol");
    assert.equal(chooseModel(policy, role, "claude", catalog).model, "claude-sonnet-5-5");
    assert.deepEqual(chooseModel(policy, role, "agy", agyLive), {
      model: "gemini-4-argon-medium",
      thinkingOptionId: "medium",
    });
    assert.equal(chooseModel(policy, role, "codex", catalog, "gpt-6-astra", "high").model, "gpt-6-astra");
    // Owners ignore the worker lists entirely.
    assert.equal(
      chooseModel(policy, role, "claude", catalog, "claude-opus-5-5", "xhigh").thinkingOptionId,
      "xhigh",
    );
    assert.throws(
      () =>
        chooseModel(
          policy,
          role,
          "codex",
          catalog.filter((m) => m.id === "gpt-6-astra"),
        ),
      /explicit|available/i,
    );
  }
  // An explicit saved room policy remains authoritative, including deliberate premium defaults.
  const opus = policy.routes.find((r) => r.role === "lens" && r.model === "claude-opus-5-5");
  assert(opus);
  const custom = {
    ...policy,
    routes: [
      ...policy.routes.map((r) => (r.role === "peer" ? { ...r, priority: r.priority + 1 } : r)),
      { ...opus, role: "peer" as const, priority: 1 },
    ],
  };
  assert.equal(chooseModel(custom, "peer", "claude", catalog).model, "claude-opus-5-5");
});

test("reset clears unreadable lists, never lowers the revision and can require the editor's revision", async () => {
  const home = await temporary("alliance-policy-reset-");
  let store = new RoomStore(home);
  try {
    for (const id of ["broken", "shared", "plain"])
      store.addRoom({
        id,
        title: `${id} room`,
        cwd: `/fixture/${id}`,
        workspaceId: id,
        mission: "",
        artifacts: `${home}/${id}`,
        createdAt: "2026-10-21",
      });
    const policy = defaultModelPolicy();
    store.saveModelPolicy(
      "shared",
      { ...policy, routes: [...policy.routes, { ...policy.routes[0], role: "lens" }] },
      0,
    );
    store.saveModelPolicy("plain", policy, 0);
    // Three resets push the counter to 3; then an older release saves a row at revision 1.
    for (let i = 0; i < 3; i++) store.resetModelPolicy("broken");
    store.close();
    const db = new DatabaseSync(join(home, "rooms.sqlite"));
    db.prepare("INSERT INTO room_model_policies(roomId,revision,data) VALUES(?,?,?)").run(
      "broken",
      1,
      JSON.stringify({ leadEffort: "medium", routes: [{ harness: "future", model: "x", effort: "high" }] }),
    );
    db.close();
    // The rollback check reads the database directly: no daemon or plugin needed. It names lists
    // that share a route across roles, and rows that are not even JSON.
    assert.deepEqual(roomsUnreadableBefore0118(home), ["shared room (shared)"]);
    const corrupt = new DatabaseSync(join(home, "rooms.sqlite"));
    corrupt.prepare("UPDATE room_model_policies SET data='{' WHERE roomId='plain'").run();
    corrupt.close();
    assert.deepEqual(roomsUnreadableBefore0118(home).sort(), ["plain room (plain)", "shared room (shared)"]);
    assert.deepEqual(roomsUnreadableBefore0118(join(home, "missing")), []);
    store = new RoomStore(home);
    assert.throws(() => store.modelPolicy("broken"), /Invalid/);
    // A page opened at revision 3 (before the older release saved) cannot reset the newer row.
    assert.throws(() => store.resetModelPolicy("broken", 3), /changed elsewhere/);
    const cleared = store.resetModelPolicy("broken");
    assert.deepEqual([cleared.revision, cleared.saved], [4, false], "max(row 1, counter 3) + 1");
    // The Models page passes the revision it shows (plain was saved once: revision 1).
    assert.throws(() => store.resetModelPolicy("plain", 0), /changed elsewhere/);
    const plain = store.resetModelPolicy("plain", 1);
    assert.equal(plain.saved, false);
    assert.deepEqual(roomsUnreadableBefore0118(home), ["shared room (shared)"]);
    // Each reset keeps the removed row byte for byte, even when it cannot be parsed; a room with
    // nothing saved has nothing to keep.
    assert.equal(cleared.removed?.revision, 1);
    assert.equal(plain.removed?.revision, 1);
    assert.equal(store.resetModelPolicy("plain").removed, undefined);
    const copies = new DatabaseSync(join(home, "rooms.sqlite"), { readOnly: true });
    const copy = (id?: number) =>
      copies.prepare("SELECT roomId, revision, data FROM room_model_policy_removed WHERE id=?").get(id ?? -1);
    assert.deepEqual(
      { ...copy(cleared.removed?.id) },
      {
        roomId: "broken",
        revision: 1,
        data: JSON.stringify({
          leadEffort: "medium",
          routes: [{ harness: "future", model: "x", effort: "high" }],
        }),
      },
    );
    assert.deepEqual({ ...copy(plain.removed?.id) }, { roomId: "plain", revision: 1, data: "{" });
    copies.close();
  } finally {
    store.close();
  }
});
