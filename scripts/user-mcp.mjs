import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoLinks, atomicWrite, projectRoot } from "./profiles.mjs";

export const mobbinUrl = "https://api.mobbin.com/mcp";
export async function userMcpSettings(home) {
  const path = join(home, "user-mcp.json");
  await assertNoLinks(path);
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { version: 1 };
  if (!info.isFile()) throw new Error("Alliance user MCP settings must be a regular file");
  const config = JSON.parse(await readFile(path, "utf8"));
  if (config.version !== 1 || Object.keys(config).some((key) => !["version", "mobbin"].includes(key)))
    throw new Error("Unsupported Alliance user MCP configuration");
  if (
    config.mobbin &&
    (typeof config.mobbin.enabled !== "boolean" ||
      !Array.isArray(config.mobbin.harnesses) ||
      config.mobbin.harnesses.some((name) => !["claude", "codex"].includes(name)))
  )
    throw new Error("Mobbin supports the explicit Claude/Codex harness list");
  return config;
}
export async function enableMobbin(home) {
  const config = await userMcpSettings(home);
  config.mobbin = { enabled: true, harnesses: ["codex", "claude"] };
  await atomicWrite(join(home, "user-mcp.json"), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}
export async function userMcpServers(home, harness, root = projectRoot) {
  if (!["codex", "claude"].includes(harness)) return {};
  const config = await userMcpSettings(home);
  if (!config.mobbin?.enabled || !config.mobbin.harnesses.includes(harness)) return {};
  return { mobbin: { command: process.execPath, args: [join(root, "scripts/mobbin.mjs"), home] } };
}
