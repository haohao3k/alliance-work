import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillManifest, SkillPath } from "../shared/skill-settings.mjs";
import { bundledSkillCatalog } from "./bundled-skills.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";
import { projectRootFor, projectSkills } from "./project-skills.mjs";

export async function projectSkillSettings(cwd) {
  const root = await projectRootFor(cwd);
  const path = join(root, ".alliance/skills.json");
  await assertNoLinks(path);
  const text = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const manifest = SkillManifest.parse(text === null ? { version: 1, skills: [] } : JSON.parse(text));
  const source = join(root, ".agents/skills");
  await assertNoLinks(source);
  const entries = await readdir(source, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (entries.length > 1000) throw new Error("Too many skill directories (maximum 1000)");
  const paths = [
    ...new Set([
      ...manifest.skills,
      ...entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => `.agents/skills/${e.name}`),
    ]),
  ].sort();
  const available = [];
  for (const entry of paths) {
    /** @type {import("zod").infer<typeof import("../shared/skill-settings.mjs").SkillEntry>} */
    const item = {
      path: entry,
      name: entry.split("/").at(-1) ?? entry,
      directory: join(root, entry),
      description: "",
      error: null,
      digest: null,
    };
    try {
      SkillPath.parse(entry);
      const bundle = await projectSkills(root, { version: 1, skills: [entry] });
      item.description = bundle.skills[0].description;
      item.digest = bundle.digest;
    } catch (error) {
      item.error = error.message;
    }
    available.push(item);
  }
  // Bind both the selection and the content the Human reviewed, including disabled skills.
  const bundled = await bundledSkillCatalog();
  const revision = createHash("sha256").update(JSON.stringify({ text, available, bundled })).digest("hex");
  return {
    root,
    revision,
    selected: manifest.skills,
    available,
    bundled,
    disabledBundled: manifest.disabledBundled ?? [],
  };
}

export async function withSkillLock(cwd, action) {
  const root = await projectRootFor(cwd);
  const parent = join(root, ".alliance");
  await assertNoLinks(parent);
  await mkdir(parent, { recursive: true });
  const lock = join(parent, ".skills-lock");
  await mkdir(lock, { mode: 0o700 }).catch((error) => {
    if (error.code === "EEXIST") throw new Error("Skills are being edited; reload and retry");
    throw error;
  });
  try {
    return await action(root, lock);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// Caller holds the project lock. A rejected save never changes the selection.
/** @param {string} root @param {string} lock @param {string[]} selected @param {string[] | undefined} disabledBundled */
export async function writeSkillSelection(root, lock, selected, disabledBundled = undefined) {
  const path = join(root, ".alliance/skills.json");
  await assertNoLinks(path);
  const previous = await readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const disabled =
    disabledBundled ??
    (previous ? SkillManifest.parse(JSON.parse(previous.toString())).disabledBundled : undefined) ??
    [];
  const next = SkillManifest.parse({
    version: 1,
    skills: selected,
    ...(disabled.length ? { disabledBundled: disabled } : {}),
  });
  const known = new Set((await bundledSkillCatalog()).map((skill) => skill.name));
  if (disabled.some((name) => !known.has(name))) throw new Error("Unknown bundled skill; reload the catalog");
  await projectSkills(root, next);
  if (previous) {
    const backups = join(root, ".alliance/skill-backups");
    await assertNoLinks(backups);
    await mkdir(backups, { recursive: true });
    await writeFile(join(backups, `${Date.now()}-${randomUUID()}.json`), previous, {
      mode: 0o600,
      flag: "wx",
    });
  }
  const staged = join(lock, "skills.json");
  await writeFile(staged, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(staged, path);
}

/** @param {string} cwd @param {string[]} selected @param {string} revision @param {string[] | undefined} disabledBundled */
export async function saveProjectSkills(cwd, selected, revision, disabledBundled = undefined) {
  return withSkillLock(cwd, async (root, lock) => {
    const current = await projectSkillSettings(root);
    if (current.revision !== revision) throw new Error("Project skills changed; reload before saving");
    await writeSkillSelection(root, lock, selected, disabledBundled);
    return projectSkillSettings(root);
  });
}
