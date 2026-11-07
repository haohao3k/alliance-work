import assert from "node:assert/strict";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { profileEnvironment } from "../scripts/launch.mjs";
import {
  claudeAccountsState,
  importClaudeAccount,
  osCredentialStore,
  selectClaudeAccount,
  selectedClaudeCredentials,
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
