import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ClaudeAccountId, ClaudeAccounts } from "./claude-accounts.mjs";

const state = z.object({
  config: ClaudeAccounts,
  revision: z.string(),
  sessions: z
    .array(
      z.object({
        agentId: z.string(),
        title: z.string(),
        role: z.string(),
        current: z.string().nullable(),
        selected: z.string(),
        reason: z.string().optional(),
        state: z.enum(["current", "pending", "ready", "unsupported", "unknown"]),
      }),
    )
    .optional(),
});
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

const projectSelection = z.enum(["inherit", "5x", "20x"]);
const projectAccountState = z.object({
  account: projectSelection,
  accounts: z.array(ClaudeAccountId),
  revision: z.string(),
});
export const projectClaudeAccountRead = defineRpc({
  name: "claude.accounts.project.read",
  input: z.object({ roomId: z.string() }),
  output: projectAccountState,
});
export const projectClaudeAccountSelect = defineRpc({
  name: "claude.accounts.project.select",
  input: z.object({ roomId: z.string(), account: projectSelection, revision: z.string() }),
  output: projectAccountState,
});

export const claudeAccountsSwitchNow = defineRpc({
  name: "claude.accounts.switch",
  input: z.object({ agentId: z.string(), selected: z.enum(["legacy", "5x", "20x"]) }),
  output: z.object({ status: z.string() }),
});
