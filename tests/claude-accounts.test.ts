import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import {
  claudeAccountsState,
  importClaudeAccount,
  osCredentialStore,
  projectClaudeAccountState,
  selectClaudeAccount,
  selectedClaudeCredentials,
  selectProjectClaudeAccount,
} from "../server/claude-accounts.mjs";
import { temporary } from "./temp";

function fixtureStore() {
  const values = new Map<string, string>();
  return {
    values,
    put: async (id: string, token: string) => {
      values.set(id, token);
    },
    get: async (id: string) => {
      if (!values.has(id)) throw new Error("locked or missing");
      return values.get(id)!;
    },
  };
}

test("host default and role override affect only future launch environments; metadata never contains tokens", async () => {
  const home = await temporary("claude-accounts-");
  const other = await temporary("claude-other-host-");
  const store = fixtureStore();
  assert.equal(await selectedClaudeCredentials(home, "hq", store), null);
  await importClaudeAccount(home, "5x", "private-five", store);
  let state = await importClaudeAccount(home, "20x", "private-twenty", store);
  state = await selectClaudeAccount(home, "default", "5x", state.revision, store);
  const profile = { harness: "claude", role: "hq", home: "/role", osHome: "/private" };
  const credential = await selectedClaudeCredentials(home, "hq", store);
  assert(credential);
  const existing = profileEnvironment(profile, home, {}, credential);
  state = await selectClaudeAccount(home, "default", "20x", state.revision, store);
  await selectClaudeAccount(home, "peer", "5x", state.revision, store);
  assert.equal(existing.CLAUDE_CODE_OAUTH_TOKEN, "private-five");
  for (const role of ["hq", "supervisor", "lead", "lens"])
    assert.deepEqual(await selectedClaudeCredentials(home, role, store), {
      CLAUDE_CODE_OAUTH_TOKEN: "private-twenty",
    });
  assert.deepEqual(await selectedClaudeCredentials(home, "peer", store), {
    CLAUDE_CODE_OAUTH_TOKEN: "private-five",
  });
  assert.equal(await selectedClaudeCredentials(other, "hq", store), null);
  const raw = await readFile(join(home, "claude-accounts.json"), "utf8");
  assert(!raw.includes("private-"));
  assert(!JSON.stringify(await claudeAccountsState(home)).includes("private-"));
});

test("missing/locked credentials, stale edits and tampered files fail closed", async () => {
  const home = await temporary("claude-accounts-fail-");
  const store = fixtureStore();
  const initial = await claudeAccountsState(home);
  await assert.rejects(selectClaudeAccount(home, "default", "20x", initial.revision, store), /Provision/);
  const state = await importClaudeAccount(home, "5x", "private-five", store);
  await assert.rejects(selectClaudeAccount(home, "default", "5x", initial.revision, store), /changed/);
  await selectClaudeAccount(home, "default", "5x", state.revision, store);
  store.values.clear();
  await assert.rejects(selectedClaudeCredentials(home, "hq", store), /locked/);
  const file = join(home, "claude-accounts.json");
  await chmod(file, 0o644);
  await assert.rejects(claudeAccountsState(home), /Cannot read/);
  await chmod(file, 0o600);
  await writeFile(file, "secret-invalid-json");
  await assert.rejects(
    claudeAccountsState(home),
    (error: Error) => !error.message.includes("secret-invalid"),
  );
  const linked = await temporary("claude-accounts-link-");
  await symlink(file, join(linked, "claude-accounts.json"));
  await assert.rejects(claudeAccountsState(linked), /Cannot read/);
});

test("a bound Claude resume fails closed on an unavailable project credential", async () => {
  const root = await temporary("claude-project-launch-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  const roomId = randomUUID();
  const workspaceRoom = randomUUID();
  await mkdir(cwd);
  await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  await writeFile(
    join(home, "claude-project-accounts.json"),
    JSON.stringify({ version: 1, projects: { [roomId]: "20x" } }),
    { mode: 0o600 },
  );
  const env = {
    ALLIANCE_CLAUDE_ROOM: roomId,
    ALLIANCE_BOUND_ROOM: workspaceRoom,
    ALLIANCE_WORKSPACE_CWD: cwd,
  };
  await assert.rejects(
    launchPlan(home, "claude-hq", ["--resume", "session"], { ...env, PASEO_AGENT_ID: "retained" }, cwd),
    /not provisioned/,
  );
  const terminal = await launchPlan(home, "claude-hq", ["--resume", "session"], env, cwd);
  assert.equal("claudeAccount" in terminal && terminal.claudeAccount, "legacy");
});

test("project account selection uses the host revision and Inherit restores the role or default", async () => {
  const home = await temporary("claude-project-accounts-");
  const store = fixtureStore();
  const project = randomUUID();
  const other = randomUUID();
  const initial = await projectClaudeAccountState(home, project);
  assert.equal(initial.account, "inherit");
  await assert.rejects(selectProjectClaudeAccount(home, project, "5x", initial.revision, store), /Provision/);
  await importClaudeAccount(home, "5x", "private-five", store);
  const imported = await importClaudeAccount(home, "20x", "private-twenty", store);
  const host = await selectClaudeAccount(home, "default", "20x", imported.revision, store);
  const role = await selectClaudeAccount(home, "peer", "5x", host.revision, store);
  const hostPath = join(home, "claude-accounts.json");
  const hostBytes = await readFile(hostPath, "utf8");
  const selected = await selectProjectClaudeAccount(home, project, "5x", role.revision, store);
  assert.equal(selected.account, "5x");
  assert.notEqual(selected.revision, role.revision);
  assert.equal(await readFile(hostPath, "utf8"), hostBytes, "older releases can still read host settings");
  const updated = await selectProjectClaudeAccount(home, project, "20x", selected.revision, store);
  assert.deepEqual(await projectClaudeAccountState(home, project), updated);
  assert.equal((await projectClaudeAccountState(home, other)).account, "inherit");
  assert.deepEqual(await selectedClaudeCredentials(home, "peer", store, project), {
    CLAUDE_CODE_OAUTH_TOKEN: "private-twenty",
  });
  assert.deepEqual(await selectedClaudeCredentials(home, "peer", store, other), {
    CLAUDE_CODE_OAUTH_TOKEN: "private-five",
  });
  await assert.rejects(selectClaudeAccount(home, "peer", "20x", role.revision, store), /changed/);
  const changedHost = await selectClaudeAccount(home, "default", "5x", updated.revision, store);
  await assert.rejects(
    selectProjectClaudeAccount(home, project, "inherit", updated.revision, store),
    /changed/,
  );
  store.values.delete("20x");
  await assert.rejects(selectedClaudeCredentials(home, "peer", store, project), /locked/);
  const inherited = await selectProjectClaudeAccount(home, project, "inherit", changedHost.revision, store);
  assert.equal(inherited.account, "inherit");
  assert.deepEqual((await claudeAccountsState(home)).config.projects, {});
  assert.deepEqual(await selectedClaudeCredentials(home, "hq", store, project), {
    CLAUDE_CODE_OAUTH_TOKEN: "private-five",
  });
  assert(!JSON.stringify(await projectClaudeAccountState(home, project)).includes("private-"));
});

test("OS stores pass tokens on stdin, reject command injection and never store plaintext on Linux", async () => {
  const home = await temporary("claude-os-store-");
  const token = `sk-ant-oat01-${"x".repeat(30)}`;
  const calls: { command: string; args: string[]; input: string }[] = [];
  const run = async (command: string, args: string[], input = "") => {
    calls.push({ command, args, input });
    return args[0] === "encrypt" ? "ciphertext" : token;
  };
  const mac = osCredentialStore(home, "darwin", run);
  await mac.put("5x", token);
  assert.equal(calls[0].args.includes(token), false);
  assert.equal(calls[0].input.includes(token), true);
  await assert.rejects(mac.put("5x", `${token}\ndelete-keychain`), /Expected/);
  const linux = osCredentialStore(home, "linux", run);
  await linux.put("20x", token);
  assert.equal(await readFile(join(home, "claude-secrets/20x.cred"), "utf8"), "ciphertext");
  assert.equal(await linux.get("20x"), token);
  assert(calls[1].args.includes("--with-key=host+tpm2"));
  assert(calls[2].args.includes("--refuse-null"));
});
