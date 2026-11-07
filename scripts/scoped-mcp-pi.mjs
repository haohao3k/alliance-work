import { fileURLToPath } from "node:url";
import { scopedMcpServers } from "../server/scoped-mcp.mjs";

// Pi awaits extension loading before its builtin MCP session_start handler connects servers.
// Registrations are session-local and never write role or project mcp.json files.
export default async function scopedPiMcp(pi) {
  const home = process.env.ALLIANCE_WORK_HOME;
  if (!home) throw new Error("Scoped Pi MCP requires its Alliance home binding");
  const release = fileURLToPath(new URL("../", import.meta.url));
  const servers = await scopedMcpServers(home, "pi", release, process.cwd());
  for (const [name, server] of Object.entries(servers)) pi.registerMcpServer(name, server);
}
