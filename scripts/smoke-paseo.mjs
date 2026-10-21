// Run against an explicitly selected isolated daemon. No prompts or model turns.
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.argv[2];
if (!url) throw new Error("Pass the test daemon WebSocket URL explicitly");
const client = new DaemonClient({ url, clientId: "alliance-native-smoke", connectTimeoutMs: 10000 });
const api = createPaseoApi(client);
const receipt = { url, modelTurns: 0, profiles: 0, room: null, agents: [] };
try {
  await client.connect();
  const profiles = await client.invokePluginRpc("alliance-work", "profiles.status", {});
  receipt.profiles = profiles.profiles.length;
  const cwd = await mkdtemp(join(await realpath(tmpdir()), "alliance-paseo-smoke-"));
  const room = await client.invokePluginRpc("alliance-work", "rooms.create", {
    title: "Native lifecycle smoke",
    cwd,
    mission: "Check isolated native session creation and history reopening without model turns.",
  });
  receipt.room = room.id;
  for (const [provider, model] of [
    ["alliance-codex-peer", "gpt-6.1-sol"],
    // Peer routes only: Opus is a Lens route in the release defaults.
    ["alliance-claude-peer", "claude-sonnet-5-5"],
  ]) {
    const agent = await api.workspaces
      .ref(room.workspaceId)
      .agents.create({ title: `${provider} metadata check`, config: { provider: `${provider}/${model}` } });
    const commands = await agent.commands();
    receipt.agents.push({ id: agent.id, provider, commandsError: commands.error ?? null });
    assert(!commands.error, commands.error);
    const mcpUrl = new URL(url);
    mcpUrl.protocol = mcpUrl.protocol === "wss:" ? "https:" : "http:";
    mcpUrl.pathname = "/mcp/agents";
    mcpUrl.search = new URLSearchParams({ callerAgentId: agent.id }).toString();
    const mcp = new Client({ name: "alliance-native-tools-check", version: "0.1.0" });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(mcpUrl));
      assert(mcp.getServerCapabilities()?.tools, "Native Paseo tools must be injected into agents");
      const { tools } = await mcp.listTools();
      for (const name of ["create_agent", "send_agent_prompt", "get_agent_activity", "list_agents"])
        assert(
          tools.some((tool) => tool.name === name),
          `Missing native coordination tool ${name}`,
        );
      assert(!tools.some((tool) => /^(alliance|slp_)/.test(tool.name)), "No duplicate plugin MCP tools");
      receipt.agents.at(-1).nativeTools = tools.length;
    } finally {
      await mcp.close();
      await agent.detach();
    }
    await agent.timeline.refetch({ limit: 5 });
    const status = await agent.refresh();
    assert(status, "Stored agent survives detach and history load");
  }
  const view = await client.invokePluginRpc("alliance-work", "rooms.list", {});
  for (const agent of receipt.agents)
    assert(view.members.some((member) => member.id === agent.id && member.decision === "open"));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  api.dispose();
  await client.close();
}
