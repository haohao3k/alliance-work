import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { discoverCodex } from "./codex-discovery.mjs";
import { launchPlan } from "./launch.mjs";

async function response(plan, input) {
  const child = spawn(plan.executable, plan.args, {
    env: { ...plan.env, PI_OFFLINE: "1" },
    cwd: plan.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native skill discovery timed out")), 30000);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Native skill discovery exited ${code}`));
      });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === "control_response" || message.id === "skill-probe") {
          clearTimeout(timer);
          resolve(message);
        }
      });
      child.stdin.write(`${JSON.stringify(input)}\n`);
    });
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

// Real native registries, without a model turn or provider request.
export async function nativeSkillDiscovery(home, harness, role, cwd, extraArgs = []) {
  const args =
    harness === "claude"
      ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"]
      : harness === "pi"
        ? ["--mode", "rpc", "--no-session"]
        : ["app-server"];
  const plan = await launchPlan(
    home,
    `${harness}-${role}`,
    [...args, ...extraArgs],
    { PATH: process.env.PATH },
    cwd,
  );
  let names;
  if (harness === "codex") {
    const flags = [];
    for (let i = 0; i < plan.args.length; i++) if (plan.args[i] === "-c") flags.push("-c", plan.args[++i]);
    const discovered = await discoverCodex(plan.executable, plan.env, cwd, flags);
    names = discovered.skills.filter((s) => s.enabled).map((s) => s.name);
  } else if (harness === "claude") {
    const reply = await response(plan, {
      type: "control_request",
      request_id: "skill-probe",
      request: { subtype: "initialize" },
    });
    names = reply.response.response.commands.map((c) => c.name.replace(/^alliance-project:/, ""));
  } else if (harness === "pi") {
    const reply = await response(plan, { id: "skill-probe", type: "get_commands" });
    if (!reply.success) throw new Error("Pi skill discovery failed");
    names = reply.data.commands.filter((c) => c.source === "skill").map((c) => c.name.replace(/^skill:/, ""));
  } else throw new Error("This harness has no qualified native skill metadata API");
  return { names: names.sort(), plan };
}
