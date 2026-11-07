import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const [planFile, output, expected] = process.argv.slice(2);
const plan = JSON.parse(await readFile(planFile, "utf8"));
const extensions = [];
for (let i = 0; i < plan.args.length; i++)
  if (plan.args[i] === "-e" && !plan.args[i + 1].startsWith("builtin:")) extensions.push(plan.args[i + 1]);
const settingsManager = SettingsManager.create(plan.cwd, process.env.PI_CODING_AGENT_DIR);
let registrations;
const resourceLoader = new DefaultResourceLoader({
  cwd: plan.cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noContextFiles: true,
  noPromptTemplates: true,
  noThemes: true,
  additionalExtensionPaths: extensions,
  extensionFactories: [
    createMcpExtension(),
    createCodemodeExtension(),
    createToolSearchExtension(),
    (pi) =>
      pi.on("session_start", () => {
        registrations = pi.getMcpServers().map((s) => s.name);
      }),
  ],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd: plan.cwd,
  agentDir: process.env.PI_CODING_AGENT_DIR,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(plan.cwd),
});
try {
  await session.bindExtensions({ mode: "rpc" });
  assert.equal(registrations.includes("fixture"), expected === "allow");
  if (expected === "allow") await session.prompt("/mcp reconnect fixture");
  const names = session.getCallableToolNames().filter((name) => name.startsWith("mcp__fixture__"));
  let result = { names };
  if (expected === "allow") {
    assert.deepEqual(names, ["mcp__fixture__echo"]);
    session.setActiveToolsByName([...session.getActiveToolNames(), "mcp__fixture__echo"]);
    const echo = session.agent.state.tools.find((tool) => tool.name === "mcp__fixture__echo");
    assert(echo);
    const reply = await echo.execute("scoped-proof", {}, new AbortController().signal);
    assert(!reply.isError);
    assert.equal(JSON.parse(reply.content[0].text).cwd, await realpath(plan.cwd));
    result = { names, reply };
  } else assert.deepEqual(names, []);
  await writeFile(output, JSON.stringify({ cwd: plan.cwd, registrations, expected, result }, null, 2));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  session.dispose();
}
