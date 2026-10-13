import { appendFileSync } from "node:fs";

// Import this small adapter in a project-owned driver. The assertion callback must
// observe the real behavior; the recorder cannot judge the strength of that check.
function record(id, status, detail) {
  const path = process.env.ALLIANCE_ASSERTIONS;
  const run = process.env.ALLIANCE_ASSERTION_RUN;
  if (!path || !run) throw new Error("Run this driver through alliance-work verify/eval");
  appendFileSync(path, `${JSON.stringify({ run, id, status, detail })}\n`, { mode: 0o600 });
}
export async function check(id, assertion) {
  try {
    const result = await assertion();
    if (result === false) throw new Error("Assertion returned false");
  } catch (error) {
    record(id, "FAIL", error.message ?? String(error));
    throw error;
  }
  record(id, "PASS", "");
}
export function skip(id, reason) {
  if (!reason?.trim()) throw new Error("A skipped assertion needs a reason");
  record(id, "SKIP", reason);
}
export function blocked(id, reason) {
  if (!reason?.trim()) throw new Error("A blocked assertion needs a reason");
  record(id, "BLOCKED", reason);
}
