import { spawn } from "node:child_process";
import { startFilteredMcp } from "../server/mcp-tool-filter.mjs";
import { boundMcpCwd } from "../server/scoped-mcp.mjs";

// Capture the launcher's session cwd explicitly; native MCP clients may start in a role HOME.
try {
  const [root, sessionCwd, command, rawArgs, rawPolicy] = process.argv.slice(2);
  const cwd = await boundMcpCwd(root, sessionCwd);
  const args = JSON.parse(rawArgs);
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
    throw new Error("Invalid scoped MCP command arguments");
  if (rawPolicy) {
    const close = await startFilteredMcp(command, args, cwd, JSON.parse(rawPolicy));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.once(signal, () => {
        void close();
      });
  } else {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => {
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
} catch (error) {
  console.error(`Scoped MCP refused: ${error.message}`);
  process.exitCode = 1;
}
