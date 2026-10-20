import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { discoverCodex } from "../scripts/codex-discovery.mjs";
import { launchPlan } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

test("user Mobbin reaches every Claude role across projects while project MCP stays excluded", async () => {
  const root = await temporary("alliance-user-mcp-");
  const home = join(root, "home");
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "roles"),
    executables: { claude: "/usr/bin/false", codex: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  await writeFile(
    join(home, "user-mcp.json"),
    JSON.stringify({ version: 1, mobbin: { enabled: true, harnesses: ["codex", "claude"] } }),
  );
  for (const project of ["one", "two"]) {
    const cwd = join(root, project);
    await mkdir(cwd);
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { mobbin: { command: "project-spoof" } } }),
    );
    for (const role of ["hq", "supervisor", "lead", "peer", "lens"]) {
      const paseo = { type: "http", url: "http://localhost:6771/mcp/agents?callerAgentId=fixture" };
      const plan = await launchPlan(
        home,
        `claude-${role}`,
        [
          "-p",
          "--mcp-config",
          JSON.stringify({
            mcpServers: { paseo, mobbin: { command: "caller-spoof" }, unexpected: { command: "false" } },
          }),
        ],
        {},
        cwd,
      );
      const config = JSON.parse(plan.args[plan.args.indexOf("--mcp-config") + 1]);
      assert.deepEqual(Object.keys(config.mcpServers).sort(), ["mobbin", "paseo"]);
      assert.deepEqual(config.mcpServers.paseo, paseo);
      assert.equal(config.mcpServers.mobbin.command, process.execPath);
      assert(config.mcpServers.mobbin.args.includes(home));
      assert(!JSON.stringify(config.mcpServers.mobbin).includes(cwd));
      assert(plan.args.includes("--strict-mcp-config"));
    }
  }
});

test("native Codex loads user Mobbin in unrelated projects and rejects project replacements", {
  skip: process.env.ALLIANCE_NATIVE_TESTS !== "1",
}, async () => {
  const root = await temporary("alliance-native-user-mcp-");
  const home = join(root, "home");
  const codex = spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).stdout.trim();
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "roles"),
    executables: { codex, claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  await writeFile(
    join(home, "user-mcp.json"),
    JSON.stringify({ version: 1, mobbin: { enabled: true, harnesses: ["codex", "claude"] } }),
  );
  for (const project of ["one", "two"]) {
    const cwd = join(root, project);
    await mkdir(join(cwd, ".codex"), { recursive: true });
    await writeFile(join(cwd, ".codex/config.toml"), '[mcp_servers.mobbin]\ncommand="project-spoof"\n');
    for (const role of ["hq", "supervisor", "lead", "peer", "lens"]) {
      const p = await launchPlan(home, `codex-${role}`, ["app-server"], { PATH: process.env.PATH }, cwd);
      const flags: string[] = [];
      for (let i = 0; i < p.args.length; i++) if (p.args[i] === "-c") flags.push("-c", p.args[++i]);
      const d = await discoverCodex(p.executable, p.env, cwd, flags);
      assert.equal(d.config.mcp_servers.mobbin.command, process.execPath);
      assert.equal(d.config.mcp_servers.mobbin.enabled, true);
      assert(d.config.mcp_servers.mobbin.args.includes(home));
    }
  }
});
