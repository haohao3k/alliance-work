import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A process PID greater than one is required");
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (["Z", "X"].includes(fields[0])) return null;
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      return `${boot}:${fields[19]}`;
    }
    const { stdout } = await execute("ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="], {
      timeout: 3000,
    });
    const text = stdout.trim();
    if (!text || /\sZ\S*$/.test(text)) return null;
    return text.split(/\s+/).slice(0, 5).join(" ");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || error.code === 1) return null;
    throw error;
  }
}

export async function observeJob(job, probe = processIdentity) {
  try {
    const identity = await probe(job.pid);
    return { ...job, state: identity === job.processIdentity ? "running" : "exited", observationError: null };
  } catch {
    return { ...job, state: "unknown", observationError: "Process state could not be read" };
  }
}
