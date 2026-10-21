import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** True when a list names one harness/model/effort for both Peer and Lens. Releases before
 * 0.1.18 keyed routes without a role and reject such a list. */
export function sharesRouteAcrossRoles(policy) {
  const keys = (policy?.routes ?? []).map((route) => `${route.harness}/${route.model}/${route.effort}`);
  return new Set(keys).size !== keys.length;
}

/** Rooms whose saved list a release before 0.1.18 could not read. Reads the room database
 * directly, so it works with a stopped daemon or a broken plugin (the usual reasons to roll back). */
export function roomsUnreadableBefore0118(home) {
  const path = join(home, "rooms.sqlite");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_model_policies'").get())
      return [];
    const titles = new Map(
      db
        .prepare("SELECT id, data FROM rooms")
        .all()
        .map((row) => [row.id, JSON.parse(row.data).title ?? row.id]),
    );
    return db
      .prepare("SELECT roomId, data FROM room_model_policies")
      .all()
      .filter((row) => {
        try {
          return sharesRouteAcrossRoles(JSON.parse(row.data));
        } catch {
          return true; // unreadable here is unreadable there too
        }
      })
      .map((row) => `${titles.get(row.roomId) ?? "unknown room"} (${row.roomId})`);
  } finally {
    db.close();
  }
}
