import { z } from "zod";

export const IntegrationDigest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Id = z.string().min(1).max(200);
const Reason = z.string().trim().min(1).max(2000);
export const OutputPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes("\\") &&
      ![...path].some((character) => character.charCodeAt(0) < 32) &&
      !path.startsWith("/") &&
      !path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git"),
    "Expected a relative file path without traversal or .git",
  );
export const IntegrationArtifact = z
  .object({ path: z.string().min(1).max(4096), digest: IntegrationDigest })
  .strict();
export const OutputFingerprint = z
  .object({
    path: OutputPath,
    kind: z.enum(["file", "symlink", "absent"]),
    digest: IntegrationDigest.nullable(),
    executable: z.boolean(),
  })
  .strict()
  .refine((value) => (value.kind === "absent") === (value.digest === null), "Missing output fingerprint");
export const Contribution = z
  .object({
    version: z.literal(1),
    source: z.enum(["git", "inputs"]),
    base: Commit.nullable(),
    head: Commit.nullable(),
    committed: z.boolean(),
    outputs: z.array(OutputFingerprint).max(2000),
  })
  .strict();
const BoundChild = { agentId: Id, candidate: IntegrationDigest };
const Paths = z
  .array(z.object({ source: OutputPath, target: OutputPath }).strict())
  .min(1)
  .max(2000);
export const IntegrationPlan = z
  .object({
    version: z.literal(1),
    children: z
      .array(
        z.discriminatedUnion("method", [
          z.object({ ...BoundChild, method: z.literal("merge") }).strict(),
          z
            .object({
              ...BoundChild,
              method: z.literal("squash"),
              landedHead: Commit,
              reason: Reason,
              paths: Paths.optional(),
            })
            .strict(),
          z
            .object({
              ...BoundChild,
              method: z.literal("cherry-pick"),
              landedHead: Commit,
              reason: Reason,
              paths: Paths.optional(),
            })
            .strict(),
          z.object({ ...BoundChild, method: z.literal("files"), reason: Reason, paths: Paths }).strict(),
          z
            .object({
              ...BoundChild,
              method: z.literal("review"),
              reason: Reason,
              artifacts: z.array(IntegrationArtifact).min(1).max(50),
            })
            .strict(),
        ]),
      )
      .max(128)
      .default([]),
    supersessions: z
      .array(
        z
          .object({
            ...BoundChild,
            path: OutputPath,
            byAgentId: Id,
            byCandidate: IntegrationDigest,
            reason: Reason,
          })
          .strict(),
      )
      .max(2000)
      .default([]),
  })
  .strict();
export const Contributor = z
  .object({
    agentId: Id,
    decisionEvidence: z.string().max(4096).nullable(),
    decisionAt: z.string().nullable(),
    decisionTurnId: z.string().nullable(),
    lastTurnId: z.string().nullable(),
    parentId: Id.nullable(),
    ownerId: Id.nullable(),
  })
  .strict();
export const IntegrationProof = z
  .object({
    version: z.literal(1),
    candidate: z.object({ cwd: z.string(), head: z.string().nullable(), digest: IntegrationDigest }).strict(),
    contributors: z.array(Contributor).min(1).max(128),
    contributorsStamp: IntegrationDigest,
    plan: IntegrationPlan,
    artifacts: z.array(IntegrationArtifact).max(20000),
  })
  .strict();
