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
    maxRetries: z.number().int().min(0).max(5).default(2),
    maxContinuations: z.number().int().min(1).max(100).default(20),
    autoArchive: z.boolean().default(true),
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
