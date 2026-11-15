import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { discoverCodex } from "../scripts/codex-discovery.mjs";
import { launchPlan } from "../scripts/launch.mjs";
import { bundledPi } from "../scripts/pi-runtime.mjs";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
import {
  claudeAccountsState,
  credentialCommand,
  importClaudeAccount,
  selectClaudeAccount,
} from "../server/claude-accounts.mjs";
import { temporary } from "./temp";

const enabled = process.env.ALLIANCE_NATIVE_TESTS === "1";
test("actual launcher reads the selected Keychain account without altering prior process environments", {
  skip: !enabled || process.platform !== "darwin",
}, async () => {
  const { home, cwd } = await fixture();
  const token = `sk-ant-oat01-${"synthetic_launcher_probe_".repeat(2)}`;
  const name = `alliance-claude-${createHash("sha256").update(home).digest("hex").slice(0, 16)}-5x`;
  try {
    const before = await launchPlan(home, "claude-hq", ["--version"], {}, cwd);
    const imported = await importClaudeAccount(home, "5x", token);
    await selectClaudeAccount(home, "default", "5x", imported.revision);
    const selected = await launchPlan(home, "claude-hq", ["--version"], {}, cwd);
    assert.equal(selected.env.CLAUDE_CODE_OAUTH_TOKEN, token);
    assert.equal(before.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    const state = await claudeAccountsState(home);
    await selectClaudeAccount(home, "hq", "legacy", state.revision);
    assert.equal(
      (await launchPlan(home, "claude-hq", ["--version"], {}, cwd)).env.CLAUDE_CODE_OAUTH_TOKEN,
      undefined,
    );
    assert.equal(selected.env.CLAUDE_CODE_OAUTH_TOKEN, token);
  } finally {
    await credentialCommand("/usr/bin/security", [
      "delete-generic-password",
      "-a",
      "alliance-work",
      "-s",
      name,
    ]).catch(() => {});
  }
});
async function fixture() {
  const root = await temporary("alliance-native-check-"),
    home = join(root, "home"),
    cwd = join(root, "repo");
  await mkdir(join(cwd, ".agents/skills/project-check"), { recursive: true });
  await writeFile(
    join(cwd, ".agents/skills/project-check/SKILL.md"),
    "---\nname: project-check\ndescription: Check selected project behavior.\n---\nInspect this project.\n",
  );
  await mkdir(join(cwd, ".alliance"));
  await writeFile(
    join(cwd, ".alliance/skills.json"),
    JSON.stringify({ version: 1, skills: [".agents/skills/project-check"] }),
  );
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

test("managed Claude removes Workflow from the native request shape and API tools", {
  skip: !enabled,
}, async () => {
  const f = await fixture();
  const captured: string[][] = [];
  const api = createServer(async (request, response) => {
    let bytes = "";
    for await (const part of request) bytes += part;
    const body = JSON.parse(bytes);
    if (request.url?.includes("count_tokens")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    captured.push(body.tools.map((tool: { name: string }) => tool.name));
    response.setHeader("content-type", "text/event-stream");
    const event = (type: string, data: object) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    event("message_start", {
      type: "message_start",
      message: {
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "OK" },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    event("message_stop", { type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  try {
    const manifest = JSON.parse(await readFile(join(f.home, "profiles.json"), "utf8"));
    const profile = manifest.profiles["claude-peer"];
    const address = api.address();
    assert(address && typeof address !== "string");
    await writeFile(
      join(profile.home, "credentials.env.json"),
      JSON.stringify({
        ANTHROPIC_API_KEY: "synthetic-loopback-only",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      }),
      { mode: 0o600 },
    );
    const readShape = async (directory: string, sessionId: string): Promise<string[] | undefined> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          const found = await readShape(path, sessionId);
          if (found) return found;
        } else if (entry.name.endsWith(".jsonl")) {
          for (const line of (await readFile(path, "utf8")).split("\n")) {
            if (!line.includes('"api-request-shape"')) continue;
            const shape = JSON.parse(line);
            if (shape.sessionId === sessionId)
              return shape.shape.tools.map((tool: { name: string }) => tool.name);
          }
        }
      }
    };
    for (const managed of [false, true]) {
      const sessionId = randomUUID();
      const plan = await launchPlan(
        f.home,
        "claude-peer",
        ["-p", "Reply OK.", "--model", "claude-sonnet-4-6", "--session-id", sessionId],
        { PATH: process.env.PATH },
        f.cwd,
      );
      if (!managed) {
        const baseline = join(f.root, "baseline-settings.json");
        const settings = JSON.parse(await readFile(join(profile.home, "settings.json"), "utf8"));
        await writeFile(baseline, JSON.stringify({ ...settings, disableWorkflows: false }));
        plan.args[plan.args.indexOf("--settings") + 1] = baseline;
      }
      plan.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      plan.env.DISABLE_AUTOUPDATER = "1";
      const child = spawn(plan.executable, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (part) => {
        output += part;
      });
      child.stderr.resume();
      const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      }).finally(() => clearTimeout(timeout));
      assert.equal(code, 0);
      assert.equal(output.trim(), "OK");
      const tools = await readShape(profile.home, sessionId);
      assert(tools, "Native transcript must record api-request-shape.tools");
      assert.equal(tools.includes("Workflow"), !managed);
      assert.equal(captured.at(-1)?.includes("Workflow"), !managed);
      for (const tool of ["Bash", "Read", "Edit", "Write"])
        assert(tools.includes(tool), `Missing native capability: ${tool}`);
    }
  } finally {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

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
const commonSkills = [
  "alliance-verify",
  "alliance-learn-from-failure",
  "alliance-test-audit",
  "alliance-blast-radius",
  "project-check",
];
for (const role of ["peer", "supervisor"]) {
  const expected = [
    ...commonSkills,
    ...(role === "peer"
      ? [
          "slp-candidate-handoff",
          "slp-challenge-premise",
          "slp-evidence-report",
          "slp-frontend-design",
          "slp-test-proof-debt-audit",
        ]
      : ["alliance-friction", "slp-decision-brief", "slp-intent-record", "slp-lead-handoff"]),
  ].sort();
  test(`native Codex ${role} only enables selected playbooks despite project and bundled discovery`, {
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
    const config = join(manifest.profiles[`codex-${role}`].home, "config.toml");
    await writeFile(
      config,
      (await readFile(config, "utf8")) + `\n[projects.${JSON.stringify(f.cwd)}]\ntrust_level = "trusted"\n`,
    );
    const p = await launchPlan(
      f.home,
      `codex-${role}`,
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
        "-c",
        "agents.enabled=true",
        "-c",
        "model_auto_compact_token_limit=1000000",
        "-c",
        'model_auto_compact_token_limit_scope="body_after_prefix"',
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
    assert.equal(discovered.config.agents.enabled, false);
    assert.notEqual(discovered.config.model_reasoning_effort, "low");
    assert.equal(discovered.config.model_auto_compact_token_limit, 300000);
    assert.equal(discovered.config.model_auto_compact_token_limit_scope, "total");
    assert.equal(discovered.config.mcp_servers?.["explicit.sentinel"]?.enabled, false);
    assert(
      !discovered.config.mcp_servers?.project_sentinel ||
        discovered.config.mcp_servers.project_sentinel.enabled === false,
    );
  });
  test(`native Claude ${role} loads role playbooks, excluding project customization`, {
    skip: !enabled,
  }, async () => {
    const f = await fixture();
    await mkdir(join(f.cwd, ".claude/skills/project-sentinel"), { recursive: true });
    await writeFile(
      join(f.cwd, ".claude/skills/project-sentinel/SKILL.md"),
      "---\nname: project-sentinel\ndescription: Isolation fixture.\n---\nSentinel.\n",
    );
    const p = await launchPlan(
      f.home,
      `claude-${role}`,
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
    for (const name of expected)
      assert(
        names.some((item) => item === name || item === `alliance-project:${name}`),
        `Missing ${name}: ${names.join(", ")}`,
      );
    assert(!names.includes("project-sentinel"));
    if (role === "peer") assert(!names.includes("alliance-friction"));
  });
  test(`native Pi ${role} retains builtin MCP and only discovers explicit playbooks`, {
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
      `pi-${role}`,
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
}
