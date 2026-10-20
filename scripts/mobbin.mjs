import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { assertNoLinks, projectRoot } from "./profiles.mjs";
import { mobbinUrl } from "./user-mcp.mjs";

const [home, mode] = process.argv.slice(2);
if (!home || !isAbsolute(home) || (mode && mode !== "--login"))
  throw new Error("Usage: mobbin.mjs ABSOLUTE_ALLIANCE_HOME [--login]");
process.umask(0o077);
const directory = join(home, "mcp-auth/mobbin");
await assertNoLinks(directory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const child = spawn(
  process.execPath,
  [
    join(projectRoot, "node_modules/mcp-remote/dist", mode ? "client.js" : "proxy.js"),
    mobbinUrl,
    "43159",
    "--host",
    "127.0.0.1",
    "--transport",
    "http-only",
    "--auth-timeout",
    "600",
    ...(mode ? [] : ["--silent"]),
  ],
  { env: { ...process.env, MCP_REMOTE_CONFIG_DIR: directory }, stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => {
  console.error("Could not start the installed Mobbin transport");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
