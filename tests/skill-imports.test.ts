import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectSkills } from "../server/project-skills.mjs";
import { installProjectSkills, parseSkillSource, previewSkillImport } from "../server/skill-imports.mjs";
import { projectSkillSettings } from "../server/skill-settings.mjs";
import { temporary } from "./temp";

test("skill source accepts GitHub and npx skills syntax without executing pasted commands", () => {
  assert.equal(parseSkillSource("owner/repo").repository, "https://github.com/owner/repo.git");
  assert.deepEqual(parseSkillSource("npx skills add owner/repo --skill ui-design review").names, [
    "ui-design",
    "review",
  ]);
  assert.equal(
    parseSkillSource("https://github.com/owner/repo/blob/main/skills/design/SKILL.md").path,
    "skills/design",
  );
  for (const value of [
    "npx skills add owner/repo; touch /tmp/owned",
    "npx skills add owner/repo -g",
    "https://github.com.evil.test/owner/repo",
    "https://user:password@github.com/owner/repo",
    "https://github.com/owner/repo/tree/main/%2e%2e%2fescape",
    "file:///tmp/repo",
  ])
    assert.throws(() => parseSkillSource(value), Error, value);
});

test("GitHub import pins preview content, preserves resources and enables only selected project skills", async (t) => {
  const root = await temporary("skill-import-");
  const repo = join(root, "upstream"),
    project = join(root, "project");
  await mkdir(repo);
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  for (const name of ["ui-design", "other"]) {
    const path = join(repo, "skills", name);
    await mkdir(join(path, "references"), { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Design interfaces.\n---\nRead references/layout.md.\n`,
    );
    await writeFile(join(path, "references/layout.md"), "Use spacing tokens.");
  }
  await mkdir(join(repo, "skills", "broken"));
  await writeFile(join(repo, "skills", "broken", "SKILL.md"), "Missing frontmatter");
  await symlink("/etc/passwd", join(repo, "skills", "broken", "link"));
  await writeFile(join(repo, "package.json"), '{"scripts":{"postinstall":"exit 99"}}');
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial");
  const config = join(root, "gitconfig");
  await writeFile(
    config,
    `[url "file://${repo}"]\n insteadOf = https://github.com/fixture/skills.git\n[protocol "file"]\n allow = always\n`,
  );
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  });
  const source = "npx skills add fixture/skills --skill ui-design";
  const preview = await previewSkillImport(source);
  assert.equal(preview.skills.length, 1);
  assert.match(preview.errors[0].error, /symlink/);
  assert.equal((await projectSkillSettings(project)).available.length, 0, "preview must not install");
  const initial = await projectSkillSettings(project);
  const chosen = preview.skills.map(({ path, digest }: { path: string; digest: string }) => ({
    path,
    digest,
  }));
  await assert.rejects(
    installProjectSkills(
      project,
      source,
      preview.commit,
      [{ ...chosen[0], digest: "wrong" }],
      initial.revision,
    ),
    /changed/,
  );
  await writeFile(join(repo, "skills/ui-design/references/layout.md"), "New unreviewed content");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed");
  const state = await installProjectSkills(project, source, preview.commit, chosen, initial.revision);
  assert.deepEqual(state.selected, [".agents/skills/ui-design"]);
  assert.equal(
    await readFile(join(project, ".agents/skills/ui-design/references/layout.md"), "utf8"),
    "Use spacing tokens.",
  );
  assert.equal((await projectSkills(project)).skills[0].name, "ui-design");
  const provenance = JSON.parse(
    await readFile(join(project, ".agents/skills/ui-design/.alliance-source.json"), "utf8"),
  );
  assert.equal(provenance.commit, preview.commit);
  await assert.rejects(
    installProjectSkills(project, source, preview.commit, chosen, state.revision),
    /already exists/,
  );
  await assert.rejects(readFile(join(project, "package.json")));
});
