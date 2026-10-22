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
    // Omitted: see defaultDelivery. Wakeups.add fills it in so the input hash matches an explicit value.
    delivery: z.enum(["pull", "idle"]).optional(),
    everyMs: z
      .number()
      .int()
      .min(60000)
      .max(30 * 86400000)
      .optional(),
    maxRuns: z.number().int().min(1).max(100).default(1),
    expiresAt: z.number().int().nonnegative().optional(),
    /** Grace from now before the reminder can become due, whatever its trigger. */
    delayMs: z.number().int().min(0).max(86400000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.obligationKey && v.delivery === "idle")
      ctx.addIssue({
        code: "custom",
        message: "Obligation wakeups require pull: this native API has no atomic idle-only send",
      });
    if (v.everyMs && (v.trigger.kind !== "time" || v.maxRuns < 2))
      ctx.addIssue({ code: "custom", message: "Repeats need a time trigger and maxRuns >= 2" });
    if (!v.everyMs && v.maxRuns !== 1) ctx.addIssue({ code: "custom", message: "maxRuns requires everyMs" });
  });
/** A reminder wakes its idle owner unless it asks for pull; obligation reminders are pull-only. */
export const defaultDelivery = (input: { obligationKey?: string }) =>
  input.obligationKey ? ("pull" as const) : ("idle" as const);
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
  /** Times the owner deferred this reminder (wakeups defer). */
  defers: z.number().optional(),
});
export type WakeRecordValue = z.infer<typeof WakeRecord>;
/** The reminder still asks its owner: it will be pushed, or it was sent. A pending pull item never is. */
export const asking = (w: Pick<WakeRecordValue, "state" | "delivery">) =>
  !["acknowledged", "canceled", "expired"].includes(w.state) &&
  (w.delivery === "idle" || w.state === "delivered" || w.state === "uncertain");
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
    action: z.enum(["ack", "cancel", "owner", "defer"]),
    nextOwnerId: z.string().optional(),
    /** defer: the reminder is due again after this many minutes. */
    minutes: z.number().int().min(1).max(1440).optional(),
  }),
  output: WakeRecord,
});
