import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import contribute from "../index.server";
import { discoverCodex } from "../scripts/codex-discovery.mjs";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
import { prepareAgySession } from "../server/agy-provider";
import { temporary } from "./temp";

async function fixture(native = false) {
  const root = await temporary("alliance-scoped-mcp-");
  const home = join(root, "home");
  const roots = [join(root, "studio"), join(root, "workspace")];
  const unrelated = join(root, "unrelated");
  const prefix = `${roots[0]}-sibling`;
  for (const cwd of [...roots, ...roots.map((r) => join(r, "nested")), unrelated, prefix])
    await mkdir(cwd, { recursive: true });
  const escapedCwd = join(roots[0], "escape");
  await symlink(unrelated, escapedCwd);
  const inbound = join(root, "alias");
  await symlink(roots[1], inbound);
  const codex = native
    ? spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).stdout.trim()
    : "/usr/bin/false";
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "roles"),
    executables: { codex, claude: "/usr/bin/false", pi: "/usr/bin/false", agy: "/usr/bin/false" },
  });
  await writeFile(
    join(home, "scoped-mcp.json"),
    JSON.stringify({
      version: 1,
      projects: roots.map((root) => ({
        root,
        harnesses: ["codex", "claude", "agy"],
        servers: { fixture: { command: process.execPath, args: ["-e", "console.log(process.cwd())"] } },
      })),
    }),
    { mode: 0o600 },
  );
  const cases = [...roots, ...roots.map((r) => join(r, "nested")), inbound].map((cwd) => ({
    cwd,
    allowed: true,
  }));
  cases.push(...[root, unrelated, prefix, escapedCwd].map((cwd) => ({ cwd, allowed: false })));
  return { root, home, roots, manifest, cases };
}

test("scoped servers survive Claude launch, Codex per-thread config and AGY session config only for canonical project sessions", async () => {
  const f = await fixture();
  const hooks = new Map<string, (...args: any[]) => any>();
  const dispose = contribute({
    registerProvider() {},
    registerUsageSource() {},
    handle() {},
    registerSettings: () => ({
      read: async () => ({ status: "ready", values: { home: f.home } }),
      subscribe: () => () => {},
    }),
    addHook: (name: string, handler: (...args: any[]) => any) => hooks.set(name, handler),
  } as unknown as PluginServerContext);
  const paseo = {
    agents: { ref: () => ({ refresh: async () => ({ agent: { model: selectedModel } }) }) },
    workspaces: {
      open: async () => ({
        id: "scoped-workspace",
        refresh: async () => ({ title: null }),
        setTitle: async () => ({}),
      }),
      ref: (id: string) => ({ id, refresh: async () => ({ title: null }), setTitle: async () => ({}) }),
    },
    providers: {
      listModels: async () => ({
        models: [{ id: "gpt-6.1-sol", label: "Sol", thinkingOptions: [{ id: "high", label: "high" }] }],
      }),
    },
  };
  const create = hooks.get("agent.create.before");
  assert(create);
  let selectedModel = "claude-opus-5-5";
  try {
    const open = hooks.get("agent.open.before");
    assert(open);
    const request = {
      agentId: "claude-resume",
      workspaceId: "scoped-workspace",
      provider: "alliance-claude-peer",
      cwd: f.roots[0],
      reason: "resume",
      purpose: "interactive",
      env: { ALLIANCE_SESSION_MODEL: "stale-inherited-model" },
    };
    const first = await open({ request }, { paseo });
    assert.equal(first.env.ALLIANCE_SESSION_MODEL, selectedModel);
    selectedModel = "claude-sonnet-5-5";
    const reopened = await open({ request }, { paseo });
    assert.equal(
      reopened.env.ALLIANCE_SESSION_MODEL,
      selectedModel,
      "later Human model changes win on resume",
    );
    for (const { cwd, allowed } of f.cases) {
      const request = {
        config: {
          provider: "alliance-codex-peer",
          model: "gpt-6.1-sol",
          cwd,
          mcpServers: {
            fixture: { type: "stdio", command: "caller-spoof" },
            unwanted: { type: "stdio", command: "caller-spoof" },
          },
        },
      };
      const created = await create({ request }, { paseo });
      assert.equal(!!created.config.mcpServers.fixture, allowed, `Codex thread: ${cwd}`);
      assert.equal(created.config.mcpServers.unwanted, undefined);
      const plan = await launchPlan(f.home, "claude-peer", ["-p"], {}, cwd);
      const servers = JSON.parse(plan.args[plan.args.indexOf("--mcp-config") + 1]).mcpServers;
      assert.equal(!!servers.fixture, allowed, `Claude: ${cwd}`);
      if (allowed) {
        const output = execFileSync(servers.fixture.command, servers.fixture.args, {
          cwd: f.root,
          encoding: "utf8",
        });
        const canonical = await import("node:fs/promises").then((fs) => fs.realpath(cwd));
        assert.equal(
          output.trim(),
          canonical,
          "subprocess is bound to session cwd despite different parent cwd",
        );
      }
      const profile = f.manifest.profiles["agy-peer"];
      const config: ProviderSessionConfig = {
        cwd,
        env: profileEnvironment(profile, f.home, {
          PATH: process.env.PATH,
          PASEO_AGENT_ID: "scoped-peer",
        }),
        mcpServers: {
          paseo: { type: "http", url: "http://localhost:6771/mcp/agents?callerAgentId=scoped-peer" },
        },
        settings: {},
        persist: false,
      };
      const session = await prepareAgySession(config);
      try {
        const agy = JSON.parse(await readFile(join(session.path, ".agents/mcp_config.json"), "utf8"));
        assert.equal(!!agy.mcpServers.fixture, allowed, `AGY: ${cwd}`);
        assert(agy.mcpServers.paseo);
      } finally {
        await session.dispose();
      }
    }
  } finally {
    await dispose();
  }
});

test("native Codex effective launcher config retains scoped servers without trusting project MCP", {
  skip: process.env.ALLIANCE_NATIVE_TESTS !== "1",
}, async () => {
  const f = await fixture(true);
  for (const { cwd, allowed } of f.cases) {
    const plan = await launchPlan(f.home, "codex-peer", ["app-server"], { PATH: process.env.PATH }, cwd);
    const flags: string[] = [];
    for (let i = 0; i < plan.args.length; i++) if (plan.args[i] === "-c") flags.push("-c", plan.args[++i]);
    const discovered = await discoverCodex(plan.executable, plan.env, cwd, flags);
    assert.equal(discovered.config.mcp_servers.fixture?.enabled === true, allowed, cwd);
  }
});

test("bound helper refuses cwd symlink escapes and prefix siblings before spawning", async () => {
  const f = await fixture();
  for (const cwd of [`${f.roots[0]}-sibling`, join(f.roots[0], "escape")]) {
    const run = spawnSync(
      process.execPath,
      [
        join(projectRoot, "scripts/scoped-mcp.mjs"),
        f.roots[0],
        cwd,
        process.execPath,
        JSON.stringify(["-e", "console.log('MUST_NOT_RUN')"]),
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 1);
    assert(!run.stdout.includes("MUST_NOT_RUN"));
    assert.match(run.stderr, /outside its canonical project root/);
  }
});
