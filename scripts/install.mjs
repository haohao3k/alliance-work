import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { atomicWrite, loadManifest } from "./profiles.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
try {
  if (!option("--paseo-home") || !option("--home"))
    throw new Error(
      "Usage: install.mjs --home ALLIANCE_HOME --paseo-home PASEO_HOME [--port 6771]. Both homes must be explicit.",
    );
  const home = resolve(option("--home"));
  const paseoHome = resolve(option("--paseo-home"));
  await loadManifest(home);
  const providers = JSON.parse(await readFile(join(home, "providers.json"), "utf8"));
  const path = join(paseoHome, "config.json");
  const ownerPath = join(paseoHome, "alliance-instance.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
    const owner = JSON.parse(
      await readFile(ownerPath, "utf8").catch(() => {
        throw new Error(
          "This installer only manages a dedicated Alliance Paseo home. The existing instance was not changed.",
        );
      }),
    );
    if (owner.allianceHome !== home) throw new Error("Paseo home belongs to another Alliance installation");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    config = {
      version: 1,
      daemon: {
        listen: `127.0.0.1:${option("--port") ?? "6771"}`,
        relay: { enabled: false },
        mcp: { enabled: true, injectIntoAgents: true },
      },
      features: { webUi: { enabled: true } },
      agents: {
        providers: Object.fromEntries(
          ["codex", "claude", "pi", "opencode", "copilot", "omp"].map((id) => [id, { enabled: false }]),
        ),
      },
    };
    await atomicWrite(ownerPath, JSON.stringify({ allianceHome: home }) + "\n");
  }
  const installed = config.plugins?.["alliance-work"];
  if (installed && (installed.source !== "directory" || resolve(installed.path ?? "") !== resolve(root)))
    throw new Error("Alliance plugin ID is already owned by another source");
  // This installer never restarts a daemon or rewrites existing listen/relay/UI/auth settings.
  const existing = config.agents?.providers ?? {};
  for (const id of Object.keys(providers))
    if (existing[id] && JSON.stringify(existing[id].command) !== JSON.stringify(providers[id].command))
      throw new Error(`Provider ID already belongs to another installation: ${id}`);
  config.agents = { ...config.agents, providers: { ...existing, ...providers } };
  config.pluginsEnabled = true;
  config.daemon = {
    ...config.daemon,
    mcp: { ...config.daemon?.mcp, enabled: true, injectIntoAgents: true },
  };
  await atomicWrite(path, JSON.stringify(config, null, 2) + "\n");
  const cli = join(root, "node_modules/@getpaseo/cli/bin/paseo");
  const env = { ...process.env, ALLIANCE_WORK_HOME: home };
  const run = (command) => {
    const result = spawnSync(process.execPath, [cli, ...command, "--home", paseoHome, "--json"], {
      env,
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error(`Paseo ${command.join(" ")} failed`);
  };
  run(["daemon", "start"]);
  run(["daemon", "reload"]);
  if (installed) run(["plugin", "reload", "alliance-work"]);
  else run(["plugin", "install", root, "--id", "alliance-work"]);
  // Native plugin settings survive a daemon restart that does not inherit this installer environment.
  const client = new DaemonClient({
    url: `ws://${config.daemon.listen}/ws`,
    clientId: "alliance-installer",
    password: process.env.ALLIANCE_PASEO_PASSWORD,
    connectTimeoutMs: 10000,
  });
  try {
    await client.connect();
    const settings = await client.invokePluginRpc("alliance-work", "settings.alliance.read", {});
    if (settings.status !== "ready") throw new Error(settings.error);
    if (settings.values.home !== home) {
      const saved = await client.invokePluginRpc("alliance-work", "settings.alliance.write", {
        revision: settings.revision,
        values: { ...settings.values, home },
      });
      if (saved.status !== "saved") throw new Error(saved.error);
    }
  } finally {
    await client.close();
  }
  console.log(`Alliance Work installed into ${paseoHome}. Profile home: ${home}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
