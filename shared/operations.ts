export function responsibleOwner(member: {
  parentId: string | null;
  ownership?: { ownerId: string | null };
}) {
  return member.ownership ? member.ownership.ownerId : member.parentId;
}

/** The harness of an Alliance provider alias (alliance-claude-peer → claude), or null. */
export const harnessOf = (provider: string) => /^alliance-(codex|claude|pi|agy)-/.exec(provider)?.[1] ?? null;

/** Not working: a finished session is idle, and closed once Paseo unloads it (e.g. after a restart). */
export const atRest = (status: string) => status === "idle" || status === "closed";

/**
 * Whether a plugin prompt may be sent now. Paseo loads a closed session when it receives a prompt,
 * so idle and closed agents qualify; an archived one would be restored by the send, a pending
 * permission must be answered first, and a provider that cannot load refuses the prompt.
 */
export function deliverable(agent: {
  status: string;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[] | null;
  providerUnavailable?: boolean;
}) {
  return (
    atRest(agent.status) &&
    !agent.archivedAt &&
    !agent.pendingPermissions?.length &&
    !agent.providerUnavailable
  );
}

export type OwnerAgent = { id: string; title: string; status: string; archived: boolean };
export function ownerState(id: string | null, agents: readonly OwnerAgent[]) {
  if (!id) return { ownerId: null, ownerLabel: "Human", ownerStatus: "human" };
  const agent = agents.find((a) => a.id === id);
  const available =
    agent &&
    !agent.archived &&
    ["idle", "running", "starting", "initializing", "awaiting_permission"].includes(agent.status);
  return {
    ownerId: id,
    ownerLabel: agent?.title || id,
    ownerStatus: available ? "available" : "needs-owner",
  };
}

export function acceptanceLabel(value: {
  decision: string;
  kind?: string | null;
  lastOutcome?: string | null;
}) {
  if (value.decision === "accepted") return `Accepted ${value.kind || "scope unspecified"}`;
  if (value.decision === "rejected") return "Rejected";
  return value.lastOutcome === "completed" ? "Turn finished · awaiting acceptance" : "Not accepted";
}
