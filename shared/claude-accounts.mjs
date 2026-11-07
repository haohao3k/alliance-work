import { z } from "zod";

export const ClaudeAccountId = z.enum(["5x", "20x"]);
export const ClaudeRole = z.enum(["hq", "supervisor", "lead", "peer", "lens"]);
export const ClaudeSelection = z.enum(["legacy", "5x", "20x"]);
export const ClaudeAccounts = z
  .object({
    version: z.literal(1),
    accounts: z.array(ClaudeAccountId),
    defaultAccount: ClaudeSelection,
    roles: z.partialRecord(ClaudeRole, ClaudeSelection).default({}),
  })
  .strict();
