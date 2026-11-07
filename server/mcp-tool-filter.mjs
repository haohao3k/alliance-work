import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolPolicy, toolAllowed } from "../shared/scoped-mcp.mjs";

// A tool-only adapter for an explicitly restricted MCP. No coordination or message transport.
export async function startFilteredMcp(command, args, cwd, inputPolicy) {
  const policy = ToolPolicy.parse(inputPolicy);
  const upstream = new Client({ name: "alliance-tool-filter", version: "1" });
  const child = new StdioClientTransport({ command, args, cwd, env: process.env, stderr: "inherit" });
  try {
    await upstream.connect(child);
  } catch (error) {
    await upstream.close();
    throw error;
  }
  const server = new Server(
    { name: "alliance-scoped-tools", version: "1" },
    {
      capabilities: { tools: { listChanged: true } },
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await upstream.listTools(request.params, { signal: extra.signal });
    return { ...result, tools: result.tools.filter((tool) => toolAllowed(policy, tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (!toolAllowed(policy, request.params.name))
      return { isError: true, content: [{ type: "text", text: "Tool denied by this project's MCP policy" }] };
    return upstream.callTool(request.params, undefined, { signal: extra.signal });
  });
  upstream.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    // SDK closes a bounded stdio transport by pausing input. Close our owned pipe before
    // waiting for upstream shutdown, which may need a forced kill after its grace period.
    process.stdin.destroy();
    await Promise.allSettled([server.close(), upstream.close()]);
  };
  upstream.onclose = () => {
    void close();
  };
  server.onclose = () => {
    void close();
  };
  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await close();
    throw error;
  }
  return close;
}
