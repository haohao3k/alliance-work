import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../scripts/profiles.mjs";
import { bundledSkillCatalog, readBundledSkillCatalog } from "../server/bundled-skills.mjs";
import { projectSkills, registerSkill } from "../server/project-skills.mjs";
import { projectSkillSettings, saveProjectSkills } from "../server/skill-settings.mjs";
import { temporary } from "./temp";

async function skill(root: string, name: string) {
  const path = join(root, ".agents/skills", name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: Check the UI.\n---\nInspect the layout.\n`,
  );
  return `.agents/skills/${name}`;
}

test("project skill settings enable and disable without deleting files or changing other projects", async () => {
  const root = await temporary("skill-settings-");
  const a = join(root, "a"),
    b = join(root, "b");
  const selected = await skill(a, "design");
  await skill(b, "other");
  const initial = await projectSkillSettings(a);
  assert.equal(initial.available[0].name, "design");
  assert.deepEqual(initial.selected, []);
  const enabled = await saveProjectSkills(a, [selected], initial.revision);
  assert.deepEqual(
    (await projectSkills(a)).skills.map((s) => s.name),
    ["design"],
  );
  await saveProjectSkills(a, [], enabled.revision);
  assert.deepEqual((await projectSkills(a)).skills, []);
  assert.match(await readFile(join(a, selected, "SKILL.md"), "utf8"), /Inspect the layout/);
  assert.deepEqual((await projectSkillSettings(b)).selected, []);
  const backups = await readdir(join(a, ".alliance/skill-backups"));
  assert.equal(backups.length, 1);
  assert.deepEqual(
    JSON.parse(await readFile(join(a, ".alliance/skill-backups", backups[0]), "utf8")).skills,
    [selected],
  );
});

test("skill settings reject stale and concurrent writers, including edits to skill content", async () => {
  const root = await temporary("skill-conflict-");
  const entry = await skill(root, "design");
  const initial = await projectSkillSettings(root);
  await writeFile(join(root, entry, "reference.md"), "New instructions");
  await assert.rejects(saveProjectSkills(root, [entry], initial.revision), /changed/);
  const current = await projectSkillSettings(root);
  const attempts = await Promise.allSettled([
    saveProjectSkills(root, [entry], current.revision),
    saveProjectSkills(root, [], current.revision),
  ]);
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 1);
  await registerSkill(root, entry);
  await assert.rejects(saveProjectSkills(root, [], current.revision), /changed/);
});

test("broken selected skills can be disabled while traversal and linked sources cannot be enabled", async () => {
  const root = await temporary("skill-invalid-");
  const entry = await skill(root, "design");
  await registerSkill(root, entry);
  await rm(join(root, entry), { recursive: true });
  const broken = await projectSkillSettings(root);
  assert(broken.available[0].error);
  await saveProjectSkills(root, [], broken.revision);
  const external = await temporary("skill-external-");
  await skill(external, "linked");
  await symlink(join(external, ".agents/skills/linked"), join(root, ".agents/skills/linked"));
  const state = await projectSkillSettings(root);
  assert.match(state.available[0].error ?? "", /symlink/i);
  await assert.rejects(saveProjectSkills(root, [".agents/skills/linked"], state.revision), /symlink/i);
  await assert.rejects(saveProjectSkills(root, ["../external"], state.revision));
  await assert.rejects(projectSkills(root, { version: 1, skills: ["../external"] }));
  assert.deepEqual((await projectSkillSettings(root)).selected, []);
});

test("skills use the Git root for subdirectories and keep separate worktree selections", async () => {
  const root = await temporary("skill-worktree-");
  const repo = join(root, "repo"),
    worktree = join(root, "worktree");
  const entry = await skill(repo, "design");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "init",
  );
  git("worktree", "add", "--detach", worktree);
  await mkdir(join(repo, "src"));
  const initial = await projectSkillSettings(join(repo, "src"));
  assert.equal(initial.root, repo);
  await saveProjectSkills(join(repo, "src"), [entry], initial.revision);
  assert.equal((await projectSkillSettings(repo)).selected.length, 1);
  assert.equal((await projectSkillSettings(worktree)).selected.length, 0);
});

test("skills CLI shares revisions with the editor and preserves disabled files", async () => {
  const root = await temporary("skill-cli-");
  const entry = await skill(root, "design");
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [join(projectRoot, "scripts/cli.mjs"), "skills", ...args, "--project", root],
        { encoding: "utf8" },
      ),
    );
  const before = cli("settings");
  const selection = join(root, "selection.json");
  await writeFile(selection, JSON.stringify([entry]));
  const enabled = cli("save", "--file", selection, "--revision", before.revision);
  assert.equal(cli("list").skills[0].name, "design");
  const disabled = cli("remove", entry, "--revision", enabled.revision);
  assert.deepEqual(disabled.selected, []);
  assert.match(await readFile(join(root, entry, "SKILL.md"), "utf8"), /Inspect/);
  assert.throws(() => cli("save", "--file", selection, "--revision", before.revision), /changed/);
});

test("bundled catalog exposes role scope and project changes preserve bundled toggles", async () => {
  assert.deepEqual(await bundledSkillCatalog(), await readBundledSkillCatalog(projectRoot));
  const root = await temporary("bundled-toggle-");
  const entry = await skill(root, "design");
  let state = await projectSkillSettings(root);
  assert.equal(state.bundled.length, 23);
  assert.deepEqual(state.bundled.find((s) => s.name === "slp-frontend-design")?.roles, ["peer"]);
  assert.deepEqual(state.bundled.find((s) => s.name === "alliance-friction")?.roles, [
    "hq",
    "supervisor",
    "lead",
  ]);
  state = await saveProjectSkills(root, [], state.revision, ["alliance-test-audit"]);
  const offDigest = (await projectSkills(root)).digest;
  await registerSkill(root, entry);
  state = await projectSkillSettings(root);
  assert.deepEqual(state.disabledBundled, ["alliance-test-audit"]);
  await assert.rejects(
    saveProjectSkills(root, state.selected, state.revision, ["alliance-unknown"]),
    /Unknown/,
  );
  state = await saveProjectSkills(root, [], state.revision, []);
  assert.notEqual((await projectSkills(root)).digest, offDigest);
});
