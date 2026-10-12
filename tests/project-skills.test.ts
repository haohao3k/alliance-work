import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { claudeSkillPlugin, projectSkills } from "../server/project-skills.mjs";
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
