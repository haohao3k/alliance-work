import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { launchPlan } from "./launch.mjs";
import { projectRoot } from "./profiles.mjs";

const [homeArg, outputArg] = process.argv.slice(2);
if (!homeArg || !outputArg) throw new Error("Usage: acceptance-mobbin.mjs ALLIANCE_HOME NEW_OUTPUT");
const home = resolve(homeArg),
  output = resolve(outputArg);
await mkdir(output, { mode: 0o700 });
const expected = ["search_flows", "search_screens", "search_sections"];
const receipt = { native: [], remote: null };

async function native(harness, cwd) {
  const args =
    harness === "claude"
      ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
      : ["app-server"];
  const plan = await launchPlan(home, `${harness}-peer`, args, { PATH: process.env.PATH }, cwd);
  const child = spawn(plan.executable, plan.args, { env: plan.env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let serial = 0;
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const response = harness === "claude" ? event.response : event;
    const id = harness === "claude" ? response?.request_id : event.id;
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id);
    clearTimeout(item.timer);
    const error = response.error;
    if (error) item.reject(new Error(JSON.stringify(error)));
    else item.resolve(harness === "claude" ? response.response : event.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = String(++serial);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${harness} ${method} timeout`));
      }, 90000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify(
          harness === "claude"
            ? { type: "control_request", request_id: id, request: { subtype: method, ...params } }
            : { jsonrpc: "2.0", id, method, params },
        ) + "\n",
      );
    });
  child.on("error", (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  try {
    await request(
      "initialize",
      harness === "claude"
        ? {}
        : {
            clientInfo: { name: "alliance-mobbin-qualification", version: "1" },
            capabilities: { experimentalApi: true },
          },
    );
    if (harness === "codex") child.stdin.write('{"method":"initialized","params":{}}\n');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const result = await request(
        harness === "claude" ? "mcp_status" : "mcpServerStatus/list",
        harness === "claude" ? {} : { serverName: "mobbin" },
      );
      const server = (harness === "claude" ? result.mcpServers : result.data)?.find(
        (s) => s.name === "mobbin",
      );
      const tools =
        harness === "claude" ? (server?.tools ?? []).map((t) => t.name) : Object.keys(server?.tools ?? {});
      if (expected.every((name) => tools.some((tool) => tool === name || tool.endsWith(`__${name}`)))) {
        return { harness, cwd, server: server.name, status: server.status ?? server.runtimeStatus, tools };
      }
      if (server?.status === "failed" || server?.toolsError)
        throw new Error(server.error ?? server.toolsError);
      await new Promise((done) => setTimeout(done, 1000));
    }
    throw new Error(`${harness} did not discover all Mobbin tools`);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
try {
  for (const project of ["project-one", "project-two"]) {
    const cwd = join(output, project);
    await mkdir(cwd);
    for (const harness of ["claude", "codex"]) {
      const result = await native(harness, cwd);
      receipt.native.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, "scripts/mobbin.mjs"), home],
    stderr: "pipe",
  });
  const client = new Client({ name: "alliance-mobbin-qualification", version: "1" });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, expected);
    const result = await client.callTool(
      {
        name: "search_screens",
        arguments: {
          query: "login screen with email and password fields",
          platform: "web",
          mode: "standard",
          limit: 1,
          task_intent: "Verify the Mobbin MCP installation with one sample search",
          output_destination: "chat",
        },
      },
      undefined,
      { timeout: 90000 },
    );
    receipt.remote = {
      tools,
      isError: result.isError ?? false,
      contentTypes: result.content.map((c) => c.type),
      textPreview: result.content.filter((c) => c.type === "text").map((c) => c.text.slice(0, 350)),
    };
    assert(!result.isError, JSON.stringify(receipt.remote));
  } finally {
    await client.close();
  }
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
}
await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
