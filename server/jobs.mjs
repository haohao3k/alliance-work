import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const psStart =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;
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
      // ps localizes lstart. A daemon/CLI with another locale must see the same process run.
      env: { ...process.env, LC_ALL: "C" },
    });
    const text = stdout.trim();
    if (!text) return null;
    const fields = text.split(/\s+/);
    const identity = fields.slice(0, 5).join(" ");
    if (fields.length !== 6 || !psStart.test(identity))
      throw new Error("Process start time could not be read");
    return /^[ZX]/.test(fields[5]) ? null : identity;
  } catch (error) {
    if (
      (process.platform === "linux" && error.code === "ENOENT") ||
      error.code === "ESRCH" ||
      error.code === 1
    )
      return null;
    throw error;
  }
}

export async function observeJob(job, probe = processIdentity) {
  try {
    const identity = await probe(job.pid);
    // Keep pre-fix localized records intact: unequal representations do not prove PID reuse.
    // If that PID disappears we can observe exit; otherwise its owner must reconcile the run.
    if (
      identity &&
      identity !== job.processIdentity &&
      psStart.test(identity) &&
      !psStart.test(job.processIdentity)
    )
      return {
        ...job,
        state: "unknown",
        observationError:
          "Recorded process locale is not comparable; reconcile the original run before tracking again",
      };
    return { ...job, state: identity === job.processIdentity ? "running" : "exited", observationError: null };
  } catch {
    return { ...job, state: "unknown", observationError: "Process state could not be read" };
  }
}
