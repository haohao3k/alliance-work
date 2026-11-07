import { z } from "zod";

export const McpHarness = z.enum(["codex", "claude", "agy", "pi"]);
export const McpName = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .refine(
    (name) => !["paseo", "mobbin", "__proto__", "constructor", "prototype"].includes(name),
    "Reserved MCP server name",
  );
// Exact upstream tool names: deny wins; omitted allow means all, [] means none.
export const ToolPolicy = z
  .object({
    allow: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const ScopedServer = z
  .object({
    command: z.string().startsWith("/", "Executable must be an absolute path"),
    args: z.array(z.string()),
    tools: ToolPolicy.optional(),
  })
  .strict();
export const ScopedProject = z
  .object({
    root: z.string().startsWith("/").min(2),
    harnesses: z.array(McpHarness).min(1),
    servers: z.record(McpName, ScopedServer),
  })
  .strict();
export const ScopedConfig = z
  .object({
    version: z.literal(1),
    projects: z.array(ScopedProject),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (let i = 0; i < config.projects.length; i++) {
      const a = config.projects[i];
      for (const b of config.projects.slice(i + 1)) {
        const overlap =
          a.root === b.root || a.root.startsWith(`${b.root}/`) || b.root.startsWith(`${a.root}/`);
        if (
          a.root === b.root ||
          (overlap &&
            a.harnesses.some((h) => b.harnesses.includes(h)) &&
            Object.keys(a.servers).some((name) => Object.hasOwn(b.servers, name)))
        )
          ctx.addIssue({
            code: "custom",
            message: "Duplicate project or colliding inherited MCP server name",
            path: ["projects", i],
          });
      }
    }
  });

export function toolAllowed(policy, name) {
  return !policy.deny.includes(name) && (policy.allow === undefined || policy.allow.includes(name));
}
