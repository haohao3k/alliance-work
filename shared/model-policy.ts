import { z } from "zod";

export const Difficulty = z.enum(["routine", "standard", "complex", "frontier"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ModelRoute = z.object({
  harness: z.enum(["codex", "claude", "pi"]),
  model: z.string().trim().min(1).max(200),
  effort: Effort,
  priority: z.number().int().min(1).max(99),
  difficulties: z.array(Difficulty).min(1).max(4),
});
export const ModelPolicy = z
  .object({
    leadEffort: Effort,
    routes: z.array(ModelRoute).min(1).max(100),
  })
  .superRefine((policy, context) => {
    const keys = policy.routes.map((route) => `${route.harness}/${route.model}/${route.effort}`);
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Each harness/model/effort may appear only once" });
    for (const difficulty of Difficulty.options)
      if (!policy.routes.some((route) => route.difficulties.includes(difficulty)))
        context.addIssue({ code: "custom", message: `Allow at least one route for ${difficulty}` });
  });
export type ModelPolicyValue = z.infer<typeof ModelPolicy>;
export type ModelRouteValue = z.infer<typeof ModelRoute>;
export type TaskDifficulty = z.infer<typeof Difficulty>;

export function defaultModelPolicy(): ModelPolicyValue {
  return {
    leadEffort: "medium",
    routes: [
      { harness: "codex", model: "gpt-6.1-sol", effort: "medium", priority: 1, difficulties: ["routine"] },
      {
        harness: "codex",
        model: "gpt-6.1-sol",
        effort: "high",
        priority: 1,
        difficulties: ["standard", "complex"],
      },
      {
        harness: "claude",
        model: "claude-sonnet-5-5",
        effort: "medium",
        priority: 2,
        difficulties: ["routine", "standard"],
      },
      {
        harness: "claude",
        model: "claude-opus-5-5",
        effort: "medium",
        priority: 2,
        difficulties: ["standard", "complex"],
      },
      {
        harness: "claude",
        model: "claude-sonnet-5-5",
        effort: "xhigh",
        priority: 3,
        difficulties: ["complex"],
      },
      {
        harness: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        priority: 1,
        difficulties: ["frontier"],
      },
      { harness: "codex", model: "gpt-6-astra", effort: "high", priority: 2, difficulties: ["frontier"] },
    ],
  };
}

// Pi model IDs include the backend. Do not accept arbitrary aliases or suffix matches.
export function isPreferredLeadModel(harness: string, model: string): boolean {
  if (harness === "codex") return model === "gpt-6-astra";
  if (harness === "claude") return model === "claude-opus-5-5";
  return (
    harness === "pi" &&
    ["openai/gpt-6-astra", "openai-codex/gpt-6-astra", "anthropic/claude-opus-5-5"].includes(model)
  );
}

export function policyInstruction(policy: ModelPolicyValue, revision: number): string {
  return `# Room model policy (revision ${revision})
Lead: prefer gpt-6-astra or claude-opus-5-5 at medium/high, but choose any live-catalog model/effort that fits the task.
Preferred Lead effort when omitted: ${policy.leadEffort}; otherwise use the selected model's supported default.
Peer and Lens allowlist below. Lower priority numbers are preferred within each difficulty.
Lead chooses the difficulty and final route; Supervisor/HQ may intervene with reasons and evidence.
Difficulty is a judgment, not an automatic classifier. Native delegation enforces the union of allowed routes;
the difficulty bands guide your choice. Never inherit a parent's expensive model without assessing the task.
Record difficulty, chosen provider/model/effort and a short justification in the durable assignment.
Reassess when evidence, verification failures or task scope change. Peer/Lens selections stay inside their allowlist.
${policy.routes.map((route) => `- ${route.harness}/${route.model}, ${route.effort}; priority ${route.priority}; ${route.difficulties.join(", ")}`).join("\n")}
Use the target role's live provider catalog. Unavailable routes are not substitutes for other models.
Room settings apply to new launches. Existing native sessions keep their loaded policy; coordinate a fresh
session when changing model policy, preserving the assignment and prior results.\n`;
}
