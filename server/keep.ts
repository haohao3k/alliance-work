import type { MemberRecord, RoomStore } from "./store";

/** A keep outlasts neither this lifetime nor its keeper; the keeper sets a different one explicitly. */
export const KEEP_DEFAULT_HOURS = 24;
export const KEEP_MAX_HOURS = 30 * 24;

/**
 * The keep that still holds this member open, as the blocker names it, or null. A keep set by a
 * release before lifetimes existed has no `until` and holds until lifted; every keep ends when
 * its keeper (an agent, not the Human) is archived, because nobody is left to follow up.
 */
export function keepBlocker(store: RoomStore, member: MemberRecord, now: number) {
  const keep = member.keep;
  if (!keep) return null;
  if (keep.until !== undefined && Date.parse(keep.until) <= now) return null;
  if (keep.by !== "Human" && keep.by !== member.id && store.member(keep.by)?.archivedAt) return null;
  const until = keep.until === undefined ? "" : ` until ${keep.until}`;
  const why = keep.reason ? `: ${keep.reason}` : "";
  return `kept open by ${keep.by}${until}${why} (members keep --off lifts it)`;
}
