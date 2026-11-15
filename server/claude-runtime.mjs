import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { processIdentity } from "./jobs.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

function receiptPath(home, agentId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) throw new Error("Invalid native agent identity");
  return join(home, "claude-runtimes", `${agentId}.json`);
}
export async function recordClaudeRuntime(home, agentId, account, pid) {
  const path = receiptPath(home, agentId);
  await assertNoLinks(path);
  await mkdir(join(home, "claude-runtimes"), { recursive: true, mode: 0o700 });
  const identity = await processIdentity(pid);
  if (!identity) return;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ account, pid, identity }), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function currentClaudeAccount(home, agentId, probe = processIdentity) {
  try {
    const path = receiptPath(home, agentId);
    await assertNoLinks(path);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (!["legacy", "5x", "20x"].includes(receipt.account)) return null;
    return (await probe(receipt.pid)) === receipt.identity ? receipt.account : null;
  } catch {
    return null; // Missing/legacy receipt, exited/reused PID or failed probe is not proof of an account.
  }
}

/** Reporting ownership alone is not process dependency. Unknown ancestry remains a veto. */
export async function jobBlocksClaudeSwitch(home, agentId, job) {
  if (job.state === "exited") return false;
  if (job.state !== "running") return true;
  try {
    const path = receiptPath(home, agentId);
    await assertNoLinks(path);
    const runtime = JSON.parse(await readFile(path, "utf8"));
    if (!runtime.identity || (await processIdentity(runtime.pid)) !== runtime.identity) return true;
    let pid = job.pid;
    const seen = new Set();
    while (pid > 1) {
      if (pid === runtime.pid || seen.has(pid)) return true;
      seen.add(pid);
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } else {
        const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "ppid="], {
          timeout: 3000,
        });
        if (!/^\s*\d+\s*$/.test(stdout)) return true;
        pid = Number(stdout.trim());
      }
      if (!Number.isSafeInteger(pid) || pid < 0) return true;
    }
    return (
      (await processIdentity(runtime.pid)) !== runtime.identity ||
      (await processIdentity(job.pid)) !== job.processIdentity
    );
  } catch {
    return true;
  }
}
