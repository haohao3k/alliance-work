import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { RoleName } from "../shared/contracts";
import { isEconomicalOwnerModel, type ModelPolicyValue, type TaskDifficulty } from "../shared/model-policy";

export function chooseModel(
  policy: ModelPolicyValue,
  role: RoleName,
  harness: string,
  catalog: AgentModelDefinition[],
  model?: string,
  effort?: string,
  difficulty?: TaskDifficulty,
) {
  const available = catalog.filter((entry) => entry.isSelectable !== false);
  // Resolve only catalog-declared aliases; never infer an exact model from "opus" or "latest".
  const requested = model
    ? available.find((entry) => entry.id === model || entry.aliases?.includes(model))
    : undefined;
  const id = requested?.id ?? model;
  if (model && !requested) throw new Error(`Model ${model} is unavailable in the ${harness} ${role} catalog`);

  if (role === "lead" || role === "hq" || role === "supervisor") {
    const lead = requested ?? available.find((entry) => isEconomicalOwnerModel(harness, entry.id));
    if (!lead)
      throw new Error(
        `No available economical ${harness} ${role} model; select an explicit live-catalog model`,
      );
    const options = lead.thinkingOptions ?? [];
    if (effort && !options.some((option) => option.id === effort))
      throw new Error(`Effort ${effort} is unavailable for ${lead.id}; no silent effort fallback`);
    const preferred = options.find((option) => option.id === policy.leadEffort);
    const providerDefault = options.find(
      (option) => option.id === lead.defaultThinkingOptionId || option.isDefault,
    );
    return {
      model: lead.id,
      thinkingOptionId: effort ?? preferred?.id ?? providerDefault?.id ?? options[0]?.id,
    };
  }
  let selected: { model: string; effort: string } | undefined;
  {
    // Explicit models retain the room allowlist union. Omitted models stay in the
    // assessed band (standard by default), never falling through to frontier.
    const band = difficulty ?? (model ? undefined : "standard");
    const routes = policy.routes
      .filter(
        (route) =>
          route.role === role &&
          route.harness === harness &&
          (!id || route.model === id) &&
          (!effort || route.effort === effort) &&
          (!band || route.difficulties.includes(band)),
      )
      .sort(
        (a, b) =>
          (!difficulty && !effort
            ? Number(b.difficulties.includes("standard")) - Number(a.difficulties.includes("standard"))
            : 0) || a.priority - b.priority,
      );
    selected = routes.find((route) =>
      available.some(
        (entry) =>
          entry.id === route.model && entry.thinkingOptions?.some((option) => option.id === route.effort),
      ),
    );
  }
  if (!selected) {
    const allowed = policy.routes
      .filter((route) => route.role === role && route.harness === harness)
      .sort((a, b) => a.priority - b.priority)
      .map((route) => {
        const live = available.some(
          (entry) =>
            entry.id === route.model && entry.thinkingOptions?.some((option) => option.id === route.effort),
        );
        return `${route.model} ${route.effort}${live ? "" : " (not in the live catalog)"}`;
      });
    throw new Error(
      `No allowed, available ${harness} ${role} model/effort${difficulty ? ` for ${difficulty}` : ""}${model ? ` (requested ${id}${effort ? ` ${effort}` : ""})` : ""}. This room allows ${allowed.length ? allowed.join("; ") : `no ${harness} ${role} routes`}. The Human changes this in Alliance Work → Models.`,
    );
  }
  const entry = available.find((item) => item.id === selected.model);
  if (!entry?.thinkingOptions?.some((option) => option.id === selected.effort))
    throw new Error(
      `Effort ${selected.effort} is unavailable for ${selected.model}; no silent effort fallback`,
    );
  return { model: selected.model, thinkingOptionId: selected.effort };
}
