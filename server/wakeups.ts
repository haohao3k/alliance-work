import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { pauseKind } from "../shared/autonomy";
import { blockedOn } from "../shared/obligations";
import { responsibleOwner } from "../shared/operations";
import { type WakeRecordValue as Wake, WakeInput } from "../shared/wakeups";
import { observeJob } from "./jobs.mjs";
import type { RoomStore } from "./store";

const terminal = new Set(["acknowledged", "canceled", "expired"]);
/** Finished reminders are kept this long for audit, then removed so the active cap stays usable. */
export const WAKE_RETENTION_MS = 7 * 86400000;
const ACTIVE_LIMIT = 1000;

/** Durable notifications. Their expiry/acknowledgement never closes an obligation. */
export class Wakeups {
  private running: Promise<void> | undefined;
  private stopped = false;
  constructor(
    private store: RoomStore,
    private now: () => number = Date.now,
  ) {}
  list() {
    return this.store.wakeups();
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
      const child = this.store.member(w.trigger.agentId);
      return child?.roomId === w.roomId && responsibleOwner(child) === owner.id;
    }
    if (w.trigger.kind === "job") {
      const key = w.trigger.key;
      return this.store.jobs().some((j) => j.key === key && j.roomId === w.roomId && j.ownerId === owner.id);
    }
    return this.store.members(w.roomId).some((m) => responsibleOwner(m) === owner.id);
  }
  private current(w: Wake) {
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
      return member?.lastTurnId === w.trigger.turnId && member.decision !== "accepted";
    }
    return true;
  }
  private owner(w: Pick<Wake, "ownerId" | "roomId" | "trigger" | "obligationKey">) {
    if (!this.authorized(w))
      throw new Error("Wakeup requires a room member or its explicitly responsible owner");
  }
  add(raw: unknown) {
    const input = WakeInput.parse(raw);
    this.store.room(input.roomId);
    this.owner(input);
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = this.list().find((w) => w.key === input.key);
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error("Wakeup key already names different work");
      return prior;
    }
    if (this.list().filter((w) => !terminal.has(w.state)).length >= ACTIVE_LIMIT)
      throw new Error(`Active wakeup limit reached (${ACTIVE_LIMIT} unfinished records)`);
    const now = this.now();
    const expiresAt = input.expiresAt ?? now + 30 * 86400000;
    if (expiresAt <= now || (input.trigger.kind === "time" && input.trigger.at >= expiresAt))
      throw new Error("Wakeup must be due before a future expiry");
    const record: Wake = {
      ...input,
      inputHash,
      expiresAt,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      state: "scheduled",
      note: null,
      runs: 0,
      dueAt: input.trigger.kind === "time" ? input.trigger.at : now,
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
  action(
    key: string,
    ownerId: string,
    revision: number,
    action: "ack" | "cancel" | "owner",
    nextOwnerId?: string,
  ) {
    const w = this.list().find((w) => w.key === key);
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
    if (!["delivered", "uncertain"].includes(w.state))
      throw new Error("Take or receive the wakeup before acknowledging it");
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
  /** An owner whose turn the Human cancelled is not prompted by the plugin; it waits for pull. */
  private heldByCancel(ownerId: string) {
    // Only while the cancelled turn is still the latest; a 0.1.15 record kept the cancel reason
    // after later turns, and those owners have been working since.
    const r = this.store.autonomous().find((a) => a.agentId === ownerId);
    return r ? pauseKind(r) === "cancel" && r.outcome === "canceled" : false;
  }
  private async round(api?: PaseoApi) {
    this.prune();
    for (const w of this.list()) {
      if (terminal.has(w.state) || w.state === "uncertain") continue;
      if (w.state === "dispatching") {
        this.save(w, {
          state: "uncertain",
          note: "Dispatch interrupted; inspect owner history before ack/cancel",
        });
        continue;
      }
      if (this.now() >= w.expiresAt) {
        this.save(w, { state: "expired", note: "Expired" });
        continue;
      }
      if (w.trigger.kind === "turn") {
        const member = this.store.member(w.trigger.agentId);
        if (!member || member.lastTurnId !== w.trigger.turnId || member.decision === "accepted") {
          this.save(w, { state: "canceled", note: "Turn superseded or work accepted" });
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
          if (w.note !== "Job changed; reconcile ownership")
            this.save(w, { note: "Job changed; reconcile ownership" });
          continue;
        }
        const result = await observeJob(job);
        // Re-read after asynchronous observation: cancellation/owner changes win.
        if (this.list().find((v) => v.key === w.key)?.revision !== w.revision) continue;
        if (result.state !== "exited") continue;
      }
      if (!this.authorized(w)) {
        if (w.note !== "Owner changed; reconcile handoff")
          this.save(w, { note: "Owner changed; reconcile handoff" });
        continue;
      }
      if (w.state === "scheduled" && this.now() >= w.dueAt) this.save(w, { state: "pending", note: null });
    }
    if (!api || this.stopped) return;
    for (const owner of new Set(
      this.list()
        .filter((w) => w.state === "pending" && w.delivery === "idle" && !w.note)
        .map((w) => w.ownerId),
    )) {
      if (
        this.heldByCancel(owner) ||
        this.list().some(
          (w) => w.ownerId === owner && w.lastSentAt !== null && this.now() - w.lastSentAt < 60000,
        )
      )
        continue;
      const ref = api.agents.ref(owner);
      const live = await ref.refresh().catch(() => null);
      if (
        this.stopped ||
        !live ||
        live.agent.status !== "idle" ||
        live.agent.archivedAt ||
        (live.agent.pendingPermissions ?? []).length
      )
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
      const body = claimed
        .map(
          (w) => `[${w.key}] ${w.reason}\nTrigger: ${JSON.stringify(w.trigger)}; revision: ${w.revision + 1}`,
        )
        .join("\n\n");
      try {
        await ref.send(
          `Alliance wakeups for owner ${owner}:\n${body}\n\nInspect the room's durable assignment/results before acting. Process exit or turn completion is not acceptance. Use alliance-work wakeups ack --key KEY --owner ${owner} --revision N after reconciliation.`,
          { messageId, activeTurnBehavior: "steer" },
        );
        for (const w of claimed)
          this.save(w, { state: "delivered", note: "Native send acknowledged; owner review pending" });
      } catch {
        for (const w of claimed)
          this.save(w, {
            state: "uncertain",
            note: "Native delivery outcome unknown; inspect history before ack/cancel",
          });
      }
    }
  }
  async take(ownerId: string) {
    await this.tick();
    return this.list()
      .filter(
        (w) =>
          w.ownerId === ownerId &&
          this.current(w) &&
          ["pending", "delivered"].includes(w.state) &&
          (w.state === "delivered" || !w.note),
      )
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
