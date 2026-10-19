import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WakeTrigger = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), at: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("job"), key: z.string().min(1).max(160) }),
  z.object({ kind: z.literal("turn"), agentId: z.string().min(1), turnId: z.string().min(1) }),
]);
export const WakeInput = z
  .object({
    key: z.string().min(1).max(160),
    roomId: z.string().min(1),
    ownerId: z.string().min(1),
    reason: z.string().trim().min(1).max(2000),
    obligationKey: z.string().min(1).max(160).optional(),
    trigger: WakeTrigger,
    delivery: z.enum(["pull", "idle"]).default("pull"),
    everyMs: z
      .number()
      .int()
      .min(60000)
      .max(30 * 86400000)
      .optional(),
    maxRuns: z.number().int().min(1).max(100).default(1),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.obligationKey && v.delivery !== "pull")
      ctx.addIssue({
        code: "custom",
        message: "Obligation wakeups require pull: this native API has no atomic idle-only send",
      });
    if (v.everyMs && (v.trigger.kind !== "time" || v.maxRuns < 2))
      ctx.addIssue({ code: "custom", message: "Repeats need a time trigger and maxRuns >= 2" });
    if (!v.everyMs && v.maxRuns !== 1) ctx.addIssue({ code: "custom", message: "maxRuns requires everyMs" });
  });
export const WakeRecord = z.object({
  key: z.string(),
  roomId: z.string(),
  ownerId: z.string(),
  reason: z.string(),
  obligationKey: z.string().optional(),
  trigger: WakeTrigger,
  delivery: z.enum(["pull", "idle"]),
  everyMs: z.number().optional(),
  maxRuns: z.number(),
  expiresAt: z.number(),
  inputHash: z.string(),
  revision: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: z.enum([
    "scheduled",
    "pending",
    "dispatching",
    "delivered",
    "acknowledged",
    "canceled",
    "expired",
    "uncertain",
  ]),
  note: z.string().nullable(),
  runs: z.number(),
  dueAt: z.number(),
  jobIdentity: z.string().optional(),
  jobRevision: z.number().optional(),
  messageId: z.string().nullable(),
  lastSentAt: z.number().nullable(),
});
export type WakeRecordValue = z.infer<typeof WakeRecord>;
export const wakeList = defineRpc({ name: "wakeups.list", input: z.object({}), output: z.array(WakeRecord) });
export const wakeAdd = defineRpc({ name: "wakeups.add", input: WakeInput, output: WakeRecord });
export const wakeTake = defineRpc({
  name: "wakeups.take",
  input: z.object({ ownerId: z.string() }),
  output: z.array(WakeRecord),
});
export const wakeAction = defineRpc({
  name: "wakeups.action",
  input: z.object({
    key: z.string(),
    ownerId: z.string(),
    revision: z.number().int().positive(),
    action: z.enum(["ack", "cancel", "owner"]),
    nextOwnerId: z.string().optional(),
  }),
  output: WakeRecord,
});
