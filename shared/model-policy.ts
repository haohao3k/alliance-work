import { z } from "zod";

export const Difficulty = z.enum(["routine", "standard", "complex", "frontier"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const WorkerRole = z.enum(["peer", "lens"]);
export const ModelRoute = z.object({
  role: WorkerRole,
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
    const keys = policy.routes.map(
      (route) => `${route.role}/${route.harness}/${route.model}/${route.effort}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Each role/harness/model/effort may appear only once" });
    for (const role of WorkerRole.options)
      for (const difficulty of Difficulty.options)
        if (!policy.routes.some((route) => route.role === role && route.difficulties.includes(difficulty)))
          context.addIssue({ code: "custom", message: `Allow at least one ${role} route for ${difficulty}` });
  });
export type ModelPolicyValue = z.infer<typeof ModelPolicy>;
export type ModelRouteValue = z.infer<typeof ModelRoute>;
export type TaskDifficulty = z.infer<typeof Difficulty>;
export type WorkerRoleName = z.infer<typeof WorkerRole>;

/** Policies saved before 0.1.18 had one list for both workers; each such route applies to both. */
export function upgradeModelPolicy(value: unknown): unknown {
  if (!value || typeof value !== "object" || !Array.isArray((value as { routes?: unknown }).routes))
    return value;
  const policy = value as { routes: Record<string, unknown>[] };
  return {
    ...policy,
    routes: policy.routes.flatMap((route) =>
      route && typeof route === "object" && !("role" in route)
        ? WorkerRole.options.map((role) => ({ ...route, role }))
        : [route],
    ),
  };
}

const ALL: TaskDifficulty[] = [...Difficulty.options];
// The Human's order, first choice first. Every route serves every difficulty: the order decides.
const PEER: Omit<ModelRouteValue, "role" | "priority" | "difficulties">[] = [
  { harness: "claude", model: "claude-sonnet-5-5", effort: "high" },
  { harness: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
  { harness: "agy", model: "gemini-4-argon-medium", effort: "medium" },
  { harness: "pi", model: "zai/glm-5.3", effort: "high" },
  { harness: "pi", model: "izno-vps/ds/deepseek-v4.1-flash", effort: "high" },
];
const LENS: Omit<ModelRouteValue, "role" | "priority" | "difficulties">[] = [
  { harness: "claude", model: "claude-opus-5-5", effort: "medium" },
  { harness: "codex", model: "gpt-6-astra", effort: "medium" },
  { harness: "agy", model: "gemini-4-argon-high", effort: "high" },
];

export function defaultModelPolicy(): ModelPolicyValue {
  const ranked = (role: WorkerRoleName, routes: typeof PEER) =>
    routes.map((route, index) => ({ ...route, role, priority: index + 1, difficulties: [...ALL] }));
  return { leadEffort: "medium", routes: [...ranked("peer", PEER), ...ranked("lens", LENS)] };
}

/**
 * The Human's rule: AGY runs only Gemini models, for every role. Enforced when a model is chosen,
 * offered or saved, never when stored lists are read, so older saved lists stay readable.
 */
export const allowedModel = (harness: string, model: string) =>
  harness !== "agy" || model.startsWith("gemini-");
export const refusedModel = (model: string) =>
  `AGY runs only Gemini models; ${model} is refused for every role. Choose a gemini-* model.`;

// Pi model IDs include the backend. Do not accept arbitrary aliases or suffix matches.
export function isEconomicalOwnerModel(harness: string, model: string): boolean {
  if (harness === "codex") return model === "gpt-6.1-sol";
  if (harness === "claude") return model === "claude-sonnet-5-5";
  if (harness === "agy") return model === "gemini-4-argon-medium";
  return (
    harness === "pi" &&
    ["openai/gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "anthropic/claude-sonnet-5-5"].includes(model)
  );
}

export function policyInstruction(policy: ModelPolicyValue, revision: number): string {
  const list = (role: WorkerRoleName) =>
    policy.routes
      .filter((route) => route.role === role)
      .sort((a, b) => a.priority - b.priority)
      .map(
        (route) =>
          `- ${route.priority}. ${route.harness}/${route.model}, ${route.effort}${route.difficulties.length < Difficulty.options.length ? `; only ${route.difficulties.join(", ")}` : ""}`,
      )
      .join("\n");
  return `# Room model policy (revision ${revision})
HQ/Supervisor/Lead default to gpt-6.1-sol, claude-sonnet-5-5 or AGY gemini-4-argon-medium; AGY runs only Gemini models. Select Astra/Opus explicitly for a named hard decision, diagnosis or integration risk; record why the cheaper route is insufficient.
Preferred owner effort when omitted: ${policy.leadEffort}; otherwise use the selected model's supported default.
Peer and Lens each have their own allowlist below, in the Human's order of preference (1 is the first choice).
Use the first route that is available and suits the work; move down the list when a route is unavailable, out of quota or unsuited, and record why. A route marked "only" applies to those difficulties.
Lead chooses the difficulty and final route; Supervisor/HQ may intervene with reasons and evidence.
Native delegation enforces the role's allowlist exactly (harness, model and effort). An omitted worker model takes that harness's highest-priority standard route, never a frontier-only fallback. Never inherit a parent's expensive model without assessing the task.
Record difficulty, chosen provider/model/effort and a short justification in the durable assignment.
Reassess when evidence, verification failures or task scope change. Peer/Lens selections stay inside their allowlist.
Peer:
${list("peer")}
Lens:
${list("lens")}
Use the target role's live provider catalog. Unavailable routes are not substitutes for other models.
Room settings apply to new launches. Existing native sessions keep their loaded policy; coordinate a fresh
session when changing model policy, preserving the assignment and prior results.\n`;
}
