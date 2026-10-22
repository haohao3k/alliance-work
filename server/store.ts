import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AutonomyState } from "../shared/autonomy";
import type { RoleName, RoomRecord } from "../shared/contracts";
import {
  allowedModel,
  defaultModelPolicy,
  ModelPolicy,
  type ModelPolicyValue,
  refusedModel,
  upgradeModelPolicy,
} from "../shared/model-policy";
import type { Obligation } from "../shared/obligations";
import { harnessOf } from "../shared/operations";
import type { WakeRecordValue } from "../shared/wakeups";

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
  ownership?: { ownerId: string | null; revision: number; evidence: string; at: string };
  policyAck?: { digest: string; at: string };
  /**
   * Its latest turn, with lastOutcome, resultPath and lastTurnEndedAt. A turn that keeps the phase
   * it found (Autonomy.carrying) leaves them, and the decision on them, as they were.
   */
  lastTurnId?: string | null;
  /** Epoch ms when the latest turn ended; drives the stale-decision reminder. */
  lastTurnEndedAt?: number;
  /** Baseline for members recorded before turn end times existed. */
  staleSince?: number;
  /** Who recorded the decision: an agent ID, null for the Human, absent for legacy records. */
  decisionBy?: string | null;
  decisionAt?: string;
  decisionScope?: "technical" | "product";
  /** The turn the decision reviewed; a later turn needs its own decision. */
  decisionTurnId?: string | null;
  /** Explicitly kept open by its owner chain or the Human; never auto-archived. */
  keep?: { by: string; at: string };
  /** Set once Paseo reports the agent archived; a reopened agent clears it on its next turn. */
  archivedAt?: string;
  /**
   * Its latest turn ended on a provider limit that lifts at `until` (the reset plus a minute).
   * `messageId` is the plugin message that started that turn, if any. Cleared when a turn ends otherwise.
   */
  limited?: { until: number; messageId: string | null };
  /**
   * Its running turn has shown no activity since `since` (ISO). `key` names the owner's notice,
   * null when no member owner is notified; cleared once the member works again or stops.
   */
  silence?: {
    turnId: string | null;
    since: string;
    key: string | null;
    notifiedAt: string | null;
  };
  /** Approval requests of its running turn and when Alliance first saw each (epoch ms). */
  approvals?: { id: string; since: number }[];
  /** The last approval request Alliance denied for it. */
  denied?: { requestId: string; tool: string; command: string | null; at: string };
  lastAcceptance?: {
    decision: "accepted" | "rejected";
    kind: string | null;
    candidate: string;
    target: string | null;
    at: string;
    evidence: string;
    product?: { outcome: string; journey: string; reviewer: string; remaining: string[] };
  };
}
/** A turn that is new work: its result is still to come and an earlier decision no longer applies. */
export const newTurn = (turnId: string | null): Partial<MemberRecord> => ({
  lastTurnId: turnId,
  lastOutcome: null,
  resultPath: null,
  decision: "open",
  decisionEvidence: null,
  decisionBy: undefined,
  decisionAt: undefined,
  decisionScope: undefined,
  decisionTurnId: undefined,
  staleSince: undefined,
  // A running turn means Paseo reopened an agent it had archived.
  archivedAt: undefined,
});
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
/** A saved model list a reset removed, kept raw in room_model_policy_removed under this id. */
export type RemovedModelPolicy = { id: number; revision: number; at: string };
export class RoomStore {
  private db: DatabaseSync;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(home, "rooms.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, roomId TEXT NOT NULL, launchKey TEXT, data TEXT NOT NULL, UNIQUE(roomId, launchKey));
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS autonomy(agentId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wakeups(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obligations(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obligation_history(key TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,revision));
      CREATE TABLE IF NOT EXISTS room_model_policies(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_model_policy_resets(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_model_policy_removed(id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, removedAt TEXT NOT NULL);`);
  }
  obligations(): Obligation[] {
    return (this.db.prepare("SELECT data FROM obligations ORDER BY rowid").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }
  obligationHistory(key: string): Obligation[] {
    return (
      this.db.prepare("SELECT data FROM obligation_history WHERE key=? ORDER BY revision").all(key) as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data));
  }
  atomic<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  // Caller includes this and related wakeup/job changes in one synchronous transaction.
  saveObligation(o: Obligation, revision?: number) {
    const data = JSON.stringify(o);
    const result =
      revision === undefined
        ? this.db
            .prepare("INSERT INTO obligations(key,revision,data) VALUES(?,?,?) ON CONFLICT DO NOTHING")
            .run(o.key, o.revision, data)
        : this.db
            .prepare("UPDATE obligations SET revision=?,data=? WHERE key=? AND revision=?")
            .run(o.revision, data, o.key, revision);
    if (!result.changes) throw new Error("Obligation changed; refresh owner and revision");
    this.db
      .prepare("INSERT INTO obligation_history(key,revision,data) VALUES(?,?,?)")
      .run(o.key, o.revision, data);
  }
  autonomous(): AutonomyState[] {
    return (this.db.prepare("SELECT data FROM autonomy ORDER BY agentId").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }
  autonomyOf(agentId: string): AutonomyState | undefined {
    const row = this.db.prepare("SELECT data FROM autonomy WHERE agentId=?").get(agentId) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  saveAutonomy(record: AutonomyState, revision?: number) {
    const result =
      revision === undefined
        ? this.db
            .prepare("INSERT INTO autonomy(agentId,revision,data) VALUES(?,?,?) ON CONFLICT DO NOTHING")
            .run(record.agentId, record.revision, JSON.stringify(record))
        : this.db
            .prepare("UPDATE autonomy SET revision=?,data=? WHERE agentId=? AND revision=?")
            .run(record.revision, JSON.stringify(record), record.agentId, revision);
    if (!result.changes) throw new Error("Autonomy changed; refresh before retrying");
  }
  /** The last one-time data migration this home ran (SQLite user_version; releases before 0.1.19 leave 0). */
  migration(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }
  /** Records that migration `step` ran; call it in that migration's transaction. */
  setMigration(step: number) {
    this.db.exec(`PRAGMA user_version=${Math.trunc(step)}`);
  }
  wakeups(): WakeRecordValue[] {
    return (this.db.prepare("SELECT data FROM wakeups ORDER BY rowid").all() as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  }
  saveWakeup(w: WakeRecordValue, revision?: number) {
    const result =
      revision === undefined
        ? this.db
            .prepare("INSERT INTO wakeups(key,revision,data) VALUES(?,?,?) ON CONFLICT DO NOTHING")
            .run(w.key, w.revision, JSON.stringify(w))
        : this.db
            .prepare("UPDATE wakeups SET revision=?,data=? WHERE key=? AND revision=?")
            .run(w.revision, JSON.stringify(w), w.key, revision);
    if (!result.changes) throw new Error("Wakeup changed; refresh before retrying");
  }
  /** Removes one finished record only if nobody changed it since it was read. */
  deleteWakeup(key: string, revision: number) {
    this.db.prepare("DELETE FROM wakeups WHERE key=? AND revision=?").run(key, revision);
  }
  claimWakeups(batch: WakeRecordValue[], messageId: string, now: number) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const claimed = batch.map((w) => ({
        ...w,
        revision: w.revision + 1,
        state: "dispatching" as const,
        runs: w.runs + 1,
        messageId,
        lastSentAt: now,
        updatedAt: now,
      }));
      for (let i = 0; i < batch.length; i++) this.saveWakeup(claimed[i], batch[i].revision);
      this.db.exec("COMMIT");
      return claimed;
    } catch {
      this.db.exec("ROLLBACK");
      return null;
    }
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
      revision: row?.revision ?? this.resetRevision(roomId),
      saved: Boolean(row),
      policy: row ? ModelPolicy.parse(upgradeModelPolicy(JSON.parse(row.data))) : defaultModelPolicy(),
    };
  }
  // A reset deletes the saved row (older releases then read their own defaults) but keeps the
  // revision counting up here, so an editor opened before the reset cannot overwrite a later save.
  private resetRevision(roomId: string) {
    const row = this.db.prepare("SELECT revision FROM room_model_policy_resets WHERE roomId=?").get(roomId) as
      | { revision: number }
      | undefined;
    return row?.revision ?? 0;
  }
  /** Drop the room's saved policy so it follows the release defaults again. The saved row is not
   * parsed, so an unreadable list can still be cleared; its raw text is kept in
   * room_model_policy_removed (id returned as `removed`). With `expected`, refuse if it changed. */
  resetModelPolicy(
    roomId: string,
    expected?: number,
  ): ReturnType<RoomStore["modelPolicy"]> & { removed?: RemovedModelPolicy } {
    this.room(roomId);
    let removed: RemovedModelPolicy | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT revision,data FROM room_model_policies WHERE roomId=?")
        .get(roomId) as { revision: number; data: string } | undefined;
      const counter = this.resetRevision(roomId);
      if (expected !== undefined && expected !== (row?.revision ?? counter))
        throw new Error("Model policy changed elsewhere. Reload settings before resetting.");
      // An older release may have saved below the counter; never let the revision go back.
      this.db
        .prepare(
          "INSERT INTO room_model_policy_resets(roomId,revision) VALUES(?,?) ON CONFLICT(roomId) DO UPDATE SET revision=excluded.revision",
        )
        .run(roomId, Math.max(row?.revision ?? 0, counter) + 1);
      if (row) {
        const at = new Date().toISOString();
        const kept = this.db
          .prepare("INSERT INTO room_model_policy_removed(roomId,revision,data,removedAt) VALUES(?,?,?,?)")
          .run(roomId, row.revision, row.data, at);
        removed = { id: Number(kept.lastInsertRowid), revision: row.revision, at };
      }
      this.db.prepare("DELETE FROM room_model_policies WHERE roomId=?").run(roomId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...this.modelPolicy(roomId), ...(removed ? { removed } : {}) };
  }
  saveModelPolicy(roomId: string, policy: ModelPolicyValue, revision: number) {
    const current = this.modelPolicy(roomId);
    const parsed = ModelPolicy.parse(policy);
    const refused = parsed.routes.find((route) => !allowedModel(route.harness, route.model));
    if (refused) throw new Error(`${refusedModel(refused.model)} Remove that ${refused.role} route to save.`);
    const data = JSON.stringify(parsed);
    const result = current.saved
      ? this.db
          .prepare("UPDATE room_model_policies SET revision=revision+1,data=? WHERE roomId=? AND revision=?")
          .run(data, roomId, revision)
      : revision === current.revision
        ? this.db
            .prepare(
              "INSERT INTO room_model_policies(roomId,revision,data) VALUES(?,?,?) ON CONFLICT DO NOTHING",
            )
            .run(roomId, revision + 1, data)
        : { changes: 0 };
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
  /**
   * When the provider limit this agent shares lifts, or null: the latest reset reported by a member
   * of the same harness on this host. The credential behind a role is not read, so every member of
   * that harness counts as sharing it (all Claude roles of a host hit one limit on 2026-10-21).
   */
  heldUntil(agentId: string, now: number): number | null {
    const harness = harnessOf(this.member(agentId)?.provider ?? "");
    if (!harness) return null;
    const { until } = this.db
      .prepare(
        "SELECT MAX(json_extract(data, '$.limited.until')) AS until FROM members WHERE json_extract(data, '$.provider') LIKE ?",
      )
      .get(`alliance-${harness}-%`) as { until: number | null };
    return until !== null && until > now ? until : null;
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
  saveOwnership(id: string, ownership: NonNullable<MemberRecord["ownership"]>, revision: number) {
    const result = this.db
      .prepare(`UPDATE members SET data=json_set(data, '$.ownership', json(?))
      WHERE id=? AND COALESCE(json_extract(data, '$.ownership.revision'), 0)=?`)
      .run(JSON.stringify(ownership), id, revision);
    if (!result.changes) throw new Error("Owner changed; refresh before handing off");
  }
  close() {
    this.db.close();
  }
}
