import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "@getpaseo/client";
import { type AutonomyState, pauseKind } from "../shared/autonomy";
import { blockedOn } from "../shared/obligations";
import { responsibleOwner } from "../shared/operations";
import type { RoomStore } from "./store";
import type { Wakeups } from "./wakeups";

/** Assignment policy only. Paseo remains the sole agent runtime and prompt transport. */
export class Autonomy {
  private running?: Promise<void>;
  private stopped = false;
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
    // Pause provenance describes only a current pause.
    if (next.phase !== "paused") {
      next.pausedBy = undefined;
      next.pausedAt = undefined;
    }
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
    const key = options.obligationKey ?? prior?.obligationKey;
    if (key) {
      const obligation = this.store.obligations().find((o) => o.key === key);
      if (!obligation || obligation.ownerId !== id || obligation.state !== "open")
        throw new Error("Autonomy requires an open obligation owned by this agent");
      if (prior?.obligationKey && prior.obligationKey !== key)
        throw new Error("A managed assignment cannot switch obligations; hand off or close it first");
    }
    if (prior) {
      if (prior.phase === "archived") throw new Error("Archived assignments need explicit native reopening");
      if (prior.delivery === "uncertain" || prior.delivery === "dispatching")
        throw new Error("Reconcile uncertain delivery with a checkpoint before restarting");
      return this.save(prior, {
        phase: "active",
        reason: "Assignment resumed",
        retries: 0,
        continuations: 0,
        pausedBy: undefined,
        pausedAt: undefined,
        ...options,
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
    return this.save(r, {
      phase,
      reason,
      delivery: "none",
      messageId: null,
      dueAt: this.now() + 15000,
      pausedBy: phase === "paused" ? "checkpoint" : undefined,
      pausedAt: phase === "paused" ? this.now() : undefined,
    });
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
    // An explicitly started turn reopens a prior handback. A turn sent after a cancellation is
    // the resume; checkpoint and handoff pauses still need an explicit autonomy start.
    const resumed = pauseKind(r) === "cancel";
    this.save(r, {
      turnId,
      outcome: null,
      delivery: "none",
      messageId: null,
      phase: ["review", "archived"].includes(r.phase) || resumed ? "active" : r.phase,
      ...(resumed ? { reason: "Resumed after cancellation", pausedBy: undefined, pausedAt: undefined } : {}),
    });
  }
  ended(id: string, turnId: string | null, outcome: string) {
    const r = this.get(id);
    if (!r || (r.turnId && r.turnId !== turnId)) return;
    if (r.outcome === outcome && r.turnId === turnId) return;
    let phase = r.phase;
    if (outcome === "canceled") phase = "paused";
    if (outcome === "failed" && phase !== "paused") phase = r.retries >= r.maxRetries ? "blocked" : "active";
    this.save(r, {
      turnId,
      outcome,
      phase,
      ...(outcome === "canceled" ? { pausedBy: "cancel" as const, pausedAt: this.now() } : {}),
      delivery: "none",
      messageId: null,
      reason:
        outcome === "canceled"
          ? "Turn canceled; explicit resume required"
          : outcome === "failed" && phase === "blocked"
            ? "Retry budget exhausted"
            : r.reason,
      dueAt: this.now() + (outcome === "failed" ? 30000 * 2 ** r.retries : 15000),
    });
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
  private async round(api: PaseoApi) {
    const errors: unknown[] = [];
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
        const live = await ref.refresh().catch(() => null);
        if (this.stopped || this.get(r.agentId)?.revision !== r.revision || !live) continue;
        if (live.agent.archivedAt) {
          this.save(r, { phase: "archived" });
          continue;
        }
        // Hooks are best effort. Retained turn records recover missed scheduler callbacks.
        if (member.lastOutcome && member.lastTurnId === r.turnId && !r.outcome) {
          this.ended(r.agentId, r.turnId, member.lastOutcome);
          r = this.get(r.agentId) ?? r;
        }
        if (live.agent.pendingPermissions?.length) continue;
        const owner = responsibleOwner(member);
        if (
          owner &&
          this.store.member(owner) &&
          r.turnId &&
          r.outcome &&
          ["review", "blocked"].includes(r.phase) &&
          member.decision !== "accepted"
        ) {
          const key =
            "auto-review-" +
            createHash("sha256")
              .update(`${r.agentId}:${r.turnId}:${owner}:${r.phase}`)
              .digest("hex")
              .slice(0, 32);
          if (!this.wakes.list().some((w) => w.key === key))
            this.wakes.add({
              key,
              roomId: member.roomId,
              ownerId: owner,
              reason: `Review ${r.agentId}: ${r.reason.slice(0, 1000)}. Read ${member.resultPath ?? member.assignment}. Accept with evidence, request rework, or resolve the blocker.`,
              trigger: { kind: "turn", agentId: r.agentId, turnId: r.turnId },
              delivery: "idle",
            });
        }
        if (
          (r.phase !== "active" && !(r.phase === "waiting" && r.obligationKey)) ||
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
        if (r.phase === "waiting" && !obligation?.conditions.length) continue;
        // Only known failed runs may recover from error/closed. Never resurrect a canceled or archived agent.
        const retry = r.outcome === "failed";
        if (live.agent.status !== "idle" && !(retry && ["error", "closed"].includes(live.agent.status)))
          continue;
        if ((retry && r.retries >= r.maxRetries) || (!retry && r.continuations >= r.maxContinuations)) {
          this.save(r, { phase: "blocked", reason: "Autonomous run budget exhausted" });
          continue;
        }
        const messageId = randomUUID();
        const claimed = this.save(r, {
          phase: "active",
          delivery: "dispatching",
          messageId,
          retries: r.retries + (retry ? 1 : 0),
          continuations: r.continuations + (retry ? 0 : 1),
        });
        try {
          await ref.send(
            `Alliance ${retry ? "retry after failed turn" : "continue assignment"} [${messageId}]. Read ${obligation?.assignment ?? member.assignment} and prior results before acting. ${r.reason}\n${obligation ? `Obligation ${obligation.key}, revision ${obligation.revision}: ${obligation.nextAction}. Recover current policy and obligation evidence before dependent effects.\n` : ""}Own the next concrete step. Preserve completed effects. Before ending, use alliance-work autonomy checkpoint --phase active|waiting|review|blocked|paused --reason TEXT. Use review only when a checked handback is ready; waiting when a dependency must finish. This is not acceptance.`,
            { messageId, activeTurnBehavior: "steer" },
          );
          const latest = this.get(r.agentId);
          if (latest?.revision === claimed.revision) this.save(latest, { delivery: "sent" });
        } catch {
          const latest = this.get(r.agentId);
          if (latest?.revision === claimed.revision)
            this.save(latest, {
              delivery: "uncertain",
              reason: "Native delivery outcome unknown; inspect history before checkpoint/resume",
            });
        }
      } catch (error) {
        // One bad obligation must not starve other agents in this sweep.
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Autonomy sweep incomplete; state retained");
  }
}
