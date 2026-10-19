import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { linkAgyAuth, setAgyAuthSource } from "../scripts/agy-auth.mjs";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { agyEffort, prepareAgySession } from "../server/agy-provider";
import { chooseModel } from "../server/model-policy";
import { allianceProvider } from "../server/runtime";
import { defaultModelPolicy } from "../shared/model-policy";
import { temporary } from "./temp";

async function fixture() {
  const root = await temporary("alliance-agy-test-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const executable = process.env.ALLIANCE_AGY_BINARY ?? "/usr/bin/false";
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false", agy: executable },
  });
  const profile = manifest.profiles["agy-peer"];
  const env = profileEnvironment(profile, home, {
    PATH: process.env.PATH,
    PASEO_AGENT_ID: "native-peer",
    ALLIANCE_BOUND_ROOM: "room",
    ALLIANCE_WORKSPACE_CWD: cwd,
    ANTIGRAVITY_GEMINI_DIR: "/daily",
    AGY_ACCOUNT: "ambient-account",
  });
  const config: ProviderSessionConfig = {
    cwd,
    env,
    systemPrompt: "Only this role's instructions.",
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6771/mcp/agents?callerAgentId=native-peer",
        headers: { Authorization: "Bearer synthetic-test" },
      },
    },
    settings: {},
    persist: true,
  };
  return { home, cwd, manifest, profile, config };
}

test("AGY roles isolate HOME and sessions without falling into Codex launch flags", async () => {
  const f = await fixture();
  assert.equal(Object.values(f.manifest.profiles).filter((p) => p.harness === "agy").length, 5);
  assert.equal(allianceProvider("alliance-agy-supervisor")?.role, "supervisor");
  assert.equal(f.config.env.ANTIGRAVITY_GEMINI_DIR, undefined);
  assert.equal(f.config.env.AGY_ACCOUNT, undefined);
  const a = await prepareAgySession(f.config),
    b = await prepareAgySession(f.config);
  try {
    assert.notEqual(a.path, b.path);
    const plan = await launchPlan(
      f.home,
      "agy-peer",
      ["--input-format", "stream-json"],
      { ...f.config.env, ALLIANCE_AGY_SESSION_DIR: a.path },
      f.cwd,
    );
    assert(plan.args.includes("--agent"));
    assert(!plan.args.includes("-c"));
    assert(!plan.args.includes("--no-daemon"));
    assert.equal(plan.env.HOME, f.profile.osHome);
    const mcpPath = join(a.path, ".agents/mcp_config.json");
    assert.equal((await stat(mcpPath)).mode & 0o777, 0o600);
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    assert.equal(
      mcp.mcpServers.paseo.serverUrl,
      f.config.mcpServers.paseo.type === "http" ? f.config.mcpServers.paseo.url : "",
    );
    await a.dispose();
    await assert.rejects(stat(a.path), { code: "ENOENT" });
    await stat(b.path);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

test("AGY rejects another agent's MCP endpoint and unqualified exact grants", async () => {
  const f = await fixture();
  await assert.rejects(
    prepareAgySession({
      ...f.config,
      mcpServers: {
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6771/mcp/agents?callerAgentId=someone-else",
        },
      },
    }),
    /not bound/,
  );
  await assert.rejects(
    prepareAgySession({
      ...f.config,
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "paseo", tool: "send_agent_message" }],
      },
    }),
    /not yet qualified/,
  );
});

test("AGY model IDs retain their actual effort and obey the room allowlist", () => {
  const id = "claude-sonnet-5-5-medium";
  const effort = agyEffort(id);
  assert.equal(effort, "medium");
  assert(effort);
  const catalog = [
    { id, provider: "alliance-agy-peer", label: id, thinkingOptions: [{ id: effort, label: effort }] },
  ];
  assert.equal(chooseModel(defaultModelPolicy(), "peer", "agy", catalog).model, id);
  assert.throws(() => chooseModel(defaultModelPolicy(), "peer", "agy", catalog, id, "high"), /No allowed/);
});

test("dedicated AGY auth links follow native refresh without copying tokens or replacing another login", async () => {
  const f = await fixture();
  const source = join(f.home, "dedicated-native-token");
  await writeFile(source, "synthetic-before", { mode: 0o600 });
  await setAgyAuthSource(f.home, source);
  await linkAgyAuth(f.home, f.profile);
  const destination = join(f.profile.osHome, ".gemini/antigravity-cli/antigravity-oauth-token");
  assert((await lstat(destination)).isSymbolicLink());
  assert.equal(await readlink(destination), source);
  await writeFile(`${source}.next`, "synthetic-refreshed", { mode: 0o600 });
  await rename(`${source}.next`, source);
  assert.equal(await readFile(destination, "utf8"), "synthetic-refreshed");
  await linkAgyAuth(f.home, f.profile);
  const other = f.manifest.profiles["agy-lead"];
  const otherPath = join(other.osHome, ".gemini/antigravity-cli");
  await mkdir(otherPath, { recursive: true });
  await writeFile(join(otherPath, "antigravity-oauth-token"), "different-login", { mode: 0o600 });
  await assert.rejects(linkAgyAuth(f.home, other), /refusing to replace/);
});

test("native AGY discovers the isolated generated agent", {
  skip: !process.env.ALLIANCE_AGY_BINARY,
}, async () => {
  const f = await fixture();
  const session = await prepareAgySession(f.config);
  try {
    const output = execFileSync(f.profile.executable, ["agents"], {
      cwd: session.path,
      env: f.config.env,
      encoding: "utf8",
      timeout: 20000,
    });
    assert(output.split("\n").includes(session.name));
  } finally {
    await session.dispose();
  }
});
