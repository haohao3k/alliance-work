import type { z } from "zod";
import type { roomList } from "./contracts";
import { activityState } from "./monitor";

export type RoomSnapshot = z.infer<typeof roomList.output>;
export type SessionFilter = "all" | "working" | "attention" | "idle";
type Member = RoomSnapshot["members"][number];

export function needsAttention(member: Member) {
  return Boolean(
    activityState(member).group === "attention" ||
      member.ownerStatus === "needs-owner" ||
      member.error ||
      member.silence ||
      (member.signIn?.until ?? 0) > Date.now() ||
      member.denied ||
      member.lifecycle?.needsHuman ||
      (member.selectedModel && member.runtimeModel && member.selectedModel !== member.runtimeModel),
  );
}

/** Index one status result once; clocks, disclosure and search do not rescan every collection per room. */
export function indexRoomBoard(snapshot: RoomSnapshot | undefined, archived: boolean) {
  const rooms = snapshot?.rooms ?? [];
  const members = (snapshot?.members ?? []).filter((member) => archived || !member.archived);
  const openObligations = (snapshot?.obligations ?? []).filter((item) => item.state === "open");
  const counts = { all: members.length, working: 0, attention: 0, idle: 0 };
  const byRoom = new Map(
    rooms.map((room) => [
      room.id,
      {
        room,
        members: [] as Member[],
        jobs: [] as RoomSnapshot["jobs"],
        obligations: [] as RoomSnapshot["obligations"],
        wakeups: [] as RoomSnapshot["wakeups"],
        attention: 0,
      },
    ]),
  );
  for (const member of members) {
    const group = activityState(member).group;
    if (group === "working" || group === "idle") counts[group]++;
    const attention = needsAttention(member);
    if (attention) counts.attention++;
    const entry = byRoom.get(member.roomId);
    if (entry) {
      entry.members.push(member);
      if (attention) entry.attention++;
    }
  }
  for (const job of snapshot?.jobs ?? []) {
    if (archived || !job.archivedAt || job.state !== "exited") byRoom.get(job.roomId)?.jobs.push(job);
  }
  for (const obligation of openObligations) byRoom.get(obligation.roomId)?.obligations.push(obligation);
  for (const wakeup of snapshot?.wakeups ?? []) {
    if (!["acknowledged", "canceled", "expired"].includes(wakeup.state))
      byRoom.get(wakeup.roomId)?.wakeups.push(wakeup);
  }
  for (const group of byRoom.values())
    group.members.sort(
      (a, b) => activityState(a).order - activityState(b).order || a.title.localeCompare(b.title),
    );
  const jobOrder = { unknown: 0, running: 1, exited: 2 };
  for (const group of byRoom.values()) group.jobs.sort((a, b) => jobOrder[a.state] - jobOrder[b.state]);
  return { rooms, members, openObligations, counts, byRoom };
}

export function roomJobPage(jobs: RoomSnapshot["jobs"], limit: number) {
  return { visible: jobs.slice(0, limit), remaining: Math.max(0, jobs.length - limit) };
}

export function filterRoomBoard(
  board: ReturnType<typeof indexRoomBoard>,
  { project, filter, search }: { project: string | null; filter: SessionFilter; search: string },
) {
  const needle = search.trim().toLowerCase();
  return [...board.byRoom.values()]
    .filter(({ room }) => !project || project === room.id)
    .map((group) => ({
      ...group,
      members: group.members.filter(
        (member) =>
          (filter === "all" ||
            (filter === "attention" ? needsAttention(member) : activityState(member).group === filter)) &&
          (!needle ||
            `${group.room.title} ${group.room.cwd} ${member.title} ${member.role} ${member.model ?? ""} ${member.ownerLabel}`
              .toLowerCase()
              .includes(needle)),
      ),
    }))
    .filter(
      ({ room, members, jobs, obligations, wakeups }) =>
        members.length ||
        ((filter === "all" || jobs.length || obligations.length || wakeups.length) &&
          (!needle || `${room.title} ${room.cwd}`.toLowerCase().includes(needle))),
    );
}

export function projectIsExpanded(
  explicitlyExpanded: boolean,
  { focused, filter, search }: { focused: boolean; filter: SessionFilter; search: string },
) {
  return explicitlyExpanded || focused || filter !== "all" || Boolean(search.trim());
}
