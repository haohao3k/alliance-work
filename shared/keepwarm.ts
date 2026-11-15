import { z } from "zod";
import type { WakeRecordValue } from "./wakeups";

export const KeepWarmPolicy = z.object({
  enabled: z.boolean().default(false),
  maxPings: z.number().int().min(1).max(5).default(3),
  minCtx: z.number().int().min(60000).default(60000),
  disabledAt: z.number().optional(),
  disabledReason: z.string().optional(),
});
export type KeepWarmPolicyValue = z.infer<typeof KeepWarmPolicy>;
export const WarmState = z.object({
  idleSince: z.number(),
  pings: z.number().int(),
  lastAt: z.number(),
  lastAttemptAt: z.number().optional(),
  messageIds: z.array(z.string()),
  model: z.string(),
  effort: z.string().nullable(),
  account: z.string(),
  pending: z
    .object({
      messageId: z.string(),
      at: z.number(),
      turnId: z.string().nullable().optional(),
      startedAt: z.number().optional(),
      contextTokens: z.number().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type WarmState = z.infer<typeof WarmState>;

export const warmKey = (key: string) => key.startsWith("warm-");
export const pluginNotice = (key: string) => /^(?:warm|quota|silent|permission|signin)-/.test(key);
/** Short quota notices need no action while the member retries itself; actionable notices never wait. */
export const warmCompanion = (w: WakeRecordValue) =>
  /^quota-/.test(w.key) &&
  w.trigger.kind === "time" &&
  !w.failure &&
  !w.retries &&
  w.expiresAt - w.dueAt <= 2 * 3600000;
