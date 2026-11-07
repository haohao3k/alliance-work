import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledSkills } from "../shared/bundled-skill-catalog.mjs";
import { projectSkills, readSkillDirectory, skillDigest, skillMetadata } from "./project-skills.mjs";

import { skillOverrides } from "./skill-overrides.mjs";

export async function bundledSkillCatalog() {
  return structuredClone(bundledSkills);
}

export async function readBundledSkillCatalog(root) {
  const provenance = JSON.parse(await readFile(join(root, "vendor/seatwork/provenance.json"), "utf8"));
  const local = JSON.parse(await readFile(join(root, "room/skills.json"), "utf8"));
  const overrides = await skillOverrides(root, provenance);
  const entries = provenance.skills.map((path) => {
    const [role, name] = path.split("/");
    return {
      name,
      roles: [role, ...(["slp-challenge-premise", "slp-evidence-report"].includes(name) ? ["lens"] : [])],
      source: overrides.has(name) ? "Alliance (Seatwork adaptation)" : "Seatwork",
      path: overrides.has(name)
        ? join(root, overrides.get(name).directory, "SKILL.md")
        : join(root, "vendor/seatwork/skills", path, "SKILL.md"),
    };
  });
  for (const [name, roles] of Object.entries(local.skills))
    entries.push({ name, roles, source: "Alliance", path: join(root, "room/skills", name, "SKILL.md") });
  const result = [];
  for (const { path, ...entry } of entries) {
    const body = await readFile(path, "utf8");
    const metadata = skillMetadata(body, true);
    result.push({ ...entry, description: metadata.description });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// One selection path for native launchers, AGY configuration and Alliance's instruction catalog.
export async function effectiveSkills(cwd, profile) {
  const project = await projectSkills(cwd);
  const disabled = new Set(project.disabledBundled);
  const bundled = [];
  for (const directory of profile.skillDirectories) {
    const name = directory.split(/[\\/]/).at(-1);
    if (!disabled.has(name)) bundled.push(await readSkillDirectory(directory, true));
  }
  const skills = [...bundled, ...project.skills];
  return { ...project, skills, digest: skillDigest(skills, project.disabledBundled) };
}
