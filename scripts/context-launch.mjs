import { spawn } from "node:child_process";
import { contextPolicy } from "./context-policy.mjs";

// Native Paseo providers use this same policy without changing daily CLI homes.
const [harness, executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error("Usage: context-launch.mjs HARNESS EXECUTABLE [arguments]");
const plan = contextPolicy(harness, args, process.env);
const child = spawn(executable, plan.args, { env: plan.env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(`Context-policy launch failed: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
