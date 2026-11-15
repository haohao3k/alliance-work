import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { effectiveSkills } from "../server/bundled-skills.mjs";
import { claudeSkillPlugin, projectSkills, skillCatalog } from "../server/project-skills.mjs";
import { temporary } from "./temp";

test("project skills require an explicit manifest and preserve resources without importing project config", async () => {
  const cwd = await temporary("alliance-skills-");
  const skill = join(cwd, ".agents/skills/check-product");
  await mkdir(join(skill, "references"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: check-product\ndescription: Check this product.\n---\nRead references/flow.md.\n",
  );
  await writeFile(join(skill, "references/flow.md"), "Drive the real flow.");
  assert.equal((await projectSkills(cwd)).skills.length, 0);
  await mkdir(join(cwd, ".alliance"));
  await writeFile(
    join(cwd, ".alliance/skills.json"),
    JSON.stringify({ version: 1, skills: [".agents/skills/check-product"] }),
  );
  const first = await projectSkills(cwd);
  assert.equal(first.skills[0].name, "check-product");
  assert.equal(first.skills[0].files.length, 2);
  const plugin = await claudeSkillPlugin(join(cwd, "isolated-home"), first);
  assert(plugin);
  assert.equal(await claudeSkillPlugin(join(cwd, "isolated-home"), first), plugin);
  await writeFile(join(plugin, ".mcp.json"), "{}");
  await assert.rejects(claudeSkillPlugin(join(cwd, "isolated-home"), first), /cache changed/);
  await writeFile(join(skill, "references/flow.md"), "Updated real flow.");
  assert.notEqual((await projectSkills(cwd)).digest, first.digest);
  await symlink("/etc", join(skill, "escape"));
  await assert.rejects(projectSkills(cwd), /symlink/i);
});

test("the skill catalog points to every skill's own SKILL.md, wherever it lives, without per-skill boilerplate", async () => {
  const cwd = await temporary("alliance-catalog-");
  const write = async (directory: string, name: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use ${name} when its trigger fits.\n---\nBody of ${name}.\n`,
    );
    return directory;
  };
  // Bundled skills sit under the role home; a project skill sits in the project, outside that root.
  const home = join(cwd, "role-home/skills");
  const bundled = [await write(join(home, "alpha"), "alpha"), await write(join(home, "beta"), "beta")];
  await write(join(cwd, ".agents/skills/gamma"), "gamma");
  await mkdir(join(cwd, ".alliance"));
  await writeFile(
    join(cwd, ".alliance/skills.json"),
    JSON.stringify({ version: 1, skills: [".agents/skills/gamma"] }),
  );
  const selected = await effectiveSkills(cwd, { skillDirectories: bundled });
  const catalog = skillCatalog(selected);
  assert.deepEqual(
    selected.skills.map((skill: { name: string }) => skill.name),
    ["alpha", "beta", "gamma"],
  );
  for (const skill of selected.skills) {
    const path = join(skill.directory, "SKILL.md");
    assert.equal(catalog.split(path).length - 1, 1, `${skill.name} is pointed to once`);
    assert.match(await readFile(path, "utf8"), new RegExp(`^---\\nname: ${skill.name}\\n`));
  }
  // The read instruction is not repeated per skill: each extra skill adds only its own entry.
  const one = skillCatalog({ ...selected, skills: selected.skills.slice(0, 1) });
  const extra = selected.skills.slice(1);
  const entries = extra.reduce(
    (sum: number, skill: { name: string; description: string; directory: string }) =>
      sum + `- ${skill.name}: ${skill.description}\n  ${join(skill.directory, "SKILL.md")}\n`.length,
    0,
  );
  assert.equal(catalog.length - one.length, entries);
});
