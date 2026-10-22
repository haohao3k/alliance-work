import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { pauseKind } from "../shared/autonomy";
import { blockedOn } from "../shared/obligations";
import { deliverable, responsibleOwner } from "../shared/operations";
import { defaultDelivery, type WakeRecordValue as Wake, WakeInput } from "../shared/wakeups";
import { observeJob } from "./jobs.mjs";
import { decisionChain } from "./lifecycle";
import type { MemberRecord, RoomStore } from "./store";

const terminal = new Set(["acknowledged", "canceled", "expired"]);
/** Acknowledged, canceled or expired: kept only for audit and never sent again. */
export const finished = (w: Pick<Wake, "state">) => terminal.has(w.state);
/** Finished reminders are kept this long for audit, then removed so the active cap stays usable. */
export const WAKE_RETENTION_MS = 7 * 86400000;
const ACTIVE_LIMIT = 1000;
/** A closed owner whose session failed to load is tried again after this long, or once it is idle. */
const UNLOADABLE_MS = 3600000;
/** An owner may push a reminder back this often; after that it decides or cancels. */
const MAX_DEFERS = 3;
/** These notes hold a reminder only while its job or owner does not match; they clear when it does. */
const JOB_CHANGED = "Job changed; reconcile ownership";
const OWNER_CHANGED = "Owner changed; reconcile handoff";
/** A review that closed by itself: its turn was decided or superseded, or its child archived. */
const SETTLED = "Turn superseded or decided";
const CHILD_ARCHIVED = "Child archived; nothing left to decide";
/** The one-time migration of reminders older releases stored pull by default (store.migration). */
const PULL_MIGRATION = 1;
/** Such a reminder that came due longer ago than this is canceled instead. */
const STALE_PULL_MS = 72 * 3600000;
const settled = (w: Wake) =>
  w.trigger.kind === "turn" &&
  w.state === "canceled" &&
  // 0.1.18 wrote "Turn superseded or work accepted".
  (w.note?.startsWith("Turn superseded") || w.note === CHILD_ARCHIVED);
/**
 * True when the daemon refused a send before prompting the agent: the agent is unknown or its
 * provider cannot load (both before any receipt is written), or a provider that cannot be steered
 * (AGY on Paseo 0.11) started a turn meanwhile. Any other failure may have delivered.
 */
export const refusedSend = (error: unknown) =>
  error instanceof Error &&
  /^Agent not found: |references unavailable provider|^agent_request_key_conflict$|does not support prompt\.steer/.test(
    error.message,
  );
/**
 * Paseo could not load a closed session, so the prompt was never recorded. A client timeout or a
 * lost connection says nothing about delivery: the daemon may still be loading it.
 */
const loadFailed = (error: unknown) =>
  error instanceof Error &&
  error.name !== "DaemonConnectionError" &&
  /is not available|does not exist|initiali[sz]e timed out|(?:failed|unable) to (?:load|resume)|could not (?:load|resume)/i.test(
    error.message,
  );
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
/** Its owner chain or the Human accepted or rejected this turn (a decision without a turn is older). */
export const decidedTurn = (member: Pick<MemberRecord, "decision" | "decisionTurnId">, turnId: string) =>
  member.decision !== "open" && (member.decisionTurnId == null || member.decisionTurnId === turnId);
/** The CLI command agents should run; `managed` when it is the launcher of the active release. */
export type CliCommand = { command: string; managed: boolean };
/**
 * Plugin prompts name the CLI to run. A long-lived session's instructions may name a release
 * directory that an update has since replaced; the managed launcher always runs the active one.
 */
export const cliLine = ({ command, managed }: CliCommand) =>
  managed
    ? `Alliance CLI: ${command} (it always runs the active release; use it instead of any older path in your instructions).`
    : `Alliance CLI: ${command}.`;

/** Durable notifications. Their expiry/acknowledgement never closes an obligation. */
export class Wakeups {
  private running: Promise<void> | undefined;
  private stopped = false;
  /** Closed owners whose session failed to load on our last send, and when. */
  private unloadable = new Map<string, number>();
  /** The command named in delivered prompts; the runtime points it at the managed launcher. */
  cli: () => CliCommand = () => ({ command: "alliance-work", managed: false });
  constructor(
    private store: RoomStore,
    private now: () => number = Date.now,
  ) {
    if (store.migration() < PULL_MIGRATION)
      store.atomic(() => {
        this.migratePull();
        store.setMigration(PULL_MIGRATION);
      });
  }
  list() {
    return this.store.wakeups();
  }
  /**
   * Before 0.1.19 a reminder that did not ask for idle delivery was pull, and nothing pushes a
   * pull reminder, so owners waiting on one stalled. At the first load of this release each one
   * still open wakes its owner like any reminder (the next rounds send it once, batched with the
   * owner's other items), unless it was created and came due over 72 hours ago: that one is
   * canceled. A job reminder comes due when its job exits. Obligation reminders stay pull.
   */
  private migratePull() {
    const cutoff = this.now() - STALE_PULL_MS;
    for (const w of this.list())
      if (w.delivery === "pull" && !w.obligationKey && !terminal.has(w.state))
        this.save(
          w,
          w.state === "scheduled" || Math.max(w.createdAt, w.dueAt, w.updatedAt) >= cutoff
            ? { delivery: "idle" }
            : {
                state: "canceled",
                note: "Pull reminder from before 0.1.19, due over 72 hours ago; canceled at the upgrade. Add it again if it still applies",
              },
        );
  }
  private authorized(w: Pick<Wake, "ownerId" | "roomId" | "trigger" | "obligationKey">) {
    const owner = this.store.member(w.ownerId);
    if (!owner) return false;
    if (w.obligationKey) {
      const o = this.store.obligations().find((o) => o.key === w.obligationKey);
      return o?.roomId === w.roomId && o.ownerId === w.ownerId && o.state === "open";
    }
    if (owner.roomId === w.roomId) return true;
    if (w.trigger.kind === "turn") {
      // Any owner up the child's decision chain may be asked to decide on its turn.
      const child = this.store.member(w.trigger.agentId);
      return child?.roomId === w.roomId && decisionChain(this.store, child.id).includes(owner.id);
    }
    if (w.trigger.kind === "job") {
      const key = w.trigger.key;
      return this.store.jobs().some((j) => j.key === key && j.roomId === w.roomId && j.ownerId === owner.id);
    }
    return this.store.members(w.roomId).some((m) => responsibleOwner(m) === owner.id);
  }
  /** The reminder still applies: authorized, unblocked, and its job or undecided child turn is current. */
  current(w: Wake) {
    if (!this.authorized(w)) return false;
    if (w.obligationKey) {
      const o = this.store.obligations().find((o) => o.key === w.obligationKey);
      if (!o || blockedOn(o, this.now()).length) return false;
    }
    if (w.trigger.kind === "job") {
      const key = w.trigger.key;
      const job = this.store.jobs().find((j) => j.key === key);
      return (
        job?.ownerId === w.ownerId && job.revision === w.jobRevision && job.processIdentity === w.jobIdentity
      );
    }
    if (w.trigger.kind === "turn") {
      const member = this.store.member(w.trigger.agentId);
      return (
        member?.lastTurnId === w.trigger.turnId &&
        !decidedTurn(member, w.trigger.turnId) &&
        !this.archivedChild(member.id)
      );
    }
    return true;
  }
  /** The member was archived (recorded on it or on its assignment): nothing about it is left to decide. */
  private archivedChild(id: string) {
    return Boolean(this.store.member(id)?.archivedAt) || this.store.autonomyOf(id)?.phase === "archived";
  }
  private owner(w: Pick<Wake, "ownerId" | "roomId" | "trigger" | "obligationKey">) {
    if (!this.authorized(w))
      throw new Error("Wakeup requires a room member or its explicitly responsible owner");
  }
  add(raw: unknown) {
    const parsed = WakeInput.parse(raw);
    const delivery = parsed.delivery ?? defaultDelivery(parsed);
    // Parsed again with the default in place, so key order and input hash equal an explicit value.
    const input = { ...WakeInput.parse({ ...parsed, delivery }), delivery };
    this.store.room(input.roomId);
    this.owner(input);
    const inputHash = sha256(JSON.stringify(input));
    const prior = this.list().find((w) => w.key === input.key);
    if (prior) {
      // Before 0.1.19 an omitted delivery meant pull; the unchanged command still names that work.
      const legacy = parsed.delivery
        ? null
        : sha256(JSON.stringify(WakeInput.parse({ ...parsed, delivery: "pull" })));
      if (prior.inputHash !== inputHash && prior.inputHash !== legacy)
        throw new Error("Wakeup key already names different work");
      return prior;
    }
    if (this.list().filter((w) => !terminal.has(w.state)).length >= ACTIVE_LIMIT)
      throw new Error(`Active wakeup limit reached (${ACTIVE_LIMIT} unfinished records)`);
    const now = this.now();
    const expiresAt = input.expiresAt ?? now + 30 * 86400000;
    const { delayMs, ...fields } = input;
    const due = input.trigger.kind === "time" ? input.trigger.at : now;
    const dueAt = delayMs ? Math.max(due, now + delayMs) : due;
    if (expiresAt <= now || dueAt >= expiresAt) throw new Error("Wakeup must be due before a future expiry");
    const record: Wake = {
      ...fields,
      inputHash,
      expiresAt,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      state: "scheduled",
      note: null,
      runs: 0,
      dueAt,
      messageId: null,
      lastSentAt: null,
    };
    if (input.trigger.kind === "job") {
      const key = input.trigger.key;
      const job = this.store.jobs().find((j) => j.key === key);
      if (!job || job.roomId !== input.roomId || job.ownerId !== input.ownerId)
        throw new Error("Job and wakeup must share room and owner");
      record.jobIdentity = job.processIdentity;
      record.jobRevision = job.revision;
    }
    if (input.trigger.kind === "turn") {
      const member = this.store.member(input.trigger.agentId);
      if (!member || member.roomId !== input.roomId) throw new Error("Child must belong to the source room");
      if (member.lastTurnId !== input.trigger.turnId) throw new Error("Turn is no longer current");
    }
    this.store.saveWakeup(record);
    return record;
  }
  private save(w: Wake, change: Partial<Wake>) {
    const next = { ...w, ...change, revision: w.revision + 1, updatedAt: this.now() };
    this.store.saveWakeup(next, w.revision);
    return next;
  }
  /**
   * The child whose turn this review still needs this owner's decision on, or null. A decision on
   * that turn, a newer turn (rework), or an archived, kept or re-owned child releases it, and so
   * does a turn that handed nothing back.
   */
  private undecided(w: Wake) {
    if (w.trigger.kind !== "turn") return null;
    const { agentId, turnId } = w.trigger;
    const child = this.store.member(agentId);
    if (!child || child.lastTurnId !== turnId || child.archivedAt || child.keep) return null;
    if (decidedTurn(child, turnId) || !this.handedBack(agentId, turnId)) return null;
    return decisionChain(this.store, agentId).includes(w.ownerId) ? child : null;
  }
  /**
   * False when the child's checkpoint in that turn left it waiting or active: the turn handed nothing
   * back, so a reminder about it (an owner's `wait --agent`) needs an ack, not a decision. Turns that
   * only keep the phase leave that standing (Autonomy.carrying); a checkpoint in one moves the child
   * to it.
   */
  private handedBack(agentId: string, turnId: string) {
    const r = this.store.autonomyOf(agentId);
    return !(r?.checkpointTurnId === turnId && ["waiting", "active"].includes(r.phase));
  }
  action(
    key: string,
    ownerId: string,
    revision: number,
    action: "ack" | "cancel" | "owner" | "defer",
    nextOwnerId?: string,
    minutes?: number,
  ) {
    const w = this.list().find((w) => w.key === key);
    // The owner's decision (or rework) already closed this review; its ack has nothing left to do.
    if (action === "ack" && w?.ownerId === ownerId && settled(w))
      return { ...w, note: `Already closed (${w.note}); no ack needed` };
    if (!w || w.ownerId !== ownerId || w.revision !== revision)
      throw new Error("Wakeup changed; refresh owner and revision");
    if (terminal.has(w.state) || w.state === "dispatching")
      throw new Error("Wakeup is terminal or being dispatched");
    if (action === "cancel") return this.save(w, { state: "canceled", note: "Canceled by owner" });
    if (action === "owner") {
      if (w.obligationKey)
        throw new Error("Hand off the obligation to transfer its pending wakeups atomically");
      if (!nextOwnerId || !["scheduled", "pending"].includes(w.state))
        throw new Error("Only waiting wakeups can change owner");
      this.owner({ ...w, ownerId: nextOwnerId });
      let jobRevision = w.jobRevision;
      if (w.trigger.kind === "job") {
        const key = w.trigger.key;
        const job = this.store.jobs().find((j) => j.key === key);
        if (!job || job.ownerId !== nextOwnerId || job.processIdentity !== w.jobIdentity)
          throw new Error("Transfer the same tracked job to this owner first");
        jobRevision = job.revision;
      }
      return this.save(w, { ownerId: nextOwnerId, jobRevision, note: null });
    }
    if (action === "defer") {
      if (!minutes) throw new Error("Defer needs --minutes (1-1440)");
      if (w.state === "scheduled") throw new Error("Wakeup is not due yet; nothing to defer");
      const defers = w.defers ?? 0;
      if (defers >= MAX_DEFERS)
        throw new Error(`Wakeup already deferred ${MAX_DEFERS} times; decide now or cancel it`);
      const dueAt = this.now() + minutes * 60000;
      if (dueAt >= w.expiresAt) throw new Error("Deferral passes the wakeup's expiry; decide or cancel it");
      // Deferring a delivered reminder postpones that delivery; it is not another run.
      return this.save(w, {
        state: "scheduled",
        dueAt,
        runs: w.state === "pending" ? w.runs : Math.max(0, w.runs - 1),
        messageId: null,
        defers: defers + 1,
        note: `Deferred ${minutes} min by owner`,
      });
    }
    if (!["delivered", "uncertain"].includes(w.state))
      throw new Error("Take or receive the wakeup before acknowledging it");
    const child = this.undecided(w);
    if (child)
      throw new Error(
        `Decide on ${child.id} turn ${child.lastTurnId} before acknowledging its review: accept with evidence (alliance-work accept), reject (alliance-work reject), send it rework (its new turn supersedes this wakeup), or defer (alliance-work wakeups defer --minutes N).`,
      );
    if (w.everyMs && w.runs < w.maxRuns && this.now() + w.everyMs < w.expiresAt)
      return this.save(w, { state: "scheduled", dueAt: this.now() + w.everyMs, messageId: null, note: null });
    return this.save(w, {
      state: "acknowledged",
      note: "Review acknowledged; no artifact acceptance implied",
    });
  }
  tick(api?: PaseoApi) {
    if (this.stopped) return Promise.resolve();
    if (!this.running)
      this.running = this.round(api).finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  /** One more first pass after any round in flight, so a change recorded just now takes effect. */
  async settle() {
    await this.running?.catch(() => undefined);
    await this.tick();
  }
  async stop() {
    this.stopped = true;
    await this.running;
  }
  /**
   * Remove finished reminders past retention. Kept: a turn reminder for the member's current
   * turn (its key prevents the same review being sent again) and anything linked to an open
   * obligation (handoff uses it to move the obligation's jobs and reminders together).
   */
  private prune() {
    const cutoff = this.now() - WAKE_RETENTION_MS;
    const open = new Set(
      this.store
        .obligations()
        .filter((o) => o.state === "open")
        .map((o) => o.key),
    );
    for (const w of this.list()) {
      if (!terminal.has(w.state) || w.updatedAt > cutoff) continue;
      if (w.obligationKey && open.has(w.obligationKey)) continue;
      if (w.trigger.kind === "turn" && this.store.member(w.trigger.agentId)?.lastTurnId === w.trigger.turnId)
        continue;
      this.store.deleteWakeup(w.key, w.revision);
    }
  }
  /**
   * The plugin does not prompt an owner the Human cancelled while that cancelled turn is still its
   * latest; pull still works. An owner paused by checkpoint or handoff is prompted, and a turn the
   * plugin starts keeps its pause.
   */
  private held(ownerId: string) {
    const r = this.store.autonomyOf(ownerId);
    // A 0.1.15 record kept the cancel reason after later turns; those owners have been working since.
    return r ? pauseKind(r) === "cancel" && r.outcome === "canceled" : false;
  }
  /**
   * Recorded on the owner's assignment just before a batch is sent, so the turn it starts keeps
   * the owner's phase. An active assignment keeps its usual course and needs no mark. Returns the
   * mark's time, or null.
   */
  private markBatch(ownerId: string, batch: Wake[]) {
    const r = this.store.autonomyOf(ownerId);
    if (!r || r.phase === "active" || r.phase === "archived") return null;
    const at = this.now();
    try {
      this.store.saveAutonomy(
        { ...r, wakeBatch: { at, keys: batch.map((w) => w.key) }, revision: r.revision + 1 },
        r.revision,
      );
      return at;
    } catch {
      return null; // Changed meanwhile; the batch is sent unmarked.
    }
  }
  /** The batch delivered nothing, so no turn of the owner's is the batch's. */
  private unmarkBatch(ownerId: string, at: number) {
    const r = this.store.autonomyOf(ownerId);
    if (r?.wakeBatch?.at !== at) return;
    try {
      this.store.saveAutonomy({ ...r, wakeBatch: undefined, revision: r.revision + 1 }, r.revision);
    } catch {
      /* Changed meanwhile; the mark lapses after a few minutes. */
    }
  }
  /** The owner was archived: its reminders and reviews end. A later handback asks the next live owner. */
  private release(w: Wake) {
    this.save(w, {
      state: "canceled",
      note:
        w.trigger.kind === "turn" && this.archivedChild(w.trigger.agentId)
          ? CHILD_ARCHIVED
          : "Owner archived; re-add for an available owner",
    });
  }
  /** Paseo reports the owner archived or deleted: record that, then release its reminders. */
  private gone(ownerId: string) {
    const member = this.store.member(ownerId);
    if (member && !member.archivedAt)
      this.store.updateMember(ownerId, { archivedAt: new Date(this.now()).toISOString() });
    for (const w of this.list())
      if (w.ownerId === ownerId && !w.obligationKey && !terminal.has(w.state) && w.state !== "dispatching")
        this.release(w);
  }
  /** A notice the plugin raised no longer applies: cancel it unless it was already sent. */
  withdraw(key: string, note: string) {
    const w = this.list().find((v) => v.key === key);
    if (w?.state === "scheduled" || w?.state === "pending") this.save(w, { state: "canceled", note });
  }
  /** The owner's pending pull reminders, one short line each, for prompts that reach it anyway. */
  pullList(ownerId: string) {
    const items = this.list().filter(
      (w) =>
        w.ownerId === ownerId && w.delivery === "pull" && w.state === "pending" && !w.note && this.current(w),
    );
    if (!items.length) return "";
    const lines = items.slice(0, 8).map((w) => `[${w.key}] ${w.reason.split("\n", 1)[0].slice(0, 160)}`);
    if (items.length > 8) lines.push(`(${items.length - 8} more)`);
    return `Also pending for you, not delivered by this message (read with wakeups take --owner ${ownerId}):\n${lines.join("\n")}`;
  }
  private async round(api?: PaseoApi) {
    this.prune();
    for (const w of this.list()) {
      if (terminal.has(w.state)) continue;
      if (w.state === "dispatching") {
        this.save(w, {
          state: "uncertain",
          note: "Dispatch interrupted; inspect owner history before ack/cancel",
        });
        continue;
      }
      // An archived owner never takes its reminders; obligation reminders move only with handoff.
      if (!w.obligationKey && this.store.member(w.ownerId)?.archivedAt) {
        this.release(w);
        continue;
      }
      if (w.state === "uncertain") continue;
      // The owner's turn that read this batch ended on a provider limit (the runtime records the
      // limit on the owner), so nobody read it: it is sent again once the limit lifts.
      const limited = this.store.member(w.ownerId)?.limited;
      if (w.state === "delivered" && w.messageId && limited?.messageId === w.messageId) {
        this.save(w, {
          state: "scheduled",
          dueAt: limited.until,
          runs: Math.max(0, w.runs - 1),
          messageId: null,
          note: "Its turn ended on a provider limit; sent again once the limit lifts",
        });
        continue;
      }
      if (this.now() >= w.expiresAt) {
        this.save(w, { state: "expired", note: "Expired" });
        continue;
      }
      if (w.trigger.kind === "turn") {
        const member = this.store.member(w.trigger.agentId);
        // A decision on that turn (accept or reject) or a newer turn settles the review.
        if (!member || member.lastTurnId !== w.trigger.turnId || decidedTurn(member, w.trigger.turnId)) {
          this.save(w, { state: "canceled", note: SETTLED });
          continue;
        }
        // So does the child's archive: it is never pushed.
        if (this.archivedChild(member.id)) {
          this.save(w, { state: "canceled", note: CHILD_ARCHIVED });
          continue;
        }
        if (!member.lastOutcome || !member.resultPath) continue;
      }
      if (w.trigger.kind === "job") {
        const key = w.trigger.key;
        const job = this.store.jobs().find((j) => j.key === key);
        if (
          !job ||
          job.processIdentity !== w.jobIdentity ||
          job.revision !== w.jobRevision ||
          job.ownerId !== w.ownerId
        ) {
          if (w.note !== JOB_CHANGED) this.save(w, { note: JOB_CHANGED });
          continue;
        }
        const result = await observeJob(job);
        // Re-read after asynchronous observation: cancellation/owner changes win.
        if (this.list().find((v) => v.key === w.key)?.revision !== w.revision) continue;
        if (result.state !== "exited") continue;
      }
      if (!this.authorized(w)) {
        if (w.note !== OWNER_CHANGED) this.save(w, { note: OWNER_CHANGED });
        continue;
      }
      if (w.state === "scheduled" && this.now() >= w.dueAt) this.save(w, { state: "pending", note: null });
      // The job and owner match again, so the reconcile note no longer hides this reminder.
      else if (w.note === JOB_CHANGED || w.note === OWNER_CHANGED) this.save(w, { note: null });
    }
    if (!api || this.stopped) return;
    for (const owner of new Set(
      this.list()
        .filter((w) => w.state === "pending" && w.delivery === "idle" && !w.note)
        .map((w) => w.ownerId),
    )) {
      if (
        this.held(owner) ||
        // A provider limit holds every member of the owner's harness on this host until it lifts.
        this.store.heldUntil(owner, this.now()) !== null ||
        this.list().some(
          (w) => w.ownerId === owner && w.lastSentAt !== null && this.now() - w.lastSentAt < 60000,
        )
      )
        continue;
      const ref = api.agents.ref(owner);
      let live: Awaited<ReturnType<typeof ref.refresh>>;
      try {
        live = await ref.refresh();
      } catch {
        continue;
      }
      if (this.stopped) return;
      if (!live || live.agent.archivedAt) {
        this.gone(owner);
        continue;
      }
      if (!deliverable(live.agent)) continue;
      const closed = live.agent.status === "closed";
      if (closed && this.now() - (this.unloadable.get(owner) ?? Number.NEGATIVE_INFINITY) < UNLOADABLE_MS)
        continue;
      const batch = this.list()
        .filter(
          (w) =>
            w.ownerId === owner &&
            w.state === "pending" &&
            w.delivery === "idle" &&
            !w.note &&
            this.current(w),
        )
        .slice(0, 8);
      if (!batch.length) continue;
      const messageId = randomUUID();
      // Persist one batch claim before native send. Never retry an ambiguous send automatically.
      const claimed = this.store.claimWakeups(batch, messageId, this.now());
      if (!claimed) continue;
      // Plugin notices lapse by themselves; a review of a handback closes with its decision.
      const notice = (w: Wake) => /^(?:quota|silent|permission)-/.test(w.key);
      const review = (w: Wake) =>
        w.trigger.kind === "turn" && this.handedBack(w.trigger.agentId, w.trigger.turnId);
      const items = claimed.map(
        (w) =>
          `[${w.key}] ${w.reason}\nTrigger: ${JSON.stringify(w.trigger)}; revision: ${w.revision + 1}\n${review(w) ? "Decide: accept, reject, rework or defer." : notice(w) ? "No ack needed; it lapses by itself." : "Act, then ack."}`,
      );
      const pull = this.pullList(owner);
      const decide = claimed.some(review)
        ? " Decide each review with alliance-work accept --agent ID --report REPORT (the report path alliance-work verify prints for the candidate, not a turn file), alliance-work reject --agent ID --reason TEXT, a rework prompt to that agent, or wakeups defer (the ack flags plus --minutes M, at most three times). A decision closes its review; it needs no ack."
        : "";
      const ack = claimed.some((w) => !review(w) && !notice(w))
        ? ` Ack only the items marked "Act, then ack": alliance-work wakeups ack --key KEY --owner ${owner} --revision N.`
        : "";
      const marked = this.markBatch(owner, claimed);
      try {
        await ref.send(
          `Alliance wakeups for owner ${owner}:\n${items.join("\n\n")}${pull ? `\n\n${pull}` : ""}\n\nInspect the room's durable assignment/results before acting; a process exit or finished turn is not acceptance.${decide}${ack} To wait for something, run alliance-work wait and end your turn; never sleep or poll.\n\n${cliLine(this.cli())}`,
          { messageId, activeTurnBehavior: "steer" },
        );
        for (const w of claimed)
          this.save(w, { state: "delivered", note: "Native send acknowledged; owner review pending" });
        this.unloadable.delete(owner);
      } catch (error) {
        // An explicit refusal delivered nothing: due again after the owner cooldown.
        // So did a closed session that failed to load and is still closed: Paseo loads it before
        // recording the prompt. A timeout or lost connection may still deliver: uncertain.
        const unloaded =
          !refusedSend(error) &&
          closed &&
          loadFailed(error) &&
          (await ref.refresh().then(
            (again) => again?.agent.status === "closed",
            () => false,
          ));
        if (unloaded) this.unloadable.set(owner, this.now());
        const refused = refusedSend(error) || unloaded;
        if (refused && marked !== null) this.unmarkBatch(owner, marked);
        for (const w of claimed)
          this.save(
            w,
            refused
              ? {
                  state: "scheduled",
                  dueAt: this.now(),
                  runs: w.runs - 1,
                  messageId: null,
                  note: `${unloaded ? "Owner session did not load" : "Delivery refused"} (${(error as Error).message.slice(0, 200)}); retrying`,
                }
              : {
                  state: "uncertain",
                  note: "Native delivery outcome unknown; inspect history before ack/cancel",
                },
          );
      }
    }
  }
  async take(ownerId: string) {
    await this.tick();
    const mine = this.list().filter(
      (w) =>
        w.ownerId === ownerId &&
        this.current(w) &&
        (w.state === "delivered" || (w.state === "pending" && !w.note)),
    );
    // Unread reminders first, so items read but not yet acknowledged cannot hide new ones.
    return [...mine.filter((w) => w.state === "pending"), ...mine.filter((w) => w.state === "delivered")]
      .slice(0, 8)
      .map((w) =>
        w.state === "delivered"
          ? w
          : this.save(w, {
              state: "delivered",
              runs: w.runs + 1,
              note: "Read through CLI; acknowledgement pending",
            }),
      );
  }
}
