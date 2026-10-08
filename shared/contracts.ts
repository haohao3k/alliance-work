import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

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
export const Member = z.object({
  id: z.string(),
  roomId: z.string(),
  role: Role,
  provider: z.string(),
  parentId: z.string().nullable(),
  assignment: z.string(),
  lastOutcome: z.string().nullable(),
  resultPath: z.string().nullable(),
  decision: z.enum(["open", "accepted", "rejected"]),
  decisionEvidence: z.string().nullable(),
  status: z.string(),
  error: z.string().nullable(),
});
export const roomList = defineRpc({
  name: "rooms.list",
  input: z.object({}),
  output: z.object({ rooms: z.array(Room), members: z.array(Member) }),
});
export const roomCreate = defineRpc({
  name: "rooms.create",
  input: z.object({
    title: z.string().trim().min(1).max(160),
    cwd: z.string().min(1),
    mission: z.string().trim().min(1).max(50000),
  }),
  output: Room,
});
export const memberLaunch = defineRpc({
  name: "members.launch",
  input: z.object({
    roomId: z.string(),
    key: z.string().min(1).max(160),
    role: Role,
    harness: Harness,
    model: z.string().min(1),
    prompt: z.string().min(1).max(100000),
    thinking: z.string().optional(),
    mode: z.string().optional(),
  }),
  output: z.object({ agentId: z.string() }),
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
