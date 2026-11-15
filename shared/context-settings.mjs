import { z } from "zod";

export const claudeContextTokenLimit = 300_000;
export const claudePilotContextTokenLimit = 232_000;
export const ClaudeContextWindow = z.union([
  z.literal(claudeContextTokenLimit),
  z.literal(claudePilotContextTokenLimit),
]);
export const ContextPolicy = z
  .object({
    claudeWindow: ClaudeContextWindow.default(claudeContextTokenLimit),
    roles: z
      .object({
        hq: ClaudeContextWindow.optional(),
        supervisor: ClaudeContextWindow.optional(),
        lead: ClaudeContextWindow.optional(),
        peer: ClaudeContextWindow.optional(),
        lens: ClaudeContextWindow.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const ContextSettings = z.object({
  roomId: z.string().min(1),
  policy: ContextPolicy,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  saved: z.boolean(),
});

export function claudeWindowFor(policy, role) {
  const parsed = ContextPolicy.parse(policy);
  return parsed.roles[role] ?? parsed.claudeWindow;
}
