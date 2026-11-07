import type { RoleName } from "./contracts";

const labels: Record<RoleName, string> = {
  hq: "HQ",
  supervisor: "Supervisor",
  lead: "Lead",
  peer: "Peer",
  lens: "Lens",
};

/** Display text only: never used as an identity, path, ownership or launch key. */
function compact(value: string, limit: number): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (clean.length <= limit) return clean;
  let prefix = "";
  for (const point of clean) {
    if (prefix.length + point.length >= limit) break;
    prefix += point;
  }
  return `${prefix}…`;
}

export function agentTitle(project: string, role: RoleName, task = ""): string {
  const firstLine = task.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  const summary = compact(firstLine.replace(/^\s*#{1,6}\s+/u, ""), 60);
  return [compact(project, 72) || "Project", labels[role], summary].filter(Boolean).join(" · ");
}

export function namingInstruction(project: string, role: RoleName): string {
  const initial = agentTitle(project, role);
  return `Naming: the automatic initial title is ${JSON.stringify(initial)}. After understanding the first request, refine your own automatic title once if it still exactly matches that initial title with native update_agent, using only your own PASEO_AGENT_ID and name (never settings or labels). Use ${JSON.stringify(`${initial} · <short task>`)} with a concise natural task summary in the Human's language; do not copy secrets, URLs, or long prompts into titles. Preserve any Human-supplied title unless the Human explicitly asks you to rename it. Read the current title immediately before updating; if it differs from the automatic title you expected, stop the rename. Titles are display text: never change IDs, ownership, models, budgets or assignments to rename a session. A shared workspace has a project title, not a role or task title. Only its accountable project owner may use native rename_workspace for its own workspace after an explicit Human naming request; a Peer must hand that request to the owner. Host identity stays in native host context. Native rename tools do not provide atomic expected-title checks; these are operating rules, not an authorization boundary. Never repeatedly rename a session or launch a model just to generate a name.`;
}
