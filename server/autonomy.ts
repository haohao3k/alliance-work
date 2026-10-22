import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { type AutonomyState, pauseKind } from "../shared/autonomy";
import { blockedOn } from "../shared/obligations";
import { harnessOf, responsibleOwner } from "../shared/operations";
import { asking } from "../shared/wakeups";
import { availableOwner, STALE_DECISION_MS } from "./lifecycle";
import { newTurn, type RoomStore } from "./store";
import { type CliCommand, cliLine, decidedTurn, refusedSend, type Wakeups } from "./wakeups";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** Milliseconds per unit as providers write it ("120ms", "1.898s", "4h7m1s", "6 minutes"); 0 if unknown. */
const unitMs = (word: string) => {
  const w = word.toLowerCase();
  if (w === "ms" || w.startsWith("msec") || w.startsWith("milli")) return 1;
  if (/^s(ec(ond)?s?)?$/.test(w)) return 1000;
  if (/^m(in(ute)?s?)?$/.test(w)) return 60000;
  if (/^h((ou)?rs?)?$/.test(w)) return 3600000;
  if (/^d(ays?)?$/.test(w)) return 86400000;
  return 0;
};
/** Quota waits in a row before the assignment is blocked for its owner instead. */
const QUOTA_WAITS = 3;
/** The owner hears of a quota wait only when it is at least this long. */
const QUOTA_NOTICE_MS = 5 * 60000;
const QUOTA_REASON = "Provider quota; retry after ";
/** A child created this recently that has not started its first turn will still hand back. */
const FIRST_TURN_MS = 10 * 60000;
/** A turn that starts this soon after the plugin sent a wake batch is that batch's turn. */
const WAKE_TURN_MS = 5 * 60000;
/** A turn Paseo has not been running for this long is over, even if its end hook was lost. */
const LOST_TURN_MS = 5 * 60000;
/** Continuation turns in a row without a checkpoint before the last one's final message goes to the owner. */
const UNCHECKED_CONTINUATIONS = 2;
/**
 * Claude prints a reset within a day as its minute alone ("resets 9:40pm"), and every notice until
 * the reset's second inside that minute still says so; a printed time at most this far past is that
 * reset, not tomorrow's. The notice is recorded as it is printed, so a later one is tomorrow's.
 */
const RESET_MINUTE_MS = 5 * 60000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** The wall clock of an IANA zone; throws for an unknown zone. */
function wallClock(zone: string) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  /** The local date at `t` and the zone's offset there. */
  const local = (t: number) => {
    const p = Object.fromEntries(format.formatToParts(t).map(({ type, value }) => [type, Number(value)]));
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return { year: p.year, month: p.month, day: p.day, offset: shown - Math.floor(t / 60000) * 60000 };
  };
  /** The instant the zone shows this date and time (month 1-12; a day past the month's end rolls over). */
  const at = (year: number, month: number, day: number, hour: number, minute: number) => {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    return guess - local(guess - local(guess).offset).offset;
  };
  return { local, at };
}
/**
 * When a provider quota named by a failure lifts, plus a minute: at most 7 days ahead, 30 minutes
 * for a quota or usage limit that gives no time. null when the failure is not a quota, including a
 * rate limit that names no time (an ordinary retry). Seen in the fleet: "Resets in 4h7m1s" (AGY),
 * "try again at Oct 18th, 2026 6:06 PM" (Codex), "(reset after 29m 43s)" (Pi through an API proxy) and
 * Claude's "You've hit your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)", a clock time in the
 * host's zone (its next occurrence, or the printed minute just past; Claude puts the date first,
 * "Oct 27, 6:32am", beyond a day).
 * OpenAI says "Please try again in 1.898s".
 */
export function quotaReset(error: string | undefined, now: number) {
  if (
    !error ||
    !/quota|rate.?limit|usage limit|hit your|resets? (?:in|after)|try again (?:at|in)/i.test(error)
  )
    return null;
  let at = Number.NaN;
  const span = /(?:resets?|try again) (?:in|after)\s*((?:\d+(?:\.\d+)?\s*[a-z]+[\s,]*(?:and\s+)?)+)/i.exec(
    error,
  )?.[1];
  const date = /try again at\s+(.+?)(?:\.\s|\.?$)/i.exec(error)?.[1];
  const clock =
    /resets (?:([A-Z][a-z]{2}) (\d{1,2}), (?:(\d{4}), )?)?(\d{1,2})(?::(\d{2}))?([ap]m) \(([\w+/-]+)\)/.exec(
      error,
    );
  if (span) {
    for (const [, n, word] of span.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi))
      if (unitMs(word)) at = (Number.isFinite(at) ? at : now) + Number(n) * unitMs(word);
  } else if (date) at = Date.parse(date.replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/, "$1"));
  else if (clock) {
    const [, month, day, year, hour, minute = "0", half, zone] = clock;
    try {
      const wall = wallClock(zone);
      const today = wall.local(now);
      const h = (Number(hour) % 12) + (half === "pm" ? 12 : 0);
      if (!month) {
        // That clock time nearest after the notice, or the printed minute just past (see above).
        for (const day of [today.day - 1, today.day, today.day + 1]) {
          at = wall.at(today.year, today.month, day, h, Number(minute));
          if (at >= now - RESET_MINUTE_MS) break;
        }
      } else if (MONTHS.includes(month.toLowerCase()))
        at = wall.at(
          Number(year ?? today.year),
          MONTHS.indexOf(month.toLowerCase()) + 1,
          Number(day),
          h,
          Number(minute),
        );
    } catch {
      /* An unknown zone states no time we can read. */
    }
  }
  // Claude's "Server is temporarily limiting requests (not your usage limit)" is a brief retry.
  if (!Number.isFinite(at) && !/quota|(?<!not your )usage limit/i.test(error)) return null;
  const due = Number.isFinite(at) ? at + 60000 : now + 30 * 60000;
  return Math.min(Math.max(due, now + 60000), now + 7 * 86400000);
}
/**
 * Claude Code answers a request the provider refused with a notice of its own as the turn's final
 * message, and Paseo (0.11.2 and 0.12.0) reports that turn completed. Its limits read "You've hit
 * your session limit · resets 9:40pm (Asia/Ho_Chi_Minh)" (or weekly, Opus, Sonnet, Fable 5, spend
 * limit); its API errors "API Error: …", "Failed to authenticate. API Error: 401 …", "There's an
 * issue with the selected model (…)" and, for a role home without a login, "Not logged in · Please
 * run /login". Returns the notice, or undefined for any other message.
 */
export function providerNotice(text: string | undefined) {
  const notice = text?.trim();
  return notice &&
    /^(?:You've hit your |API Error\b|Failed to authenticate\b|There's an issue with the selected model \(|Not logged in · Please run \/login)/.test(
      notice,
    )
    ? notice
    : undefined;
}

/** Assignment policy only. Paseo remains the sole agent runtime and prompt transport. */
export class Autonomy {
  private running?: Promise<void>;
  private stopped = false;
  /** Members whose open turn Paseo reported not running, and since when. */
  private unseen = new Map<string, number>();
  /** Members whose archive state was read from Paseo once since load. */
  private reconciled = new Set<string>();
  /** The command named in continuation prompts; the runtime points it at the managed launcher. */
  cli: () => CliCommand = () => ({ command: "alliance-work", managed: false });
  constructor(
    private store: RoomStore,
    private wakes: Wakeups,
    private now: () => number = Date.now,
  ) {}
  list() {
    return this.store.autonomous();
  }
  get(id: string) {
    return this.list().find((r) => r.agentId === id);
  }
  private save(r: AutonomyState, change: Partial<AutonomyState>) {
    const next = { ...r, ...change, revision: r.revision + 1, updatedAt: this.now() };
    // Pause provenance describes only a current pause, and the blocker asked about a current block.
    if (next.phase !== "paused") {
      next.pausedBy = undefined;
      next.pausedAt = undefined;
    }
    if (next.phase !== "blocked") next.blocker = undefined;
    this.store.saveAutonomy(next, r.revision);
    return next;
  }
  start(
    id: string,
    options: Partial<
      Pick<AutonomyState, "maxRetries" | "maxContinuations" | "autoArchive" | "obligationKey">
    > = {},
  ) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    // Omitted options keep their recorded value (an earlier --auto-archive false survives).
    options = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    const prior = this.get(id);
    // An obligation handed off, fulfilled or canceled no longer binds a restart.
    const binding = prior && this.bound(prior) ? prior.obligationKey : undefined;
    const key = options.obligationKey ?? binding;
    if (key) {
      const obligation = this.store.obligations().find((o) => o.key === key);
      if (!obligation || obligation.ownerId !== id || obligation.state !== "open")
        throw new Error("Autonomy requires an open obligation owned by this agent");
      if (binding && binding !== key)
        throw new Error("A managed assignment cannot switch obligations; hand off or close it first");
    }
    if (prior) {
      if (prior.phase === "archived") throw new Error("Archived assignments need explicit native reopening");
      if (prior.delivery === "uncertain" || prior.delivery === "dispatching")
        throw new Error("Reconcile uncertain delivery with a checkpoint before restarting");
      return this.save(prior, {
        phase: "active",
        reason: prior.handbackOnly ? "Assignment enabled" : "Assignment resumed",
        retries: 0,
        continuations: 0,
        quotaWaits: undefined,
        unchecked: undefined,
        handbackOnly: undefined,
        pausedBy: undefined,
        pausedAt: undefined,
        ...options,
        obligationKey: key,
      });
    }
    const r: AutonomyState = {
      agentId: id,
      phase: "active",
      reason: "Assignment enabled",
      revision: 1,
      turnId: member.lastTurnId ?? null,
      outcome: member.lastOutcome,
      dueAt: this.now(),
      retries: 0,
      continuations: 0,
      maxRetries: 2,
      maxContinuations: 20,
      autoArchive: true,
      delivery: "none",
      messageId: null,
      updatedAt: this.now(),
      ...options,
    };
    this.store.saveAutonomy(r);
    return r;
  }
  /**
   * A member whose owner is an Alliance member needs a record so its handbacks reach that owner.
   * It is handback-only, never continued and retried only at a provider limit's reset: it waits, or
   * goes up for review at once when its last turn is an undecided handback from the last 48 hours
   * that nothing else will follow up.
   */
  ensure(id: string) {
    const prior = this.get(id);
    if (prior) return prior;
    const member = this.store.member(id);
    if (!member || member.archivedAt || !availableOwner(this.store, id)) return undefined;
    const now = this.now();
    const handback =
      Boolean(member.lastTurnId) &&
      member.lastOutcome === "completed" &&
      member.decision === "open" &&
      member.lastTurnEndedAt !== undefined &&
      now - member.lastTurnEndedAt < STALE_DECISION_MS &&
      !this.wakeSource(id);
    const r: AutonomyState = {
      agentId: id,
      phase: handback ? "review" : "waiting",
      reason: handback
        ? "Its last turn completed undecided; the final message is the handback"
        : "Owner assigned; checkpoint review to hand back",
      revision: 1,
      turnId: member.lastTurnId ?? null,
      outcome: member.lastOutcome,
      dueAt: now,
      retries: 0,
      continuations: 0,
      maxRetries: 2,
      maxContinuations: 20,
      autoArchive: true,
      delivery: "none",
      messageId: null,
      updatedAt: now,
      handbackOnly: true,
    };
    try {
      this.store.saveAutonomy(r);
    } catch {
      return this.get(id); // Recorded concurrently.
    }
    return r;
  }
  /**
   * Something will wake this agent besides a handback: its own reminder that is still to be pushed
   * and still applies (not for a child turn it already decided), or a child it owns whose turn is
   * running or that was created in the last minutes and has not started yet (it hands back to it).
   * A turn Paseo stopped running a while ago, though its end was never recorded, wakes nobody, and
   * neither does a reminder waiting for that turn's end.
   */
  wakeSource(id: string) {
    const starting = (child: string) => {
      const r = this.get(child);
      return r?.turnId === null && r.outcome === null && this.now() - r.updatedAt < FIRST_TURN_MS;
    };
    const lost = (child: string) =>
      this.now() - (this.unseen.get(child) ?? Number.POSITIVE_INFINITY) >= LOST_TURN_MS;
    return (
      this.wakes
        .list()
        .some(
          (w) =>
            w.ownerId === id &&
            w.delivery === "idle" &&
            ["scheduled", "pending", "dispatching"].includes(w.state) &&
            !(w.trigger.kind === "turn" && lost(w.trigger.agentId)) &&
            this.wakes.current(w),
        ) ||
      this.store
        .members()
        .some(
          (m) =>
            m.id !== id &&
            !m.archivedAt &&
            responsibleOwner(m) === id &&
            m.lastOutcome === null &&
            ((Boolean(m.lastTurnId) && !lost(m.id)) || starting(m.id)),
        )
    );
  }
  /** Bound to an obligation that is still open and its own; a handed-off or closed one binds nothing. */
  bound(r: Pick<AutonomyState, "agentId" | "obligationKey">) {
    if (!r.obligationKey) return false;
    const o = this.store.obligations().find((o) => o.key === r.obligationKey);
    return o?.state === "open" && o.ownerId === r.agentId;
  }
  checkpoint(
    id: string,
    phase: Exclude<AutonomyState["phase"], "archived">,
    reason: string,
    turnId?: string,
  ) {
    const r = this.get(id);
    if (!r) throw new Error("Start autonomy for this assignment first");
    if (r.phase === "archived") throw new Error("Archived assignments need explicit native reopening");
    if (turnId && r.turnId !== turnId) throw new Error("Checkpoint belongs to an old turn");
    if (r.delivery === "dispatching")
      throw new Error("Delivery in progress; retry checkpoint after dispatch");
    const carried = this.carrying(id) && r.outcome === null;
    const next = this.save(r, {
      phase,
      reason,
      delivery: "none",
      messageId: null,
      dueAt: this.now() + 15000,
      pausedBy: phase === "paused" ? "checkpoint" : undefined,
      pausedAt: phase === "paused" ? this.now() : undefined,
      checkpointTurnId: r.turnId,
      unchecked: undefined,
      // Asking to be continued makes a handback-only record an assignment.
      ...(phase === "active" ? { handbackOnly: undefined } : {}),
    });
    // Recorded while a turn that kept the handback it found runs, a checkpoint is a new handback: from
    // here that turn is the member's, with its own result and decision to come, and the old review is
    // superseded.
    if (carried) this.store.updateMember(id, newTurn(r.turnId));
    return next;
  }
  /**
   * Its latest turn keeps the phase it found (started: the plugin's wake batch on a record that is
   * not active, or a turn Claude Code started by itself) and has recorded no checkpoint. Such a turn
   * is transparent: the member's handback before it stands, with its turn, result, review and
   * decision, and a decision on it may be recorded while the turn runs.
   */
  carrying(id: string) {
    const r = this.get(id);
    return Boolean(r?.turnId) && r?.wakeTurnId === r?.turnId && r?.checkpointTurnId !== r?.turnId;
  }
  /** Its owner chain or the Human decided on its turn: a blocker that still stands may ask again. */
  decided(id: string) {
    const r = this.get(id);
    if (r?.blocker) this.save(r, { blocker: undefined });
  }
  /** The lifecycle sweep archived this agent, or Paseo reports it archived. */
  markArchived(id: string) {
    const r = this.get(id);
    if (r && r.phase !== "archived")
      this.save(r, { phase: "archived", reason: "Accepted assignment archived through Paseo" });
  }
  started(id: string, turnId: string | null) {
    const r = this.get(id);
    if (!r || (turnId && r.turnId === turnId && !r.outcome)) return;
    // Claude Code starts a turn by itself when a background task or Monitor event finishes; Paseo
    // (0.11.2 and 0.12) names it autonomous-turn-N or autonomous-<uuid>. Nobody sent it anything.
    const autonomous = turnId?.startsWith("autonomous") === true;
    // Any turn sent after a cancellation is the resume.
    const resumed = !autonomous && pauseKind(r) === "cancel";
    // The plugin's own wake batch only asks the agent to read it, so its turn keeps the phase, and
    // so does a turn the agent started itself.
    const pushed =
      !resumed &&
      r.phase !== "active" &&
      (autonomous || (r.wakeBatch !== undefined && this.now() - r.wakeBatch.at <= WAKE_TURN_MS));
    // Another turn reopens a prior handback; a handback-only member waits again, so the end of
    // this turn is its next handback. A blocked assignment stays blocked until a checkpoint or
    // `autonomy start` lifts it, and checkpoint and handoff pauses need an explicit start too.
    const reopened =
      resumed ||
      (!pushed && (["review", "archived"].includes(r.phase) || (r.phase === "blocked" && r.handbackOnly)));
    // Later prompts repeat the reason; one about the handback or the quota wait no longer applies.
    const reason = resumed
      ? "Resumed after cancellation"
      : reopened
        ? "Reopened by a new turn"
        : r.reason.startsWith(QUOTA_REASON)
          ? "Resumed after a provider quota"
          : r.reason;
    this.save(r, {
      turnId,
      outcome: null,
      delivery: "none",
      messageId: null,
      quotaRetry: undefined,
      phase: reopened ? (r.handbackOnly ? "waiting" : "active") : r.phase,
      reason,
      wakeBatch: undefined,
      wakeTurnId: pushed ? turnId : undefined,
    });
  }
  /**
   * `error` is the failure text, or the provider notice the turn ended on; a provider limit is
   * waited out until its reset. `promptId` is the message that started the turn, when known.
   */
  ended(id: string, turnId: string | null, outcome: string, error?: string, promptId?: string) {
    const r = this.get(id);
    if (!r || (r.turnId && r.turnId !== turnId)) return;
    if (r.outcome === outcome && r.turnId === turnId) return;
    const now = this.now();
    let phase = r.phase;
    let reason = r.reason;
    let dueAt = now + 15000;
    let quotaRetry: true | undefined;
    let quotaWaits: number | undefined;
    let { retries, continuations, unchecked } = r;
    // A checkpoint in this turn decides how it ends. Without one, a turn the plugin's wake batch or
    // the agent itself started leaves the phase as it found it: no inferred handback or continuation.
    const checkpointed = r.checkpointTurnId === r.turnId;
    const pushed = !checkpointed && r.wakeTurnId !== undefined && r.wakeTurnId === r.turnId;
    const autonomous = turnId?.startsWith("autonomous") === true;
    // Paused work stays paused, a blocker stays until a checkpoint or start lifts it, and a
    // handback or wait recorded in this turn stands: finished work is not retried.
    const standing = ["paused", "review", "blocked"].includes(phase) || (phase === "waiting" && checkpointed);
    // A wake batch's turn that failed did not finish: it is retried, or goes to the owner, like
    // any other. A turn the agent started itself is not retried.
    const kept = standing || (pushed && (autonomous || outcome !== "failed"));
    const reset = outcome === "failed" ? quotaReset(error, now) : null;
    // Such a turn that is canceled, or fails into a retry or its owner's review, ends as new work:
    // it no longer keeps the handback it found (carrying), so the member records it.
    const renewed = pushed && (outcome === "canceled" || (outcome === "failed" && !kept && reset === null));
    // The turn the plugin's own continuation or retry started; a provider limit cutting it short
    // gives that budget back.
    const paid = promptId !== undefined && r.charged?.messageId === promptId ? r.charged : undefined;
    if (reset !== null && paid?.retry) retries = Math.max(0, retries - 1);
    else if (reset !== null && paid) continuations = Math.max(0, continuations - 1);
    // A limit that already holds this harness is the same outage, not another wait.
    const held = reset !== null ? this.store.heldUntil(id, now) : null;
    if (outcome === "canceled") {
      phase = "paused";
      reason = "Turn canceled; explicit resume required";
    } else if (reset !== null && !standing && !(pushed && !autonomous)) {
      // Waited out without budget. A wake batch's turn is not: Wakeups sends that batch again.
      quotaWaits = held !== null ? Math.max(r.quotaWaits ?? 0, 1) : (r.quotaWaits ?? 0) + 1;
      if (quotaWaits > QUOTA_WAITS) {
        phase = "blocked";
        reason = `Provider quota did not lift after ${QUOTA_WAITS} waits`;
      } else {
        // A handback-only member is retried once at the reset too, and stays handback-only.
        if (!r.handbackOnly) phase = "active";
        quotaRetry = true;
        dueAt = reset;
        reason = `${QUOTA_REASON}${new Date(reset).toISOString()}`;
      }
    } else if (outcome === "failed" && !kept && reset === null) {
      dueAt = now + 30000 * 2 ** r.retries;
      if (r.handbackOnly) {
        // Nothing retries it; its owner decides what follows.
        phase = "blocked";
        reason = `Turn failed${error ? `: ${error.split("\n", 1)[0].slice(0, 300)}` : ""}`;
      } else {
        phase = r.retries >= r.maxRetries ? "blocked" : "active";
        if (phase === "blocked") reason = "Retry budget exhausted";
      }
    } else if (outcome === "failed") {
      dueAt = now + 30000 * 2 ** r.retries;
    } else if (
      outcome === "completed" &&
      !pushed &&
      phase === "waiting" &&
      !checkpointed &&
      !this.bound(r) &&
      availableOwner(this.store, id) &&
      !this.wakeSource(id)
    ) {
      // No checkpoint in this turn and nothing else will wake it: the turn is its handback.
      phase = "review";
      reason = "Turn ended without a checkpoint; its final message is the handback";
    } else if (outcome === "completed" && paid && !paid.retry && !checkpointed && phase === "active") {
      // Continued twice without a checkpoint: its final message goes to its owner instead.
      unchecked = (unchecked ?? 0) + 1;
      if (unchecked >= UNCHECKED_CONTINUATIONS) {
        phase = "review";
        reason = `Turn ended without a checkpoint after ${UNCHECKED_CONTINUATIONS} continuations; its final message is the handback`;
        unchecked = undefined;
      }
    }
    this.save(r, {
      turnId,
      outcome,
      phase,
      ...(outcome === "canceled" ? { pausedBy: "cancel" as const, pausedAt: now } : {}),
      delivery: "none",
      messageId: null,
      reason,
      dueAt,
      quotaRetry,
      quotaWaits,
      retries,
      continuations,
      unchecked,
      charged: paid ? undefined : r.charged,
      // A batch sent while this turn ran was read in it.
      wakeBatch: undefined,
      ...(renewed ? { wakeTurnId: undefined } : {}),
    });
    // Once per run of quota waits, and only for a wait worth knowing about.
    if (quotaRetry && quotaWaits === 1 && dueAt - now >= QUOTA_NOTICE_MS)
      this.quotaNotice(id, Math.max(dueAt, held ?? 0));
  }
  /** The nearest live owner hears once per provider limit that this agent waits for it. */
  private quotaNotice(id: string, retryAt: number) {
    const member = this.store.member(id);
    const owner = availableOwner(this.store, id);
    if (!member || !owner) return;
    // Its other members waiting on the same limit add nothing new.
    const harness = harnessOf(member.provider);
    const key = `quota-${sha256(`${owner}:${harness}:${retryAt}`).slice(0, 32)}`;
    if (this.wakes.list().some((w) => w.key === key)) return;
    try {
      this.wakes.add({
        key,
        roomId: member.roomId,
        ownerId: owner,
        reason: `${member.role} ${id} hit a provider limit. Until ${new Date(retryAt).toISOString()} Alliance prompts no ${harness ?? "such"} member on this host, then retries it without using its budget; reassign the work only if it cannot wait.`,
        trigger: { kind: "time", at: this.now() },
        delivery: "idle",
        expiresAt: retryAt,
      });
    } catch {
      /* A cross-room owner may not be authorized; the assignment's reason still names the pause. */
    }
  }
  tick(api: PaseoApi) {
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
  /**
   * Once per load, read whether Paseo archived or deleted a member that no live assignment covers
   * (0.1.18 marked only the assignment), so its reminders end and reviews about it close.
   */
  private async reconcile(api: PaseoApi) {
    for (const member of this.store.members()) {
      if (this.stopped) return;
      if (member.archivedAt || this.reconciled.has(member.id)) continue;
      const r = this.get(member.id);
      if (r && r.phase !== "archived") continue; // Read every round below.
      const live = await api.agents
        .ref(member.id)
        .refresh()
        .catch(() => undefined);
      if (live === undefined) continue; // Unknown now; read again next round.
      this.reconciled.add(member.id);
      if ((!live || live.agent.archivedAt) && !this.store.member(member.id)?.archivedAt)
        this.store.updateMember(member.id, { archivedAt: new Date(this.now()).toISOString() });
    }
  }
  /** Paseo runs no turn for this member although its store turn is open: its end hook was lost. */
  private observe(id: string, status: string) {
    const m = this.store.member(id);
    const open = Boolean(m?.lastTurnId) && m?.lastOutcome === null;
    if (!open || ["running", "starting", "initializing"].includes(status)) this.unseen.delete(id);
    else if (!this.unseen.has(id)) this.unseen.set(id, this.now());
  }
  private async round(api: PaseoApi) {
    const errors: unknown[] = [];
    await this.reconcile(api).catch((error) => errors.push(error));
    // Members given an owner later, or recorded before assignments existed, get a record here.
    const managed = new Set(this.list().map((r) => r.agentId));
    for (const member of this.store.members())
      if (!managed.has(member.id) && !member.archivedAt && availableOwner(this.store, member.id))
        try {
          this.ensure(member.id);
        } catch (error) {
          errors.push(error);
        }
    for (const initial of this.list()) {
      try {
        if (this.stopped) return;
        let r = this.get(initial.agentId) ?? initial;
        if (r.phase === "archived") continue;
        if (r.delivery === "dispatching") {
          this.save(r, {
            delivery: "uncertain",
            reason: "Dispatch interrupted; inspect native history and checkpoint before retry",
          });
          continue;
        }
        const member = this.store.member(r.agentId);
        if (!member) continue;
        const ref = api.agents.ref(r.agentId);
        const live = await ref.refresh().catch(() => undefined);
        if (this.stopped || live === undefined) continue;
        if (live) this.observe(r.agentId, live.agent.status);
        if (this.get(r.agentId)?.revision !== r.revision) continue;
        // Archived, or deleted natively: it can never run or decide again.
        if (!live || live.agent.archivedAt) {
          this.save(r, { phase: "archived" });
          // Marked on the member too, so its reminders end or move even if the archive event was missed.
          if (!this.store.member(r.agentId)?.archivedAt)
            this.store.updateMember(r.agentId, { archivedAt: new Date(this.now()).toISOString() });
          continue;
        }
        // Hooks are best effort. Retained turn records recover missed scheduler callbacks.
        if (member.lastOutcome && member.lastTurnId === r.turnId && !r.outcome) {
          this.ended(r.agentId, r.turnId, member.lastOutcome, live.agent.lastError);
          r = this.get(r.agentId) ?? r;
        }
        if (live.agent.pendingPermissions?.length) continue;
        // The nearest owner up the chain that is not archived decides, on the member's turn: the
        // handback, which turns that keep the phase leave standing (carrying).
        const owner = availableOwner(this.store, r.agentId);
        const turnId = member.lastTurnId ?? null;
        if (
          owner &&
          turnId &&
          r.outcome &&
          ["review", "blocked"].includes(r.phase) &&
          !decidedTurn(member, turnId)
        ) {
          const key = `auto-review-${sha256(`${r.agentId}:${turnId}:${owner}:${r.phase}`).slice(0, 32)}`;
          // A blocker asks its owner once, until its reason changes or the owner decides. A review
          // a newer turn superseded before it reached the owner did not ask.
          const blocker = r.phase === "blocked" ? sha256(`${owner}:${r.reason}`).slice(0, 32) : undefined;
          const asked = this.wakes.list().some(
            (w) =>
              w.key === key ||
              (blocker !== undefined &&
                r.blocker?.hash === blocker &&
                w.key === r.blocker?.review &&
                (w.runs > 0 || asking(w))) ||
              // One review per turn and owner, whichever path created it. The owner's own pull
              // reminder on that turn is never pushed, so it does not count.
              (asking(w) &&
                w.ownerId === owner &&
                w.trigger.kind === "turn" &&
                w.trigger.agentId === r.agentId &&
                w.trigger.turnId === turnId),
          );
          if (!asked) {
            this.wakes.add({
              key,
              roomId: member.roomId,
              ownerId: owner,
              reason: `Review ${r.agentId}: ${r.reason.slice(0, 1000)}. Read ${member.resultPath ?? member.assignment}${r.phase === "blocked" ? ", then resolve the blocker" : ""}.`,
              trigger: { kind: "turn", agentId: r.agentId, turnId },
              delivery: "idle",
              // Owners usually act on Paseo's own finish notice within two minutes; accepting or
              // reworking in that time cancels this wakeup before it is sent.
              delayMs: 120000,
            });
            if (blocker) r = this.save(r, { blocker: { hash: blocker, review: key } });
          }
        }
        // A handback-only member waiting out a provider limit is retried once, like an assignment.
        const quota = r.quotaRetry === true && r.outcome === "failed";
        if (
          (r.phase !== "active" && !(r.phase === "waiting" && (r.obligationKey || quota))) ||
          !r.outcome ||
          r.delivery !== "none" ||
          this.now() < r.dueAt ||
          member.decision === "accepted"
        )
          continue;
        // A bound assignment may advance only its current owner's ready obligation.
        // Unrelated assignments are not blocked by other owners' prerequisites.
        const obligation = r.obligationKey
          ? this.store.obligations().find((o) => o.key === r.obligationKey)
          : undefined;
        if (
          r.obligationKey &&
          (!obligation || obligation.ownerId !== r.agentId || blockedOn(obligation, this.now()).length)
        )
          continue;
        if (r.phase === "waiting" && !quota && !obligation?.conditions.length) continue;
        // Nothing reaches a member whose provider limit has not lifted yet.
        if (this.store.heldUntil(r.agentId, this.now()) !== null) continue;
        // Only known failed runs may recover from error/closed. Never resurrect a canceled or archived agent.
        const retry = r.outcome === "failed";
        if (
          live.agent.providerUnavailable ||
          (live.agent.status !== "idle" && !(retry && ["error", "closed"].includes(live.agent.status)))
        )
          continue;
        // A retry after a provider quota reset does not use the retry budget.
        const spent = retry && !r.quotaRetry;
        if ((spent && r.retries >= r.maxRetries) || (!retry && r.continuations >= r.maxContinuations)) {
          // Only start renews the budget: an `active` checkpoint would be blocked again right here.
          this.save(r, {
            phase: "blocked",
            reason: `Autonomous run budget exhausted: a checkpoint does not renew it; alliance-work autonomy start --agent ${r.agentId} does, and that is its owner's or the Human's decision`,
          });
          continue;
        }
        const messageId = randomUUID();
        const claimed = this.save(r, {
          phase: r.handbackOnly ? r.phase : "active",
          delivery: "dispatching",
          messageId,
          retries: r.retries + (spent ? 1 : 0),
          continuations: r.continuations + (retry ? 0 : 1),
          quotaRetry: undefined,
          charged: spent || !retry ? { messageId, retry } : undefined,
        });
        const pull = this.wakes.pullList(r.agentId);
        try {
          await ref.send(
            `Alliance ${retry ? "retry after failed turn" : "continue assignment"} [${messageId}]. Read ${obligation?.assignment ?? member.assignment} and prior results before acting. ${r.reason}\n${obligation ? `Obligation ${obligation.key}, revision ${obligation.revision}: ${obligation.nextAction}. Recover current policy and obligation evidence before dependent effects.\n` : ""}Own the next concrete step and preserve completed effects. Before ending the turn, either run alliance-work wait for a child, job or time (it records waiting), or alliance-work autonomy checkpoint --phase review|blocked|active|paused --reason TEXT: review hands checked results to your owner (send no handback prompt); blocked asks for a decision. Never sleep or poll. Commands must not wait for input or approval: nobody approves them.\n\n${pull ? `${pull}\n\n` : ""}${cliLine(this.cli())}`,
            { messageId, activeTurnBehavior: "steer" },
          );
          const latest = this.get(r.agentId);
          if (latest?.revision === claimed.revision) this.save(latest, { delivery: "sent" });
        } catch (error) {
          const latest = this.get(r.agentId);
          if (latest?.revision === claimed.revision)
            this.save(
              latest,
              // The daemon refused before prompting: restore the claim and try again in a minute.
              refusedSend(error)
                ? {
                    phase: r.phase,
                    delivery: "none",
                    messageId: null,
                    retries: r.retries,
                    continuations: r.continuations,
                    quotaRetry: r.quotaRetry,
                    charged: r.charged,
                    dueAt: this.now() + 60000,
                  }
                : {
                    delivery: "uncertain",
                    reason: "Native delivery outcome unknown; inspect history before checkpoint/resume",
                  },
            );
        }
      } catch (error) {
        // One bad obligation must not starve other agents in this sweep.
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Autonomy sweep incomplete; state retained");
  }
}
