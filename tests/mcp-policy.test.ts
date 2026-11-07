import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { projectRoot } from "../scripts/profiles.mjs";
import { saveScopedProject, scopedMcpServers, scopedMcpState } from "../server/scoped-mcp.mjs";
import { temporary } from "./temp";

test("Human CLI saves, previews and removes a project without changing global Mobbin settings", async (t) => {
  const dir = await temporary("alliance-mcp-cli-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"),
    root = join(dir, "project");
  await Promise.all([mkdir(home), mkdir(root)]);
  const global = JSON.stringify({ version: 1, mobbin: { enabled: true, harnesses: ["codex"] } });
  await writeFile(join(home, "user-mcp.json"), global);
  const file = join(dir, "project.json");
  await writeFile(
    file,
    JSON.stringify({
      root,
      harnesses: ["codex"],
      servers: {
        fixture: { command: process.execPath, args: [], tools: { allow: [] } },
      },
    }),
  );
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [join(projectRoot, "scripts/cli.mjs"), "mcp", ...args, "--home", home], {
        encoding: "utf8",
        env: { ...process.env, PASEO_AGENT_ID: "", ALLIANCE_ROLE: "", ALLIANCE_BOUND_ROOM: "" },
      }),
    );
  const initial = cli("projects");
  const saved = cli("save", "--file", file, "--revision", initial.revision);
  assert.deepEqual(Object.keys(cli("preview", "--project", root, "--harness", "codex")).sort(), [
    "fixture",
    "mobbin",
  ]);
  assert.deepEqual(cli("preview", "--project", root, "--harness", "pi"), {});
  const removed = cli("remove", "--project", root, "--revision", saved.revision);
  assert.deepEqual(removed.config.projects, []);
  assert.equal(await readFile(join(home, "user-mcp.json"), "utf8"), global);
});

test("project MCP edits preserve other projects, reject stale writers and back up removed settings", async (t) => {
  const dir = await temporary("alliance-mcp-edit-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"),
    a = join(dir, "a"),
    b = join(dir, "b");
  await Promise.all([mkdir(a), mkdir(b)]);
  const server = { command: process.execPath, args: ["server.mjs"] };
  const initial = await scopedMcpState(home);
  const first = await saveScopedProject(
    home,
    a,
    { root: a, harnesses: ["codex"], servers: { sample: server } },
    initial.revision,
  );
  await assert.rejects(
    saveScopedProject(home, b, { root: b, harnesses: ["claude"], servers: {} }, initial.revision),
    /changed/,
  );
  const second = await saveScopedProject(
    home,
    b,
    { root: b, harnesses: ["claude"], servers: { other: server } },
    first.revision,
  );
  const nested = join(a, "nested");
  await mkdir(nested);
  await assert.rejects(
    saveScopedProject(
      home,
      nested,
      { root: nested, harnesses: ["codex"], servers: { sample: server } },
      second.revision,
    ),
    /colliding/,
  );
  assert.equal((await scopedMcpState(home)).revision, second.revision);
  const removed = await saveScopedProject(home, a, null, second.revision);
  assert.deepEqual(
    removed.config.projects.map((p) => p.root),
    [b],
  );
  assert.equal((await stat(join(home, "scoped-mcp.json"))).mode & 0o777, 0o600);
  const backups = await readdir(join(home, "configuration-backups"));
  assert.equal(backups.length, 2);
  assert(backups.some((name) => name.includes(second.revision)));
  const backupName = backups.find((name) => name.includes(second.revision));
  assert(backupName);
  const backup = JSON.parse(await readFile(join(home, "configuration-backups", backupName), "utf8"));
  assert.equal(backup.projects.length, 2);
  const concurrent = await Promise.allSettled([
    saveScopedProject(home, a, { root: a, harnesses: ["codex"], servers: {} }, removed.revision),
    saveScopedProject(home, b, null, removed.revision),
  ]);
  assert.equal(concurrent.filter((r) => r.status === "fulfilled").length, 1);
});

test("restricted MCP filters every discovery page and blocks direct denied calls before upstream execution", async (t) => {
  const dir = await temporary("alliance-mcp-filter-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, "home"),
    project = join(dir, "project");
  await mkdir(project);
  const calls = join(dir, "calls.jsonl");
  // Absolute SDK imports keep the fixture isolated from user MCP and credentials.
  const sdk = new URL("../node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url).href;
  const fixture = join(dir, "fixture.mjs");
  await writeFile(
    fixture,
    `
import {appendFile} from 'node:fs/promises';
import {Server} from '${sdk}server/index.js';
import {StdioServerTransport} from '${sdk}server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '${sdk}types.js';
const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
const tool=name=>({name,description:name,inputSchema:{type:'object',properties:{}}});
server.setRequestHandler(ListToolsRequestSchema,r=>r.params?.cursor ? {tools:[tool('read_second'),tool('write')]} : {tools:[tool('read'),tool('write')],nextCursor:'page2'});
server.setRequestHandler(CallToolRequestSchema,async r=>{await appendFile(${JSON.stringify(calls)},JSON.stringify(r.params)+'\\n');return {content:[{type:'text',text:process.cwd()}]};});
await server.connect(new StdioServerTransport());
// A long-lived MCP may need forced cleanup; the adapter must still close its input promptly.
setInterval(()=>{},1000);
process.on('SIGTERM',()=>{});
`,
  );
  const initial = await scopedMcpState(home);
  await saveScopedProject(
    home,
    project,
    {
      root: project,
      harnesses: ["codex"],
      servers: {
        fixture: {
          command: process.execPath,
          args: [fixture],
          tools: { allow: ["read", "read_second", "write"], deny: ["write"] },
        },
      },
    },
    initial.revision,
  );
  const selected = (await scopedMcpServers(home, "codex", projectRoot, project)).fixture;
  if (process.env.ALLIANCE_MCP_BASELINE_WRAPPER) selected.args[0] = process.env.ALLIANCE_MCP_BASELINE_WRAPPER;
  const client = new Client({ name: "policy-test", version: "1" });
  const transport = new StdioClientTransport({ ...selected, cwd: home, stderr: "pipe" });
  t.after(() => client.close());
  await client.connect(transport);
  const first = await client.listTools();
  assert.deepEqual(
    first.tools.map((tool) => tool.name),
    ["read"],
  );
  assert.equal(first.nextCursor, "page2");
  assert.deepEqual(
    (await client.listTools({ cursor: first.nextCursor })).tools.map((tool) => tool.name),
    ["read_second"],
  );
  assert.equal((await client.callTool({ name: "write", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "unlisted", arguments: {} })).isError, true);
  await assert.rejects(readFile(calls), { code: "ENOENT" });
  const result = await client.callTool({ name: "read", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: project }]);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  // MCP SDK 1.32 keeps the 10 MiB stdio bound introduced in 1.30. Prove the actual adapter
  // rejects an oversized request before executing upstream and closes the owned pipe,
  // allowing the SDK's two 2-second upstream shutdown grace periods.
  await assert.rejects(
    client.callTool({ name: "read", arguments: { oversized: "x".repeat(10 * 1024 * 1024) } }, undefined, {
      timeout: 10000,
    }),
    /closed|maximum size|EPIPE|write after end/i,
  );
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
});
