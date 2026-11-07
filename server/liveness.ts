import { createHash } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { observeJob } from "./jobs.mjs";
import { availableOwner } from "./lifecycle";
import type { MemberRecord, RoomStore } from "./store";
import type { Wakeups } from "./wakeups";

/** A running turn quiet for longer than this may be stuck on a prompt or a hung command. */
export const SILENT_MS = 20 * 60000;
/** An approval request still pending this long after Alliance first saw it is denied. */
export const APPROVAL_MS = 5 * 60000;
/** An unanswered notice lapses after this; the member keeps the incident on record. */
const NOTICE_MS = 6 * 3600000;
/** The denied member reads this as the result of the call it asked to run. */
const DENIAL =
  "Alliance denied this request after 5 minutes: nobody approves commands for Alliance members. Redo the step without anything that needs approval (for example, write into a fresh `mktemp -d` directory instead of running `rm -rf` with a glob) and continue your task.";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
type Agent = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
type Permission = NonNullable<Agent["pendingPermissions"]>[number];
/** What the scheduler last read from the daemon (runtime DaemonInfo); null before it connects. */
type Daemon = { version: string | null; agentMessageProvenance: boolean } | null;

/**
 * How an owner stops a child's running turn on this daemon. A steer reaches the model only after
 * the running tool call returns, so it never reaches a command stuck on a prompt.
 */
export function interruptRule(daemon: Daemon) {
  if (daemon?.agentMessageProvenance)
    return 'send_agent_prompt with activeTurnBehavior "interrupt", or cancel_agent first';
  if (daemon?.version?.startsWith("0.11."))
    return `any send_agent_prompt, which interrupts on Paseo ${daemon.version}, or cancel_agent first`;
  return "cancel_agent, then send_agent_prompt";
}

/**
 * Running members that wait. Nobody approves an Alliance member's commands, so an approval
 * request is denied after 5 minutes, never allowed. A turn otherwise quiet for 20 minutes (Paseo
 * touches an agent's updatedAt on every live event) may be hung: the nearest live member owner
 * hears once per incident; work without one only shows it in status. Nothing is interrupted.
 */
export class Liveness {
  private running?: Promise<void>;
  private stopped = false;
  /** The daemon the scheduler last connected to; the runtime points it at its own record. */
  daemon: () => Daemon = () => null;
  constructor(
    private store: RoomStore,
    private wakes: Wakeups,
    private now: () => number = Date.now,
  ) {}

  /** Paseo reports a member's approval request: its 5 minutes start now. */
  requested(id: string, requestId: string) {
    const member = this.store.member(id);
    if (!member || member.archivedAt || member.approvals?.some((a) => a.id === requestId)) return;
    this.store.updateMember(id, {
      approvals: [...(member.approvals ?? []), { id: requestId, since: this.now() }],
    });
  }

  sweep(api: PaseoApi) {
    if (this.stopped) return Promise.resolve();
    if (!this.running)
      this.running = this.round(api).finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop() {
    this.stopped = true;
    await this.running;
  }

  private async round(api: PaseoApi) {
    if (!this.store.members().some((m) => !m.archivedAt || m.silence || m.approvals)) return;
    const listedAt = this.now();
    // One listing covers every running agent; only members are checked.
    const filter = { statuses: ["running" as const] };
    const listed = await api.agents
      .list({ filter: { ...filter, includeBackground: true } })
      // Paseo 0.11 has no background workspaces, and the client refuses the flag for it.
      .catch((error: Error) => {
        if (!/background workspaces/.test(error.message)) throw error;
        return api.agents.list({ filter });
      });
    const running = new Map(listed.entries.map((entry) => [entry.agent.id, entry.agent]));
    const errors: unknown[] = [];
    for (const member of this.store.members()) {
      if (this.stopped) return;
      try {
        await this.deny(member.id, running.get(member.id), listedAt, api);
        await this.check(member, running.get(member.id), api);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Liveness sweep incomplete; state retained");
  }

  /**
   * Denies each approval request of the member's running turn 5 minutes after Alliance first saw
   * it (Paseo's request hook, or the first sweep that lists it), with how to redo the step. A
   * request still pending after its denial is denied again at the next sweep.
   */
  private async deny(id: string, agent: Agent | undefined, listedAt: number, api: PaseoApi) {
    const member = this.store.member(id);
    if (!member) return;
    const pending = member.archivedAt || agent?.archivedAt ? [] : (agent?.pendingPermissions ?? []);
    const asking = pending.filter((p) => p.id);
    const prior = member.approvals ?? [];
    const approvals = [
      // A request the hook recorded after this listing was read still waits.
      ...prior.filter((a) => a.since >= listedAt || asking.some((p) => p.id === a.id)),
      ...asking
        .filter((p) => !prior.some((a) => a.id === p.id))
        .map((p) => ({ id: p.id, since: this.now() })),
    ];
    if (JSON.stringify(approvals) !== JSON.stringify(prior))
      this.store.updateMember(id, { approvals: approvals.length ? approvals : undefined });
    for (const p of asking) {
      const since = approvals.find((a) => a.id === p.id)?.since ?? this.now();
      if (this.now() - since < APPROVAL_MS) continue;
      await api.agents
        .ref(id)
        .respondToPermission({ requestId: p.id, response: { behavior: "deny", message: DENIAL } });
      if (this.store.member(id)?.denied?.requestId !== p.id) this.denied(member, p);
    }
  }

  /** Status shows the denial; the owner finds it among its pull items and is not woken. */
  private denied(member: MemberRecord, p: Permission) {
    const input = p.input?.command;
    const command = p.detail?.type === "shell" ? p.detail.command : typeof input === "string" ? input : null;
    this.store.updateMember(member.id, {
      denied: {
        requestId: p.id,
        tool: p.name,
        command: command?.slice(0, 300) ?? null,
        at: new Date(this.now()).toISOString(),
      },
    });
    const owner = availableOwner(this.store, member.id);
    const key = `permission-${sha256(`${member.id}:${p.id}`).slice(0, 32)}`;
    if (!owner || this.wakes.list().some((w) => w.key === key)) return;
    this.wakes.add({
      key,
      // The owner's own room always authorizes its reminder.
      roomId: this.store.member(owner)?.roomId ?? member.roomId,
      ownerId: owner,
      reason: `Alliance denied ${member.role} ${member.id}'s approval request to run ${p.name}${command ? `: ${command.slice(0, 200)}` : ""}, pending for 5 minutes, and told it to redo that step without it.`,
      trigger: { kind: "time", at: this.now() },
      delivery: "pull",
      expiresAt: this.now() + NOTICE_MS,
    });
  }

  /**
   * The member's quiet stretch in a running turn; null while it works, waits for an approval (that
   * request is denied instead) or waits on a job it tracks.
   */
  private async incident(member: MemberRecord, agent: Agent) {
    if (member.archivedAt || agent.archivedAt || agent.pendingPermissions?.length) return null;
    const times = [agent.updatedAt, agent.activeTurn?.startedAt]
      .map((at) => (at ? Date.parse(at) : Number.NaN))
      .filter(Number.isFinite);
    if (!times.length) return null;
    const since = Math.max(...times);
    if (this.now() - since <= SILENT_MS) return null;
    // A long command the member tracks as a job is an announced wait.
    for (const job of this.store.jobs().filter((j) => j.ownerId === member.id))
      if ((await observeJob(job)).state !== "exited") return null;
    return { turnId: agent.activeTurn?.turnId ?? member.lastTurnId ?? null, since };
  }

  private async check(member: MemberRecord, agent: Agent | undefined, api: PaseoApi) {
    const found = agent && (await this.incident(member, agent));
    const prior = this.store.member(member.id)?.silence;
    if (!agent || !found) {
      // It works again, waits on someone, or its turn ended: a notice not sent yet no longer applies.
      if (prior?.key) this.wakes.withdraw(prior.key, "Activity resumed or the turn ended; notice withdrawn");
      if (prior) this.store.updateMember(member.id, { silence: undefined });
      return;
    }
    // One incident per quiet stretch.
    const since = new Date(found.since).toISOString();
    const owner = availableOwner(this.store, member.id);
    const key = owner && `silent-${sha256(`${member.id}:${found.turnId}:${since}:${owner}`).slice(0, 32)}`;
    if (prior?.since === since && prior.key === key) return;
    // A new incident, or the same one under another owner.
    if (prior?.key) this.wakes.withdraw(prior.key, "Activity resumed or the owner changed; notice withdrawn");
    let notifiedAt: string | null = null;
    if (owner && key) {
      if (!this.wakes.list().some((w) => w.key === key))
        this.wakes.add({
          key,
          // The owner's own room always authorizes its reminder.
          roomId: this.store.member(owner)?.roomId ?? member.roomId,
          ownerId: owner,
          reason: await this.reason(member, agent, found.since, api),
          trigger: { kind: "time", at: this.now() },
          delivery: "idle",
          expiresAt: this.now() + NOTICE_MS,
        });
      notifiedAt = new Date(this.now()).toISOString();
    }
    this.store.updateMember(member.id, { silence: { turnId: found.turnId, since, key, notifiedAt } });
  }

  /** The shell command (or tool) the member's turn is still running, when Paseo shows it. */
  private async runningCommand(member: MemberRecord, api: PaseoApi) {
    let command = "";
    try {
      const tail = await api.agents.ref(member.id).timeline.refetch({ direction: "tail", limit: 3 });
      for (const { item } of tail.entries)
        if (item.type === "tool_call" && item.status === "running")
          command = item.detail.type === "shell" ? item.detail.command : item.name;
    } catch {
      /* The command is detail; the notice stands without it. */
    }
    return command;
  }

  /** How long it has been quiet, the turn's age and the command it is still running, when known. */
  private async reason(member: MemberRecord, agent: Agent, since: number, api: PaseoApi) {
    const minutes = (from: number) => Math.floor((this.now() - from) / 60000);
    const started = agent.activeTurn?.startedAt ? Date.parse(agent.activeTurn.startedAt) : Number.NaN;
    const command = await this.runningCommand(member, api);
    return `${member.role} ${member.id} has shown no activity for ${minutes(since)} min${Number.isFinite(started) ? ` in a turn running for ${minutes(started)} min` : ""}${command ? `; still running: ${command.slice(0, 300)}` : ""}. It may be waiting for input or hung: inspect its activity (get_agent_activity). If it is stuck, interrupt it (${interruptRule(this.daemon())}) and tell it what to do instead; a steer reaches it only after the running command returns. Otherwise let it run; a long command it tracks with alliance-work jobs track is not reported.`;
  }
}
