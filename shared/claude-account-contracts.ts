import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ClaudeAccounts } from "./claude-accounts.mjs";

const state = z.object({ config: ClaudeAccounts, revision: z.string() });
export const claudeQuotaRead = defineRpc({
  name: "claude.accounts.quota",
  input: z.object({}),
  output: z.object({
    fetchedAt: z.string(),
    accounts: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        error: z.string().nullable(),
        windows: z.array(
          z.object({ label: z.string(), usedPct: z.number(), resetsAt: z.string().nullable() }),
        ),
      }),
    ),
  }),
});
export const claudeAccountsRead = defineRpc({
  name: "claude.accounts.read",
  input: z.object({}),
  output: state,
});
export const claudeAccountsSelect = defineRpc({
  name: "claude.accounts.select",
  input: z.object({
    role: z.enum(["default", "hq", "supervisor", "lead", "peer", "lens"]),
    account: z.enum(["inherit", "legacy", "5x", "20x"]),
    revision: z.string(),
  }),
  output: state,
});
