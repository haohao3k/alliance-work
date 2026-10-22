import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const Phase = z.enum(["active", "waiting", "review", "blocked", "paused", "archived"]);
export const AutonomyRecord = z.object({
  agentId: z.string(),
  obligationKey: z.string().min(1).max(160).optional(),
  phase: Phase,
  reason: z.string(),
  revision: z.number().int(),
  turnId: z.string().nullable(),
  outcome: z.string().nullable(),
  dueAt: z.number(),
  retries: z.number().int(),
  continuations: z.number().int(),
  maxRetries: z.number().int(),
  maxContinuations: z.number().int(),
  autoArchive: z.boolean(),
  // Why continuation stopped. A cancellation or handoff pause is lifted by a later turn or an
  // explicit acceptance; a checkpoint pause stays until the assignment is started again.
  pausedBy: z.enum(["cancel", "checkpoint", "handoff"]).optional(),
  pausedAt: z.number().optional(),
  delivery: z.enum(["none", "dispatching", "sent", "uncertain"]),
  messageId: z.string().nullable(),
  updatedAt: z.number(),
  /** The turn that was current at the latest checkpoint; a turn without one may be a handback. */
  checkpointTurnId: z.string().nullable().optional(),
  /** The due retry waits out a provider quota and does not use the retry budget. */
  quotaRetry: z.boolean().optional(),
  /** Quota waits in a row; at the cap the assignment is blocked for its owner instead. */
  quotaWaits: z.number().int().optional(),
  /**
   * Recorded only so an owned member's handbacks reach its owner: until `autonomy start` or an
   * `active` checkpoint makes it an assignment, it is never continued and is retried only at a
   * provider limit's reset.
   */
  handbackOnly: z.boolean().optional(),
  /** The plugin's own wake batch, sent at `at` with these reminders; the turn it starts is the plugin's. */
  wakeBatch: z.object({ at: z.number(), keys: z.array(z.string()) }).optional(),
  /** The current turn was started by a wake batch or by the agent itself: it keeps the phase it found. */
  wakeTurnId: z.string().nullable().optional(),
  /** The plugin's last continuation or retry, by message, and the budget it used. */
  charged: z.object({ messageId: z.string(), retry: z.boolean() }).optional(),
  /** Continuation turns since the last checkpoint that ended without one. */
  unchecked: z.number().int().optional(),
  /** The blocker its owner was asked about (hash of owner and reason) and that review's key. */
  blocker: z.object({ hash: z.string(), review: z.string() }).optional(),
});
export type AutonomyState = z.infer<typeof AutonomyRecord>;
export const autonomyList = defineRpc({
  name: "autonomy.list",
  input: z.object({}),
  output: z.array(AutonomyRecord),
});
export const autonomyStart = defineRpc({
  name: "autonomy.start",
  input: z.object({
    agentId: z.string(),
    obligationKey: z.string().min(1).max(160).optional(),
    // Omitted budgets keep the recorded values (2 retries, 20 continuations for a new one).
    maxRetries: z.number().int().min(0).max(5).optional(),
    maxContinuations: z.number().int().min(1).max(100).optional(),
    // Omitted: keep the recorded choice (true for a new assignment).
    autoArchive: z.boolean().optional(),
  }),
  output: AutonomyRecord,
});
export const autonomyCheckpoint = defineRpc({
  name: "autonomy.checkpoint",
  input: z.object({
    agentId: z.string(),
    phase: Phase.exclude(["archived"]),
    reason: z.string().trim().min(1).max(4000),
    turnId: z.string().optional(),
  }),
  output: AutonomyRecord,
});

const legacyCancel = "Turn canceled; explicit resume required";
/** Records written before pausedBy existed carry the cancellation only in their reason. */
export function pauseKind(r: Pick<AutonomyState, "phase" | "pausedBy" | "reason">) {
  if (r.phase !== "paused") return null;
  if (r.pausedBy) return r.pausedBy;
  if (r.reason === legacyCancel) return "cancel";
  return r.reason.startsWith("Obligation handed to ") ? "handoff" : "checkpoint";
}
