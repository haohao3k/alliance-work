// Shared with the plain-Node operations CLI; model IDs may carry a Pi backend prefix.
export const isCarbonModel = (model) => /(?:^|\/)gemini-4-carbon(?:$|-)/i.test(model);
export const isFableModel = (model) => /(?:^|\/)claude-fable(?:$|-)/i.test(model);
export const allowedModel = (harness, model) =>
  !isCarbonModel(model) && (harness !== "agy" || model.startsWith("gemini-"));
export const refusedModel = (model) =>
  isCarbonModel(model)
    ? `Carbon model ${model} is refused for every role. Choose another live-catalog model.`
    : `AGY runs only Gemini models; ${model} is refused for every role. Choose a gemini-* model.`;

/** @returns {{role: string, harness: string, model: string, reason: string}[]} */
export function modelPolicyWarnings(policy) {
  return policy.routes.flatMap((route) => {
    const reason = !allowedModel(route.harness, route.model)
      ? refusedModel(route.model)
      : isFableModel(route.model) && (route.difficulties.length !== 1 || route.difficulties[0] !== "frontier")
        ? "Fable routes must be frontier-only."
        : isFableModel(route.model) && !policy.fable?.rationale?.trim()
          ? "Fable requires a recorded owner rationale in the room model policy."
          : null;
    return reason ? [{ role: route.role, harness: route.harness, model: route.model, reason }] : [];
  });
}
