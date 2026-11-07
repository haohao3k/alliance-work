import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { launchPlan } from "../scripts/launch.mjs";
import { bundledPi } from "../scripts/pi-runtime.mjs";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

const exec = promisify(execFile);

test("Pi session-local MCP connects and calls only for canonical allowlisted project cwd", async () => {
  const root = await temporary("alliance-pi-scoped-");
  const home = join(root, "home");
  const roots = [join(root, "studio"), join(root, "workspace")];
  const other = join(root, "other"),
    prefix = `${roots[0]}-sibling`;
  for (const cwd of [...roots, ...roots.map((r) => join(r, "nested")), other, prefix])
    await mkdir(cwd, { recursive: true });
  const escaped = join(roots[0], "escape");
  await symlink(other, escaped);
  const alias = join(root, "alias");
  await symlink(roots[1], alias);
  const pi = await bundledPi(projectRoot);
  assert(pi);
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "roles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: pi.executable },
  });
  const helper = join(root, "echo.mjs");
  await writeFile(
    helper,
    `import {Server} from ${JSON.stringify(join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js"))};
import {StdioServerTransport} from ${JSON.stringify(join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js"))};
import {ListToolsRequestSchema,CallToolRequestSchema} from ${JSON.stringify(join(projectRoot, "node_modules/@modelcontextprotocol/sdk/dist/esm/types.js"))};
const s=new Server({name:"cwd-proof",version:"1"},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:"echo",description:"Return process cwd",inputSchema:{type:"object",properties:{}}}]}));
s.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:"text",text:JSON.stringify({cwd:process.cwd()})}]}));
await s.connect(new StdioServerTransport());`,
  );
  await writeFile(
    join(home, "scoped-mcp.json"),
    JSON.stringify({
      version: 1,
      projects: roots.map((root) => ({
        root,
        harnesses: ["pi"],
        servers: { fixture: { command: process.execPath, args: [helper] } },
      })),
    }),
    { mode: 0o600 },
  );
  const cases = [...roots, ...roots.map((r) => join(r, "nested")), alias].map((cwd) => ({
    cwd,
    allow: true,
  }));
  cases.push(...[root, other, prefix, escaped].map((cwd) => ({ cwd, allow: false })));
  for (const [index, { cwd, allow }] of cases.entries()) {
    const plan = await launchPlan(
      home,
      "pi-peer",
      ["--mode", "rpc", "--no-session"],
      { PATH: process.env.PATH },
      cwd,
    );
    assert.equal(
      plan.args.some((arg: string) => arg.endsWith("/scoped-mcp-pi.mjs")),
      allow,
      cwd,
    );
    const input = join(root, `plan-${index}.json`),
      output = join(root, `result-${index}.json`);
    await writeFile(input, JSON.stringify(plan));
    await exec(
      process.execPath,
      [join(projectRoot, "tests/pi-scoped-session.mjs"), input, output, allow ? "allow" : "deny"],
      {
        cwd,
        env: { ...plan.env, PI_OFFLINE: "1" },
        timeout: 45000,
        maxBuffer: 2000000,
      },
    );
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.registrations.includes("fixture"), allow);
    if (allow) assert(JSON.stringify(result.result).includes(await realpath(cwd)));
  }
});
