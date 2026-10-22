import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { projectRoot } from "./profiles.mjs";

// Exact daemon versions exercised by native lifecycle/maintenance tests. SDK and CLI stay pinned.
export function requireCompatibleDaemon(version, pinned) {
  if (version && !new Set([pinned, "0.11.2"]).has(version))
    throw new Error(`Running Paseo ${version} is not validated for this Alliance release (CLI ${pinned}).`);
}

export function paseo(command, home, root = projectRoot) {
  const result = spawnSync(
    process.execPath,
    [join(root, "node_modules/@getpaseo/cli/bin/paseo"), ...command, "--home", home, "--json"],
    {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Paseo ${command.join(" ")} failed: ${result.error?.message ?? result.stderr.trim().slice(0, 1200)}`,
    );
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Paseo ${command.join(" ")} returned an unknown status.`);
  }
}

export function requireIdleState(agents, scripts) {
  if (!Array.isArray(agents) || !Array.isArray(scripts))
    throw new Error("Idle state is unknown; no update applied.");
  const busy = agents.filter(
    (agent) => !["idle", "error", "closed", "stopped", "archived"].includes(agent.status),
  );
  const active = scripts.filter((script) => script.lifecycle !== "stopped");
  if (busy.length || active.length)
    throw new Error(
      `Update blocked: agents ${busy.map((a) => `${a.id}:${a.status}`).join(", ") || "none"}; scripts ${active.map((s) => `${s.scriptName}:${s.lifecycle}`).join(", ") || "none"}. Finish the work before setup/update.`,
    );
}

export function requireIdle(home, root = projectRoot) {
  const agents = paseo(["agent", "ls"], home, root);
  const workspaces = paseo(["workspace", "ls"], home, root);
  if (!Array.isArray(workspaces)) throw new Error("Workspace state unknown; no update applied.");
  const scripts = workspaces.flatMap((workspace) => {
    if (!workspace.workspaceId) throw new Error("Workspace identity unknown; no update applied.");
    return paseo(["script", "ls", "--workspace", workspace.workspaceId], home, root);
  });
  requireIdleState(agents, scripts);
  return { agents: agents.length, activeAgents: 0, activeScripts: 0 };
}

export async function instanceState(home, root = projectRoot) {
  try {
    await readFile(join(home, "config.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return paseo(["daemon", "status"], home, root);
}

// Paseo's daemon reload deliberately retains in-memory plugin sources. Register the
// selected source through its native config API before reloading that plugin.
export async function reloadRegisteredPlugin(home, root = projectRoot) {
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const source = config.plugins?.["alliance-work"];
  if (source?.source !== "directory" || resolve(source.path ?? "") !== resolve(root))
    throw new Error("Persisted Alliance source does not match the selected installation.");
  const client = new DaemonClient({
    url: `ws://${config.daemon.listen}/ws`,
    clientId: "alliance-source-activation",
    password: process.env.ALLIANCE_PASEO_PASSWORD,
    connectTimeoutMs: 10000,
  });
  try {
    await client.connect();
    await client.patchDaemonConfig({ plugins: config.plugins });
  } finally {
    await client.close();
  }
  paseo(["plugin", "reload", "alliance-work"], home, root);
}

/**
 * True once no scheduler round that began before `since` (epoch ms) can still send a prompt: the
 * plugin reports a round started later (rounds run one at a time and read the pause first, since
 * 0.1.16), or no Alliance plugin is running. False after `timeoutMs`, e.g. while a round is stuck.
 */
export async function schedulerPaused(since, { health, running, timeoutMs = 120000, interval = 3000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { checkedAt } = await health();
      if (checkedAt && Date.parse(checkedAt) > since) return true;
    } catch {
      // Without an answer only a plugin that is not running shows that no round is in flight.
      if (!(await running().catch(() => true))) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(interval);
  }
}

/** schedulerPaused for this Paseo home: the plugin's wakeupHealth via rooms.list. */
export async function schedulerPausedAt(home, since, root = projectRoot) {
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const client = new DaemonClient({
    url: `ws://${config.daemon.listen}/ws`,
    clientId: "alliance-maintenance",
    password: process.env.ALLIANCE_PASEO_PASSWORD,
    connectTimeoutMs: 10000,
  });
  let connected = false;
  try {
    return await schedulerPaused(since, {
      health: async () => {
        if (!connected) {
          await client.connect();
          connected = true;
        }
        return (await client.invokePluginRpc("alliance-work", "rooms.list", {})).wakeupHealth;
      },
      running: async () => {
        const plugins = paseo(["plugin", "ls"], home, root);
        const plugin = (Array.isArray(plugins) ? plugins : plugins.plugins)?.find(
          (p) => p.id === "alliance-work",
        );
        return plugin?.status === "running";
      },
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function verifyRuntime(home, root = projectRoot) {
  const state = await instanceState(home, root);
  if (state?.localDaemon !== "running" || state.connectedDaemon !== "reachable")
    throw new Error("Alliance daemon is not reachable after installation.");
  const plugins = paseo(["plugin", "ls"], home, root);
  const plugin = (Array.isArray(plugins) ? plugins : plugins.plugins)?.find((p) => p.id === "alliance-work");
  if (plugin?.status !== "running" || plugin.error)
    throw new Error("Alliance plugin did not reach running state.");
  if (resolve(plugin.path ?? "") !== resolve(root))
    throw new Error("Running Alliance plugin is not the selected candidate source.");
  const url = `http://${state.listen}`;
  const get = (path) => fetch(url + path, { signal: AbortSignal.timeout(10000) });
  for (const path of ["/api/health", "/"]) {
    // A pooled keep-alive socket left idle while the paseo calls above blocked the event loop may
    // already be closed by the daemon; its reuse fails with ECONNRESET. Retry once on a new one.
    const response = await get(path).catch((error) => {
      if (error?.cause?.code !== "ECONNRESET") throw error;
      return get(path);
    });
    if (!response.ok) throw new Error(`Alliance ${path} returned ${response.status}.`);
  }
  return { version: state.daemonVersion, url, plugin: plugin.status };
}
