import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { instanceState, paseo, reloadRegisteredPlugin, requireIdle, verifyRuntime } from "./paseo.mjs";
import { atomicWrite, loadManifest, projectRoot } from "./profiles.mjs";

export async function install({ home, paseoHome, port = 6771, root = projectRoot, previousRoot = root }) {
  home = resolve(home);
  paseoHome = resolve(paseoHome);
  if (!Number.isInteger(Number(port)) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error("Port must be an integer from 1024 to 65535.");
  await loadManifest(home);
  const providers = JSON.parse(await readFile(join(home, "providers.json"), "utf8"));
  const path = join(paseoHome, "config.json");
  const ownerPath = join(paseoHome, "alliance-instance.json");
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
    const owner = JSON.parse(
      await readFile(ownerPath, "utf8").catch(() => {
        throw new Error("Existing Paseo home has no Alliance ownership marker. It was not changed.");
      }),
    );
    if (owner.allianceHome !== home) throw new Error("Paseo home belongs to another Alliance installation.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    config = {
      version: 1,
      daemon: {
        listen: `127.0.0.1:${port}`,
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
  }
  const installed = config.plugins?.["alliance-work"];
  if (
    installed &&
    (installed.source !== "directory" ||
      ![resolve(root), resolve(previousRoot)].includes(resolve(installed.path ?? "")))
  )
    throw new Error("Alliance plugin ID belongs to another source.");
  const existing = config.agents?.providers ?? {};
  for (const [id, provider] of Object.entries(providers)) {
    if (!existing[id]) continue;
    const expectedOld = [...provider.command];
    expectedOld[1] = join(previousRoot, "scripts/launch.mjs");
    if (
      ![JSON.stringify(provider.command), JSON.stringify(expectedOld)].includes(
        JSON.stringify(existing[id].command),
      )
    )
      throw new Error(`Provider ID belongs to another installation: ${id}`);
  }
  const state = await instanceState(paseoHome, root);
  if (state?.localDaemon === "running") requireIdle(paseoHome, root);
  else if (state && state.localDaemon !== "stopped")
    throw new Error("Daemon state unknown; installation refused.");
  config.agents = { ...config.agents, providers: { ...existing, ...providers } };
  config.pluginsEnabled = true;
  config.daemon = { ...config.daemon, mcp: { ...config.daemon?.mcp, enabled: true, injectIntoAgents: true } };
  if (installed) config.plugins["alliance-work"] = { ...installed, path: root };
  await atomicWrite(ownerPath, JSON.stringify({ allianceHome: home, root }) + "\n");
  await atomicWrite(path, JSON.stringify(config, null, 2) + "\n");
  // Native start is idempotent. Source/config updates use hot reload, never daemon restart.
  paseo(["daemon", "start"], paseoHome, root);
  paseo(["daemon", "reload"], paseoHome, root);
  if (installed) await reloadRegisteredPlugin(paseoHome, root);
  else paseo(["plugin", "install", root, "--id", "alliance-work"], paseoHome, root);
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
  return verifyRuntime(paseoHome, root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  try {
    if (!args.includes("--home") || !args.includes("--paseo-home"))
      throw new Error("Both --home and --paseo-home are required. Prefer alliance-work install.");
    console.log(
      JSON.stringify(
        await install({
          home: option("--home"),
          paseoHome: option("--paseo-home"),
          port: args.includes("--port") ? option("--port") : 6771,
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
