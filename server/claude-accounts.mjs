import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ClaudeAccountId, ClaudeAccounts, ClaudeRole, ClaudeSelection } from "../shared/claude-accounts.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

async function atomicWrite(path, value) {
  await assertNoLinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, value, { mode: 0o600, flag: "wx" });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

// Never attach subprocess errors/stdout/stderr to errors: they may contain credentials.
export function credentialCommand(command, args, input = "") {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const fail = () =>
      reject(new Error("OS credential store unavailable or locked; no account fallback was used."));
    const timer = setTimeout(() => {
      child.kill();
      fail();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 65536) {
        child.kill();
        fail();
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) fail();
      else resolveResult(output);
    });
    child.stdin.end(input);
  });
}

function key(home, id) {
  ClaudeAccountId.parse(id);
  return `alliance-claude-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 16)}-${id}`;
}

async function privateRead(path) {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077) throw new Error("Claude account file must be owner-only (0600).");
  return readFile(path, "utf8");
}

export function osCredentialStore(home, platform = process.platform, run = credentialCommand) {
  return {
    async put(id, token) {
      const name = key(home, id);
      // Restrict input before the security interactive command parser. Secret travels on stdin only.
      if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,4096}$/.test(token))
        throw new Error("Expected a Claude setup-token credential; token content was not logged.");
      if (platform === "darwin") {
        await run(
          "/usr/bin/security",
          ["-i"],
          `add-generic-password -U -a alliance-work -s ${name} -w ${token}\n`,
        );
      } else if (platform === "linux") {
        const encrypted = await run(
          "/usr/bin/systemd-creds",
          ["encrypt", "--user", "--with-key=host+tpm2", `--name=${name}`, "-", "-"],
          token,
        );
        await atomicWrite(join(home, "claude-secrets", `${id}.cred`), encrypted);
      } else throw new Error("No supported OS credential store on this host.");
    },
    async get(id) {
      const name = key(home, id);
      if (platform === "darwin")
        return (
          await run("/usr/bin/security", ["find-generic-password", "-a", "alliance-work", "-s", name, "-w"])
        ).trim();
      if (platform === "linux") {
        const encrypted = await privateRead(join(home, "claude-secrets", `${id}.cred`));
        return (
          await run(
            "/usr/bin/systemd-creds",
            ["decrypt", "--user", "--refuse-null", `--name=${name}`, "-", "-"],
            encrypted,
          )
        ).trim();
      }
      throw new Error("No supported OS credential store on this host.");
    },
  };
}

export async function claudeAccountsState(home) {
  let config;
  try {
    config = ClaudeAccounts.parse(JSON.parse(await privateRead(join(home, "claude-accounts.json"))));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Cannot read Claude account settings; repair the host configuration.");
    config = ClaudeAccounts.parse({ version: 1, accounts: [], defaultAccount: "legacy", roles: {} });
  }
  return { config, revision: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}

async function edit(home, revision, change) {
  await assertNoLinks(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, ".claude-accounts-lock");
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw new Error("Claude accounts are being edited; reload and retry.");
  });
  try {
    const state = await claudeAccountsState(home);
    if (revision && state.revision !== revision)
      throw new Error("Claude accounts changed; reload before saving.");
    const config = ClaudeAccounts.parse(await change(state.config));
    await atomicWrite(join(home, "claude-accounts.json"), `${JSON.stringify(config, null, 2)}\n`);
    return claudeAccountsState(home);
  } finally {
    await rm(lock, { recursive: true });
  }
}

export async function importClaudeAccount(home, id, token, store = osCredentialStore(home)) {
  ClaudeAccountId.parse(id);
  return edit(home, null, async (config) => {
    await store.put(id, token);
    // Verify persistence before advertising availability. Never return the secret.
    if ((await store.get(id)) !== token) throw new Error("Credential storage verification failed.");
    return { ...config, accounts: [...new Set([...config.accounts, id])] };
  });
}

export async function selectClaudeAccount(home, role, account, revision, store = osCredentialStore(home)) {
  if (role !== "default") ClaudeRole.parse(role);
  if (account !== "inherit") ClaudeSelection.parse(account);
  if (role === "default" && account === "inherit") throw new Error("Default account cannot inherit.");
  return edit(home, revision, async (config) => {
    if (!["inherit", "legacy"].includes(account)) {
      if (!config.accounts.includes(account)) throw new Error("Provision this account on this host first.");
      if (!(await store.get(account))) throw new Error("Selected credential is unavailable.");
    }
    if (role === "default") return { ...config, defaultAccount: account };
    const roles = { ...config.roles };
    if (account === "inherit") delete roles[role];
    else roles[role] = account;
    return { ...config, roles };
  });
}

export async function selectedClaudeCredentials(home, role, store = osCredentialStore(home)) {
  const { config } = await claudeAccountsState(home);
  const account = config.roles[role] ?? config.defaultAccount;
  if (account === "legacy") return null;
  if (!config.accounts.includes(account))
    throw new Error("Selected Claude account is not provisioned on this host.");
  const token = await store.get(account);
  if (!token) throw new Error("Selected Claude credential is unavailable; no fallback was used.");
  return { CLAUDE_CODE_OAUTH_TOKEN: token };
}
