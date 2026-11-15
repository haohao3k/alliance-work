import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import { type AutonomyState, pauseKind } from "../shared/autonomy";
import { atRest, responsibleOwner } from "../shared/operations";
import { asking } from "../shared/wakeups";
import type { Autonomy } from "./autonomy";
import { quotaNotice } from "./claude-limit";
import { validateEvidence } from "./evidence.mjs";
import {
  integrationStamp,
  validateIntegrationCurrentSync,
  validateIntegrationProof,
} from "./integration.mjs";
import { observeJob } from "./jobs.mjs";
import { keepBlocker } from "./keep";
import type { MemberRecord, RoomStore } from "./store";
import type { Wakeups } from "./wakeups";

/** Roles whose acceptance must cover the Human's outcome, not only a technical check. */
export const coordinatingRoles = new Set(["hq", "supervisor", "lead"]);
/** An undecided handback is first reminded about this long after its turn ended. */
export const STALE_DECISION_MS = 48 * 3600000;
/** Reminders about one overdue decision are at least this far apart. */
export const REMIND_EVERY_MS = 24 * 3600000;
/** Reminders one owner gets before the decision moves to the next owner up the chain. */
export const REMINDERS_PER_OWNER = 3;
/** A rejection nobody followed up with a new turn reminds its owner once, after this long. */
export const REJECTED_REMIND_MS = 24 * 3600000;
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
  /** Every message since the member's decision is one this plugin positively identified as its own. */
  pluginOnly?: boolean;
};
export type LifecycleView = {
  state: "archived" | "archivable" | "held" | "awaiting-decision" | "rejected";
  blockers: string[];
  /** Overdue work only the Human can move: nobody above it can be asked, or all were asked in turn. */
  needsHuman?: { since: string; ageHours: number; reason: string };
};

/** "3d", "5h", "12m": how long, for blocker and status lines. */
export function span(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 2880) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

/** Open members counted by lifecycle state, and held ones by each cause that holds them. */
export function summarizeLifecycle(views: LifecycleView[]) {
  const summary = { awaitingDecision: 0, needsHuman: 0, rejected: 0, held: {} as Record<string, number> };
  for (const view of views) {
    if (view.state === "awaiting-decision") summary.awaitingDecision++;
    if (view.state === "rejected") summary.rejected++;
    if (view.needsHuman) summary.needsHuman++;
    if (view.state === "held")
      for (const cause of new Set(view.blockers.map(blockerCause)))
        summary.held[cause] = (summary.held[cause] ?? 0) + 1;
  }
  return summary;
}

/** What holds a member, for grouping status; unrecognized text is "other". */
export function blockerCause(text: string) {
  const causes: [RegExp, string][] = [
    [/^kept open/, "keep"],
    [/^wakeup /, "wakeup"],
    [/needs product acceptance/, "product-acceptance"],
    [/^native child |^child /, "child"],
    [/^job /, "job"],
    [/obligation/, "obligation"],
    [/^agent is /, "agent-state"],
    [/new work arrived|newer turn/, "new-work"],
    [/paused/, "paused"],
    [/^permission/, "permission"],
  ];
  return causes.find(([pattern]) => pattern.test(text))?.[1] ?? "other";
}

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

/** The owners up the decision chain that are Alliance members not archived, nearest first. */
export function availableOwners(store: RoomStore, id: string) {
  return decisionChain(store, id).filter((owner) => {
    const member = store.member(owner);
    return member && !member.archivedAt;
  });
}

/** The nearest owner up the decision chain that is an Alliance member not archived; null when none. */
export function availableOwner(store: RoomStore, id: string) {
  return availableOwners(store, id)[0] ?? null;
}

/** Accepted direct contributors remain dependencies after their native sessions are archived. */
export function acceptedContributors(store: RoomStore, id: string) {
  return store
    .members()
    .filter(
      (member) =>
        member.id !== id &&
        member.decision === "accepted" &&
        (responsibleOwner(member) === id || member.parentId === id),
    )
    .map((member) => ({
      agentId: member.id,
      decisionEvidence: member.decisionEvidence,
      decisionAt: member.decisionAt ?? null,
      decisionTurnId: member.decisionTurnId ?? null,
      lastTurnId: member.lastTurnId ?? null,
      parentId: member.parentId,
      ownerId: responsibleOwner(member),
    }));
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
    private sourceRoot?: string,
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
    if (member.turnInputPending) blockers.push("native turn input awaits reconciliation");
    if (member.turnReadbackPending)
      blockers.push(`native turn handback awaits readback: ${member.turnReadbackPending.error}`);
    if (member.decisionIntegration) {
      const contributors = acceptedContributors(this.store, member.id);
      if (
        contributors.length > 128 ||
        integrationStamp(contributors) !== member.decisionIntegration.contributorsStamp
      )
        blockers.push(
          "accepted contributions changed after product acceptance; verify and review the integrated candidate again",
        );
      if (
        contributors.some((child) => {
          const member = this.store.member(child.agentId);
          return member?.turnInputPending || member?.turnReadbackPending;
        })
      )
        blockers.push("a contributor's native turn awaits reconciliation");
    }
    const kept = keepBlocker(this.store, member, this.now());
    if (kept) blockers.push(kept);
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
    const now = this.now();
    for (const w of this.wakes.list())
      if (w.ownerId === member.id && !terminalWake.has(w.state))
        blockers.push(
          `wakeup ${w.key} is ${w.state} (${span(now - (w.lastSentAt ?? w.updatedAt))} since its last change; expires in ${span(w.expiresAt - now)})`,
        );
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
    nativeChildren?: () => Promise<string[]>,
  ) {
    if (member.decision !== "accepted") return [];
    const blockers = this.durableBlockers(member, a);
    if (coordinatingRoles.has(member.role) && member.decisionBy !== null) {
      if ((await this.scope(member)) !== "product")
        blockers.push(
          `${member.role} needs product acceptance (accept --product) by its owner, or the Human's decision`,
        );
    }
    if (!atRest(live.status)) blockers.push(`agent is ${live.status}`);
    // A turn whose start hook was lost still shows up as a newer message in Paseo.
    if (
      live.lastMessageAt &&
      member.decisionAt &&
      !live.pluginOnly &&
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
      else if (!atRest(state.status) || state.permissions)
        blockers.push(`child ${child.id} still ${state.status}`);
    }
    // Native archive cascades to children that are not Alliance members, so they hold their parent too.
    if (nativeChildren) {
      const tracked = new Set(children.filter((c) => !c.archivedAt).map((c) => c.id));
      for (const id of await nativeChildren())
        if (!tracked.has(id))
          blockers.push(`native child ${id} is still open and not an accepted Alliance member`);
    }
    for (const job of this.store.jobs().filter((j) => j.ownerId === member.id))
      if ((await observeJob(job)).state !== "exited") blockers.push(`job ${job.key} still running`);
    return blockers;
  }

  /** Unarchived native children of an agent; a few suffice to report or to hold it. */
  async nativeChildren(api: PaseoApi, id: string) {
    const page = await api.agents.list({
      filter: { labels: { "paseo.parent-agent-id": id }, includeArchived: false },
      page: { limit: 5 },
    });
    return page.entries.map((entry) => entry.agent.id);
  }

  async describe(
    member: MemberRecord,
    live: LiveState,
    others: Map<string, LiveState>,
    /** With the native API, blockers include native children that are not Alliance members. */
    api?: PaseoApi,
  ): Promise<LifecycleView> {
    if (!live.archived && !["unknown", "unavailable"].includes(live.status)) this.restored(member.id);
    if (live.archived)
      return {
        state: "archived",
        blockers: this.store
          .obligations()
          .filter((o) => o.ownerId === member.id && o.state === "open")
          .map(
            (o) =>
              `Archived owner still owns open obligation ${o.key}; reconcile evidence or hand off without weakening closeWhen`,
          ),
      };
    const quota = quotaNotice(this.store, member.id, this.now(), (id) => {
      const state = others.get(id);
      return !!state && !state.archived && !state.permissions && atRest(state.status);
    });
    const notice = quota && this.wakes.list().find((w) => w.key === quota.key);
    const since = member.lastTurnEndedAt ?? this.now();
    const quotaHuman: LifecycleView["needsHuman"] =
      quota && (!quota.ownerId || !notice || notice.note === "Quota advice needs Human")
        ? {
            since: new Date(since).toISOString(),
            ageHours: Math.max(0, Math.floor((this.now() - since) / 3600000)),
            reason: quota.reason,
          }
        : undefined;
    if (member.decision === "rejected") {
      const at = member.decisionAt ? Date.parse(member.decisionAt) : Number.NaN;
      const age = Number.isFinite(at) ? ` ${span(this.now() - at)} ago` : "";
      return {
        state: "rejected",
        blockers: [`rejected${age}; owner decides rework or archive`],
        ...(quotaHuman ? { needsHuman: quotaHuman } : {}),
      };
    }
    if (member.decision !== "accepted") {
      const owner = responsibleOwner(member);
      const review = this.reviewOwners(member);
      const since = this.undecided(member)?.since;
      const age = since === undefined ? "" : `; undecided for ${span(this.now() - since)}`;
      const needsHuman = quotaHuman ?? this.needsHuman(member);
      return {
        state: "awaiting-decision",
        blockers: [
          (review.fallback
            ? `awaiting owner review by room coordinator ${review.owners[0]}; decision authority is unchanged`
            : owner
              ? `awaiting decision by owner ${owner}`
              : "awaiting the Human's decision") + age,
        ],
        ...(needsHuman ? { needsHuman } : {}),
      };
    }
    const blockers = await this.blockers(
      member,
      live,
      async (id) => others.get(id) ?? null,
      undefined,
      api && (() => this.nativeChildren(api, member.id)),
    );
    return {
      state: blockers.length ? "held" : "archivable",
      blockers,
      ...(quotaHuman ? { needsHuman: quotaHuman } : {}),
    };
  }
  /** A native reopening restores custody, not permission to replay a parked assignment. */
  restored(id: string) {
    const member = this.store.member(id);
    if (!member?.archivedAt) return;
    this.store.updateMember(id, { archivedAt: undefined });
    const run = this.store.autonomyOf(id);
    if (run?.phase === "archived")
      this.store.saveAutonomy(
        {
          ...run,
          phase: "paused",
          pausedBy: "checkpoint",
          pausedAt: this.now(),
          reason: `Native session reopened for custody; resume only under the recorded obligation conditions and authority. Previous checkpoint: ${run.reason}`,
          updatedAt: this.now(),
          revision: run.revision + 1,
        },
        run.revision,
      );
  }

  private markArchived(id: string) {
    const member = this.store.member(id);
    if (member && !member.archivedAt)
      this.store.updateMember(id, { archivedAt: new Date(this.now()).toISOString() });
    const a = this.autonomy.get(id);
    if (a && a.phase !== "archived") this.autonomy.markArchived(id);
  }

  /** Paseo archived this agent: record it and settle its reminders now, not at the next sweep. */
  async archived(id: string) {
    this.markArchived(id);
    await this.wakes.settle();
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
    const lastMessageAt = (state.agent as { lastUserMessageAt?: string | null }).lastUserMessageAt ?? null;
    return {
      status: state.agent.status,
      archived: state.agent.archivedAt != null,
      permissions: state.agent.pendingPermissions?.length ?? 0,
      lastMessageAt,
      pluginOnly: await this.pluginOnly(api, id, lastMessageAt),
    };
  }

  /** Prompts this plugin is known to have sent to the member, by native message ID. */
  private pluginMessageIds(id: string) {
    const a = this.autonomy.get(id);
    return new Set<string>([
      ...(this.store.member(id)?.pluginMessages ?? []).map((m) => m.id),
      ...this.wakes.list().flatMap((w) => (w.ownerId === id && w.messageId ? [w.messageId] : [])),
      ...(a?.wakeMessages ?? []),
      ...[a?.wakeBatch?.messageId, a?.messageId, a?.charged?.messageId].filter((m): m is string => !!m),
    ]);
  }

  private pluginChecks = new Map<string, { at: string; decidedAt: string; only: boolean }>();
  /**
   * Paseo reports only the time of the latest message, so a message after the decision is read
   * back from the native timeline: it is not new work when every user message since the decision
   * carries the ID of a prompt this plugin sent. Anything unidentified, or any doubt, is not.
   */
  private async pluginOnly(api: PaseoApi, id: string, lastMessageAt: string | null) {
    const member = this.store.member(id);
    if (!lastMessageAt || member?.decision !== "accepted" || !member.decisionAt) return undefined;
    const decidedAt = Date.parse(member.decisionAt);
    if (!(Date.parse(lastMessageAt) > decidedAt)) return undefined;
    const cached = this.pluginChecks.get(id);
    if (cached?.at === lastMessageAt && cached.decidedAt === member.decisionAt) return cached.only;
    const known = this.pluginMessageIds(id);
    let only = false;
    try {
      let cursor: { epoch: string; seq: number } | undefined;
      let seen = false;
      for (let pageNumber = 0; pageNumber < 5 && known.size; pageNumber++) {
        const page = await api.agents.ref(id).timeline.refetch({
          direction: cursor ? "before" : "tail",
          cursor,
          limit: 100,
          projection: "canonical",
        });
        if (page.error || page.gap || page.staleCursor || (cursor && page.epoch !== cursor.epoch)) break;
        let done = false;
        let foreign = false;
        for (const entry of [...page.entries].reverse()) {
          const timestamp = Date.parse(entry.timestamp);
          if (!Number.isFinite(timestamp)) {
            foreign = true;
            break;
          }
          if (timestamp <= decidedAt) {
            done = true;
            break;
          }
          if (entry.item.type !== "user_message") continue;
          const identity = entry.item.clientMessageId ?? entry.item.messageId;
          if (!identity || !known.has(identity)) {
            foreign = true;
            break;
          }
          seen = true;
        }
        if (foreign) break;
        if (done || !page.hasOlder) {
          only = seen;
          break;
        }
        if (!page.startCursor || (cursor && page.startCursor.seq >= cursor.seq)) break;
        cursor = page.startCursor;
      }
    } catch {
      only = false;
    }
    this.pluginChecks.set(id, { at: lastMessageAt, decidedAt: member.decisionAt, only });
    return only;
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
    if ((await this.nativeChildren(api, member.id)).length) return;
    let recheck: (() => void) | undefined;
    if (member.decisionIntegration && member.decisionEvidence) {
      const bytes = await readFile(member.decisionEvidence);
      if (createHash("sha256").update(bytes).digest("hex") !== member.decisionIntegration.dispositionDigest)
        throw new Error("Integrated product disposition changed; review the candidate again");
      const record = JSON.parse(bytes.toString());
      if (record.agentId !== member.id || record.decision !== "accepted" || !record.product)
        throw new Error("Integrated product disposition changed; review the candidate again");
      const report = await validateEvidence(
        record.evidence,
        member.cwd ?? this.store.room(member.roomId).cwd,
        record.candidate,
      );
      if (!record.verificationArtifact || JSON.stringify(report) !== JSON.stringify(record.verification))
        throw new Error("Integrated runtime report changed; review the candidate again");
      if (member.decisionIntegration.contributors.length) {
        if (record.integration?.contributorsStamp !== member.decisionIntegration.contributorsStamp)
          throw new Error("Integrated contributor proof changed; review the candidate again");
        await validateIntegrationProof(record.integration, report);
      }
      const receipts = [
        record.verificationArtifact,
        { path: member.decisionEvidence, digest: member.decisionIntegration.dispositionDigest },
      ];
      recheck = () => validateIntegrationCurrentSync(report, record.integration, receipts, this.sourceRoot);
    }
    const fresh = await this.live(api, member.id);
    if (!fresh || fresh.archived || !atRest(fresh.status) || fresh.permissions) return;
    if (
      fresh.lastMessageAt &&
      member.decisionAt &&
      !fresh.pluginOnly &&
      Date.parse(fresh.lastMessageAt) > Date.parse(member.decisionAt)
    )
      return;
    recheck?.();
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
   * A completed handback whose decision is still open, with the time its turn ended (undefined for
   * records from before turn end times). Active assignments have a next step of their own, and
   * waiting ones are woken by something; neither is awaiting a decision.
   */
  private undecided(member: MemberRecord) {
    if (member.archivedAt || member.decision !== "open" || member.lastOutcome !== "completed") return null;
    if (!member.lastTurnId) return null;
    const a = this.autonomy.get(member.id);
    if (a && ["active", "archived"].includes(a.phase)) return null;
    if (a?.phase === "waiting" && (this.autonomy.bound(a) || this.autonomy.wakeSource(member.id)))
      return null;
    return { since: member.lastTurnEndedAt ?? member.staleSince };
  }

  /** Reminders sent for the member's current turn, by owner. */
  private reminded(member: MemberRecord) {
    return member.remind?.turnId === member.lastTurnId ? member.remind : undefined;
  }

  /** Reminder routing only: a room coordinator does not acquire decision authority or custody. */
  private reviewOwners(member: MemberRecord): {
    owners: string[];
    fallback?: true;
    reason?: string;
  } {
    const owners = availableOwners(this.store, member.id);
    if (owners.length || !responsibleOwner(member)) return { owners };
    const chain = decisionChain(this.store, member.id);
    // Missing/native-only owners and cycles do not establish a fully archived owner chain.
    if (
      !chain.length ||
      chain.some((id) => !this.store.member(id)?.archivedAt) ||
      responsibleOwner(this.store.member(chain[chain.length - 1]) as MemberRecord)
    )
      return { owners };

    // An archived HQ can belong to another room while connecting this room's sibling members.
    const room = [
      ...this.store.members(member.roomId),
      ...chain.map((id) => this.store.member(id) as MemberRecord),
    ];
    const graph = new Map(room.map((m) => [m.id, new Set<string>()]));
    for (const m of room) {
      // Never ask the work's own descendants to take responsibility for its review.
      if (decisionChain(this.store, m.id).includes(member.id)) graph.delete(m.id);
    }
    for (const m of room) {
      const owner = responsibleOwner(m);
      if (!owner || !graph.has(m.id) || !graph.has(owner)) continue;
      graph.get(m.id)?.add(owner);
      graph.get(owner)?.add(m.id);
    }
    const seen = new Set([member.id]);
    let level = [member.id];
    while (level.length) {
      const next = [...new Set(level.flatMap((id) => [...(graph.get(id) ?? [])]))].filter(
        (id) => !seen.has(id),
      );
      for (const id of next) seen.add(id);
      const candidates = next.filter((id) => {
        const m = this.store.member(id) as MemberRecord;
        return m.roomId === member.roomId && !m.archivedAt && (m.role === "lead" || m.role === "hq");
      });
      if (candidates.length === 1) return { owners: candidates, fallback: true };
      if (candidates.length > 1)
        return {
          owners: [],
          reason: `archived owner chain; nearest room coordinator is ambiguous: ${candidates.sort().join(", ")}; the Human must choose an owner`,
        };
      level = next;
    }
    return {
      owners: [],
      reason:
        "archived owner chain; no connected living room coordinator can be asked; the Human must choose an owner",
    };
  }

  /**
   * Overdue work nobody who can be asked is left to decide: no owner above it, or every owner up
   * the chain was reminded in turn and a day passed since the last reminder. Only the Human moves it.
   */
  private needsHuman(member: MemberRecord): LifecycleView["needsHuman"] {
    const pending = this.undecided(member);
    if (pending?.since === undefined) return undefined;
    const now = this.now();
    const age = now - pending.since;
    if (age < STALE_DECISION_MS) return undefined;
    const review = this.reviewOwners(member);
    const chain = review.owners;
    let reason = review.reason ?? "no owner above it can be asked; only the Human can decide";
    if (chain.length) {
      const state = this.reminded(member);
      if (
        !state ||
        chain.some((owner) => (state.owners[owner] ?? 0) < REMINDERS_PER_OWNER) ||
        (state.at && now - state.at < REMIND_EVERY_MS)
      )
        return undefined;
      const total = Object.values(state.owners).reduce((sum, n) => sum + n, 0);
      reason = review.fallback
        ? `its room coordinator was reminded ${total} times without an owner decision`
        : `its owner chain was reminded ${total} times without a decision`;
    }
    return { since: new Date(pending.since).toISOString(), ageHours: Math.floor(age / 3600000), reason };
  }

  /** Spreads reminders for work already long overdue over a day, the same for each member. */
  private spread(id: string) {
    return Number.parseInt(hashOf(id).slice(0, 8), 16) % LEGACY_SPREAD_MS;
  }

  /**
   * An idle, completed handback nobody decided on for 48 hours wakes its responsible owner, then
   * again every 24 hours until that owner was reminded three times; the next owner up the chain
   * is reminded in turn. When none is left, status and the board flag it as needing the Human
   * (needsHuman), as they do Human-owned work from its 48th hour. Nothing here accepts or archives.
   * Work already more than three days overdue when this first sees it starts its schedule at a
   * point spread over the next day, so an upgraded fleet does not wake every owner at once.
   */
  private async remindStale(api: PaseoApi) {
    const now = this.now();
    let sent = 0;
    for (const member of this.store.members()) {
      if (this.stopped || sent >= REMINDERS_PER_SCAN) return;
      if (member.warm?.pending) continue;
      if (member.archivedAt) continue;
      if (member.decision === "rejected") {
        if (await this.remindRejected(api, member)) sent++;
        continue;
      }
      const pending = this.undecided(member);
      if (!pending) continue;
      const review = this.reviewOwners(member);
      const chain = review.owners;
      const turnId = member.lastTurnId as string;
      const turnWakes = this.wakes
        .list()
        .filter(
          (w) => w.trigger.kind === "turn" && w.trigger.agentId === member.id && w.trigger.turnId === turnId,
        );
      // A Human handoff or an ambiguous replacement route also invalidates queued notices.
      for (const w of turnWakes.filter(
        (w) =>
          !terminalWake.has(w.state) && w.key.startsWith("stale-decision-") && !chain.includes(w.ownerId),
      ))
        try {
          this.wakes.action(w.key, w.ownerId, w.revision, "cancel");
        } catch {
          /* Changed concurrently; the next scan re-evaluates. */
        }
      if (!chain.length) continue;
      const since = pending.since;
      if (since === undefined) {
        // Records from before 0.1.16 have no turn end time. Start their clock now, spread over a
        // day so an upgraded fleet does not wake every dormant owner in the same scan.
        this.store.updateMember(member.id, { staleSince: now + this.spread(member.id) });
        continue;
      }
      if (now - since < STALE_DECISION_MS) continue;
      let state = this.reminded(member);
      if (!state) {
        // A 48h reminder sent before schedules existed counts as the first one.
        const owners: Record<string, number> = {};
        let at = 0;
        for (const w of turnWakes)
          if (w.key.startsWith("stale-decision-") && w.lastSentAt !== null) {
            owners[w.ownerId] = (owners[w.ownerId] ?? 0) + 1;
            at = Math.max(at, w.lastSentAt);
          }
        const overdue = now - since >= STALE_DECISION_MS + REMIND_EVERY_MS;
        state = { turnId, owners, at, ...(overdue ? { notBefore: now + this.spread(member.id) } : {}) };
        this.store.updateMember(member.id, { remind: state });
      }
      if (state.notBefore !== undefined && now < state.notBefore) continue;
      const owner = chain.find((o) => (state.owners[o] ?? 0) < REMINDERS_PER_OWNER);
      if (!owner) continue;
      const count = state.owners[owner] ?? 0;
      // Owners above that were already asked make this a repeat or an escalation: wait out the day.
      // A new nearest owner (the former one archived or handed off) is asked at once.
      const before = chain.slice(0, chain.indexOf(owner)).filter((o) => (state.owners[o] ?? 0) > 0);
      if ((count > 0 || before.length) && state.at && now - state.at < REMIND_EVERY_MS) continue;
      const open = turnWakes.filter((w) => !terminalWake.has(w.state));
      // A reminder left with a former owner no longer applies; the current owner decides.
      for (const w of open.filter((w) => w.ownerId !== owner && w.key.startsWith("stale-decision-")))
        try {
          this.wakes.action(w.key, w.ownerId, w.revision, "cancel");
        } catch {
          /* Changed concurrently; the next scan re-evaluates. */
        }
      // A review reminder for this turn that will be pushed, or was sent in the last day, already
      // asks the current owner to decide. The owner's own pull reminder on the turn is never pushed
      // and does not count.
      const recent = (w: (typeof open)[number]) =>
        !["delivered", "uncertain"].includes(w.state) ||
        now - (w.lastSentAt ?? w.updatedAt) < REMIND_EVERY_MS;
      if (open.some((w) => w.ownerId === owner && asking(w) && recent(w))) continue;
      const key = `stale-decision-${hashOf(`${member.id}:${turnId}:${owner}${count ? `:${count + 1}` : ""}`).slice(0, 32)}`;
      const existing = this.wakes.list().find((w) => w.key === key);
      if (existing) {
        // Sent, but the count was not recorded; adopt it rather than ask again.
        this.store.updateMember(member.id, {
          remind: {
            ...state,
            owners: { ...state.owners, [owner]: count + 1 },
            at: existing.lastSentAt ?? existing.updatedAt,
          },
        });
        continue;
      }
      const live = await this.live(api, member.id);
      if (!live || live.archived || !atRest(live.status)) continue;
      const ownerLive = await this.live(api, owner);
      if (!ownerLive || ownerLive.archived) continue;
      const hours = Math.floor((now - since) / 3600000);
      const moved = before.length
        ? ` ${before.join(", ")} was reminded and did not decide, so it is yours as next in its owner chain.`
        : "";
      const action = review.fallback
        ? "Its responsible owner chain is archived. You are the nearest living coordinator in its room. Review the handback and reconcile responsibility with the Human or an authorized owner; this reminder grants no acceptance authority and transfers no custody."
        : "accept with evidence or give rework.";
      try {
        this.wakes.add({
          key,
          roomId: member.roomId,
          ownerId: owner,
          reason: `Decision pending for ${hours}h on ${member.role} ${member.id} (reminder ${count + 1} of ${REMINDERS_PER_OWNER}): its last turn completed and nobody decided.${moved} Read ${member.resultPath ?? member.assignment}; ${action} Before any archive reconcile all open obligations, jobs and custody; a finished turn does not retire them.`,
          trigger: { kind: "turn", agentId: member.id, turnId },
          delivery: "idle",
        });
        this.store.updateMember(member.id, {
          remind: {
            ...state,
            owners: { ...state.owners, [owner]: count + 1 },
            at: now,
            notBefore: undefined,
          },
        });
        sent++;
      } catch {
        /* Ownership changed between reads; the next scan re-evaluates. */
      }
    }
  }

  /**
   * A rejection with no new turn after a day reminds its owner once: the agent sits idle and
   * nothing restarts it. Rejections already more than two days old at upgrade are spread over a day.
   */
  private async remindRejected(api: PaseoApi, member: MemberRecord) {
    const now = this.now();
    const decidedAt = member.decisionAt ? Date.parse(member.decisionAt) : Number.NaN;
    if (!member.decisionAt || !Number.isFinite(decidedAt)) return false;
    if (member.decisionTurnId != null && member.decisionTurnId !== (member.lastTurnId ?? null)) return false;
    const due = decidedAt + REJECTED_REMIND_MS;
    if (now < due) return false;
    const a = this.autonomy.get(member.id);
    if (a && ["active", "archived"].includes(a.phase)) return false;
    const owner = availableOwner(this.store, member.id);
    if (!owner) return false;
    let marker = member.rejectedRemind?.decisionAt === member.decisionAt ? member.rejectedRemind : undefined;
    if (marker?.sentAt !== undefined) return false;
    if (!marker) {
      marker = {
        decisionAt: member.decisionAt,
        ...(now - due >= REJECTED_REMIND_MS ? { notBefore: now + this.spread(member.id) } : {}),
      };
      this.store.updateMember(member.id, { rejectedRemind: marker });
    }
    if (marker.notBefore !== undefined && now < marker.notBefore) return false;
    const key = `rejected-${hashOf(`${member.id}:${member.decisionAt}:${owner}`).slice(0, 32)}`;
    if (this.wakes.list().some((w) => w.key === key)) {
      this.store.updateMember(member.id, { rejectedRemind: { ...marker, sentAt: now } });
      return false;
    }
    const live = await this.live(api, member.id);
    if (!live || live.archived || !atRest(live.status)) return false;
    const ownerLive = await this.live(api, owner);
    if (!ownerLive || ownerLive.archived) return false;
    try {
      this.wakes.add({
        key,
        roomId: member.roomId,
        ownerId: owner,
        reason: `${member.role} ${member.id} was rejected ${span(now - decidedAt)} ago and nothing has happened since: it is idle and will not restart by itself. Send it a rework prompt (alliance-work reject --agent ID --reason TEXT --rework TEXT does both), or archive it in Paseo if its work is dropped. This is the only reminder about this rejection.`,
        trigger: { kind: "time", at: now },
        delivery: "idle",
      });
      this.store.updateMember(member.id, { rejectedRemind: { ...marker, sentAt: now } });
      return true;
    } catch {
      return false; // Ownership changed between reads; the next scan re-evaluates.
    }
  }
}
