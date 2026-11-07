import type { RoleName } from "./contracts";

const labels: Record<RoleName, string> = {
  hq: "hq",
  supervisor: "sup",
  lead: "lead",
  peer: "peer",
  lens: "lens",
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

/** Keep project identity separate from task text, including already formatted titles. */
export function projectName(value: string): string {
  const formatted = /^\[(?:hq|sup|supervisor|lead|peer|lens|team)\]\s*\[([^\]]+)\]/iu.exec(value);
  return compact((formatted?.[1] ?? value).replace(/[[\]]/gu, " "), 48) || "Project";
}

export function workspaceTitle(project: string): string {
  return `[team] [${projectName(project)}]`;
}

export function agentTitle(project: string, role: RoleName, task = "", knownProjects: string[] = []): string {
  let summary = (task.split(/\r?\n/u).find((line) => line.trim()) ?? "").replace(/^\s*#{1,6}\s+/u, "").trim();
  const formatted = /^\[(?:hq|sup|supervisor|lead|peer|lens)\]\s*\[([^\]]+)\]\s*(.*)$/iu.exec(summary);
  let name = projectName(formatted?.[1] ?? project);
  if (formatted) summary = formatted[2];
  else {
    summary = summary.replace(
      /^(?:\[(?:hq|sup|supervisor|lead|peer|lens)\]|(?:hq|supervisor|lead|peer|lens)\s*[·|:–-])\s*/iu,
      "",
    );
    const candidates = [...new Set([name, ...knownProjects.map(projectName)])].sort(
      (a, b) => b.length - a.length,
    );
    const match = candidates.find(
      (candidate) =>
        summary === candidate ||
        (summary.startsWith(candidate) && /^[\s·|:–-]/u.test(summary.slice(candidate.length))),
    );
    if (match) {
      name = match;
      summary = summary
        .slice(match.length)
        .replace(/^[\s·|:–-]+/u, "")
        .replace(/^(?:HQ|Supervisor|Lead|Peer|Lens)(?:\s*[·|:–-]\s*|$)/iu, "");
    }
  }
  return `[${labels[role]}] [${name}]${summary ? ` ${compact(summary, 60)}` : ""}`;
}

export function namingInstruction(project: string, role: RoleName): string {
  const initial = agentTitle(project, role);
  return `Contextual naming is part of your ordinary work, not a separate task or model call. Use [${labels[role]}] [project] short purpose, for example ${JSON.stringify(`${initial} <short purpose>`)}. The actual project comes from the Human's request and the work you are doing, not necessarily this shared workspace's folder or room name. After understanding the task, use native update_agent with your own PASEO_AGENT_ID and name to replace a generic, stale or misleading title. Reconsider the title when the purpose materially changes; keep it when it still describes the work. Summarize the current objective in a few words in the Human's language, never copy long prompts, credentials, URLs or internal IDs. Keep your actual role prefix, including sup for supervisor. Read the current title immediately before changing it and preserve an explicit Human-fixed name or a later concurrent edit. When you own the work in a dedicated workspace, also use native rename_workspace for that exact workspace so its title reflects the current purpose. This standing naming preference authorizes contextual display-name updates; do not ask the Human to name it or to approve each rename. In a shared workspace, only its accountable owner updates the workspace title to the shared objective, using [team] [project] when multiple roles share it; a child may rename its own session, not the parent's workspace. A new child should receive its correct [role] [project] purpose and then refine it from its own context. Rename only when it improves accuracy: no per-turn churn, status counters or periodic renaming. Native rename tools lack atomic expected-title checks, so refresh before writing and avoid overwriting a changed title. Never change project paths, IDs, roles, ownership, settings, models, budgets or assignments as part of naming.`;
}
