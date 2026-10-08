import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const roles = ["hq", "supervisor", "lead", "peer", "lens"];
export const harnesses = ["codex", "claude", "pi"];
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** @typedef {{harness:string,role:string,home:string,osHome:string,executable:string,files:Record<string,string>,skillDirectories:string[],skillEntries:string[]}} Profile */
export async function assertNoLinks(path) {
  const full = resolve(path);
  for (let current = full; current !== dirname(current); current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink is not an Alliance home: ${current}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
export async function atomicWrite(path, value) {
  await assertNoLinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
export async function loadManifest(home) {
  await assertNoLinks(home);
  return JSON.parse(await readFile(join(home, "profiles.json"), "utf8"));
}
export async function verifyProfile(profile) {
  await assertNoLinks(profile.home);
  await assertNoLinks(profile.osHome);
  for (const [path, expected] of Object.entries(profile.files)) {
    await assertNoLinks(path);
    if (digest(await readFile(path)) !== expected)
      throw new Error(`Managed profile file changed: ${path}. Reconcile before launch.`);
  }
  // A new untracked skill must not silently become part of an existing role.
  const known = new Set(profile.skillDirectories);
  for (const item of await readdir(join(profile.home, "skills"), { withFileTypes: true })) {
    if (item.name === ".system" && profile.harness === "codex") continue;
    const path = join(profile.home, "skills", item.name);
    if (item.isSymbolicLink() || !known.has(path)) throw new Error(`Unmanaged skill in role home: ${path}`);
  }
}
export async function prepareProfiles({ home, executables, isolatedRoot, root = projectRoot }) {
  home = resolve(home);
  if (!isAbsolute(home)) throw new Error("Alliance home must be absolute");
  await assertNoLinks(home);
  const prior = await loadManifest(home).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  const provenance = JSON.parse(await readFile(join(root, "vendor/seatwork/provenance.json"), "utf8"));
  const ownership = await readFile(join(root, "room/policies/agent-ownership.md"), "utf8");
  const operating = await readFile(join(root, "room/policies/operating-contract.md"), "utf8");
  /** @type {Record<string, Profile>} */
  const profiles = {};
  for (const harness of harnesses) {
    if (!isAbsolute(executables[harness] ?? ""))
      throw new Error(`An absolute ${harness} executable is required`);
    for (const role of roles) {
      const id = `${harness}-${role}`;
      const roleHome = join(
        isolatedRoot ? resolve(isolatedRoot, harness) : join(homedir(), `.${harness}-alliance-work`),
        role,
      );
      if (prior?.profiles[id] && prior.profiles[id].home !== roleHome)
        throw new Error(`Refusing to silently move ${id}'s login/session home`);
      /** @type {Profile} */
      const profile = {
        harness,
        role,
        home: roleHome,
        osHome: join(roleHome, "os-home"),
        executable: executables[harness],
        files: {},
        skillDirectories: [],
        skillEntries: [],
      };
      await assertNoLinks(roleHome);
      await mkdir(profile.osHome, { recursive: true, mode: 0o700 });
      const manage = async (path, bytes) => {
        const old = await readFile(path).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (old && digest(old) !== digest(bytes) && digest(old) !== prior?.profiles[id]?.files[path])
          throw new Error(`Refusing to overwrite unowned file: ${path}`);
        await atomicWrite(path, bytes);
        profile.files[path] = digest(bytes);
      };
      const selected = provenance.files.filter((file) =>
        role === "lens"
          ? /\/peer\/(slp-challenge-premise|slp-evidence-report)\//.test(file.path)
          : file.path.startsWith(`vendor/seatwork/skills/${role}/`),
      );
      for (const file of selected) {
        const bytes = await readFile(join(root, file.path));
        if (digest(bytes) !== file.sha256) throw new Error(`Seatwork source bytes changed: ${file.path}`);
        const relative = file.path.split("/").slice(4).join("/");
        const path = join(roleHome, "skills", relative);
        await manage(path, bytes);
        const skillDir = join(roleHome, "skills", relative.split("/")[0]);
        if (!profile.skillDirectories.includes(skillDir)) profile.skillDirectories.push(skillDir);
        if (relative.endsWith("/SKILL.md") && harness === "pi") {
          const name = relative.split("/")[0];
          const description = /^description: (.*)$/m.exec(bytes.toString())?.[1];
          if (!description) throw new Error(`Missing Seatwork description: ${file.path}`);
          const entry = join(roleHome, "pi-skill-index", name, "SKILL.md");
          await manage(
            entry,
            `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nRead and apply the exact Seatwork playbook at ${JSON.stringify(path)}. Resolve its references relative to that source file. The Alliance operating contract still applies.\n`,
          );
          profile.skillEntries.push(entry);
        }
      }
      const roleText = await readFile(join(root, "room/roles", `${role}.md`), "utf8");
      await manage(join(roleHome, "root-instructions.md"), `${ownership}\n\n${operating}\n\n${roleText}`);
      if (harness === "codex")
        await manage(join(roleHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
      if (harness === "claude")
        await manage(
          join(roleHome, "settings.json"),
          JSON.stringify(
            {
              disableBundledSkills: true,
              syncClaudeAiSkills: false,
              syncClaudeAiPlugins: false,
              disableClaudeAiConnectors: true,
              enabledPlugins: {},
            },
            null,
            2,
          ) + "\n",
        );
      if (harness === "pi") {
        await manage(join(roleHome, "settings.json"), JSON.stringify({ packages: [] }, null, 2) + "\n");
        await manage(join(roleHome, "mcp.json"), '{"mcpServers":{}}\n');
      }
      profiles[id] = profile;
    }
  }
  const manifest = { version: 1, root, home, profiles };
  await atomicWrite(join(home, "profiles.json"), JSON.stringify(manifest, null, 2) + "\n");
  const providers = Object.fromEntries(
    Object.entries(profiles).map(([id, profile]) => [
      `alliance-${id}`,
      {
        extends: profile.harness,
        label: `Alliance · ${profile.harness} · ${profile.role}`,
        command: [process.execPath, join(root, "scripts/launch.mjs"), home, id],
        enabled: true,
        paseoTools: { enabled: true },
      },
    ]),
  );
  await atomicWrite(join(home, "providers.json"), JSON.stringify(providers, null, 2) + "\n");
  return manifest;
}
