import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { observeJob } from "./jobs.mjs";
import { decisionChain } from "./lifecycle";
import type { RoomStore } from "./store";

type Identity = { key: string; revision: number; actorId: string | null };
function current(store: RoomStore, input: Identity) {
  const job = store.job(input.key);
  if (!job || job.revision !== input.revision) throw new Error("Job changed; refresh before updating");
  if (
    input.actorId !== null &&
    input.actorId !== job.ownerId &&
    !decisionChain(store, job.ownerId).includes(input.actorId)
  )
    throw new Error("Only the job owner chain or Human may settle/archive this job");
  return job;
}
export async function settleJob(
  store: RoomStore,
  input: Identity & {
    outcome: "succeeded" | "failed" | "superseded" | "unverified";
    reason: string;
    evidence: string;
  },
) {
  const job = current(store, input);
  if (job.archivedAt) throw new Error("Restore the job before changing its result");
  if (!isAbsolute(input.evidence)) throw new Error("Evidence requires an absolute path");
  const bytes = await readFile(input.evidence);
  const parsed = JSON.parse(bytes.toString());
  const proof = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const expected = {
    key: job.key,
    pid: job.pid,
    processIdentity: job.processIdentity,
    outcome: input.outcome,
    reason: input.reason,
  };
  const mismatched = Object.entries(expected)
    .filter(([field, value]) => proof[field] !== value || (field === "reason" && !proof.reason))
    .map(([field]) => field);
  if (mismatched.length)
    throw new Error(
      `Evidence must bind job key, PID, process identity, outcome and reason; mismatched fields: ${mismatched.join(", ")}`,
    );
  if (input.outcome !== "unverified" && (!Array.isArray(proof.artifacts) || !proof.artifacts.length))
    throw new Error("Verified outcomes require artifact hashes");
  for (const artifact of proof.artifacts ?? []) {
    if (
      !isAbsolute(artifact.path) ||
      createHash("sha256")
        .update(await readFile(artifact.path))
        .digest("hex") !== artifact.sha256
    )
      throw new Error("Evidence artifact changed");
  }
  if ((await observeJob(job)).state !== "exited") throw new Error("Running or unknown job cannot be settled");
  current(store, input);
  store.saveJob(
    {
      ...job,
      settlementHistory: job.settlement
        ? [...(job.settlementHistory ?? []), job.settlement]
        : job.settlementHistory,
      settlement: {
        outcome: input.outcome,
        reason: input.reason,
        evidence: input.evidence,
        digest: createHash("sha256").update(bytes).digest("hex"),
        at: new Date().toISOString(),
        actorId: input.actorId,
      },
      revision: job.revision + 1,
    },
    job.revision,
  );
  return { saved: true as const };
}
export async function archiveJob(store: RoomStore, input: Identity & { archive: boolean }) {
  const job = current(store, input);
  if (input.archive) {
    if (!job.settlement)
      throw new Error("Record a result, including unverified when necessary, before archive");
    if (
      createHash("sha256")
        .update(await readFile(job.settlement.evidence))
        .digest("hex") !== job.settlement.digest
    )
      throw new Error("Settlement evidence changed");
    if ((await observeJob(job)).state !== "exited")
      throw new Error("Running or unknown job cannot be archived");
  }
  current(store, input);
  store.saveJob(
    { ...job, archivedAt: input.archive ? new Date().toISOString() : undefined, revision: job.revision + 1 },
    job.revision,
  );
  return { saved: true as const };
}
