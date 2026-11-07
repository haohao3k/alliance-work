import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { assertNoLinks } from "../server/profile-integrity.mjs";
import { SkillManifest as Manifest } from "../shared/skill-settings.mjs";

const execute = promisify(execFile);
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
  const manifest = Manifest.parse(
    selection ?? (text === null ? { version: 1, skills: [] } : JSON.parse(text)),
  );
  if (new Set(manifest.skills).size !== manifest.skills.length) throw new Error("Duplicate project skill");
  const skills = [];
  let bytes = 0;
  for (const entry of manifest.skills) {
    const directory = join(root, entry);
    const skill = await readSkillDirectory(directory);
    if (skill.name.startsWith("slp-") || skill.name.startsWith("alliance-"))
      throw new Error(`Reserved role skill name: ${skill.name}`);
    bytes += skill.files.reduce((sum, file) => sum + file.content.length, 0);
    if (bytes > 16 * 1024 * 1024) throw new Error("Project skill bundle exceeds 16 MiB");
    skills.push(skill);
  }
  return {
    root,
    digest: skillDigest(skills, manifest.disabledBundled),
    skills,
    disabledBundled: manifest.disabledBundled ?? [],
  };
}

export function skillDigest(skills, disabledBundled = []) {
  return hash(
    JSON.stringify({
      disabledBundled,
      skills: skills.map(({ name, files }) => ({
        name,
        files: files.map(({ path, digest, mode }) => ({ path, digest, mode })),
      })),
    }),
  );
}

export function skillMetadata(body, bundled = false) {
  const frontmatter = body?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error("Missing skill frontmatter");
  try {
    return parse(frontmatter);
  } catch (error) {
    // Pinned Seatwork legacy descriptions contain unquoted colons. Do not rewrite upstream bytes.
    if (!bundled) throw error;
    const name = /^name: ([a-z0-9-]+)$/m.exec(frontmatter)?.[1];
    const description = /^description: (.+)$/m.exec(frontmatter)?.[1];
    if (!name || !description) throw error;
    return { name, description };
  }
}

export async function readSkillDirectory(directory, bundled = false) {
  await assertNoLinks(directory);
  const files = [];
  let bytes = 0;
  const walk = async (dir) => {
    for (const name of (await readdir(dir)).sort()) {
      const file = join(dir, name),
        stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error(`Skill contains a symlink: ${file}`);
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 16 * 1024 * 1024 || files.length >= 1000)
          throw new Error("Skill exceeds 16 MiB / 1000 files");
        const content = await readFile(file);
        files.push({
          path: relative(directory, file),
          digest: hash(content),
          mode: stat.mode & 0o111,
          content,
        });
      } else throw new Error(`Unsupported skill file: ${file}`);
    }
  };
  await walk(directory);
  const body = files.find((file) => file.path === "SKILL.md")?.content.toString();
  const frontmatter = body?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) throw new Error(`Missing skill frontmatter: ${directory}`);
  const metadata = skillMetadata(body, bundled),
    name = directory.split(sep).at(-1);
  if (metadata?.name !== name || typeof metadata.description !== "string" || !metadata.description.trim())
    throw new Error(`Skill name must match its folder and have a description: ${directory}`);
  return { name, description: metadata.description, directory, files };
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
  if (!bundle.skills.length) return "No skills are enabled for this runtime.";
  return `Enabled skills (revision ${bundle.digest}):\n${bundle.skills.map((skill) => `- ${skill.name}: ${skill.description}\n  Read ${join(skill.directory, "SKILL.md")} and resolve its resources relative to that file.`).join("\n")}\nUse a skill when its trigger fits the task. The Lead chooses the approach; discovery does not mandate every skill on every task.`;
}

export async function registerSkill(cwd, directory) {
  const root = await projectRootFor(cwd);
  const entry = relative(root, resolve(cwd, directory)).split(sep).join("/");
  const { projectSkillSettings, saveProjectSkills } = await import("./skill-settings.mjs");
  const current = await projectSkillSettings(root);
  await saveProjectSkills(root, [...new Set([...current.selected, entry])], current.revision);
  const path = join(root, ".alliance/skills.json");
  return path;
}
