import { createHash } from "node:crypto";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server";
import { z } from "zod";
import { claudeQuota, readQuotaRegistry } from "./claude-quota.mjs";

const Input = z.object({ id: z.string().regex(/^[\w-]{1,40}$/) }).strict();

export function createClaudeUsageSource(registry?: string): UsageSourceRegistration {
  return {
    id: "claude-accounts",
    label: "Claude accounts",
    input: Input,
    async discover(scope) {
      if (scope.kind !== "global") return [];
      const config = await readQuotaRegistry(registry);
      return config.accounts.map((account) => ({
        key: `profile-${createHash("sha256").update(account.configDir).digest("hex").slice(0, 24)}`,
        label: account.label,
        harness: "Claude Code",
        input: { id: account.id },
      }));
    },
    async fetch(input) {
      const { id } = Input.parse(input);
      const result = await claudeQuota({ registry, accountId: id });
      const account = result.accounts.find((entry) => entry.id === id);
      if (!account)
        return { status: "error", error: "This Claude profile is no longer registered on the host." };
      if (account.error) return { status: "error", error: account.error };
      return {
        status: "available",
        windows: account.windows.map((window) => ({
          id: createHash("sha256").update(window.label).digest("hex").slice(0, 16),
          label: window.label,
          shortLabel: window.label === "Session (5h)" ? "5h" : "wk",
          summary: window.label === "Session (5h)" || window.label === "Weekly",
          usedPct: window.usedPct,
          remainingPct: Math.max(0, 100 - window.usedPct),
          resetsAt: window.resetsAt,
        })),
      };
    },
  };
}
