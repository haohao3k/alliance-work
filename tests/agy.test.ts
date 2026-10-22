import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import contribute from "../index.server";
import { linkAgyAuth, setAgyAuthSource } from "../scripts/agy-auth.mjs";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { enableMobbin } from "../scripts/user-mcp.mjs";
import { agyEffort, prepareAgySession } from "../server/agy-provider";
import { chooseModel } from "../server/model-policy";
import { allianceProvider } from "../server/runtime";
import { defaultModelPolicy } from "../shared/model-policy";
import { temporary } from "./temp";

async function fixture() {
  const root = await temporary("alliance-agy-test-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const executable = process.env.ALLIANCE_AGY_BINARY ?? "/usr/bin/false";
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false", agy: executable },
  });
  const profile = manifest.profiles["agy-peer"];
  const env = profileEnvironment(profile, home, {
    PATH: process.env.PATH,
    PASEO_AGENT_ID: "native-peer",
    ALLIANCE_BOUND_ROOM: "room",
    ALLIANCE_WORKSPACE_CWD: cwd,
    ANTIGRAVITY_GEMINI_DIR: "/daily",
    AGY_ACCOUNT: "ambient-account",
  });
  const config: ProviderSessionConfig = {
    cwd,
    env,
    systemPrompt: "Only this role's instructions.",
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6771/mcp/agents?callerAgentId=native-peer",
        headers: { Authorization: "Bearer synthetic-test" },
      },
    },
    settings: {},
    persist: true,
  };
  return { home, cwd, manifest, profile, config };
}

test("AGY roles isolate HOME and sessions without falling into Codex launch flags", async () => {
  const f = await fixture();
  assert.equal(Object.values(f.manifest.profiles).filter((p) => p.harness === "agy").length, 5);
  assert.equal(allianceProvider("alliance-agy-supervisor")?.role, "supervisor");
  assert.equal(f.config.env.ANTIGRAVITY_GEMINI_DIR, undefined);
  assert.equal(f.config.env.AGY_ACCOUNT, undefined);
  const a = await prepareAgySession(f.config),
    b = await prepareAgySession(f.config);
  try {
    assert.notEqual(a.path, b.path);
    const plan = await launchPlan(
      f.home,
      "agy-peer",
      ["--input-format", "stream-json"],
      { ...f.config.env, ALLIANCE_AGY_SESSION_DIR: a.path },
      f.cwd,
    );
    assert(plan.args.includes("--agent"));
    assert(!plan.args.includes("-c"));
    assert(!plan.args.includes("--no-daemon"));
    assert.equal(plan.env.HOME, f.profile.osHome);
    // AGY sessions launch through the same plan, so their commands do not wait for input either.
    assert.equal(plan.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");
    const mcpPath = join(a.path, ".agents/mcp_config.json");
    assert.equal((await stat(mcpPath)).mode & 0o777, 0o600);
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(
      mcp.mcpServers.paseo.serverUrl,
      f.config.mcpServers.paseo.type === "http" ? f.config.mcpServers.paseo.url : "",
    );
    await a.dispose();
    await assert.rejects(stat(a.path), { code: "ENOENT" });
    await stat(b.path);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("AGY rejects another agent's MCP endpoint and unqualified exact grants", async () => {
  const f = await fixture();
  await assert.rejects(
    prepareAgySession({
      ...f.config,
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6771/mcp/agents?callerAgentId=someone-else",
        },
      },
    }),
    /not bound/,
  );
  await assert.rejects(
    prepareAgySession({
      ...f.config,
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "paseo", tool: "send_agent_message" }],
      },
    }),
    /not yet qualified/,
  );
});

test("user Mobbin reaches all AGY roles and projects without replacing native Paseo or importing project MCP", async () => {
  const f = await fixture();
  await enableMobbin(f.home);
  for (const project of ["one", "two"]) {
    const cwd = join(f.cwd, project);
    await mkdir(join(cwd, ".agents"), { recursive: true });
    await writeFile(
      join(cwd, ".agents/mcp_config.json"),
      JSON.stringify({ mcpServers: { mobbin: { command: "project-spoof" } } }),
    );
    for (const role of ["hq", "supervisor", "lead", "peer", "lens"]) {
      const profile = f.manifest.profiles[`agy-${role}`];
      const config = {
        ...f.config,
        cwd,
        env: { ...f.config.env, HOME: profile.osHome, ALLIANCE_ROLE: role },
      };
      const session = await prepareAgySession(config);
      try {
        const mcp = JSON.parse(await readFile(join(session.path, ".agents/mcp_config.json"), "utf8"));
        assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ["mobbin", "paseo"]);
        assert.equal(mcp.mcpServers.mobbin.command, process.execPath);
        assert(mcp.mcpServers.mobbin.args.includes(f.home));
        assert(!JSON.stringify(mcp.mcpServers.mobbin).includes(cwd));
        assert.equal(mcp.mcpServers.paseo.headers.Authorization, "Bearer synthetic-test");
      } finally {
        await session.dispose();
      }
    }
  }
  await assert.rejects(
    prepareAgySession({
      ...f.config,
      mcpServers: { ...f.config.mcpServers, mobbin: { type: "stdio", command: "caller-spoof", args: [] } },
    }),
    /one native Paseo/,
  );
  await writeFile(
    join(f.home, "user-mcp.json"),
    JSON.stringify({ version: 1, mobbin: { enabled: false, harnesses: ["codex", "claude", "agy"] } }),
  );
  const session = await prepareAgySession(f.config);
  try {
    const mcp = JSON.parse(await readFile(join(session.path, ".agents/mcp_config.json"), "utf8"));
    assert.deepEqual(Object.keys(mcp.mcpServers), ["paseo"]);
  } finally {
    await session.dispose();
  }
});

test("AGY model IDs retain their actual effort and obey the room allowlist", () => {
  const catalog = ["gemini-4-argon-medium", "gemini-4-argon-high", "claude-sonnet-5-5-high"].map((id) => {
    const effort = agyEffort(id);
    assert(effort);
    return { id, provider: "alliance-agy-peer", label: id, thinkingOptions: [{ id: effort, label: effort }] };
  });
  assert.equal(agyEffort("gemini-4-argon-medium"), "medium");
  const policy = defaultModelPolicy();
  assert.equal(chooseModel(policy, "peer", "agy", catalog).model, "gemini-4-argon-medium");
  assert.equal(chooseModel(policy, "lens", "agy", catalog).model, "gemini-4-argon-high");
  assert.throws(
    () => chooseModel(policy, "peer", "agy", catalog, "gemini-4-argon-high", "high"),
    /No allowed/,
  );
});

test("AGY runs only Gemini models: no role launches another, and the Models page neither offers nor saves one", async () => {
  const f = await fixture();
  const live = [
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-high",
  ];
  const catalog = live.map((id) => {
    const effort = agyEffort(id) ?? "";
    return { id, provider: "alliance-agy-peer", label: id, thinkingOptions: [{ id: effort, label: effort }] };
  });
  const policy = defaultModelPolicy();
  // Owners may otherwise pick any live model; here no role may.
  for (const role of ["hq", "supervisor", "lead", "peer", "lens"] as const)
    assert.throws(
      () => chooseModel(policy, role, "agy", catalog, "claude-sonnet-5-5-high", "high"),
      /AGY runs only Gemini models/,
    );
  // A room list saved earlier with an AGY Claude route: launches skip it for the next route.
  const earlier = {
    ...policy,
    routes: [
      {
        ...policy.routes[0],
        harness: "agy" as const,
        model: "claude-sonnet-5-5-high",
        effort: "high" as const,
      },
      ...policy.routes.map((route) =>
        route.role === "peer" ? { ...route, priority: route.priority + 1 } : route,
      ),
    ],
  };
  assert.equal(chooseModel(earlier, "peer", "agy", catalog).model, "gemini-4-argon-medium");
  const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
  const dispose = contribute({
    registerProvider() {},
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { home: f.home } }),
      subscribe: () => () => {},
    }),
    // The daemon validates RPC input before the handler runs.
    handle: (
      rpc: { name: string; input: { parse(value: unknown): unknown } },
      handler: (input: unknown, context: unknown) => Promise<unknown>,
    ) => handlers.set(rpc.name, (input, context) => handler(rpc.input.parse(input), context)),
    on() {},
    before() {},
  } as unknown as PluginServerContext);
  try {
    const paseo = {
      workspaces: { open: async () => ({ id: "agy-workspace" }) },
      providers: { listModels: async () => ({ models: catalog }) },
    };
    const call = (method: string, input: unknown) => handlers.get(method)?.(input, { paseo });
    const room = (await call("rooms.create", { cwd: f.cwd })) as { id: string };
    const offered = (await call("models.catalog", { roomId: room.id, harness: "agy", role: "peer" })) as {
      models: { id: string }[];
    };
    assert.deepEqual(
      offered.models.map((model) => model.id),
      ["gemini-4-argon-medium", "gemini-4-argon-high"],
    );
    await assert.rejects(
      call("models.save", { roomId: room.id, policy: earlier, revision: 0 }) as Promise<unknown>,
      /AGY runs only Gemini models/,
    );
  } finally {
    await dispose();
  }
});

test("dedicated AGY auth links follow native refresh without copying tokens or replacing another login", async () => {
  const f = await fixture();
  const source = join(f.home, "dedicated-native-token");
  await writeFile(source, "synthetic-before", { mode: 0o600 });
  await setAgyAuthSource(f.home, source);
  await linkAgyAuth(f.home, f.profile);
  const destination = join(f.profile.osHome, ".gemini/antigravity-cli/antigravity-oauth-token");
  assert((await lstat(destination)).isSymbolicLink());
  assert.equal(await readlink(destination), source);
  await writeFile(`${source}.next`, "synthetic-refreshed", { mode: 0o600 });
  await rename(`${source}.next`, source);
  assert.equal(await readFile(destination, "utf8"), "synthetic-refreshed");
  await linkAgyAuth(f.home, f.profile);
  const other = f.manifest.profiles["agy-lead"];
  const otherPath = join(other.osHome, ".gemini/antigravity-cli");
  await mkdir(otherPath, { recursive: true });
  await writeFile(join(otherPath, "antigravity-oauth-token"), "different-login", { mode: 0o600 });
  await assert.rejects(linkAgyAuth(f.home, other), /refusing to replace/);
});

test("native AGY discovers the isolated generated agent", {
  skip: !process.env.ALLIANCE_AGY_BINARY,
}, async () => {
  const f = await fixture();
  const session = await prepareAgySession(f.config);
  try {
    const output = execFileSync(f.profile.executable, ["agents"], {
      cwd: session.path,
      env: f.config.env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert(output.split("\n").includes(session.name));
  } finally {
    await session.dispose();
  }
});
