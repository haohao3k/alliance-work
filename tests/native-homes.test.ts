import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { discoverCodex } from "../scripts/codex-discovery.mjs";
import { launchPlan } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

const enabled = process.env.ALLIANCE_NATIVE_TESTS === "1";
async function fixture() {
  const root = await temporary("alliance-native-check-"),
    home = join(root, "home"),
    cwd = join(root, "repo");
  await mkdir(cwd);
  const executables = Object.fromEntries(
    ["codex", "claude", "pi"].map((name) => [
      name,
      spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).stdout.trim(),
    ]),
  );
  await prepareProfiles({ home, isolatedRoot: join(root, "profiles"), executables });
  return { root, home, cwd };
}
type NativeCommand = { name: string; source?: string };
type ClaudeResponse = { response: { response: { commands: NativeCommand[] } } };
type PiResponse = { success: boolean; data: { commands: NativeCommand[] } };

async function nativeResponse<T>(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  input: unknown,
) {
  const child = spawn(executable, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Native metadata timeout")), 20000);
      child.on("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Native process exited ${code}`));
      });
      lines.on("line", (line) => {
        let m = null;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.type === "control_response" || m.id === "probe") {
          clearTimeout(timeout);
          resolve(m as T);
        }
      });
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
const expected = [
  "slp-candidate-handoff",
  "slp-challenge-premise",
  "slp-evidence-report",
  "slp-frontend-design",
  "slp-test-proof-debt-audit",
].sort();
test("native Codex only enables the selected Seatwork skills despite project and bundled discovery", {
  skip: !enabled,
}, async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, ".agents/skills/project-sentinel"), { recursive: true });
  await writeFile(
    join(f.cwd, ".agents/skills/project-sentinel/SKILL.md"),
    "---\nname: project-sentinel\ndescription: Isolation fixture.\n---\nSentinel.\n",
  );
  await mkdir(join(f.cwd, ".codex"));
  await writeFile(
    join(f.cwd, ".codex/config.toml"),
    'model_reasoning_effort = "low"\n[mcp_servers.project_sentinel]\ncommand="/usr/bin/false"\n',
  );
  const manifest = JSON.parse(await readFile(join(f.home, "profiles.json"), "utf8"));
  const config = join(manifest.profiles["codex-peer"].home, "config.toml");
  await writeFile(
    config,
    (await readFile(config, "utf8")) + `\n[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "trusted"\n`,
  );
  const p = await launchPlan(
    f.home,
    "codex-peer",
    ["app-server", "-c", 'mcp_servers={"explicit.sentinel"={command="/usr/bin/false"}}'],
    { PATH: process.env.PATH },
    f.cwd,
  );
  const flags: string[] = [];
  for (let i = 0; i < p.args.length; i++) if (p.args[i] === "-c") flags.push("-c", p.args[++i]);
  const discovered = await discoverCodex(p.executable, p.env, f.cwd, flags);
  assert.deepEqual(
    discovered.skills
      .filter((s: { enabled: boolean }) => s.enabled)
      .map((s: { name: string }) => s.name)
      .sort(),
    expected,
  );
  assert.notEqual(discovered.config.model_reasoning_effort, "low");
  assert.equal(discovered.config.mcp_servers?.["explicit.sentinel"]?.enabled, false);
  assert(
    !discovered.config.mcp_servers?.project_sentinel ||
      discovered.config.mcp_servers.project_sentinel.enabled === false,
  );
});
test("native Claude loads role skills, excluding project customization", { skip: !enabled }, async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, ".claude/skills/project-sentinel"), { recursive: true });
  await writeFile(
    join(f.cwd, ".claude/skills/project-sentinel/SKILL.md"),
    "---\nname: project-sentinel\ndescription: Isolation fixture.\n---\nSentinel.\n",
  );
  const p = await launchPlan(
    f.home,
    "claude-peer",
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    { PATH: process.env.PATH },
    f.cwd,
  );
  const response = await nativeResponse<ClaudeResponse>(p.executable, p.args, p.env, f.cwd, {
    type: "control_request",
    request_id: "probe",
    request: { subtype: "initialize" },
  });
  const names = response.response.response.commands.map((c: { name: string }) => c.name);
  for (const name of expected) assert(names.includes(name));
  assert(!names.includes("project-sentinel"));
});
test("native Pi retains builtin MCP and only discovers explicit Seatwork skills", {
  skip: !enabled,
}, async () => {
  const f = await fixture();
  await mkdir(join(f.cwd, ".pi/skills/project-sentinel"), { recursive: true });
  await writeFile(
    join(f.cwd, ".pi/skills/project-sentinel/SKILL.md"),
    "---\nname: project-sentinel\ndescription: Isolation fixture.\n---\nSentinel.\n",
  );
  const p = await launchPlan(
    f.home,
    "pi-peer",
    ["--mode", "rpc", "--no-session"],
    { PATH: process.env.PATH },
    f.cwd,
  );
  p.env.PI_OFFLINE = "1";
  const response = await nativeResponse<PiResponse>(p.executable, p.args, p.env, f.cwd, {
    id: "probe",
    type: "get_commands",
  });
  assert.equal(response.success, true);
  assert.deepEqual(
    response.data.commands
      .filter((c: NativeCommand) => c.source === "skill")
      .map((c: NativeCommand) => c.name.replace(/^skill:/, ""))
      .sort(),
    expected,
  );
  assert(response.data.commands.some((c: NativeCommand) => c.name === "mcp" && c.source === "extension"));
});
