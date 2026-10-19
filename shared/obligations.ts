import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const text = z.string().trim().min(1).max(4000);
const key = z.string().trim().min(1).max(160);
export const Condition = z.object({ id: key, requires: text });
export const Receipt = z.object({
  path: text,
  digest: z.string(),
  at: z.number(),
});
export const Observation = z.object({
  conditionId: key,
  receipt: Receipt,
  validUntil: z.number().int().positive(),
});
export const ObligationInput = z
  .object({
    key,
    roomId: key,
    ownerId: key.nullable(),
    assignment: text,
    authority: text,
    nextAction: text,
    closeWhen: text,
    conditions: z.array(Condition).max(32).default([]),
  })
  .refine(
    (v) => new Set(v.conditions.map((c) => c.id)).size === v.conditions.length,
    "Duplicate condition ID",
  );
export const ObligationRecord = ObligationInput.safeExtend({
  revision: z.number().int().positive(),
  inputHash: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: z.enum(["open", "fulfilled", "canceled"]),
  observations: z.array(Observation),
  receipt: Receipt.nullable(),
});
export type Obligation = z.infer<typeof ObligationRecord>;
export const ObligationAction = z.object({
  key,
  ownerId: key.nullable(),
  revision: z.number().int().positive(),
  action: z.enum(["observe", "reconcile", "handoff", "fulfill", "cancel"]),
  evidence: text,
  conditionId: key.optional(),
  validUntil: z.number().int().positive().optional(),
  nextOwnerId: key.nullable().optional(),
  nextAction: text.optional(),
  authority: text.optional(),
  conditions: z.array(Condition).max(32).optional(),
});
export const obligationList = defineRpc({
  name: "obligations.list",
  input: z.object({ ownerId: key.nullable().optional() }),
  output: z.array(ObligationRecord.safeExtend({ blockedOn: z.array(z.string()) })),
});
export const obligationAdd = defineRpc({
  name: "obligations.add",
  input: ObligationInput,
  output: ObligationRecord,
});
export const obligationAction = defineRpc({
  name: "obligations.action",
  input: ObligationAction,
  output: ObligationRecord,
});
export const obligationHistory = defineRpc({
  name: "obligations.history",
  input: z.object({ key }),
  output: z.array(ObligationRecord),
});

// These are accountable, bounded observations, not automatic proof of external predicates.
export function blockedOn(o: Obligation, now: number): string[] {
  if (o.state !== "open") return [`Obligation ${o.state}`];
  return [
    ...(o.ownerId === null ? ["Human owns the next decision"] : []),
    ...o.conditions
      .filter((c) => !o.observations.some((v) => v.conditionId === c.id && v.validUntil > now))
      .map((c) => `${c.id}: ${c.requires}`),
  ];
}
