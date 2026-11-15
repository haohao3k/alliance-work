import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { AutonomyRecord } from "./autonomy";
import { IntegrationPlan } from "./integration.mjs";
import { KeepWarmPolicy, WarmState } from "./keepwarm";
import { Difficulty, ModelPolicy } from "./model-policy";
import { ObligationRecord } from "./obligations";
import { WakeRecord } from "./wakeups";

export const Role = z.enum(["hq", "supervisor", "lead", "peer", "lens"]);
export const Harness = z.enum(["codex", "claude", "pi", "agy"]);
export const settings = defineSettings({
  id: "alliance",
  scope: "host",
  version: 1,
  schema: z.object({ home: z.string().default("") }),
});
export const Room = z.object({
  nativeTitle: z.string().optional(),
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  workspaceId: z.string(),
  mission: z.string(),
  artifacts: z.string(),
  createdAt: z.string(),
});
export const ProductAcceptance = z.object({
  outcome: z.string().trim().min(1).max(2000),
  journey: z.string().trim().min(1).max(4000),
  reviewer: z.string().trim().min(1).max(200),
  remaining: z.array(z.string().trim().min(1).max(2000)).max(30),
});
export const Acceptance = z.object({
  decision: z.enum(["accepted", "rejected"]),
  kind: z.string().nullable(),
  candidate: z.string(),
  target: z.string().nullable(),
  at: z.string(),
  evidence: z.string(),
  product: ProductAcceptance.optional(),
});
export const Job = z.object({
  settlementHistory: z.array(z.unknown()).optional(),
  settlement: z
    .object({
      outcome: z.enum(["succeeded", "failed", "superseded", "unverified"]),
      reason: z.string(),
      evidence: z.string(),
      digest: z.string(),
      at: z.string(),
      actorId: z.string().nullable(),
    })
    .optional(),
  archivedAt: z.string().optional(),
  key: z.string(),
  roomId: z.string(),
  ownerId: z.string(),
  title: z.string(),
  pid: z.number().int(),
  processIdentity: z.string(),
  recordedAt: z.string(),
  revision: z.number().int(),
  state: z.enum(["running", "exited", "unknown"]),
  observationError: z.string().nullable(),
  ownerLabel: z.string(),
  ownerStatus: z.string(),
});
export const Member = z.object({
  warm: WarmState.optional(),
  id: z.string(),
  roomId: z.string(),
  role: Role,
  provider: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  selectedModel: z.string().nullable().optional(),
  runtimeModel: z.string().nullable().optional(),
  updatedAt: z.string().nullable(),
  archived: z.boolean(),
  parentId: z.string().nullable(),
  assignment: z.string(),
  lastOutcome: z.string().nullable(),
  lastTurnId: z.string().nullable(),
  turnWake: z
    .object({
      turnId: z.string().nullable(),
      time: z.number(),
      source: z.string(),
      promptId: z.string().optional(),
    })
    .optional(),
  resultPath: z.string().nullable(),
  decision: z.enum(["open", "accepted", "rejected"]),
  decisionEvidence: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerLabel: z.string(),
  ownerStatus: z.string(),
  ownerRevision: z.number().int(),
  ownerEvidence: z.string().nullable(),
  policyDigest: z.string(),
  policyAcknowledged: z.boolean(),
  lastAcceptance: Acceptance.nullable(),
  // "Human" or the deciding agent ID; absent for decisions recorded before v0.1.16.
  decisionBy: z.string().optional(),
  decisionScope: z.enum(["technical", "product"]).nullable(),
  // Its running turn has been quiet since `since`; key: the owner's notice, null when none is woken.
  silence: z
    .object({
      turnId: z.string().nullable(),
      since: z.string(),
      key: z.string().nullable(),
      notifiedAt: z.string().nullable(),
    })
    .optional(),
  // Its provider is signed out: Alliance sends it nothing by itself until `until` (0: not held yet).
  signIn: z
    .object({
      since: z.number(),
      lastAt: z.number(),
      failures: z.number().int(),
      holds: z.number().int(),
      until: z.number(),
      reason: z.string(),
    })
    .optional(),
  // The last approval request Alliance denied for it: nobody approves commands for members.
  denied: z
    .object({ requestId: z.string(), tool: z.string(), command: z.string().nullable(), at: z.string() })
    .optional(),
  lifecycle: z.object({
    state: z.enum(["archived", "archivable", "held", "awaiting-decision", "rejected"]),
    blockers: z.array(z.string()),
    /** Overdue work only the Human can move; absent otherwise. */
    needsHuman: z.object({ since: z.string(), ageHours: z.number(), reason: z.string() }).optional(),
  }),
});
export const roomList = defineRpc({
  name: "rooms.list",
  input: z.object({}),
  output: z.object({
    rooms: z.array(Room),
    modelPolicyWarnings: z
      .array(
        z.object({
          roomId: z.string(),
          revision: z.number().int().optional(),
          role: z.string().optional(),
          harness: z.string().optional(),
          model: z.string().optional(),
          reason: z.string(),
        }),
      )
      .optional(),
    keepwarm: z.array(KeepWarmPolicy.extend({ roomId: z.string(), revision: z.number().int() })).optional(),
    members: z.array(Member),
    jobs: z.array(Job),
    autonomy: z.array(AutonomyRecord),
    wakeups: z.array(WakeRecord),
    obligations: z.array(
      ObligationRecord.safeExtend({
        blockedOn: z.array(z.string()),
        ownerStatus: z.string(),
        ownerLabel: z.string(),
      }),
    ),
    wakeupHealth: z.object({
      checkedAt: z.string().nullable(),
      error: z.string().nullable(),
      // The daemon the scheduler last connected to; null before its first connection.
      daemon: z
        .object({ version: z.string().nullable(), agentMessageProvenance: z.boolean() })
        .nullable()
        .optional(),
    }),
    /** Members still open, counted by why: `held` has one count per cause (a member may have several). */
    lifecycleSummary: z
      .object({
        awaitingDecision: z.number(),
        needsHuman: z.number(),
        rejected: z.number(),
        held: z.record(z.string(), z.number()),
      })
      .optional(),
  }),
});
export const roomCreate = defineRpc({
  name: "rooms.create",
  input: z.object({
    title: z.string().trim().max(160).default(""),
    cwd: z.string().min(1),
    mission: z.string().trim().max(50000).default(""),
  }),
  output: Room,
});
export const directoryList = defineRpc({
  name: "directories.list",
  input: z.object({ query: z.string().max(4096) }),
  output: z.object({ current: z.string().nullable(), parent: z.string(), paths: z.array(z.string()) }),
});
export const memberLaunch = defineRpc({
  name: "members.launch",
  input: z.object({
    roomId: z.string(),
    key: z.string().min(1).max(160),
    role: Role,
    harness: Harness,
    model: z.string().min(1).optional(),
    prompt: z.string().min(1).max(100000),
    thinking: z.string().optional(),
    mode: z.string().optional(),
    difficulty: Difficulty.optional(),
  }),
  output: z.object({ agentId: z.string() }),
});
export const roomModelPolicy = defineRpc({
  name: "models.read",
  input: z.object({ roomId: z.string() }),
  // saved=false: the room follows the release defaults (never saved, or reset by the Human).
  output: z.object({ policy: ModelPolicy, revision: z.number().int(), saved: z.boolean() }),
});
export const roomKeepwarm = defineRpc({
  name: "keepwarm.read",
  input: z.object({ roomId: z.string() }),
  output: KeepWarmPolicy.extend({ revision: z.number().int() }),
});
export const roomKeepwarmSave = defineRpc({
  name: "keepwarm.save",
  input: z.object({
    roomId: z.string(),
    enabled: z.boolean(),
    actorId: z.string().nullable(),
    maxPings: z.number().int().min(1).max(5).optional(),
  }),
  output: roomKeepwarm.output,
});
export const roomModelPolicySave = defineRpc({
  name: "models.save",
  input: z.object({ roomId: z.string(), policy: ModelPolicy, revision: z.number().int().nonnegative() }),
  output: roomModelPolicy.output,
});
export const roomModelPolicyReset = defineRpc({
  name: "models.reset",
  // The Models page passes the revision it shows; the Human's CLI resets unconditionally.
  input: z.object({ roomId: z.string(), revision: z.number().int().nonnegative().optional() }),
  // removed: the deleted saved list, kept raw in rooms.sqlite table room_model_policy_removed.
  output: roomModelPolicy.output.extend({
    removed: z.object({ id: z.number().int(), revision: z.number().int(), at: z.string() }).optional(),
  }),
});
export const roomModelCatalog = defineRpc({
  name: "models.catalog",
  input: z.object({
    roomId: z.string(),
    harness: Harness,
    role: Role,
    scope: z.enum(["project", "global"]).optional(),
  }),
  output: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()) })),
  }),
});
export const memberResume = defineRpc({
  name: "members.resume",
  input: z.object({ agentId: z.string(), prompt: z.string().min(1).max(100000) }),
  output: z.object({ sent: z.literal(true) }),
});
export const HumanDecisionSource = z.object({
  messageId: z.string().trim().min(1).max(500),
  timestamp: z.iso.datetime(),
});
export const memberDisposition = defineRpc({
  name: "members.disposition",
  input: z.object({
    agentId: z.string(),
    decision: z.enum(["accepted", "rejected"]),
    candidate: z.string().min(1),
    evidence: z.string().min(1),
    product: ProductAcceptance.optional(),
    integration: IntegrationPlan.optional(),
    analysisRoot: z.string().min(1).optional(),
    // null identifies no actor. Agents pass their PASEO_AGENT_ID; the plugin enforces the owner chain.
    // Absent only from CLIs older than 0.1.16, which the plugin refuses with the current command.
    actorId: z.string().min(1).nullable().optional(),
    /** HQ attests Human authorization using an exact message in its native transcript. */
    forHuman: z.boolean().optional(),
    source: HumanDecisionSource.optional(),
    /** accept: keep the agent open after acceptance (a keep by the same decider is otherwise lifted). */
    keep: z.boolean().optional(),
    /** reject: the rework prompt delivered to the child with the rejection. */
    rework: z.string().trim().min(1).max(100000).optional(),
  }),
  output: z.object({
    saved: z.literal(true),
    authorizedBy: z.literal("Human").optional(),
    source: HumanDecisionSource.optional(),
    keepLifted: z.literal(true).optional(),
    settledWakeups: z.array(z.string()).optional(),
    rework: z.object({ sent: z.boolean(), error: z.string().optional() }).optional(),
  }),
});
export const profileStatus = defineRpc({
  name: "profiles.status",
  input: z.object({}),
  output: z.object({
    home: z.string(),
    profiles: z.array(z.object({ id: z.string(), home: z.string(), skills: z.number() })),
  }),
});
export type RoomRecord = z.infer<typeof Room>;
export type RoleName = z.infer<typeof Role>;

export const jobTrack = defineRpc({
  name: "jobs.track",
  input: z.object({
    key: z.string().min(1).max(160),
    roomId: z.string(),
    ownerId: z.string(),
    title: z.string().min(1).max(200),
    pid: z.number().int().min(2),
  }),
  output: z.object({ saved: z.literal(true) }),
});
export const jobOwner = defineRpc({
  name: "jobs.owner",
  input: z.object({ key: z.string(), ownerId: z.string(), revision: z.number().int().positive() }),
  output: z.object({ saved: z.literal(true) }),
});

export const memberOwner = defineRpc({
  name: "members.owner",
  input: z.object({
    agentId: z.string(),
    ownerId: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    evidence: z.string().min(1),
  }),
  output: z.object({ saved: z.literal(true) }),
});
export const memberKeep = defineRpc({
  name: "members.keep",
  input: z.object({
    agentId: z.string(),
    keep: z.boolean(),
    actorId: z.string().min(1).nullable(),
    /** Why the agent stays open; shown wherever the keep holds its archive. */
    reason: z.string().trim().min(1).max(500).optional(),
    /** Lifetime of the keep; the plugin applies 24 hours when omitted. */
    hours: z.number().positive().max(720).optional(),
  }),
  output: z.object({ saved: z.literal(true) }),
});
export const policyRead = defineRpc({
  name: "policy.read",
  input: z.object({ agentId: z.string() }),
  output: z.object({
    digest: z.string(),
    text: z.string(),
    path: z.string(),
    acknowledged: z.boolean(),
    obligations: z.array(ObligationRecord.safeExtend({ blockedOn: z.array(z.string()) })),
  }),
});
export const policyAck = defineRpc({
  name: "policy.ack",
  input: z.object({ agentId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }),
  output: z.object({ saved: z.literal(true) }),
});

export const jobSettle = defineRpc({
  name: "jobs.settle",
  input: z.object({
    key: z.string(),
    revision: z.number().int().positive(),
    outcome: z.enum(["succeeded", "failed", "superseded", "unverified"]),
    reason: z.string().trim().min(1),
    evidence: z.string().min(1),
    actorId: z.string().nullable(),
  }),
  output: z.object({ saved: z.literal(true) }),
});
export const jobArchive = defineRpc({
  name: "jobs.archive",
  input: z.object({
    key: z.string(),
    revision: z.number().int().positive(),
    actorId: z.string().nullable(),
    archive: z.boolean(),
  }),
  output: z.object({ saved: z.literal(true) }),
});

export const maintenanceStatus = defineRpc({
  name: "maintenance.status",
  input: z.object({}),
  output: z.object({
    durablePause: z.literal(true),
    hold: z.unknown().nullable(),
    humanDecisionAttribution: z.literal(true).optional(),
  }),
});

export const maintenanceReconcile = defineRpc({
  name: "maintenance.reconcile",
  input: z.object({ holdId: z.string() }),
  output: z.object({
    restored: z.array(z.string()),
    alreadyRestored: z.boolean(),
    members: z.array(Member),
    autonomy: z.array(AutonomyRecord),
  }),
});
