import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { McpHarness, ScopedConfig, ScopedProject } from "./scoped-mcp.mjs";

const state = z.object({ config: ScopedConfig, revision: z.string() });
export const mcpRead = defineRpc({ name: "mcp.read", input: z.object({}), output: state });
export const mcpSave = defineRpc({
  name: "mcp.save",
  input: z.object({ root: z.string(), project: ScopedProject.nullable(), revision: z.string() }),
  output: state,
});
export const mcpPreview = defineRpc({
  name: "mcp.preview",
  input: z.object({ cwd: z.string(), harness: McpHarness }),
  output: z.object({
    servers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()) })),
  }),
});
