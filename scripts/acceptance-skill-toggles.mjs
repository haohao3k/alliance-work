import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { activate } from "./maintenance.mjs";
import { nativeSkillDiscovery } from "./native-skill-discovery.mjs";
import { paseo, requireIdle } from "./paseo.mjs";
import { roles, verifyProfile } from "./profiles.mjs";

const output = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: node scripts/acceptance-skill-toggles.mjs NEW_OUTPUT");
await mkdir(output, { recursive: false });
const home = join(output, "home"),
  paseoHome = join(output, "paseo"),
  cwd = join(output, "project"),
  other = join(output, "other-project");
await mkdir(join(cwd, ".agents/skills/toggle-probe"), { recursive: true });
await mkdir(other);
await writeFile(
  join(cwd, ".agents/skills/toggle-probe/SKILL.md"),
  "---\nname: toggle-probe\ndescription: Toggle verification sentinel.\n---\nSynthetic fixture only.\n",
);
const net = createServer();
await new Promise((r) => net.listen(0, "127.0.0.1", r));
const port = net.address().port;
await new Promise((r) => net.close(r));
const receipt = {
  startedAt: new Date().toISOString(),
  checks: [],
  pass: false,
  modelTurns: 0,
  limitations: [
    "Native skill registries are checked for Codex, Claude and Pi. AGY is separately checked at generated session configuration, not a model turn.",
    "Existing conversation context is not revocable; use a fresh session after disabling.",
  ],
};
let client;
try {
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom: undefined,
  });
  client = new DaemonClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: "skill-toggles-acceptance",
    connectTimeoutMs: 10000,
  });
  await client.connect();
  const rpc = (name, input) => client.invokePluginRpc("alliance-work", name, input);
  const manifest = JSON.parse(await readFile(join(home, "profiles.json"), "utf8"));
  let state = await rpc("skills.read", { cwd });
  const all = state.bundled.map((s) => s.name);
  assert.equal(all.length, 23);
  for (const phase of ["on", "off", "reopen-off", "restore"]) {
    const enabled = phase === "on" || phase === "restore";
    state = await rpc("skills.save", {
      cwd,
      selected: enabled ? [".agents/skills/toggle-probe"] : [],
      revision: state.revision,
      disabledBundled: enabled ? [] : all,
    });
    assert.deepEqual((await rpc("skills.read", { cwd })).disabledBundled, enabled ? [] : all);
    for (const role of roles)
      for (const harness of ["codex", "claude", "pi"]) {
        const profile = manifest.profiles[`${harness}-${role}`];
        const actual = await nativeSkillDiscovery(home, harness, role, cwd);
        const names = actual.names.filter(
          (n) => n.startsWith("slp-") || n.startsWith("alliance-") || n === "toggle-probe",
        );
        const expected = enabled
          ? [...profile.skillDirectories.map((p) => basename(p)), "toggle-probe"].sort()
          : [];
        assert.deepEqual(names, expected, `${phase}: ${harness}-${role}`);
        await verifyProfile(profile);
        receipt.checks.push({ phase, harness, role, names, pass: true });
      }
    if (!enabled)
      for (const harness of ["codex", "claude", "pi"]) {
        const actual = await nativeSkillDiscovery(home, harness, "peer", other);
        assert(actual.names.includes("alliance-test-audit"));
        assert(!actual.names.includes("toggle-probe"));
        receipt.checks.push({ phase, harness, role: "peer", otherProjectUnaffected: true, pass: true });
      }
    console.log(`${phase}: native skill inventories verified for all five roles`);
  }
  receipt.pass = true;
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
  console.error(error);
} finally {
  if (client) await client.close();
  requireIdle(paseoHome);
  paseo(["daemon", "stop"], paseoHome);
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
