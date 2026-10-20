import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { type AutonomyState, pauseKind } from "../shared/autonomy";
import { responsibleOwner } from "../shared/operations";
import type { Autonomy } from "./autonomy";
import { observeJob } from "./jobs.mjs";
import type { MemberRecord, RoomStore } from "./store";
import type { Wakeups } from "./wakeups";

/** Roles whose acceptance must cover the Human's outcome, not only a technical check. */
export const coordinatingRoles = new Set(["hq", "supervisor", "lead"]);
export const STALE_DECISION_MS = 48 * 3600000;
const STALE_SCAN_MS = 10 * 60000;
/** Legacy baselines are spread over a day and each scan sends a bounded number of reminders. */
const LEGACY_SPREAD_MS = 24 * 3600000;
export const REMINDERS_PER_SCAN = 4;
const terminalWake = new Set(["acknowledged", "canceled", "expired"]);

export type LiveState = {
  status: string;
  archived: boolean;
  permissions: number;
  /** Paseo's time of the latest message sent to the agent, when known. */
  lastMessageAt?: string | null;
};
export type LifecycleView = {
  state: "archived" | "archivable" | "held" | "awaiting-decision" | "rejected";
  blockers: string[];
};

/** Responsible owners above a member, nearest first. Cycles end the walk. */
export function decisionChain(store: RoomStore, id: string) {
  const chain: string[] = [];
  const seen = new Set([id]);
  const member = store.member(id);
  let current = member ? responsibleOwner(member) : null;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    const parent = store.member(current);
    current = parent ? responsibleOwner(parent) : null;
  }
  return chain;
}

/**
 * A decision comes from the Human (null) or an agent in the member's responsible owner chain.
 * The chain may include a native parent that is not an Alliance member. The Human is whoever
 * runs the CLI outside an agent session; an agent that strips its own session identity can
 * still claim it, so that boundary is documented rather than enforced.
 */
export function authorizeDecision(store: RoomStore, id: string, actorId: string | null) {
  if (!store.member(id)) throw new Error("Unknown Alliance member");
  if (actorId === id)
    throw new Error("An agent cannot decide on its own work; its responsible owner or the Human decides");
  if (actorId === null || decisionChain(store, id).includes(actorId)) return;
  if (!store.member(actorId))
    throw new Error(
      "Unknown deciding agent; to decide as the Human, run accept from a terminal outside agent sessions",
    );
  throw new Error("Only the responsible owner chain or the Human may decide on this work");
}

/** Acceptance recorded after the pause began lifts a cancellation/handoff pause for archive. */
function pauseBlocker(member: MemberRecord, a: AutonomyState | undefined) {
  if (!a) return null;
  const kind = pauseKind(a);
  if (!kind) return null;
  if (kind === "checkpoint") return "assignment paused by checkpoint; start it again or set it to review";
  const pausedAt = a.pausedAt ?? a.updatedAt;
  const decidedAt = member.decisionAt ? Date.parse(member.decisionAt) : Number.NaN;
  if (!(decidedAt > pausedAt))
    return `assignment paused by ${kind}; record the acceptance again after the pause to close it`;
  return null;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

export class Lifecycle {
  private lastStaleScan = Number.NEGATIVE_INFINITY;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private store: RoomStore,
    private wakes: Wakeups,
    private autonomy: Autonomy,
    private now: () => number = Date.now,
  ) {}

  /** Decision scope of an acceptance. Legacy records are read once from their disposition file. */
  async scope(member: MemberRecord) {
    if (member.decisionScope) return member.decisionScope;
    if (member.decision !== "accepted" || !member.decisionEvidence) return null;
    let scope: "technical" | "product" = "technical";
    try {
      const record = JSON.parse(await readFile(member.decisionEvidence, "utf8"));
      if (record?.agentId === member.id && record.product) scope = "product";
    } catch {
      /* An unreadable record never upgrades an acceptance. */
    }
    const current = this.store.member(member.id);
    if (current?.decisionEvidence === member.decisionEvidence && !current.decisionScope)
      this.store.updateMember(member.id, { decisionScope: scope });
    return scope;
  }

  /** Reasons that need no native readback; rechecked synchronously right before archive. */
  private durableBlockers(member: MemberRecord, a: AutonomyState | undefined) {
    const blockers: string[] = [];
    if (!member.decisionEvidence) blockers.push("acceptance has no recorded evidence");
    if (member.keep) blockers.push("kept open (members keep)");
    // A decision binds to the turn it reviewed; a newer turn needs its own decision.
    if (member.decisionTurnId !== undefined && member.decisionTurnId !== (member.lastTurnId ?? null))
      blockers.push("a newer turn started after this decision");
    // Restored natively after an earlier archive: a new turn, or a decision recorded after that
    // archive, reopens it.
    const decidedAt = member.decisionAt ? Date.parse(member.decisionAt) : Number.NaN;
    if (a?.phase === "archived" && !(decidedAt > a.updatedAt))
      blockers.push("restored natively after an earlier archive; a new turn or a new decision reopens it");
    if (a?.autoArchive === false) blockers.push("auto-archive disabled for this assignment");
    if (a && ["uncertain", "dispatching"].includes(a.delivery))
      blockers.push("autonomy delivery is uncertain; reconcile it first");
    const paused = pauseBlocker(member, a);
    if (paused) blockers.push(paused);
    if (this.store.obligations().some((o) => o.ownerId === member.id && o.state === "open"))
      blockers.push("owns an open obligation");
    for (const w of this.wakes.list())
      if (w.ownerId === member.id && !terminalWake.has(w.state))
        blockers.push(`wakeup ${w.key} is ${w.state}`);
    return blockers;
  }

  /**
   * Reasons an accepted member stays open, from durable state plus one live readback.
   * Native children are checked separately by the sweep because they need a Paseo listing.
   */
  async blockers(
    member: MemberRecord,
    live: LiveState,
    childState: (id: string) => Promise<LiveState | null>,
    a: AutonomyState | undefined = this.autonomy.get(member.id),
  ) {
    if (member.decision !== "accepted") return [];
    const blockers = this.durableBlockers(member, a);
    if (coordinatingRoles.has(member.role) && member.decisionBy !== null) {
      if ((await this.scope(member)) !== "product")
        blockers.push(
          `${member.role} needs product acceptance (accept --product) by its owner, or the Human's decision`,
        );
    }
    if (live.status !== "idle") blockers.push(`agent is ${live.status}`);
    // A turn whose start hook was lost still shows up as a newer message in Paseo.
    if (
      live.lastMessageAt &&
      member.decisionAt &&
      Date.parse(live.lastMessageAt) > Date.parse(member.decisionAt)
    )
      blockers.push("new work arrived after this decision");
    if (live.permissions) blockers.push("permission request pending");
    const children = this.store
      .members()
      .filter((m) => m.id !== member.id && (responsibleOwner(m) === member.id || m.parentId === member.id));
    for (const child of children) {
      const state = child.archivedAt
        ? { status: "idle", archived: true, permissions: 0 }
        : await childState(child.id);
      if (!state) blockers.push(`child ${child.id} state unknown`);
      else if (state.archived) continue;
      else if (child.decision !== "accepted") blockers.push(`child ${child.id} not accepted`);
      else if (state.status !== "idle" || state.permissions)
        blockers.push(`child ${child.id} still ${state.status}`);
    }
    for (const job of this.store.jobs().filter((j) => j.ownerId === member.id))
      if ((await observeJob(job)).state !== "exited") blockers.push(`job ${job.key} still running`);
    return blockers;
  }

  async describe(
    member: MemberRecord,
    live: LiveState,
    others: Map<string, LiveState>,
  ): Promise<LifecycleView> {
    if (live.archived) return { state: "archived", blockers: [] };
    if (member.decision === "rejected")
      return { state: "rejected", blockers: ["rejected; owner decides rework or archive"] };
    if (member.decision !== "accepted") {
      const owner = responsibleOwner(member);
      return {
        state: "awaiting-decision",
        blockers: [owner ? `awaiting decision by owner ${owner}` : "awaiting the Human's decision"],
      };
    }
    const blockers = await this.blockers(member, live, async (id) => others.get(id) ?? null);
    return { state: blockers.length ? "held" : "archivable", blockers };
  }

  private markArchived(id: string) {
    const member = this.store.member(id);
    if (member && !member.archivedAt)
      this.store.updateMember(id, { archivedAt: new Date(this.now()).toISOString() });
    const a = this.autonomy.get(id);
    if (a && a.phase !== "archived") this.autonomy.markArchived(id);
  }

  /** null: Paseo no longer has the agent (it was deleted). undefined: readback failed. */
  private async live(api: PaseoApi, id: string): Promise<LiveState | null | undefined> {
    let state: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
    try {
      state = await api.agents.ref(id).refresh();
    } catch {
      return undefined;
    }
    if (!state) {
      // A natively deleted agent can never be archived or decide anything; stop tracking it.
      this.markArchived(id);
      return null;
    }
    if (state.agent.archivedAt) this.markArchived(id);
    return {
      status: state.agent.status,
      archived: state.agent.archivedAt != null,
      permissions: state.agent.pendingPermissions?.length ?? 0,
      lastMessageAt: (state.agent as { lastUserMessageAt?: string | null }).lastUserMessageAt ?? null,
    };
  }

  /** True while any member may still need an archive decision or a stale-decision reminder. */
  pending() {
    return this.store.members().some((m) => !m.archivedAt);
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
    const errors: unknown[] = [];
    for (const member of this.store.members()) {
      if (this.stopped) return;
      if (member.archivedAt || member.decision !== "accepted" || !member.decisionEvidence) continue;
      try {
        await this.archiveIfDone(member, api);
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.now() - this.lastStaleScan >= STALE_SCAN_MS) {
      this.lastStaleScan = this.now();
      try {
        await this.remindStale(api);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Lifecycle sweep incomplete; state retained");
  }

  private async archiveIfDone(member: MemberRecord, api: PaseoApi) {
    // Baseline before any await: a pause or opt-out recorded during the reads must win.
    const a0 = this.autonomy.get(member.id);
    const live = await this.live(api, member.id);
    if (!live || live.archived) return;
    const blockers = await this.blockers(member, live, async (id) => (await this.live(api, id)) ?? null, a0);
    if (blockers.length || this.stopped) return;
    // Native archive cascades even to non-Alliance children. Archive leaves first; a parent
    // becomes eligible on a later sweep after its native children are archived.
    const nativeChildren = await api.agents.list({
      filter: { labels: { "paseo.parent-agent-id": member.id }, includeArchived: false },
      page: { limit: 1 },
    });
    if (nativeChildren.entries.length) return;
    const fresh = await this.live(api, member.id);
    if (!fresh || fresh.archived || fresh.status !== "idle" || fresh.permissions) return;
    if (
      fresh.lastMessageAt &&
      member.decisionAt &&
      Date.parse(fresh.lastMessageAt) > Date.parse(member.decisionAt)
    )
      return;
    // Final synchronous recheck: no await between it and the archive request.
    const current = this.store.member(member.id);
    const a1 = this.autonomy.get(member.id);
    if (
      this.stopped ||
      !current ||
      current.archivedAt ||
      current.decision !== "accepted" ||
      current.decisionAt !== member.decisionAt ||
      current.decisionEvidence !== member.decisionEvidence ||
      current.lastTurnId !== member.lastTurnId ||
      current.lastOutcome !== member.lastOutcome ||
      a1?.revision !== a0?.revision ||
      this.durableBlockers(current, a1).length
    )
      return;
    await api.agents.ref(member.id).archive();
    this.markArchived(member.id);
  }

  /**
   * An idle, completed handback nobody decided on for 48 hours wakes its responsible owner once
   * per turn and owner. Undecided Human-owned work is never prompted; status reports it, and the
   * Human's own acceptance closes it like any other.
   */
  private async remindStale(api: PaseoApi) {
    const now = this.now();
    let sent = 0;
    for (const member of this.store.members()) {
      if (this.stopped || sent >= REMINDERS_PER_SCAN) return;
      if (member.archivedAt || member.decision !== "open" || member.lastOutcome !== "completed") continue;
      if (!member.lastTurnId) continue;
      const a = this.autonomy.get(member.id);
      // Active or waiting assignments still have a scheduled next step of their own.
      if (a && ["active", "waiting", "archived"].includes(a.phase)) continue;
      const owner = responsibleOwner(member);
      if (!owner || !this.store.member(owner) || this.store.member(owner)?.archivedAt) continue;
      const since = member.lastTurnEndedAt ?? member.staleSince;
      if (since === undefined) {
        // Records from before 0.1.16 have no turn end time. Start their clock now, spread over a
        // day so an upgraded fleet does not wake every dormant owner in the same scan.
        const offset = Number.parseInt(hashOf(member.id).slice(0, 8), 16) % LEGACY_SPREAD_MS;
        this.store.updateMember(member.id, { staleSince: now + offset });
        continue;
      }
      if (now - since < STALE_DECISION_MS) continue;
      const turnId = member.lastTurnId;
      const forTurn = this.wakes
        .list()
        .filter(
          (w) =>
            !terminalWake.has(w.state) &&
            w.trigger.kind === "turn" &&
            w.trigger.agentId === member.id &&
            w.trigger.turnId === turnId,
        );
      // A reminder left with a former owner no longer applies; the current owner decides.
      for (const w of forTurn.filter((w) => w.ownerId !== owner && w.key.startsWith("stale-decision-")))
        try {
          this.wakes.action(w.key, w.ownerId, w.revision, "cancel");
        } catch {
          /* Changed concurrently; the next scan re-evaluates. */
        }
      // An unfinished review reminder for this turn already asks the current owner to decide.
      if (forTurn.some((w) => w.ownerId === owner)) continue;
      const key = `stale-decision-${hashOf(`${member.id}:${turnId}:${owner}`).slice(0, 32)}`;
      if (this.wakes.list().some((w) => w.key === key)) continue;
      const live = await this.live(api, member.id);
      if (!live || live.archived || live.status !== "idle") continue;
      const ownerLive = await this.live(api, owner);
      if (!ownerLive || ownerLive.archived) continue;
      const hours = Math.floor((now - since) / 3600000);
      try {
        this.wakes.add({
          key,
          roomId: member.roomId,
          ownerId: owner,
          reason: `Decision pending for ${hours}h on ${member.role} ${member.id}: its last turn completed and nobody accepted, rejected or archived it. Read ${member.resultPath ?? member.assignment}. Accept with evidence (alliance-work accept), request rework, or archive it natively if it is abandoned.`,
          trigger: { kind: "turn", agentId: member.id, turnId },
          delivery: "idle",
        });
        sent++;
      } catch {
        /* Ownership changed between reads; the next scan re-evaluates. */
      }
    }
  }
}
