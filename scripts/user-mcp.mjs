import { join } from "node:path";
import { userMcpServers as servers, userMcpSettings } from "../server/user-mcp.mjs";
import { atomicWrite, projectRoot } from "./profiles.mjs";

export { mobbinUrl, userMcpSettings } from "../server/user-mcp.mjs";
export async function enableMobbin(home) {
  const config = await userMcpSettings(home);
  config.mobbin = { enabled: true, harnesses: ["codex", "claude", "agy"] };
  await atomicWrite(join(home, "user-mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
export async function userMcpServers(home, harness, root = projectRoot) {
  return servers(home, harness, root);
}
