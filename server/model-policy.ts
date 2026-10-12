import type { AgentModelDefinition } from "@getpaseo/protocol/agent-types";
import type { RoleName } from "../shared/contracts";
import { isPreferredLeadModel, type ModelPolicyValue, type TaskDifficulty } from "../shared/model-policy";

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

  if (role === "lead") {
    const lead =
      requested ??
      available.find((entry) => isPreferredLeadModel(harness, entry.id)) ??
      available.find((entry) => entry.isDefault) ??
      available[0];
    if (!lead) throw new Error(`No available ${harness} Lead model in the live provider catalog`);
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
  if (role === "hq" || role === "supervisor") {
    const owner = requested ?? available.find((entry) => isPreferredLeadModel(harness, entry.id));
    if (owner) selected = { model: owner.id, effort: effort ?? owner.defaultThinkingOptionId ?? "medium" };
  } else {
    const routes = policy.routes
      .filter(
        (route) =>
          route.harness === harness &&
          (!id || route.model === id) &&
          (!effort || route.effort === effort) &&
          (!difficulty || route.difficulties.includes(difficulty)),
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
  if (!selected)
    throw new Error(
      `No allowed, available ${harness} ${role} model/effort${difficulty ? ` for ${difficulty}` : ""}. Check room Model settings and the live provider catalog.`,
    );
  const entry = available.find((item) => item.id === selected.model);
  if (!entry?.thinkingOptions?.some((option) => option.id === selected.effort))
    throw new Error(
      `Effort ${selected.effort} is unavailable for ${selected.model}; no silent effort fallback`,
    );
  return { model: selected.model, thinkingOptionId: selected.effort };
}
