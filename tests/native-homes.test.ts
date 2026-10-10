import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { discoverCodex } from "../scripts/codex-discovery.mjs";
import { launchPlan } from "../scripts/launch.mjs";
import { bundledPi } from "../scripts/pi-runtime.mjs";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
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
  const pi = await bundledPi(projectRoot);
  assert(pi);
  executables.pi = pi.executable;
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
    [
      "app-server",
      "-c",
      'mcp_servers={"explicit.sentinel"={command="/usr/bin/false"}}',
      "-c",
      "features.apps=true",
      "-c",
      "features.plugins=true",
      "-c",
      "features.remote_plugin=true",
    ],
    { PATH: process.env.PATH, ALLIANCE_WORKSPACE_CWD: f.cwd },
  );
  const flags: string[] = [];
  for (let i = 0; i < p.args.length; i++) if (p.args[i] === "-c") flags.push("-c", p.args[++i]);
  assert.equal(p.cwd, f.cwd);
  const discovered = await discoverCodex(p.executable, p.env, p.cwd, flags);
  assert.deepEqual(
    discovered.skills
      .filter((s: { enabled: boolean }) => s.enabled)
      .map((s: { name: string }) => s.name)
      .sort(),
    expected,
  );
  for (const name of ["apps", "plugins", "remote_plugin", "tool_suggest"])
    assert.equal(discovered.config.features[name], false);
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
  const metadata = join(f.root, "pi-metadata.json");
  const probe = join(f.root, "probe.mjs");
  await writeFile(
    probe,
    `import {writeFileSync} from "node:fs";
export default (pi) => pi.on("session_start", (_event, ctx) => {
  writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({
    tools: pi.getAllTools().map(t => t.name), systemPrompt: ctx.getSystemPrompt(),
    env: { home: process.env.HOME, role: process.env.PI_CODING_AGENT_DIR,
      cursorSystemCredentials: process.env.PI_CURSOR_SYSTEM_CREDENTIALS,
      antigravityExtraToolsDisabled: process.env.ANTIGRAVITY_NO_EXTRA_TOOLS }
  }));
});`,
  );
  await writeFile(join(f.cwd, ".pi/APPEND_SYSTEM.md"), "FOREIGN_PROJECT_INSTRUCTION_SENTINEL");
  await writeFile(join(f.root, "AGENTS.md"), "FOREIGN_ANCESTOR_INSTRUCTION_SENTINEL");
  p.args.push("-e", probe, "--append-system-prompt", "ALLIANCE_NATIVE_ROLE_SENTINEL");
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
  const extensions = response.data.commands.filter((c) => c.source === "extension").map((c) => c.name);
  for (const command of ["mcp", "devin-status", "antigravity.doctor", "cursor.doctor"])
    assert(extensions.includes(command), `Missing approved provider command: ${command}`);
  const actual = JSON.parse(await readFile(metadata, "utf8"));
  assert.equal(actual.env.home, p.env.HOME);
  assert.equal(actual.env.role, p.env.PI_CODING_AGENT_DIR);
  assert.equal(actual.env.cursorSystemCredentials, "0");
  assert.equal(actual.env.antigravityExtraToolsDisabled, "1");
  for (const tool of ["read", "bash", "edit", "write", "codemode", "tool_search"])
    assert(actual.tools.includes(tool), `Native capability missing: ${tool}`);
  assert(!actual.tools.some((name: string) => ["google_search", "generate_image"].includes(name)));
  assert(actual.systemPrompt.includes("ALLIANCE_NATIVE_ROLE_SENTINEL"));
  assert(!actual.systemPrompt.includes("FOREIGN_"));
});
