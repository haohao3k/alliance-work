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
