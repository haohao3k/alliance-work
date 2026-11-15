import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { contextCommand } from "../scripts/context-cli.mjs";
import { projectRoot } from "../scripts/profiles.mjs";

type Policy = { claudeWindow: number; roles: Record<string, number> };
function fixture() {
  const snapshot = {
    roomId: "room",
    policy: { claudeWindow: 300000, roles: { lens: 232000 } } as Policy,
    revision: "a".repeat(64),
    saved: true,
  };
  const calls: Array<{ method: string; input: unknown }> = [];
  const invoke = async (method: string, input: unknown) => {
    calls.push({ method, input });
    return snapshot;
  };
  return { snapshot, calls, invoke, actorId: null };
}

test("context show reads the requested room without saving, including inside an agent", async () => {
  const f = fixture();
  assert.equal(await contextCommand(["show"], { "--room": "room" }, { ...f, actorId: "agent" }), f.snapshot);
  assert.deepEqual(f.calls, [{ method: "context.read", input: { roomId: "room" } }]);
});

test("context set preserves other roles and uses the current revision and explicit Human identity", async () => {
  const f = fixture();
  await contextCommand(["set"], { "--room": "room", "--role": "peer", "--claude-window": "232000" }, f);
  assert.deepEqual(f.calls, [
    { method: "context.read", input: { roomId: "room" } },
    {
      method: "context.save",
      input: {
        roomId: "room",
        policy: { claudeWindow: 300000, roles: { lens: 232000, peer: 232000 } },
        revision: f.snapshot.revision,
        actorId: null,
      },
    },
  ]);
  assert.deepEqual(f.snapshot.policy.roles, { lens: 232000 });
});

test("context reset clears one override or resets the entire room to the default", async () => {
  for (const role of ["lens", undefined]) {
    const f = fixture();
    await contextCommand(["reset"], { "--room": "room", ...(role ? { "--role": role } : {}) }, f);
    assert.deepEqual(f.calls[1], {
      method: "context.save",
      input: {
        roomId: "room",
        policy: { claudeWindow: 300000, roles: {} },
        revision: f.snapshot.revision,
        actorId: null,
      },
    });
  }
});

test("context room defaults and unrelated role resets preserve existing overrides", async () => {
  const f = fixture();
  await contextCommand(["set"], { "--room": "room", "--claude-window": "232000" }, f);
  assert.deepEqual(f.calls[1], {
    method: "context.save",
    input: {
      roomId: "room",
      policy: { claudeWindow: 232000, roles: { lens: 232000 } },
      revision: f.snapshot.revision,
      actorId: null,
    },
  });
  f.calls.length = 0;
  await contextCommand(["reset"], { "--room": "room", "--role": "peer" }, f);
  assert.deepEqual(f.calls[1], {
    method: "context.save",
    input: { roomId: "room", policy: f.snapshot.policy, revision: f.snapshot.revision, actorId: null },
  });
});

test("context rejects agent writes and invalid options before reading or saving", async () => {
  for (const [action, flags, actorId] of [
    ["set", { "--room": "room", "--claude-window": "232000" }, "agent"],
    ["reset", { "--room": "room" }, "agent"],
    ["set", { "--room": "room", "--claude-window": "200000" }, null],
    ["set", { "--room": "room", "--claude-window": "232000", "--role": "unknown" }, null],
    ["set", { "--room": "room" }, null],
    ["show", {}, null],
    ["show", { "--room": "room", "--claude-window": "232000" }, null],
    ["reset", { "--room": "room", "--claude-window": "232000" }, null],
  ] as const) {
    const f = fixture();
    await assert.rejects(contextCommand([action], flags, { ...f, actorId }));
    assert.equal(f.calls.length, 0);
  }
});

test("context never retries a save rejected after a concurrent policy change", async () => {
  const f = fixture();
  let saves = 0;
  await assert.rejects(
    contextCommand(
      ["reset"],
      { "--room": "room" },
      {
        actorId: null,
        invoke: async (method: string, input: unknown) => {
          if (method === "context.save") {
            saves++;
            throw new Error("Context policy changed; refresh");
          }
          return f.invoke(method, input);
        },
      },
    ),
    /changed/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(saves, 1);
});

test("the context CLI recognizes controls and refuses an agent write before opening an installation", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(projectRoot, "scripts/cli.mjs"),
      "context",
      "set",
      "--room",
      "room",
      "--role",
      "peer",
      "--claude-window",
      "232000",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PASEO_AGENT_ID: "agent", ALLIANCE_WORK_HOME: "/nonexistent" },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Human/);
  assert.doesNotMatch(result.stderr, /Unknown option|Unknown command|No Alliance installation/);
});
