import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { test } from "node:test";
import { nativeSkillDiscovery } from "../scripts/native-skill-discovery.mjs";
import { bundledPi } from "../scripts/pi-runtime.mjs";
import { prepareProfiles, projectRoot, roles, verifyProfile } from "../scripts/profiles.mjs";
import { projectSkillSettings, saveProjectSkills } from "../server/skill-settings.mjs";
import { temporary } from "./temp";

test("native skill toggles remove and restore project and bundled skills for every role and preserve other projects", {
  skip: process.env.ALLIANCE_NATIVE_TESTS !== "1",
  timeout: 240000,
}, async () => {
  const root = await temporary("skill-toggle-native-"),
    home = join(root, "home"),
    cwd = join(root, "repo"),
    other = join(root, "other");
  await mkdir(join(cwd, ".agents/skills/toggle-probe"), { recursive: true });
  await mkdir(other);
  await writeFile(
    join(cwd, ".agents/skills/toggle-probe/SKILL.md"),
    "---\nname: toggle-probe\ndescription: Native toggle sentinel.\n---\nThis is a test-only sentinel.\n",
  );
  const executables = Object.fromEntries(
    ["codex", "claude"].map((name) => [
      name,
      spawnSync("/usr/bin/which", [name], { encoding: "utf8" }).stdout.trim(),
    ]),
  );
  const pi = await bundledPi(projectRoot);
  assert(pi);
  executables.pi = pi.executable;
  const manifest = await prepareProfiles({ home, isolatedRoot: join(root, "roles"), executables });
  let state = await projectSkillSettings(cwd);
  const all = state.bundled.map((s) => s.name);
  const plugins = new Map<string, string>();
  for (const phase of ["on", "off", "reopen-off", "restore"]) {
    const enabled = phase === "on" || phase === "restore";
    state = await saveProjectSkills(
      cwd,
      enabled ? [".agents/skills/toggle-probe"] : [],
      state.revision,
      enabled ? [] : all,
    );
    for (const role of roles)
      for (const harness of ["codex", "claude", "pi"]) {
        const profile = manifest.profiles[`${harness}-${role}`];
        const extras =
          !enabled && harness === "pi"
            ? ["--skill", join(cwd, ".agents/skills/toggle-probe/SKILL.md")]
            : !enabled && harness === "claude"
              ? ["--plugin-dir", plugins.get(role) ?? ""]
              : !enabled && harness === "codex"
                ? [
                    "-c",
                    `skills.config=[{path=${JSON.stringify(join(cwd, ".agents/skills/toggle-probe/SKILL.md"))},enabled=true}]`,
                  ]
                : [];
        const actual = await nativeSkillDiscovery(home, harness, role, cwd, extras);
        if (enabled && harness === "claude")
          plugins.set(role, actual.plan.args[actual.plan.args.indexOf("--plugin-dir") + 1]);
        const tracked = actual.names.filter(
          (n: string) => n.startsWith("slp-") || n.startsWith("alliance-") || n === "toggle-probe",
        );
        const expected = enabled
          ? [...profile.skillDirectories.map((p) => basename(p)), "toggle-probe"].sort()
          : [];
        assert.deepEqual(tracked, expected, `${phase} ${harness}-${role}`);
        await verifyProfile(profile);
      }
    if (phase === "off")
      for (const harness of ["codex", "claude", "pi"]) {
        const otherResult = await nativeSkillDiscovery(home, harness, "peer", other);
        assert(otherResult.names.includes("alliance-test-audit"));
        assert(!otherResult.names.includes("toggle-probe"));
      }
  }
  assert.match(
    await readFile(join(cwd, ".agents/skills/toggle-probe/SKILL.md"), "utf8"),
    /test-only sentinel/,
  );
});
