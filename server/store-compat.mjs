import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Store level: which layout of rooms.sqlite a release reads and writes. Level 1 is the layout shared by
 * 0.1.19 through 0.1.52, so a store with no marker is level 1. A release that changes the store so
 * that an older one would misread or damage it records, in table store_compat, the lowest level a
 * reader (`read_level`) and a writer (`write_level`, default read_level) needs, plus `marked_by`
 * (its version). This code compares them with STORE_LEVEL and refuses what it does not understand.
 *
 * The marker is deliberately not SQLite user_version: that is the one-time data-migration counter
 * and releases 0.1.19-0.1.51 treat any value >= 1 as "done". They never open store_compat, so the
 * marker cannot change what they do. Additive changes (a new table, a new JSON field an old release
 * ignores) must not raise it, or every future release would lock out the one before it after a
 * rollback. Docs: docs/operations.md, "Store level".
 */
export const STORE_LEVEL = 1;
const TABLE = "store_compat";
const UNRECOGNIZED = Number.POSITIVE_INFINITY;

/** The version of this release, for messages; "this release" if package.json is not beside it. */
export function releaseVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "this release";
  }
}

const level = (value) => (value === undefined ? 0 : /^\d+$/.test(value) ? Number(value) : UNRECOGNIZED);

/**
 * What a store's marker allows this code. `db` is any open node:sqlite connection.
 * access: "write" (unmarked, or marked at or below `supported`), "read" (it may be read but not
 * written) or "none" (neither). `message` explains a refusal and says what to do.
 */
export function storeAccess(db, supported = STORE_LEVEL, version = releaseVersion()) {
  const marked = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  const rows = marked ? db.prepare(`SELECT key, value FROM ${TABLE}`).all() : [];
  const value = Object.fromEntries(rows.map((row) => [row.key, String(row.value)]));
  const readLevel = level(value.read_level);
  const writeLevel = Math.max(level(value.write_level), readLevel);
  const markedBy = value.marked_by || "a newer release";
  const access = readLevel > supported ? "none" : writeLevel > supported ? "read" : "write";
  const needed = (n) => (n === UNRECOGNIZED ? "a level it does not recognize" : `store level ${n}`);
  const message =
    access === "write"
      ? null
      : `Alliance ${version} cannot ${access === "none" ? "open" : "write"} rooms.sqlite: Alliance ${markedBy} marked it as needing ${needed(access === "none" ? readLevel : writeLevel)}, and this release supports up to store level ${supported}. ${
          access === "read"
            ? "Reads and status still work; nothing is written. "
            : "Nothing was read or written. "
        }Update Alliance to ${markedBy} or newer (alliance-work update), or go back by running \`alliance-work rollback\` from the release that marked it: its rollback converts the store and lowers the marker. Nothing was deleted.`;
  return { access, level: supported, readLevel, writeLevel, markedBy, version, message };
}

/** Raised for a write (or an open) the marker forbids; `.access` carries the storeAccess result. */
export class StoreBlockedError extends Error {
  constructor(result) {
    super(result.message);
    this.name = "StoreBlockedError";
    this.access = result;
  }
}

/**
 * Wraps a connection so every write first checks the marker again, inside the write lock when it
 * starts a transaction: a release that marks the store while this code runs stops its next write.
 * Reads pass through. COMMIT and ROLLBACK are never refused, so a refused transaction can end.
 */
export function guardWrites(db, supported = STORE_LEVEL) {
  const check = () => {
    const result = storeAccess(db, supported);
    if (result.access !== "write") throw new StoreBlockedError(result);
  };
  return {
    exec(sql) {
      if (/^\s*(COMMIT|ROLLBACK|END)\b/i.test(sql)) return db.exec(sql);
      if (!/^\s*BEGIN\b/i.test(sql)) {
        check();
        return db.exec(sql);
      }
      db.exec(sql);
      try {
        check();
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args),
        run: (...args) => {
          check();
          return statement.run(...args);
        },
      };
    },
    close: () => db.close(),
  };
}

/**
 * For a release that changes the store incompatibly (not used by 0.1.52): record the levels it
 * needs, or lower them again when it rolls back after converting the store. A write level at or
 * below STORE_LEVEL, with no read level above it, removes the marker, which is how a store looks
 * to every release before and including this one.
 */
export function setStoreMarker(db, { writeLevel, readLevel = 0, by }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (Math.max(writeLevel, readLevel) <= STORE_LEVEL) db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
    else {
      db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      const put = db.prepare(`INSERT OR REPLACE INTO ${TABLE}(key,value) VALUES(?,?)`);
      put.run("write_level", String(writeLevel));
      put.run("read_level", String(readLevel));
      put.run("marked_by", by);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * The marker's verdict for the store in `home`, read-only and without creating anything, so it
 * works with the plugin stopped (doctor, rollback). Null when there is no store yet.
 * node:sqlite is loaded here so commands that never look do not print its experimental warning.
 */
export async function storeAccessAt(home, supported = STORE_LEVEL) {
  const path = join(home, "rooms.sqlite");
  if (!existsSync(path)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return storeAccess(db, supported);
  } finally {
    db.close();
  }
}
