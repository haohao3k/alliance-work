import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { Difficulty, ModelPolicy } from "./model-policy";

export const Role = z.enum(["hq", "supervisor", "lead", "peer", "lens"]);
export const Harness = z.enum(["codex", "claude", "pi"]);
export const settings = defineSettings({
  id: "alliance",
  scope: "host",
  version: 1,
  schema: z.object({ home: z.string().default("") }),
});
export const Room = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  workspaceId: z.string(),
  mission: z.string(),
  artifacts: z.string(),
  createdAt: z.string(),
});
export const Acceptance = z.object({
  decision: z.enum(["accepted", "rejected"]),
  kind: z.string().nullable(),
  candidate: z.string(),
  target: z.string().nullable(),
  at: z.string(),
  evidence: z.string(),
});
export const Job = z.object({
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
  id: z.string(),
  roomId: z.string(),
  role: Role,
  provider: z.string(),
  title: z.string(),
  model: z.string().nullable(),
  updatedAt: z.string().nullable(),
  archived: z.boolean(),
  parentId: z.string().nullable(),
  assignment: z.string(),
  lastOutcome: z.string().nullable(),
  resultPath: z.string().nullable(),
  decision: z.enum(["open", "accepted", "rejected"]),
  decisionEvidence: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  ownerId: z.string().nullable(),
  ownerLabel: z.string(),
  ownerStatus: z.string(),
  lastAcceptance: Acceptance.nullable(),
});
export const roomList = defineRpc({
  name: "rooms.list",
  input: z.object({}),
  output: z.object({ rooms: z.array(Room), members: z.array(Member), jobs: z.array(Job) }),
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
  output: z.object({ policy: ModelPolicy, revision: z.number().int() }),
});
export const roomModelPolicySave = defineRpc({
  name: "models.save",
  input: z.object({ roomId: z.string(), policy: ModelPolicy, revision: z.number().int().nonnegative() }),
  output: roomModelPolicy.output,
});
export const roomModelCatalog = defineRpc({
  name: "models.catalog",
  input: z.object({ roomId: z.string(), harness: Harness, role: Role }),
  output: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string(), efforts: z.array(z.string()) })),
  }),
});
export const memberResume = defineRpc({
  name: "members.resume",
  input: z.object({ agentId: z.string(), prompt: z.string().min(1).max(100000) }),
  output: z.object({ sent: z.literal(true) }),
});
export const memberDisposition = defineRpc({
  name: "members.disposition",
  input: z.object({
    agentId: z.string(),
    decision: z.enum(["accepted", "rejected"]),
    candidate: z.string().min(1),
    evidence: z.string().min(1),
  }),
  output: z.object({ saved: z.literal(true) }),
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
