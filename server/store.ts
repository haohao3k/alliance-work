import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RoleName, RoomRecord } from "../shared/contracts";
import { defaultModelPolicy, ModelPolicy, type ModelPolicyValue } from "../shared/model-policy";

export interface MemberRecord {
  id: string;
  roomId: string;
  role: RoleName;
  provider: string;
  parentId: string | null;
  assignment: string;
  cwd?: string;
  lastOutcome: string | null;
  resultPath: string | null;
  decision: "open" | "accepted" | "rejected";
  decisionEvidence: string | null;
  launchKey: string | null;
  launchHash: string | null;
  launchModel?: string;
  launchEffort?: string;
  lastTurnId?: string | null;
  lastAcceptance?: {
    decision: "accepted" | "rejected";
    kind: string | null;
    candidate: string;
    target: string | null;
    at: string;
    evidence: string;
  };
}
export interface JobRecord {
  key: string;
  roomId: string;
  ownerId: string;
  title: string;
  pid: number;
  processIdentity: string;
  recordedAt: string;
  revision: number;
}
export class RoomStore {
  private db: DatabaseSync;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "rooms.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, roomId TEXT NOT NULL, launchKey TEXT, data TEXT NOT NULL, UNIQUE(roomId, launchKey));
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_model_policies(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  jobs(): JobRecord[] {
    return (this.db.prepare("SELECT data FROM jobs ORDER BY key").all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }
  saveJob(job: JobRecord, expectedRevision?: number) {
    const result =
      expectedRevision === undefined
        ? this.db
            .prepare("INSERT INTO jobs(key,data) VALUES(?,?) ON CONFLICT DO NOTHING")
            .run(job.key, JSON.stringify(job))
        : this.db
            .prepare("UPDATE jobs SET data=? WHERE key=? AND json_extract(data, '$.revision')=?")
            .run(JSON.stringify(job), job.key, expectedRevision);
    if (!result.changes) throw new Error("Job changed; refresh before updating ownership");
  }

  modelPolicy(roomId: string) {
    this.room(roomId);
    const row = this.db.prepare("SELECT revision,data FROM room_model_policies WHERE roomId=?").get(roomId) as
      | { revision: number; data: string }
      | undefined;
    return {
      revision: row?.revision ?? 0,
      policy: row ? ModelPolicy.parse(JSON.parse(row.data)) : defaultModelPolicy(),
    };
  }
  saveModelPolicy(roomId: string, policy: ModelPolicyValue, revision: number) {
    this.room(roomId);
    const data = JSON.stringify(ModelPolicy.parse(policy));
    const result =
      revision === 0
        ? this.db
            .prepare(
              "INSERT INTO room_model_policies(roomId,revision,data) VALUES(?,1,?) ON CONFLICT DO NOTHING",
            )
            .run(roomId, data)
        : this.db
            .prepare(
              "UPDATE room_model_policies SET revision=revision+1,data=? WHERE roomId=? AND revision=?",
            )
            .run(data, roomId, revision);
    if (!result.changes) throw new Error("Model policy changed elsewhere. Reload settings before saving.");
    return this.modelPolicy(roomId);
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
