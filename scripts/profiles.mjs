import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoLinks,
  codexTrust,
  digest,
  managedDigest,
  nativeTrustFile,
} from "../server/profile-integrity.mjs";

export { assertNoLinks, digest, managedDigest, verifyProfile } from "../server/profile-integrity.mjs";

export const roles = ["hq", "supervisor", "lead", "peer", "lens"];
export const harnesses = ["codex", "claude", "pi"];
export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
/** @typedef {{harness:string,role:string,home:string,osHome:string,executable:string,files:Record<string,string>,skillDirectories:string[],skillEntries:string[]}} Profile */
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
/** @param {{home: string, executables: Record<string,string>, isolatedRoot?: string, root?: string}} options */
export async function prepareProfiles({ home, executables, isolatedRoot = undefined, root = projectRoot }) {
  home = resolve(home);
  root = resolve(root);
  if (!isAbsolute(home)) throw new Error("Alliance home must be absolute");
  await assertNoLinks(home);
  const prior = await loadManifest(home).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  isolatedRoot ??= prior?.isolatedRoot;
  const writes = new Map();
  const removals = [];
  const provenance = JSON.parse(await readFile(join(root, "vendor/seatwork/provenance.json"), "utf8"));
  const ownership = await readFile(join(root, "room/policies/agent-ownership.md"), "utf8");
  const operating = await readFile(join(root, "room/policies/operating-contract.md"), "utf8");
  const modelSelection = await readFile(join(root, "room/policies/model-selection.md"), "utf8");
  const mapping = await readFile(join(root, "room/policies/seatwork-mapping.md"), "utf8");
  const localSkills = [];
  const collect = async (directory) => {
    for (const name of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, name.name);
      if (name.isDirectory()) await collect(path);
      else if (name.isFile()) localSkills.push(path);
      else throw new Error(`Unsupported bundled skill: ${path}`);
    }
  };
  await collect(join(root, "room/skills"));
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

      const manage = async (path, bytes) => {
        const old = await readFile(path).catch((e) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (
          old &&
          managedDigest(profile, path, old) !== managedDigest(profile, path, bytes) &&
          managedDigest(profile, path, old) !== prior?.profiles[id]?.files[path]
        )
          throw new Error(`Refusing to overwrite unowned file: ${path}`);
        await assertNoLinks(path);
        if (old && nativeTrustFile(profile, path)) {
          bytes =
            managedDigest(profile, path, old) === managedDigest(profile, path, bytes)
              ? old
              : Buffer.from(
                  bytes.toString().trimEnd() + "\n" + (old.toString().match(codexTrust) ?? []).join("\n"),
                );
        }
        writes.set(path, bytes);
        profile.files[path] = managedDigest(profile, path, bytes);
      };
      const selected = provenance.files.filter((file) =>
        role === "lens"
          ? /\/peer\/(slp-challenge-premise|slp-evidence-report)\//.test(file.path)
          : file.path.startsWith(`vendor/seatwork/skills/${role}/`),
      );
      for (const file of [
        ...selected,
        ...localSkills.map((path) => ({ path: path.slice(root.length + 1), local: true, sha256: "" })),
      ]) {
        const bytes = await readFile(join(root, file.path));
        if (!file.local && digest(bytes) !== file.sha256)
          throw new Error(`Seatwork source bytes changed: ${file.path}`);
        const relative = file.path
          .split("/")
          .slice(file.local ? 2 : 4)
          .join("/");
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
      await manage(
        join(roleHome, "root-instructions.md"),
        `${ownership}\n\n${operating}\n\n${mapping}\n\n${modelSelection}\n\n${roleText}`,
      );
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
  // Validate the whole update before touching any managed file.
  for (const old of Object.values(prior?.profiles ?? {})) {
    for (const [path, hash] of Object.entries(old.files)) {
      if (Object.values(profiles).some((profile) => path in profile.files)) continue;
      await assertNoLinks(path);
      const bytes = await readFile(path).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (bytes && managedDigest(old, path, bytes) !== hash)
        throw new Error(`Refusing to remove modified managed file: ${path}`);
      if (bytes) removals.push(path);
    }
  }
  for (const profile of Object.values(profiles))
    await mkdir(profile.osHome, { recursive: true, mode: 0o700 });
  for (const [path, bytes] of writes) await atomicWrite(path, bytes);
  for (const path of removals) {
    await unlink(path);
    let parent = dirname(path);
    while (parent !== dirname(parent)) {
      try {
        await rmdir(parent);
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  const manifest = { version: 1, root, home, isolatedRoot, profiles };
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
