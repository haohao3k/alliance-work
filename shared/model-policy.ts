import { z } from "zod";

export { allowedModel, isFableModel, modelPolicyWarnings, refusedModel } from "./model-rules.mjs";

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
    fable: z.object({ rationale: z.string().trim().min(1).max(4000) }).optional(),
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

export const GLOBAL_MODEL_POLICY = "@daemon-model-defaults";

const ALL: TaskDifficulty[] = [...Difficulty.options];
// The Human's order, first choice first. Every route serves every difficulty: the order decides.
const PEER: Omit<ModelRouteValue, "role" | "priority" | "difficulties">[] = [
  { harness: "claude", model: "claude-sonnet-5-5", effort: "high" },
  { harness: "claude", model: "claude-sonnet-5-5", effort: "medium" },
  { harness: "codex", model: "gpt-6.1-sol", effort: "high" },
  { harness: "pi", model: "antigravity/gemini-4-argon", effort: "medium" },
  { harness: "pi", model: "antigravity/gemini-3.8-flash", effort: "medium" },
  { harness: "pi", model: "antigravity/gemini-3.8-flash", effort: "high" },
  { harness: "pi", model: "zai/glm-5.3", effort: "high" },
];
const LENS: Omit<ModelRouteValue, "role" | "priority" | "difficulties">[] = [
  { harness: "claude", model: "claude-opus-5-5", effort: "medium" },
  { harness: "codex", model: "gpt-6-astra", effort: "medium" },
  { harness: "pi", model: "antigravity/gemini-4-argon", effort: "high" },
  { harness: "pi", model: "antigravity/gemini-3.8-flash", effort: "high" },
];

export function defaultModelPolicy(): ModelPolicyValue {
  const ranked = (role: WorkerRoleName, routes: typeof PEER) =>
    routes.map((route, index) => ({ ...route, role, priority: index + 1, difficulties: [...ALL] }));
  return { leadEffort: "medium", routes: [...ranked("peer", PEER), ...ranked("lens", LENS)] };
}

// Pi model IDs include the backend. Do not accept arbitrary aliases or suffix matches.
export function isEconomicalOwnerModel(harness: string, model: string): boolean {
  if (harness === "codex") return model === "gpt-6.1-sol";
  if (harness === "claude") return model === "claude-sonnet-5-5";
  if (harness === "agy") return model === "gemini-4-argon-medium";
  return (
    harness === "pi" &&
    [
      "antigravity/gemini-3.8-flash",
      "antigravity/gemini-4-argon",
      "openai/gpt-6.1-sol",
      "openai-codex/gpt-6.1-sol",
      "anthropic/claude-sonnet-5-5",
    ].includes(model)
  );
}

/**
 * When each default route is the right one, keyed like the uniqueness check above so a route keeps
 * its line wherever the Human moves it. Advisory only: the Human's order and allowlist decide what
 * is allowed, and a route the Human adds has no line.
 */
const ROUTE_USE: Record<string, string> = {
  "peer/claude/claude-sonnet-5-5/high": "default: implementation, debugging, work with unresolved reasoning",
  "peer/claude/claude-sonnet-5-5/medium": "same model, lighter effort: bounded edits and easy-to-check work",
  "peer/codex/gpt-6.1-sol/high":
    "other provider: Claude unavailable or out of quota, or work to do or check elsewhere",
  "peer/pi/antigravity/gemini-4-argon/medium": "Gemini via Pi: earlier routes unavailable, or Gemini wanted",
  "peer/pi/antigravity/gemini-3.8-flash/medium": "lighter Gemini: clear, bounded, easy-to-verify work",
  "peer/pi/antigravity/gemini-3.8-flash/high": "lighter Gemini when medium fell short on a bounded task",
  "peer/pi/zai/glm-5.3/high": "fallback; keep to bounded work with checkable results",
  "lens/claude/claude-opus-5-5/medium": "default: independent assessment of a named hard question",
  "lens/codex/gpt-6-astra/medium": "assessment from a provider other than the work under review",
  "lens/pi/antigravity/gemini-4-argon/high": "another independent view, or earlier routes unavailable",
  "lens/pi/antigravity/gemini-3.8-flash/high": "lighter independent check of a bounded claim",
};

/**
 * Route selection guidance for every role that delegates. Adapted in wording from
 * PRESET_SELECTION_GUIDANCE in plugin/shared/runtime/peer-presets.ts of paseo-slp-plugin
 * (MIT License, Copyright (c) 2026 duongvm57).
 */
const SELECTION_GUIDANCE =
  "Choose the lightest route and effort sufficient for the actual outcome and its verification; the order below decides among sufficient routes. Judge unresolved ambiguity, interacting dependencies, novelty, stakes and how hard correctness is to check: source-grounded extraction, formatting and bounded edits need less than novel solutions or uncertain premises. Length, file count, documentation or review alone do not justify a stronger route or more effort; name the concrete unresolved difficulty that does. Verification stays required at every level; a route grants no extra retries or budget.";
("Choose the lightest route and effort that is sufficient for the actual outcome and its verification; the order below decides among sufficient routes. Judge unresolved ambiguity, interacting dependencies, novelty, stakes and how hard correctness is to check: source-grounded extraction, inventory, formatting and bounded edits need less than novel solutions or uncertain premises. A long brief, many files, documentation or review alone do not justify a stronger route or higher effort; name the concrete unresolved difficulty that does. Verification stays required at every level, and a route grants no extra retries or budget.");

/** The room model policy as one role's session should read it; no role means the full owner text. */
export function policyInstruction(policy: ModelPolicyValue, revision: number, role?: string): string {
  const list = (target: WorkerRoleName, described: boolean) =>
    policy.routes
      .filter((route) => route.role === target)
      .sort((a, b) => a.priority - b.priority)
      .map((route) => {
        const use = described
          ? ROUTE_USE[`${route.role}/${route.harness}/${route.model}/${route.effort}`]
          : undefined;
        return `- ${route.priority}. ${route.harness}/${route.model}, ${route.effort}${route.difficulties.length < Difficulty.options.length ? `; only ${route.difficulties.join(", ")}` : ""}${use ? ` (${use})` : ""}`;
      })
      .join("\n");
  if (role === "lens")
    return `# Room model policy (revision ${revision})
You choose no model. If your assignment authorizes delegation, native create_agent enforces the room allowlist exactly: an omitted model takes that role's first route, and a refusal lists the allowed routes.\n`;
  if (role === "peer")
    return `# Room model policy (revision ${revision})
Native delegation enforces the role's allowlist exactly (harness, model and effort); an omitted worker model takes that harness's highest-priority standard route. Never inherit your own model without assessing the task. The lists below are in the Human's order of preference (1 is the first choice); move down when a route is unavailable or out of quota and record why. A route marked "only" applies to those difficulties.
${SELECTION_GUIDANCE}
Record the chosen route and a short reason in the durable assignment.
Peer:
${list("peer", true)}
Lens:
${list("lens", false)}
Use the target role's live provider catalog. Unavailable routes are not substitutes for other models.\n`;
  return `# Room model policy (revision ${revision})
HQ/Supervisor/Lead default to gpt-6.1-sol, claude-sonnet-5-5 or Pi antigravity/gemini-3.8-flash (antigravity/gemini-4-argon for demanding Gemini work); use Pi for Gemini. Select Astra/Opus explicitly for a named hard decision, diagnosis or integration risk; record why the cheaper route is insufficient.
Fable is explicit-only for frontier work and requires the Human's recorded room rationale.${policy.fable ? ` Room rationale: ${policy.fable.rationale}` : " No Fable rationale is recorded."}
Preferred owner effort when omitted: ${policy.leadEffort}; otherwise use the selected model's supported default.
Peer and Lens each have their own allowlist below, in the Human's order of preference (1 is the first choice).
Use the first route that is available and sufficient for the work; move down the list when a route is unavailable, out of quota or unsuited, and record why. A route marked "only" applies to those difficulties.
${SELECTION_GUIDANCE}
Lead chooses the difficulty and final route; Supervisor/HQ may intervene with reasons and evidence.
Native delegation enforces the role's allowlist exactly (harness, model and effort). An omitted worker model takes that harness's highest-priority standard route, never a frontier-only fallback. Never inherit a parent's expensive model without assessing the task.
Record difficulty, chosen provider/model/effort and a short justification in the durable assignment.
Reassess when evidence, verification failures or task scope change. Peer/Lens selections stay inside their allowlist.
Peer:
${list("peer", true)}
Lens:
${list("lens", true)}
Use the target role's live provider catalog. Unavailable routes are not substitutes for other models.
Room settings apply to new launches. Existing native sessions keep their loaded policy; coordinate a fresh
session when changing model policy, preserving the assignment and prior results.\n`;
}
