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
