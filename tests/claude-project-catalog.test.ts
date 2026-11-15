import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  importClaudeAccount,
  selectedClaudeLaunch,
  selectProjectClaudeAccount,
} from "../server/claude-accounts.mjs";
import { ClaudeProjectCatalog } from "../server/claude-project-catalog.mjs";
import { temporary } from "./temp";

test("project Claude discovery uses the selected account and preserves the native curated catalog", async () => {
  const home = await temporary("claude-project-catalog-");
  const profile = { harness: "claude", role: "peer", home, osHome: home, executable: join(home, "claude") };
  await writeFile(
    profile.executable,
    `#!/usr/bin/env node
const assert = require("node:assert/strict");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  assert(!process.env.CLAUDE_CODE_OAUTH_TOKEN);
  console.log("2.1.321 (Claude Code)");
} else {
  assert(args.includes("--no-session-persistence"));
  assert(args.includes("--strict-mcp-config"));
  assert(!process.env.ANTHROPIC_API_KEY);
  const account = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert(["fixture-five", "fixture-twenty"].includes(account));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    assert.equal(request.type, "control_request");
    assert.equal(request.request.subtype, "initialize");
    const models = account === "fixture-twenty" ? [{ value: "claude-mythos-5-1" }] : [];
    console.log(JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: request.request_id,
        response: { models, commands: [], agents: [], output_style: "default", available_output_styles: [] },
      },
    }));
  });
}
`,
    { mode: 0o700 },
  );
  const tokens = new Map<string, string>();
  const store = {
    put: async (id: string, token: string) => void tokens.set(id, token),
    get: async (id: string) => tokens.get(id) ?? "",
  };
  const five = randomUUID();
  const twenty = randomUUID();
  const inherited = randomUUID();
  await importClaudeAccount(home, "5x", "fixture-five", store);
  const accounts = await importClaudeAccount(home, "20x", "fixture-twenty", store);
  const first = await selectProjectClaudeAccount(home, five, "5x", accounts.revision, store);
  await selectProjectClaudeAccount(home, twenty, "20x", first.revision, store);
  const catalog = new ClaudeProjectCatalog((home, role, _store, roomId) =>
    selectedClaudeLaunch(home, role, store, roomId),
  );
  const loadProfile = async () => profile;
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const [fiveModels, twentyModels, inheritedModels] = await Promise.all([
    catalog.list(sourceRoot, home, five, "peer", loadProfile),
    catalog.list(sourceRoot, home, twenty, "peer", loadProfile),
    catalog.list(sourceRoot, home, inherited, "peer", loadProfile),
  ]);
  assert.equal(inheritedModels, null);
  assert(!fiveModels?.some((model) => model.id === "claude-mythos-5-1"));
  assert(twentyModels?.some((model) => model.id === "claude-mythos-5-1"));
  const opus = fiveModels?.find((model) => model.id === "claude-opus-5-5");
  assert.equal(opus?.provider, "alliance-claude-peer");
  assert(opus?.thinkingOptions?.some(({ id }) => id === "medium"));
  assert(!JSON.stringify([fiveModels, twentyModels]).includes("fixture-"));
  tokens.delete("20x");
  await assert.rejects(
    catalog.list(sourceRoot, home, twenty, "peer", loadProfile),
    /credential is unavailable/,
  );
});
