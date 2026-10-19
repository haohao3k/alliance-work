import { z } from "zod";

export const Difficulty = z.enum(["routine", "standard", "complex", "frontier"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const ModelRoute = z.object({
  harness: z.enum(["codex", "claude", "pi", "agy"]),
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
      {
        harness: "agy",
        model: "claude-sonnet-5-5-medium",
        effort: "medium",
        priority: 3,
        difficulties: ["routine", "standard"],
      },
      {
        harness: "agy",
        model: "claude-sonnet-5-5-high",
        effort: "high",
        priority: 3,
        difficulties: ["complex"],
      },
      {
        harness: "agy",
        model: "claude-opus-5-5-high",
        effort: "high",
        priority: 3,
        difficulties: ["frontier"],
      },
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
export function isEconomicalOwnerModel(harness: string, model: string): boolean {
  if (harness === "codex") return model === "gpt-6.1-sol";
  if (harness === "claude") return model === "claude-sonnet-5-5";
  if (harness === "agy") return model === "claude-sonnet-5-5-medium";
  return (
    harness === "pi" &&
    ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"].includes(model)
  );
}

export function policyInstruction(policy: ModelPolicyValue, revision: number): string {
  return `# Room model policy (revision ${revision})
HQ/Supervisor/Lead default to gpt-6.1-sol or claude-sonnet-5-5. Select Astra/Opus explicitly for a named hard decision, diagnosis or integration risk; record why the cheaper route is insufficient.
Preferred owner effort when omitted: ${policy.leadEffort}; otherwise use the selected model's supported default.
Peer is the default implementation role. Add a Lead for integration, a Supervisor for multiple workstreams, or HQ for cross-project decisions only when that responsibility is needed. Do not create a hierarchy just to forward work.
Peer and Lens allowlist below. Lower priority numbers are preferred within each difficulty.
Lead chooses the difficulty and final route; Supervisor/HQ may intervene with reasons and evidence.
Difficulty is a judgment, not an automatic classifier. Native delegation enforces the union of allowed routes;
the difficulty bands guide your choice. Omitted worker model/difficulty uses the standard band, never the frontier fallback. Never inherit a parent's expensive model without assessing the task.
Record difficulty, chosen provider/model/effort and a short justification in the durable assignment.
Reassess when evidence, verification failures or task scope change. Peer/Lens selections stay inside their allowlist.
${policy.routes.map((route) => `- ${route.harness}/${route.model}, ${route.effort}; priority ${route.priority}; ${route.difficulties.join(", ")}`).join("\n")}
Use the target role's live provider catalog. Unavailable routes are not substitutes for other models.
Room settings apply to new launches. Existing native sessions keep their loaded policy; coordinate a fresh
session when changing model policy, preserving the assignment and prior results.\n`;
}
