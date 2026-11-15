import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { launchPlan } from "../scripts/launch.mjs";
import { prepareProfiles } from "../scripts/profiles.mjs";
import { contextSettings, saveContextSettings } from "../server/context-settings.mjs";
import { contextSave } from "../shared/context-contracts";
import { ContextPolicy, claudeWindowFor } from "../shared/context-settings.mjs";
import { temporary } from "./temp";

test("only the Human can persist a room's Claude pilot and other rooms stay at 300K", async () => {
  const home = await temporary("alliance-context-settings-");
  const original = await contextSettings(home, "one");
  assert.deepEqual(original.policy, { claudeWindow: 300000, roles: {} });
  assert.equal(original.saved, false);
  const policy = { ...original.policy, roles: { peer: 232000 } };
  for (const actorId of ["peer-agent", undefined]) {
    await assert.rejects(
      saveContextSettings(home, "one", policy, original.revision, actorId),
      /Only the Human/,
    );
  }
  assert.equal(
    contextSave.input.safeParse({ roomId: "one", policy, revision: original.revision }).success,
    false,
  );
  const saved = await saveContextSettings(home, "one", policy, original.revision, null);
  assert.equal(saved.saved, true);
  assert.notEqual(saved.revision, original.revision);
  assert.equal(claudeWindowFor(saved.policy, "peer"), 232000);
  assert.equal(claudeWindowFor(saved.policy, "lead"), 300000);
  assert.equal(claudeWindowFor((await contextSettings(home, "two")).policy, "peer"), 300000);
  assert.deepEqual(await contextSettings(home, "one"), saved);
  await assert.rejects(
    saveContextSettings(home, "one", original.policy, original.revision, null),
    /changed elsewhere/,
  );
  const reset = await saveContextSettings(home, "one", original.policy, saved.revision, null);
  assert.equal(claudeWindowFor(reset.policy, "peer"), 300000);
  await assert.rejects(
    saveContextSettings(home, "one", policy, original.revision, null),
    /changed elsewhere/,
  );
});

test("room default, role override and invalid pilot saves preserve the reviewed policy", async () => {
  const home = await temporary("alliance-context-settings-");
  const current = await contextSettings(home, "room");
  const policy = { claudeWindow: 232000, roles: { hq: 300000 } };
  const saved = await saveContextSettings(home, "room", policy, current.revision, null);
  assert.equal(claudeWindowFor(saved.policy, "peer"), 232000);
  assert.equal(claudeWindowFor(saved.policy, "hq"), 300000);
  for (const invalid of [
    { claudeWindow: 0, roles: {} },
    { claudeWindow: 1000000, roles: {} },
    { claudeWindow: 232000, roles: { unknown: 232000 } },
    { claudeWindow: 232000, roles: { peer: "232000" } },
    { claudeWindow: 232000, roles: {}, codexWindow: 232000 },
  ]) {
    await assert.rejects(saveContextSettings(home, "room", invalid, saved.revision, null));
    assert.deepEqual(await contextSettings(home, "room"), saved);
  }
  const updates = await Promise.allSettled([
    saveContextSettings(home, "room", current.policy, saved.revision, null),
    saveContextSettings(home, "room", current.policy, saved.revision, null),
  ]);
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
});

test("context settings refuse a linked settings directory", async () => {
  const home = await temporary("alliance-context-settings-");
  const elsewhere = await temporary("alliance-context-external-");
  await symlink(elsewhere, join(home, "context-settings"));
  await assert.rejects(contextSettings(home, "room"), /Symlink/);
});

test("new room-bound Claude launches select the pilot by role and standalone launches keep 300K", async () => {
  const root = await temporary("alliance-context-launch-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: process.execPath, claude: process.execPath, pi: process.execPath },
  });
  const current = await contextSettings(home, "room");
  await saveContextSettings(
    home,
    "room",
    { claudeWindow: 300000, roles: { peer: 232000 } },
    current.revision,
    null,
  );
  const ambient = {
    PASEO_AGENT_ID: "peer-agent",
    ALLIANCE_BOUND_ROOM: "room",
    ALLIANCE_WORKSPACE_CWD: cwd,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
  };
  const peer = await launchPlan(home, "claude-peer", ["-p", "fixture"], ambient, cwd);
  assert.equal(peer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "232000");
  const lead = await launchPlan(home, "claude-lead", ["-p", "fixture"], ambient, cwd);
  assert.equal(lead.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  const other = await launchPlan(
    home,
    "claude-peer",
    ["-p", "fixture"],
    {
      ...ambient,
      ALLIANCE_BOUND_ROOM: "other",
    },
    cwd,
  );
  assert.equal(other.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  const standalone = await launchPlan(home, "claude-peer", ["-p", "fixture"], {}, cwd);
  assert.equal(standalone.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  const settings = JSON.parse(
    await readFile(join(manifest.profiles["claude-peer"].home, "settings.json"), "utf8"),
  );
  assert.equal(settings.autoCompactWindow, 300000);
  await saveContextSettings(
    home,
    "room",
    ContextPolicy.parse({}),
    (await contextSettings(home, "room")).revision,
    null,
  );
  assert.equal(peer.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "232000");
  assert.equal(
    (await launchPlan(home, "claude-peer", ["-p", "fixture"], ambient, cwd)).env
      .CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    "300000",
  );
  const [settingsFile] = await readdir(join(home, "context-settings"));
  const path = join(home, "context-settings", settingsFile);
  const saved = await readFile(path, "utf8");
  await writeFile(path, "{");
  await assert.rejects(launchPlan(home, "claude-peer", ["-p", "fixture"], ambient, cwd), SyntaxError);
  await assert.rejects(
    saveContextSettings(home, "room", current.policy, current.revision, null),
    SyntaxError,
  );
  assert.equal(await readFile(path, "utf8"), "{");
  await writeFile(path, saved);
});
