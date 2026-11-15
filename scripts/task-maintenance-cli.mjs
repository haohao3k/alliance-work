import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { processIdentity } from "../server/jobs.mjs";
import { readMaintenanceHold, saveMaintenanceHold } from "../server/maintenance-hold.mjs";
import { bootTime, LOCK, lockState, MUTEX, takeLock } from "../server/maintenance-lock.mjs";
import { commandClient } from "./command-client.mjs";
import { harnessPath } from "./deploy.mjs";
import { doctor, installation } from "./maintenance.mjs";
import { paseo, schedulerPausedAt } from "./paseo.mjs";
import { assertNoLinks, atomicWrite, projectRoot } from "./profiles.mjs";
import { holdTasks, resumeTasks, runTaskMaintenance } from "./task-maintenance.mjs";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function connected(home, action) {
  const installed = await installation(home);
  if (!installed) throw new Error("No owned Alliance installation exists");
  const config = await json(join(installed.paseoHome, "config.json"));
  const client = commandClient({
    url: `ws://${config.daemon.listen}/ws`,
    clientId: "alliance-task-maintenance",
    password: process.env.ALLIANCE_PASEO_PASSWORD,
  });
  try {
    await client.connect();
    return await action(client, installed);
  } finally {
    await client.close();
  }
}
function runChild(command, home, ledger) {
  if (!command.length) throw new Error("maintenance run needs a command after --");
  return new Promise((resolveResult, reject) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: {
        ...process.env,
        ALLIANCE_PARENT_MAINTENANCE: String(process.pid),
        ALLIANCE_MAINTENANCE_HOLD: ledger.id,
        ALLIANCE_WORK_HOME: home,
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolveResult({ code: 0 })
        : reject(
            new Error(
              `Maintenance update command failed (${signal ?? code}); hold ${ledger.id} retained for recovery`,
            ),
          ),
    );
  });
}

export async function taskMaintenanceCommand(home, action, options = {}) {
  if (action === "status") return readMaintenanceHold(home);
  if (!["hold", "run", "resume"].includes(action)) throw new Error("Use maintenance status|hold|run|resume");
  const previous = await readMaintenanceHold(home);
  if (action === "resume" && (!previous || previous.phase === "complete")) return previous;
  if (options.includeNew && (!previous || !options.key || options.key !== previous.id))
    throw new Error("--include-new needs --key matching the active maintenance hold");
  if (action === "resume" && (!options.reason || !options.evidence))
    throw new Error("Recovery needs --reason and --evidence describing the verified update or rollback");
  if (options.evidence) await readFile(resolve(options.evidence), "utf8");
  await assertNoLinks(home);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const installed = await installation(home);
  if (!installed) throw new Error("No owned Alliance installation exists");
  const owner = await json(join(installed.paseoHome, "alliance-instance.json"));
  if (resolve(owner.allianceHome) !== resolve(home))
    throw new Error("Paseo home is not owned by this Alliance installation");
  const key = previous && previous.phase !== "complete" ? previous.id : (options.key ?? randomUUID());
  const mutex = await takeLock(home, MUTEX);
  let ownsPause = false;
  let anchor;
  try {
    await atomicWrite(
      join(mutex, "owner.json"),
      `${JSON.stringify({ pid: process.pid, host: hostname(), boot: bootTime(), started: new Date().toISOString() })}\n`,
    );
    const state = await lockState(home);
    if (state.held) {
      if (state.owner?.holdId !== key || !previous || previous.phase === "complete")
        throw new Error("Another maintenance operation owns the scheduler pause");
      if (
        state.owner.controllerPid !== process.pid &&
        state.owner.controllerIdentity &&
        (await processIdentity(state.owner.controllerPid)) === state.owner.controllerIdentity
      )
        throw new Error("Another maintenance controller is still running");
    } else await takeLock(home);
    // The native supervisor survives worker restart and keeps older plugins paused if this CLI dies.
    anchor = await json(join(installed.paseoHome, "paseo.pid"));
    if (!Number.isInteger(anchor.pid) || anchor.uid !== process.getuid?.())
      throw new Error("Native supervisor custody is unverified");
    const anchorIdentity = await processIdentity(anchor.pid);
    if (!anchorIdentity) throw new Error("Native supervisor is not running");
    const daemon = await connected(home, (client) => client.getDaemonStatus({ timeout: 15000 }));
    if (anchor.serverId !== daemon.serverId) throw new Error("Native supervisor server identity changed");
    await atomicWrite(
      join(home, LOCK, "owner.json"),
      `${JSON.stringify({
        pid: anchor.pid,
        host: hostname(),
        boot: bootTime(),
        started: new Date().toISOString(),
        holdId: key,
        controllerPid: process.pid,
        controllerIdentity: await processIdentity(process.pid),
        supervisorIdentity: anchorIdentity,
      })}\n`,
    );
    ownsPause = true;
    if (!(await schedulerPausedAt(installed.paseoHome, Date.now(), installed.root)))
      throw new Error("Scheduler pause was not acknowledged; no tasks changed");
    process.env.PATH = await harnessPath(home);
    const adapter = {
      list: async () => {
        const current = await installation(home);
        const rows = paseo(["agent", "ls"], current.paseoHome, projectRoot);
        return connected(home, async (client) => {
          const agents = [];
          for (const row of rows) {
            const agent = (await client.fetchAgent({ agentId: row.id, timeout: 15000 }))?.agent;
            if (!agent) throw new Error(`Native agent unavailable: ${row.id}`);
            agents.push(agent);
          }
          return agents;
        });
      },
      get: (id) =>
        connected(
          home,
          async (client) => (await client.fetchAgent({ agentId: id, timeout: 15000 }))?.agent ?? null,
        ),
      timeline: (id) =>
        connected(home, (client) =>
          client.fetchAgentTimeline(id, {
            direction: "tail",
            limit: 100,
            projection: "canonical",
            timeout: 15000,
          }),
        ),
      baselineUserIds: (id, boundary) =>
        connected(home, async (client) => {
          const index = await client.listAgentTimelinePrompts(id, { timeout: 15000 });
          if (index.error || !boundary.epoch || boundary.seq === null || index.epoch !== boundary.epoch)
            throw new Error(`Native prehold prompt boundary changed: ${id}`);
          const ids = new Set();
          for (const prompt of index.prompts.filter((row) => row.seq <= boundary.seq)) {
            const page = await client.fetchAgentTimeline(id, {
              direction: "after",
              cursor: { epoch: index.epoch, seq: prompt.seq - 1 },
              limit: 1,
              wholeTurns: false,
              projection: "canonical",
              timeout: 15000,
            });
            if (page.error || page.gap || page.staleCursor || page.epoch !== boundary.epoch)
              throw new Error(`Native prehold user history unavailable: ${id}`);
            const row = page.entries.find(
              (row) =>
                row.seqStart <= prompt.seq && row.seqEnd >= prompt.seq && row.item.type === "user_message",
            );
            if (!row) throw new Error(`Native prehold user identity unavailable: ${id}`);
            for (const value of [row.item.clientMessageId, row.item.messageId])
              if (typeof value === "string") ids.add(value);
          }
          return [...ids];
        }),
      send: (id, text, sendOptions) =>
        connected(home, (client) => client.sendAgentMessage(id, text, sendOptions)),
      stop: async (id) => {
        const current = await installation(home);
        return paseo(["agent", "stop", id], current.paseoHome, projectRoot);
      },
      snapshot: () =>
        connected(home, async (client) => ({
          daemon: await client.getDaemonStatus({ timeout: 15000 }),
          responsibilities: await client.invokePluginRpc("alliance-work", "rooms.list", {}),
          terminals: paseo(["terminal", "ls", "--all"], installed.paseoHome, projectRoot),
        })),
      pause: async () => {},
      release: async (ledger) => {
        const pause = await json(join(home, LOCK, "owner.json"));
        if (pause.holdId !== ledger.id || pause.controllerPid !== process.pid)
          throw new Error("Maintenance pause ownership changed");
        await rm(join(home, LOCK), { recursive: true });
        ownsPause = false;
      },
      health: async () => {
        const hold = await readMaintenanceHold(home);
        if (hold && hold.phase !== "complete") {
          await connected(home, (client) =>
            client.invokePluginRpc("alliance-work", "maintenance.reconcile", { holdId: hold.id }),
          );
        }
        return doctor(home);
      },
    };
    if (action === "hold") {
      const support = await connected(home, (client) =>
        client.invokePluginRpc("alliance-work", "maintenance.status", {}),
      );
      if (support?.durablePause !== true)
        throw new Error(
          "This plugin needs maintenance run for its first upgrade; durable standalone hold is not supported yet",
        );
    }
    if (action === "resume") {
      previous.recoveryEvidence = resolve(options.evidence);
      await saveMaintenanceHold(home, previous);
      return await resumeTasks(home, adapter, { reason: options.reason, result: "recovered" });
    }
    const settings = {
      reason: options.reason,
      key,
      timeoutMs: options.timeoutMs,
      interrupt: options.interrupt,
      includeNew: options.includeNew,
      evidence: options.evidence ? resolve(options.evidence) : undefined,
    };
    if (action === "hold") return await holdTasks(home, adapter, settings);
    return await runTaskMaintenance(home, adapter, {
      ...settings,
      update: (ledger) => runChild(options.command ?? [], home, ledger),
    });
  } finally {
    const ledger = await readMaintenanceHold(home).catch(() => ({ phase: "failed" }));
    if (ownsPause && (!ledger || ledger.phase === "complete")) {
      const pause = await json(join(home, LOCK, "owner.json")).catch(() => null);
      if (pause?.controllerPid === process.pid) await rm(join(home, LOCK), { recursive: true, force: true });
    }
    await rm(mutex, { recursive: true, force: true });
  }
}
