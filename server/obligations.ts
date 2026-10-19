import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { blockedOn, type Obligation, ObligationAction, ObligationInput } from "../shared/obligations";
import type { RoomStore } from "./store";

const activeWake = (state: string) => !["acknowledged", "expired", "canceled"].includes(state);

export class Obligations {
  constructor(
    private store: RoomStore,
    private now: () => number = Date.now,
  ) {}
  list(ownerId?: string | null) {
    return this.store
      .obligations()
      .filter((o) => ownerId === undefined || o.ownerId === ownerId)
      .map((o) => ({ ...o, blockedOn: blockedOn(o, this.now()) }));
  }
  private async available(ownerId: string | null, api: PaseoApi) {
    if (ownerId === null) return;
    if (!this.store.member(ownerId)) throw new Error("Unknown obligation owner");
    const live = await api.agents.ref(ownerId).refresh();
    if (
      !live ||
      live.agent.archivedAt ||
      !["idle", "running", "starting", "initializing"].includes(live.agent.status)
    )
      throw new Error("Obligation owner unavailable; preserve it and hand off explicitly");
  }
  async add(raw: unknown, api: PaseoApi) {
    const input = ObligationInput.parse(raw);
    this.store.room(input.roomId);
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const old = this.store.obligations().find((o) => o.key === input.key);
    if (old) {
      if (old.inputHash !== inputHash) throw new Error("Obligation key already names different work");
      return old;
    }
    await this.available(input.ownerId, api);
    const now = this.now();
    const record: Obligation = {
      ...input,
      inputHash,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      state: "open",
      observations: [],
      receipt: null,
    };
    this.store.atomic(() => this.store.saveObligation(record));
    return record;
  }
  async action(raw: unknown, api: PaseoApi) {
    const input = ObligationAction.parse(raw);
    const old = this.store.obligations().find((o) => o.key === input.key);
    if (!old || old.ownerId !== input.ownerId || old.revision !== input.revision)
      throw new Error("Obligation changed; refresh owner and revision");
    if (old.state !== "open") throw new Error("Obligation is terminal; retain its history");
    if (input.action === "handoff") {
      if (input.nextOwnerId === undefined) throw new Error("Handoff requires nextOwnerId (null for Human)");
      await this.available(input.nextOwnerId, api);
    }
    if (!isAbsolute(input.evidence)) throw new Error("Evidence must be an absolute regular file");
    for (let p = input.evidence; p !== dirname(p); p = dirname(p)) {
      if ((await lstat(p)).isSymbolicLink()) throw new Error("Evidence symlinks are not supported");
    }
    const stat = await lstat(input.evidence);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new Error("Evidence must be a regular file of at most 4 MiB");
    const digest = createHash("sha256")
      .update(await readFile(input.evidence))
      .digest("hex");
    const now = this.now();
    const receipt = { path: input.evidence, digest, at: now };
    const next: Obligation = { ...old, revision: old.revision + 1, updatedAt: now, receipt };
    if (input.action === "observe") {
      if (
        !old.conditions.some((c) => c.id === input.conditionId) ||
        !input.validUntil ||
        input.validUntil <= now
      )
        throw new Error("Observation requires a known condition and future validUntil");
      next.observations = [
        ...old.observations.filter((o) => o.conditionId !== input.conditionId),
        { conditionId: input.conditionId as string, validUntil: input.validUntil, receipt },
      ];
    } else if (input.action === "reconcile") {
      // New premise invalidates previous observations, even if condition IDs are reused.
      const revised = ObligationInput.parse({
        ...old,
        ...{
          nextAction: input.nextAction ?? old.nextAction,
          authority: input.authority ?? old.authority,
          conditions: input.conditions ?? old.conditions,
        },
      });
      Object.assign(next, revised, { observations: [] });
    } else if (input.action === "handoff") {
      next.ownerId = input.nextOwnerId as string | null;
    } else {
      if (
        input.action === "fulfill" &&
        old.conditions.some(
          (c) => !old.observations.some((v) => v.conditionId === c.id && v.validUntil > now),
        )
      )
        throw new Error("Unmet conditions; reconcile before fulfillment");
      next.state = input.action === "fulfill" ? "fulfilled" : "canceled";
    }
    return this.store.atomic(() => {
      // CAS occurs after all asynchronous reads; rollback covers notifications and jobs too.
      this.store.saveObligation(next, old.revision);
      const related = this.store.wakeups().filter((w) => w.obligationKey === old.key);
      const linked = related.filter((w) => activeWake(w.state));
      if (linked.some((w) => ["dispatching", "uncertain"].includes(w.state)))
        throw new Error("Resolve ambiguous delivery before changing its obligation");
      const jobs = new Map<string, number>();
      if (input.action === "handoff" && next.ownerId !== null) {
        // Receipt expiry/ack must not erase the association with the underlying job.
        for (const w of related) {
          if (w.trigger.kind !== "job") continue;
          const key = w.trigger.key;
          const job = this.store.jobs().find((j) => j.key === key);
          if (
            !job ||
            (old.ownerId !== null && job.ownerId !== old.ownerId) ||
            job.processIdentity !== w.jobIdentity ||
            (activeWake(w.state) && job.revision !== w.jobRevision) ||
            this.store
              .wakeups()
              .some(
                (other) =>
                  (activeWake(other.state) ||
                    this.store
                      .obligations()
                      .some((o) => o.key === other.obligationKey && o.state === "open")) &&
                  other.trigger.kind === "job" &&
                  other.trigger.key === key &&
                  other.obligationKey !== old.key,
              )
          )
            throw new Error("Shared or changed job; reconcile its wakeups before handoff");
          jobs.set(key, job.revision + 1);
        }
        for (const [key, revision] of jobs) {
          const job = this.store.jobs().find((j) => j.key === key);
          if (!job) throw new Error("Tracked job disappeared during handoff");
          this.store.saveJob({ ...job, ownerId: next.ownerId, revision }, job.revision);
        }
      }
      for (const w of linked) {
        this.store.saveWakeup(
          {
            ...w,
            revision: w.revision + 1,
            updatedAt: now,
            ...(input.action === "handoff" && next.ownerId !== null
              ? {
                  ownerId: next.ownerId,
                  note: null,
                  jobRevision: w.trigger.kind === "job" ? jobs.get(w.trigger.key) : w.jobRevision,
                }
              : {}),
            ...(next.state !== "open" || next.ownerId === null
              ? {
                  state: "canceled" as const,
                  note: `Obligation ${next.state}; owner ${next.ownerId ?? "Human"}`,
                }
              : {}),
            ...(input.action === "handoff" && next.ownerId !== null && w.state === "delivered"
              ? {
                  state: "acknowledged" as const,
                  ownerId: w.ownerId,
                  note: "Delivery reconciled by obligation handoff receipt; obligation remains open",
                }
              : {}),
          },
          w.revision,
        );
      }
      return next;
    });
  }
}
