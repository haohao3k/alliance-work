import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * 0.1.19 gives each owned member a handback-only record so its handbacks reach its owner. Older
 * releases would treat it as an assignment (retrying a failed turn, continuing after rework), so a
 * rollback below 0.1.19 removes them; those members fall back to the 48-hour reminder. A turn that
 * kept the phase (a wake batch's, or one Claude Code started by itself) moved only the record and
 * left the member on the handback it found; older releases review the record's turn, which must be
 * the member's, so each such record is set back on its member's turn. Writes the room database
 * directly, like the other rollback checks. Returns how many records were removed.
 */
export function dropHandbackRecords(home) {
  const path = join(home, "rooms.sqlite");
  if (!existsSync(path)) return 0;
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='autonomy'").get()) return 0;
    const removed = Number(
      db.prepare("DELETE FROM autonomy WHERE json_extract(data, '$.handbackOnly') = 1").run().changes,
    );
    const member = (field) =>
      `(SELECT json_extract(m.data, '$.${field}') FROM members m WHERE m.id = autonomy.agentId)`;
    db.prepare(
      `UPDATE autonomy SET revision = revision + 1,
         data = json_set(data, '$.turnId', ${member("lastTurnId")}, '$.outcome', ${member("lastOutcome")},
           '$.wakeTurnId', NULL, '$.revision', revision + 1)
       WHERE json_extract(data, '$.wakeTurnId') = json_extract(data, '$.turnId')
         AND ${member("lastTurnId")} <> json_extract(data, '$.turnId')`,
    ).run();
    return removed;
  } finally {
    db.close();
  }
}
