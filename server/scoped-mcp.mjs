import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ScopedConfig, ScopedProject } from "../shared/scoped-mcp.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

export async function boundMcpCwd(root, cwd) {
  if (!isAbsolute(root) || !isAbsolute(cwd)) throw new Error("Scoped MCP paths must be absolute");
  const canonicalRoot = await realpath(root);
  const canonicalCwd = await realpath(cwd);
  if (canonicalRoot !== root || !(canonicalCwd === root || canonicalCwd.startsWith(`${root}/`)))
    throw new Error("Scoped MCP session is outside its canonical project root");
  return canonicalCwd;
}

// Operator-owned allowlist, never repository-provided MCP configuration.
export async function scopedMcpSettings(home) {
  const path = join(home, "scoped-mcp.json");
  await assertNoLinks(path);
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return ScopedConfig.parse({ version: 1, projects: [] });
  if (!info.isFile() || info.mode & 0o022)
    throw new Error("Scoped MCP allowlist must be a regular file without group/world write access");
  const config = ScopedConfig.parse(JSON.parse(await readFile(path, "utf8")));
  if (
    config.version !== 1 ||
    !Array.isArray(config.projects) ||
    Object.keys(config).some((key) => !["version", "projects"].includes(key))
  )
    throw new Error("Invalid scoped MCP allowlist");
  return config;
}

export async function scopedMcpState(home) {
  const config = await scopedMcpSettings(home);
  return { config, revision: createHash("sha256").update(JSON.stringify(config)).digest("hex") };
}

// Serialize read/compare/write across CLI and plugin processes; stale editors cannot overwrite changes.
export async function saveScopedProject(home, root, project, revision) {
  await assertNoLinks(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, ".scoped-mcp-lock");
  await mkdir(lock, { mode: 0o700 }).catch((error) => {
    if (error.code === "EEXIST") throw new Error("MCP settings are being edited; reload and retry");
    throw error;
  });
  try {
    const current = await scopedMcpState(home);
    if (current.revision !== revision) throw new Error("MCP settings changed; reload before saving");
    if (!isAbsolute(root)) throw new Error("Project path must be absolute");
    if (project !== null) {
      project = ScopedProject.parse(project);
      if (project.root !== root || (await realpath(root)) !== root)
        throw new Error("Choose the canonical project directory");
      for (const server of Object.values(project.servers)) {
        if (!isAbsolute(server.command)) throw new Error("MCP executable must be an absolute path");
      }
    }
    const config = ScopedConfig.parse({
      version: 1,
      projects: [
        ...current.config.projects.filter((entry) => entry.root !== root),
        ...(project ? [project] : []),
      ],
    });
    const path = join(home, "scoped-mcp.json");
    if (current.config.projects.length) {
      const backup = join(home, "configuration-backups", `scoped-mcp-${Date.now()}-${current.revision}.json`);
      await assertNoLinks(backup);
      await mkdir(join(home, "configuration-backups"), { recursive: true, mode: 0o700 });
      await writeFile(backup, `${JSON.stringify(current.config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    }
    await assertNoLinks(path);
    const staged = join(lock, "config.json");
    await writeFile(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(staged, path);
    return scopedMcpState(home);
  } finally {
    await rm(lock, { recursive: true });
  }
}

/** @returns {Promise<Record<string, {command: string, args: string[]}>>} */
export async function scopedMcpServers(home, harness, release, cwd) {
  if (!cwd || !["codex", "claude", "agy", "pi"].includes(harness)) return {};
  const config = await scopedMcpSettings(home);
  const canonicalCwd = await realpath(cwd);
  const servers = {};
  for (const project of config.projects) {
    if (
      !project ||
      typeof project.root !== "string" ||
      !isAbsolute(project.root) ||
      !Array.isArray(project.harnesses) ||
      project.harnesses.some((name) => !["codex", "claude", "agy", "pi"].includes(name)) ||
      !project.servers ||
      typeof project.servers !== "object" ||
      Array.isArray(project.servers) ||
      Object.keys(project).some((key) => !["root", "harnesses", "servers"].includes(key))
    )
      throw new Error("Invalid scoped MCP project");
    if (
      !project.harnesses.includes(harness) ||
      !(canonicalCwd === project.root || canonicalCwd.startsWith(`${project.root}/`))
    )
      continue;
    await boundMcpCwd(project.root, canonicalCwd);
    for (const [name, server] of Object.entries(project.servers)) {
      if (
        !/^[a-zA-Z0-9_-]+$/.test(name) ||
        ["paseo", "mobbin"].includes(name) ||
        Object.hasOwn(servers, name) ||
        !server ||
        typeof server.command !== "string" ||
        !isAbsolute(server.command) ||
        !Array.isArray(server.args) ||
        server.args.some((arg) => typeof arg !== "string") ||
        Object.keys(server).some((key) => !["command", "args", "tools"].includes(key))
      )
        throw new Error("Invalid or colliding scoped MCP server");
      servers[name] = {
        command: process.execPath,
        args: [
          join(release, "scripts/scoped-mcp.mjs"),
          project.root,
          canonicalCwd,
          server.command,
          JSON.stringify(server.args),
          ...(server.tools ? [JSON.stringify(server.tools)] : []),
        ],
      };
    }
  }
  return servers;
}
