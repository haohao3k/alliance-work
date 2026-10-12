import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { assertNoLinks } from "../server/profile-integrity.mjs";

const execute = promisify(execFile);
const Manifest = z
  .object({
    version: z.literal(1),
    skills: z.array(z.string().regex(/^\.agents\/skills\/[a-z0-9][a-z0-9-]{0,63}$/)).max(100),
  })
  .strict();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function projectRootFor(cwd) {
  const path = await realpath(cwd);
  try {
    return (await execute("git", ["rev-parse", "--show-toplevel"], { cwd: path })).stdout.trim();
  } catch {
    return path;
  }
}

/** @param {string} cwd @param {{version:1, skills:string[]}|undefined} selection */
export async function projectSkills(cwd, selection = undefined) {
  const root = await projectRootFor(cwd);
  const path = join(root, ".alliance/skills.json");
  await assertNoLinks(path);
  const text = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const manifest =
    selection ?? (text === null ? { version: 1, skills: [] } : Manifest.parse(JSON.parse(text)));
  if (new Set(manifest.skills).size !== manifest.skills.length) throw new Error("Duplicate project skill");
  const skills = [];
  let bytes = 0;
  for (const entry of manifest.skills) {
    const directory = join(root, entry);
    await assertNoLinks(directory);
    const files = [];
    const walk = async (dir) => {
      for (const name of (await readdir(dir)).sort()) {
        const file = join(dir, name);
        const stat = await lstat(file);
        if (stat.isSymbolicLink()) throw new Error(`Project skill contains a symlink: ${file}`);
        if (stat.isDirectory()) await walk(file);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > 16 * 1024 * 1024 || files.length >= 1000)
            throw new Error("Project skill bundle exceeds 16 MiB / 1000 files");
          const content = await readFile(file);
          files.push({
            path: relative(directory, file),
            digest: hash(content),
            mode: stat.mode & 0o111,
            content,
          });
        } else throw new Error(`Unsupported project skill file: ${file}`);
      }
    };
    await walk(directory);
    const body = files.find((file) => file.path === "SKILL.md")?.content.toString();
    const frontmatter = body?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    if (!frontmatter) throw new Error(`Missing skill frontmatter: ${directory}`);
    const metadata = parse(frontmatter);
    const name = entry.split("/").at(-1);
    if (metadata?.name !== name || typeof metadata.description !== "string" || !metadata.description.trim())
      throw new Error(`Skill name must match its folder and have a description: ${entry}`);
    if (name.startsWith("slp-") || name.startsWith("alliance-"))
      throw new Error(`Reserved role skill name: ${name}`);
    skills.push({ name, description: metadata.description, directory, files });
  }
  const digest = hash(
    JSON.stringify(
      skills.map(({ name, files }) => ({
        name,
        files: files.map(({ path, digest, mode }) => ({ path, digest, mode })),
      })),
    ),
  );
  return { root, digest, skills };
}

// Claude's explicit plugin directory contains only selected skills, never a project's
// settings, hooks, MCP servers or arbitrary plugin manifest. Content-addressed per project.
export async function claudeSkillPlugin(home, bundle) {
  if (!bundle.skills.length) return null;
  const parent = join(home, "project-skills", hash(bundle.root));
  const destination = join(parent, bundle.digest);
  const pluginManifest = JSON.stringify({ name: "alliance-project", version: "1.0.0" });
  await assertNoLinks(destination);
  try {
    await lstat(destination);
    const expected = new Map([
      [join(".claude-plugin", "plugin.json"), { digest: hash(pluginManifest), mode: 0 }],
    ]);
    for (const skill of bundle.skills)
      for (const file of skill.files) expected.set(join("skills", skill.name, file.path), file);
    const check = async (directory) => {
      for (const name of await readdir(directory)) {
        const path = join(directory, name),
          stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new Error(`Project skill cache contains a symlink: ${path}`);
        if (stat.isDirectory()) await check(path);
        else {
          const key = relative(destination, path),
            file = expected.get(key);
          if (!file || file.digest !== hash(await readFile(path)) || file.mode !== (stat.mode & 0o111))
            throw new Error(`Project skill cache changed: ${path}`);
          expected.delete(key);
        }
      }
    };
    await check(destination);
    if (expected.size) throw new Error("Project skill cache is incomplete");
    return destination;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stage = `${destination}.${randomUUID()}`;
  try {
    for (const skill of bundle.skills)
      for (const file of skill.files) {
        const path = join(stage, "skills", skill.name, file.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.content, { mode: 0o600 | file.mode });
      }
    await mkdir(join(stage, ".claude-plugin"));
    await writeFile(join(stage, ".claude-plugin/plugin.json"), pluginManifest, { mode: 0o600 });
    await rename(stage, destination).catch((error) => {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return destination;
}

export function skillCatalog(bundle) {
  if (!bundle.skills.length)
    return "No project skills are registered. Register project-owned .agents/skills directories in .alliance/skills.json when needed.";
  return `Project skills (revision ${bundle.digest}):\n${bundle.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Read ${join(skill.directory, "SKILL.md")} and resolve its resources relative to that file.`).join("\n")}\nUse a skill when its trigger fits the task. The Lead chooses the approach; discovery does not mandate every skill on every task.`;
}

export async function registerSkill(cwd, directory) {
  const root = await projectRootFor(cwd);
  const entry = relative(root, resolve(cwd, directory)).split(sep).join("/");
  const path = join(root, ".alliance/skills.json");
  await assertNoLinks(path);
  const current = await readFile(path, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return { version: 1, skills: [] };
      throw error;
    });
  const next = Manifest.parse({ ...current, skills: [...new Set([...current.skills, entry])] });
  // Validate source before saving registration; no machine-wide profiles are changed.
  await projectSkills(cwd, next);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return path;
}
