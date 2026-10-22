import { createHash } from "node:crypto";
import { processIdentity } from "../server/jobs.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** States in which the reminder will still wake its owner. */
const waking = new Set(["scheduled", "pending", "dispatching"]);

/**
 * `alliance-work wait`: register what should wake the owner (a tracked job, a process to track,
 * a child's running turn, or a time) as an idle reminder whose key follows from the request, so
 * repeating the command registers nothing new (`--minutes` within the same turn of the owner).
 * When the owner is the caller (`self`) and its assignment is active or waiting, it is checkpointed
 * waiting, so the turn it ends now is not its handback. A handback, blocker or pause stands instead,
 * whichever turn recorded it, and `say` prints so.
 * `rpc(method, input)` calls the plugin. Returns the reminder key.
 * @param {(method: string, input: unknown) => Promise<any>} rpc
 * @param {{roomId: string, ownerId: string, self?: string | null, reason: string, job?: string, pid?: string, title?: string, agent?: string, at?: string, minutes?: string}} request
 * @param {(line: string) => void} [say]
 */
export async function registerWait(
  rpc,
  { roomId, ownerId, self, reason, job, pid, title, agent, at, minutes },
  say = (line) => console.log(line),
) {
  const chosen = [job, pid, agent, at, minutes].filter((value) => value !== undefined);
  if (chosen.length !== 1) throw new Error("Choose exactly one of --job, --pid, --agent, --at or --minutes");
  if (title !== undefined && pid === undefined) throw new Error("--title goes with --pid");
  const members = async () => (await rpc("rooms.list", {})).members;
  const assignment =
    ownerId === self || minutes !== undefined
      ? (await rpc("autonomy.list", {})).find((r) => r.agentId === ownerId)
      : undefined;
  let trigger;
  let key;
  if (pid !== undefined) {
    const id = Number(pid);
    const identity = await processIdentity(id);
    if (!identity) throw new Error(`Process ${pid} is not running; nothing to wait for`);
    // One key per process run: a reused PID is another run.
    const jobKey = `wait-pid-${id}-${digest([roomId, ownerId, id, identity]).slice(0, 12)}`;
    await rpc("jobs.track", {
      key: jobKey,
      roomId,
      ownerId,
      pid: id,
      title: title ?? reason.split("\n")[0].slice(0, 200),
    });
    trigger = { kind: "job", key: jobKey };
  } else if (job !== undefined) trigger = { kind: "job", key: job };
  else if (agent !== undefined) {
    const child = (await members()).find((member) => member.id === agent);
    if (!child) throw new Error(`Unknown Alliance member: ${agent}`);
    if (!child.lastTurnId)
      throw new Error(`${agent} has not started a turn yet; wait on it once it runs, or use --minutes`);
    if (child.lastOutcome !== null)
      throw new Error(
        `${agent} is not running a turn (turn ${child.lastTurnId} ended ${child.lastOutcome}). Decide on that turn now, or retry once work you just sent it has started.`,
      );
    trigger = { kind: "turn", agentId: agent, turnId: child.lastTurnId };
  } else if (at !== undefined) {
    const due = Date.parse(at);
    if (!Number.isFinite(due)) throw new Error("--at takes an ISO time");
    trigger = { kind: "time", at: Math.max(0, due) };
  } else {
    const count = Number(minutes);
    if (!(Number.isSafeInteger(count) && count > 0))
      throw new Error("--minutes takes whole minutes (1 or more)");
    trigger = { kind: "time", at: Date.now() + count * 60000 };
    // Counted from the first call: the same request in the same turn of the owner is one reminder.
    const turn =
      assignment && assignment.phase !== "archived"
        ? assignment.turnId
        : ((await members()).find((member) => member.id === ownerId)?.lastTurnId ?? null);
    key = `wait-${digest([roomId, ownerId, "minutes", count, turn, reason]).slice(0, 24)}`;
  }
  key ??= `wait-${digest([roomId, ownerId, trigger, reason]).slice(0, 24)}`;
  const registered =
    minutes !== undefined ? (await rpc("wakeups.list", {})).find((w) => w.key === key) : undefined;
  const record =
    registered ?? (await rpc("wakeups.add", { key, roomId, ownerId, reason, trigger, delivery: "idle" }));
  if (!waking.has(record.state))
    throw new Error(
      `${key} was already ${record.state} (${record.note ?? "no note"}); nothing new was registered. Act on it, or wait with another --reason.`,
    );
  if (ownerId === self && assignment && assignment.phase !== "archived") {
    // An explicit checkpoint, not wait, changes these; the reminder still wakes the caller.
    const standing = { review: "handback", blocked: "blocker", paused: "pause" }[assignment.phase];
    if (standing)
      say(`Your ${standing} stands (${assignment.reason.slice(0, 300)}); wait did not replace it.`);
    else
      await rpc("autonomy.checkpoint", {
        agentId: ownerId,
        phase: "waiting",
        reason: `Waiting on ${key}: ${reason}`,
      });
  }
  return key;
}
