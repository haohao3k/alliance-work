import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ClaudeAccountId,
  ClaudeAccounts,
  ClaudeProjectAccounts,
  ClaudeRole,
  ClaudeRoomId,
  ClaudeSelection,
} from "../shared/claude-accounts.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

const hostSettings = "claude-accounts.json";
const projectSettings = "claude-project-accounts.json";
const ClaudeHostAccounts = ClaudeAccounts.omit({ projects: true });

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

/**
 * @template T
 * @param {string} path
 * @param {{parse(input: unknown): T}} schema
 * @param {unknown} defaults
 */
async function readSettings(path, schema, defaults) {
  try {
    return schema.parse(JSON.parse(await privateRead(path)));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Cannot read Claude account settings; repair the host configuration.");
    return schema.parse(defaults);
  }
}

export async function claudeAccountsState(home) {
  const [host, { projects }] = await Promise.all([
    readSettings(join(home, hostSettings), ClaudeHostAccounts, {
      version: 1,
      accounts: [],
      defaultAccount: "legacy",
    }),
    readSettings(join(home, projectSettings), ClaudeProjectAccounts, { version: 1 }),
  ]);
  const config = { ...host, projects };
  const revisionInput = Object.keys(projects).length ? config : host;
  return { config, revision: createHash("sha256").update(JSON.stringify(revisionInput)).digest("hex") };
}

async function edit(home, revision, change, target = hostSettings) {
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
    const { projects, ...host } = ClaudeAccounts.parse(await change(state.config));
    // One atomic file write under the same lock for both scopes. The host file's
    // shape remains readable by releases that predate project account selection.
    const value = target === projectSettings ? { version: 1, projects } : host;
    await atomicWrite(join(home, target), `${JSON.stringify(value, null, 2)}\n`);
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

/** @param {Awaited<ReturnType<typeof claudeAccountsState>>} state @param {string} roomId */
function projectAccountState({ config, revision }, roomId) {
  return { account: config.projects[roomId] ?? "inherit", accounts: config.accounts, revision };
}

export async function projectClaudeAccountState(home, roomId) {
  ClaudeRoomId.parse(roomId);
  return projectAccountState(await claudeAccountsState(home), roomId);
}

export async function selectProjectClaudeAccount(
  home,
  roomId,
  account,
  revision,
  store = osCredentialStore(home),
) {
  ClaudeRoomId.parse(roomId);
  if (account !== "inherit") ClaudeAccountId.parse(account);
  if (!revision) throw new Error("Claude accounts revision is required; reload before saving.");
  const state = await edit(
    home,
    revision,
    async (config) => {
      const projects = { ...config.projects };
      if (account === "inherit") delete projects[roomId];
      else {
        if (!config.accounts.includes(account)) throw new Error("Provision this account on this host first.");
        if (!(await store.get(account))) throw new Error("Selected credential is unavailable.");
        projects[roomId] = account;
      }
      return { ...config, projects };
    },
    projectSettings,
  );
  return projectAccountState(state, roomId);
}

/**
 * @param {import("zod").output<typeof ClaudeAccounts>} config
 * @param {import("zod").output<typeof ClaudeRole>} role
 * @param {string} [roomId]
 */
export function selectedClaudeAccount(config, role, roomId) {
  const projects = config.projects ?? {};
  const project = roomId && Object.hasOwn(projects, roomId) ? projects[roomId] : undefined;
  return project ?? config.roles[role] ?? config.defaultAccount;
}

/** @param {string} [roomId] */
export async function selectedClaudeLaunch(home, role, store = osCredentialStore(home), roomId) {
  const { config } = await claudeAccountsState(home);
  const account = selectedClaudeAccount(config, role, roomId);
  if (account === "legacy") return { account, credentials: null };
  if (!config.accounts.includes(account))
    throw new Error("Selected Claude account is not provisioned on this host.");
  const token = await store.get(account);
  if (!token) throw new Error("Selected Claude credential is unavailable; no fallback was used.");
  return { account, credentials: { CLAUDE_CODE_OAUTH_TOKEN: token } };
}

/** @param {string} [roomId] */
export async function selectedClaudeCredentials(home, role, store = osCredentialStore(home), roomId) {
  return (await selectedClaudeLaunch(home, role, store, roomId)).credentials;
}
