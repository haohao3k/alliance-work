type Activity = { status: string; archived: boolean };
type Color = "statusSuccess" | "statusWarning" | "statusDanger" | "foregroundMuted";
type State = {
  label: string;
  group: "working" | "attention" | "idle" | "other";
  color: Color;
  order: number;
};

export function activityState(member: Activity): State {
  if (member.archived) return { label: "Archived", group: "other", color: "foregroundMuted", order: 5 };
  if (["awaiting_permission", "awaiting-permission"].includes(member.status))
    return { label: "Permission", group: "attention", color: "statusWarning", order: 0 };
  if (["error", "failed"].includes(member.status))
    return { label: "Error", group: "attention", color: "statusDanger", order: 0 };
  if (["running", "starting", "initializing"].includes(member.status))
    return {
      label: member.status === "running" ? "Working" : "Starting",
      group: "working",
      color: "statusSuccess",
      order: 1,
    };
  if (member.status === "idle") return { label: "Idle", group: "idle", color: "foregroundMuted", order: 2 };
  if (["closed", "stopped"].includes(member.status))
    return { label: "Closed", group: "other", color: "foregroundMuted", order: 4 };
  return { label: "Unavailable", group: "attention", color: "statusWarning", order: 0 };
}

export function relativeTime(timestamp: string | null, now: number): string {
  if (!timestamp) return "—";
  const elapsed = now - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.max(0, Math.floor(elapsed / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
