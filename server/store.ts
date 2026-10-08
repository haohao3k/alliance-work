import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoleName, RoomRecord } from "../shared/contracts";

export interface MemberRecord {
  id: string;
  roomId: string;
  role: RoleName;
  provider: string;
  parentId: string | null;
  assignment: string;
  lastOutcome: string | null;
  resultPath: string | null;
  decision: "open" | "accepted" | "rejected";
  decisionEvidence: string | null;
  launchKey: string | null;
  launchHash: string | null;
  lastTurnId?: string | null;
}
export class RoomStore {
  private db: DatabaseSync;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "rooms.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, roomId TEXT NOT NULL, launchKey TEXT, data TEXT NOT NULL, UNIQUE(roomId, launchKey));`);
  }
  rooms(): RoomRecord[] {
    return (this.db.prepare("SELECT data FROM rooms ORDER BY rowid DESC").all() as { data: string }[]).map(
      (row) => JSON.parse(row.data),
    );
  }
  room(id: string): RoomRecord {
    const row = this.db.prepare("SELECT data FROM rooms WHERE id=?").get(id) as { data: string } | undefined;
    if (!row) throw new Error(`Unknown room: ${id}`);
    return JSON.parse(row.data);
  }
  addRoom(room: RoomRecord) {
    this.db
      .prepare("INSERT INTO rooms(id,cwd,data) VALUES(?,?,?)")
      .run(room.id, room.cwd, JSON.stringify(room));
  }
  members(roomId?: string): MemberRecord[] {
    const rows = roomId
      ? this.db.prepare("SELECT data FROM members WHERE roomId=?").all(roomId)
      : this.db.prepare("SELECT data FROM members").all();
    return (rows as { data: string }[]).map((row) => JSON.parse(row.data));
  }
  member(id: string): MemberRecord | null {
    const row = this.db.prepare("SELECT data FROM members WHERE id=?").get(id) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  byLaunch(roomId: string, key: string): MemberRecord | null {
    const row = this.db.prepare("SELECT data FROM members WHERE roomId=? AND launchKey=?").get(roomId, key) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  saveMember(member: MemberRecord) {
    this.db
      .prepare(
        "INSERT INTO members(id,roomId,launchKey,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(member.id, member.roomId, member.launchKey, JSON.stringify(member));
  }
  updateMember(id: string, change: Partial<MemberRecord>) {
    // Synchronous read/modify/write in one writer; no await can overwrite a newer lifecycle event.
    const current = this.member(id);
    if (!current) throw new Error(`Unknown room member: ${id}`);
    this.saveMember({ ...current, ...change });
  }
  close() {
    this.db.close();
  }
}
