import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { loadManifest, prepareProfiles, projectRoot, verifyProfile } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

const executables = {
  codex: "/usr/bin/false",
  claude: "/usr/bin/false",
  pi: "/usr/bin/false",
  agy: "/usr/bin/false",
};
async function fixture() {
  const directory = await temporary("alliance-playbooks-");
  const root = join(directory, "source");
  await cp(join(projectRoot, "room"), join(root, "room"), { recursive: true });
  await cp(join(projectRoot, "vendor"), join(root, "vendor"), { recursive: true });
  const options = {
    home: join(directory, "home"),
    isolatedRoot: join(directory, "roles"),
    root,
    executables,
  };
  return { directory, root, options };
}

// Exercise adaptation mechanics with locally authored fixtures, not unpublished playbooks.
async function adaptationFixture() {
  const f = await fixture();
  const skills: Record<string, { source: string }> = {};
  for (const [role, name] of [
    ["lead", "slp-write-brief"],
    ["peer", "slp-candidate-handoff"],
  ]) {
    const directory = join(f.root, "room/skill-overrides", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Synthetic adaptation fixture.\n---\n\nRecord the test outcome.\n`,
    );
    skills[name] = { source: `vendor/seatwork/skills/${role}/${name}/SKILL.md` };
  }
  await writeFile(join(f.root, "room/skill-overrides.json"), JSON.stringify({ version: 1, skills }));
  return f;
}

test("bundled playbooks reach their intended roles with usable references and notices", async () => {
  const f = await fixture();
  const manifest = await prepareProfiles(f.options);
  for (const profile of Object.values(manifest.profiles)) {
    const names = profile.skillDirectories.map((path) => basename(path));
    for (const name of [
      "alliance-verify",
      "alliance-learn-from-failure",
      "alliance-test-audit",
      "alliance-blast-radius",
    ])
      assert(names.includes(name), `${profile.harness}/${profile.role} lacks ${name}`);
    assert.equal(names.includes("alliance-friction"), ["hq", "supervisor", "lead"].includes(profile.role));
    for (const name of names.filter((name) =>
      ["alliance-test-audit", "alliance-blast-radius", "alliance-friction"].includes(name),
    )) {
      for (const file of [
        "SKILL.md",
        "NOTICE.md",
        ...(name === "alliance-friction" ? ["LICENSE-APACHE-2.0.txt"] : []),
      ])
        assert.deepEqual(
          await readFile(join(profile.home, "skills", name, file)),
          await readFile(join(f.root, "room/skills", name, file)),
        );
    }
    assert.deepEqual(
      await readFile(join(profile.home, "skills/alliance-test-audit/references/audit.md")),
      await readFile(join(f.root, "room/skills/alliance-test-audit/references/audit.md")),
    );
    if (profile.harness === "pi")
      assert.deepEqual(profile.skillEntries.map((path) => basename(join(path, ".."))).sort(), names.sort());
    await verifyProfile(profile);
  }
});

test("playbook refresh removes only owned assets and rollback keeps pre-catalog discovery", async () => {
  const f = await fixture();
  const first = await prepareProfiles(f.options);
  const catalogPath = join(f.root, "room/skills.json");
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  catalog.skills["alliance-friction"] = ["hq"];
  await writeFile(catalogPath, JSON.stringify(catalog));
  const refreshed = await prepareProfiles(f.options);
  for (const role of ["supervisor", "lead"]) {
    const profile = refreshed.profiles[`codex-${role}`];
    assert(!profile.skillDirectories.some((path) => basename(path) === "alliance-friction"));
    await assert.rejects(readFile(join(profile.home, "skills/alliance-friction/SKILL.md")), {
      code: "ENOENT",
    });
    await verifyProfile(profile);
  }
  const changed = join(first.profiles["codex-hq"].home, "skills/alliance-friction/NOTICE.md");
  await writeFile(changed, "Operator-owned revision\n");
  catalog.skills["alliance-friction"] = ["supervisor"];
  await writeFile(catalogPath, JSON.stringify(catalog));
  await assert.rejects(prepareProfiles(f.options), /modified managed file/);
  assert.equal(await readFile(changed, "utf8"), "Operator-owned revision\n");
  assert.deepEqual(await loadManifest(f.options.home), refreshed);
  await writeFile(changed, await readFile(join(f.root, "room/skills/alliance-friction/NOTICE.md")));
  // An older source has no catalog, new playbooks or their provenance; today's installer must
  // restore exactly that source's former all-role local skill assembly.
  await rm(catalogPath);
  for (const name of ["alliance-test-audit", "alliance-blast-radius", "alliance-friction"])
    await rm(join(f.root, "room/skills", name), { recursive: true });
  await rm(join(f.root, "vendor/seatwork/upstream-ab41c12"), { recursive: true });
  const rolledBack = await prepareProfiles(f.options);
  for (const profile of Object.values(rolledBack.profiles)) {
    assert(profile.skillDirectories.some((path) => basename(path) === "alliance-verify"));
    assert(
      !profile.skillDirectories.some((path) => /alliance-(test-audit|blast-radius|friction)$/.test(path)),
    );
    await verifyProfile(profile);
  }
});

test("playbook generation rejects corrupt provenance or unrouted skills before writing a profile", async () => {
  const f = await fixture();
  const raw = join(f.root, "vendor/seatwork/upstream-ab41c12/skills/peer/test-audit/SKILL.md");
  const original = await readFile(raw);
  await writeFile(raw, "altered upstream\n");
  await assert.rejects(prepareProfiles(f.options), /Vendored bytes changed/);
  await assert.rejects(readFile(join(f.options.home, "profiles.json")), { code: "ENOENT" });
  await writeFile(raw, original);
  const notice = join(f.root, "room/skills/alliance-friction/LICENSE-APACHE-2.0.txt");
  const license = await readFile(notice);
  await rm(notice);
  await assert.rejects(prepareProfiles(f.options), /ENOENT/);
  await writeFile(notice, license);
  const catalogPath = join(f.root, "room/skills.json");
  const catalog = await readFile(catalogPath);
  await rm(catalogPath);
  await assert.rejects(prepareProfiles(f.options), /catalog/);
  await writeFile(catalogPath, catalog);
  await mkdir(join(f.root, "room/skills/accidental"));
  await writeFile(
    join(f.root, "room/skills/accidental/SKILL.md"),
    "---\nname: accidental\ndescription: Must be routed explicitly.\n---\n",
  );
  await assert.rejects(prepareProfiles(f.options), /catalog/);
  await assert.rejects(readFile(join(f.options.home, "profiles.json")), { code: "ENOENT" });
});

test("vendor verification checks raw playbooks and derivative resources through its production CLI", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "scripts"));
  await cp(join(projectRoot, "scripts/verify-vendor.mjs"), join(f.root, "scripts/verify-vendor.mjs"));
  await cp(join(projectRoot, "server/agy-native"), join(f.root, "server/agy-native"), { recursive: true });
  for (const name of ["skill-overrides.mjs", "profile-integrity.mjs"])
    await cp(join(projectRoot, "server", name), join(f.root, "server", name));
  const run = () =>
    execFileSync(process.execPath, [join(f.root, "scripts/verify-vendor.mjs")], {
      encoding: "utf8",
      stdio: "pipe",
    });
  run();
  const raw = join(f.root, "vendor/seatwork/upstream-ab41c12/skills/peer/blast-radius/SKILL.md");
  const original = await readFile(raw);
  await writeFile(raw, "altered\n");
  assert.throws(run, /Vendored bytes changed/);
  await writeFile(raw, original);
  await rm(join(f.root, "room/skills/alliance-test-audit/references/audit.md"));
  assert.throws(run, /ENOENT/);
});

test("same-name skill adaptations replace full resources and rollback restores pinned source without changing role routing", async () => {
  const f = await adaptationFixture();
  const overridesPath = join(f.root, "room/skill-overrides.json");
  const overrides = await readFile(overridesPath);
  await rm(overridesPath);
  const before = await prepareProfiles(f.options);
  const lead = before.profiles["codex-lead"];
  const original = await readFile(join(lead.home, "skills/slp-write-brief/SKILL.md"));
  const reference = join(lead.home, "skills/slp-write-brief/references/brief-template.md");
  assert((await readFile(reference)).length > 0);
  await writeFile(overridesPath, overrides);
  const after = await prepareProfiles(f.options);
  for (const [id, profile] of Object.entries(after.profiles)) {
    assert.deepEqual(
      profile.skillDirectories.map((path) => basename(path)).sort(),
      before.profiles[id].skillDirectories.map((path) => basename(path)).sort(),
    );
    for (const directory of profile.skillDirectories) {
      const name = basename(directory);
      if (!JSON.parse(overrides.toString()).skills[name]) continue;
      assert.deepEqual(
        await readFile(join(directory, "SKILL.md")),
        await readFile(join(f.root, "room/skill-overrides", name, "SKILL.md")),
      );
    }
    await verifyProfile(profile);
  }
  await assert.rejects(readFile(reference), { code: "ENOENT" });
  await rm(overridesPath);
  const restored = await prepareProfiles(f.options);
  assert.deepEqual(
    await readFile(join(restored.profiles["codex-lead"].home, "skills/slp-write-brief/SKILL.md")),
    original,
  );
  assert((await readFile(reference)).length > 0);
  await verifyProfile(restored.profiles["codex-lead"]);
});

test("skill adaptations do not conceal upstream corruption or overwrite a locally edited adaptation", async () => {
  const f = await adaptationFixture();
  const before = await prepareProfiles(f.options);
  const upstream = join(f.root, "vendor/seatwork/skills/peer/slp-candidate-handoff/SKILL.md");
  const bytes = await readFile(upstream);
  await writeFile(upstream, "changed source");
  await assert.rejects(prepareProfiles(f.options), /source bytes changed/);
  await writeFile(upstream, bytes);
  const managed = join(before.profiles["codex-peer"].home, "skills/slp-candidate-handoff/SKILL.md");
  await writeFile(managed, "local operator edit");
  await rm(join(f.root, "room/skill-overrides.json"));
  await assert.rejects(prepareProfiles(f.options), /unowned file/);
  assert.equal(await readFile(managed, "utf8"), "local operator edit");
  assert.deepEqual(await loadManifest(f.options.home), before);
});
