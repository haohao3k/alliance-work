import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { z } from "zod";
import type { AutonomyState } from "../shared/autonomy";
import type { RoleName, RoomRecord } from "../shared/contracts";
import type { Contributor } from "../shared/integration.mjs";
import { KeepWarmPolicy, type WarmState } from "../shared/keepwarm";
import {
  allowedModel,
  defaultModelPolicy,
  GLOBAL_MODEL_POLICY,
  ModelPolicy,
  type ModelPolicyValue,
  modelPolicyWarnings,
  refusedModel,
  upgradeModelPolicy,
} from "../shared/model-policy";
import type { Obligation } from "../shared/obligations";
import { apartFromLimit, harnessOf } from "../shared/operations";
import type { WakeRecordValue } from "../shared/wakeups";
import { guardWrites, StoreBlockedError, storeAccess } from "./store-compat.mjs";

export interface TurnInputReceipt {
  turnId: string;
  startedAt: number;
  outcome: string;
  error?: string;
  path: string;
  endedAt: number;
  promptId?: string;
  maintenance: string[];
  handbackTurnId: string | null;
  handbackPath: string | null;
}
export interface TurnReadbackReceipt {
  id: string;
  agent: PluginHookAgent;
  turnId: string | null;
  startedAt?: number;
  endedAt: number;
  outcome: PluginTurnOutcome;
  error: string;
  /** An end event observed while that native turn is active needs a fresh end event. */
  awaitEndEvent?: boolean;
}

export type WakeSource =
  | "unknown"
  | "native.plain"
  | "alliance.wakeup"
  | "alliance.retry"
  | "alliance.continue"
  | "alliance.resume"
  | "alliance.account-switch";
export interface TurnWake {
  turnId: string | null;
  time: number;
  source: WakeSource;
  promptId?: string;
}

export interface MemberRecord {
  warm?: WarmState;
  turnWake?: TurnWake;
  wakeMessages?: { id: string; at: number; source: WakeSource }[];
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
  /** Most recent verified completed turn; retained when a later turn fails. Older releases ignore it. */
  lastSuccessfulTurn?: { endedAt: number; provider: string; model?: string };
  /** When Alliance received the latest start hook; bounds native notice attribution across reused turn IDs. */
  turnStartedAt?: number;
  /** Native input rows already inspected in this turn/generation; a new start clears the cursor. */
  turnInputCursor?: { epoch: string; seq: number };
  /** At most 16 unread native terminal receipts. Overflow remains held until explicit new work. */
  turnInputPending?: TurnInputReceipt & { following?: TurnInputReceipt[]; overflow?: true };
  turnReadbackPending?: TurnReadbackReceipt;
  /** Baseline for members recorded before turn end times existed. */
  staleSince?: number;
  /** Who recorded the decision: an agent ID, null for an unidentified caller, absent for legacy records. */
  decisionBy?: string | null;
  decisionAt?: string;
  decisionScope?: "technical" | "product";
  /** Frozen dependencies of a newly recorded integrated product decision (including an empty set). */
  decisionIntegration?: {
    contributorsStamp: string;
    contributors: z.infer<typeof Contributor>[];
    dispositionDigest: string;
  };
  /** The turn the decision reviewed; a later turn needs its own decision. */
  decisionTurnId?: string | null;
  /**
   * Explicitly kept open by its owner chain or the Human. `until` is when it lapses (releases before
   * 0.1.52 wrote none and read any keep as permanent); it also lapses when `by` is archived.
   */
  keep?: { by: string; at: string; reason?: string; until?: string };
  /**
   * Overdue-decision reminders sent for `turnId`: how many each owner up the chain received, when
   * the latest went out, and a start time that phases records already overdue at upgrade in. A
   * different turn starts afresh. Older releases ignore it.
   */
  remind?: { turnId: string; owners: Record<string, number>; at: number; notBefore?: number };
  /** The one reminder owed for a rejection nobody followed up, by that rejection's `decisionAt`. */
  rejectedRemind?: { decisionAt: string; notBefore?: number; sentAt?: number };
  /** The latest prompts this plugin sent to the agent, so they are not mistaken for new work. */
  pluginMessages?: { id: string; at: number }[];
  /** Set once Paseo reports the agent archived; a reopened agent clears it on its next turn. */
  archivedAt?: string;
  /**
   * Its latest turn ended on a provider limit that lifts at `until` (the reset plus a minute).
   * `messageId` is the plugin message that started that turn, if any. Cleared when a turn ends otherwise.
   */
  limited?: { until: number; messageId: string | null; account?: string };
  /**
   * Claude accounts this member's next prompt can run under (the launch receipt of its live
   * process, and the account selected for its next launch). Refreshed by the account sweep;
   * absent when unknown. Older releases ignore it.
   */
  claudeAccounts?: string[];
  /**
   * Its provider is signed out: prompts failed on sign-in `failures` times since `since`, and
   * Alliance sends it nothing by itself until `until` (0: not held yet). `reason` names what to do.
   */
  signIn?: { since: number; lastAt: number; failures: number; holds: number; until: number; reason: string };
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
/** True while Alliance must not prompt this member by itself: its provider is signed out. */
export const signInHeld = (member: Pick<MemberRecord, "signIn"> | null | undefined, now: number) =>
  (member?.signIn?.until ?? 0) > now;
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
  decisionIntegration: undefined,
  decisionTurnId: undefined,
  staleSince: undefined,
  // A running turn means Paseo reopened an agent it had archived.
  archivedAt: undefined,
  turnInputPending: undefined,
  turnReadbackPending: undefined,
});
export interface JobRecord {
  settlementHistory?: NonNullable<JobRecord["settlement"]>[];
  settlement?: {
    outcome: "succeeded" | "failed" | "superseded" | "unverified";
    reason: string;
    evidence: string;
    digest: string;
    at: string;
    actorId: string | null;
  };
  archivedAt?: string;
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
  private db: ReturnType<typeof guardWrites>;
  /** Set when a newer release marked this store as needing a newer writer: it is read, never written. */
  readonly readOnly: ReturnType<typeof storeAccess> | null = null;
  constructor(private home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const path = join(home, "rooms.sqlite");
    const raw = new DatabaseSync(path);
    // Before any write (journal mode, DDL), see whether a newer release marked the store.
    const access = storeAccess(raw);
    if (access.access !== "write") {
      raw.close();
      if (access.access === "none") throw new StoreBlockedError(access);
      this.readOnly = access;
      this.db = guardWrites(new DatabaseSync(path, { readOnly: true }));
      return;
    }
    this.db = guardWrites(raw);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, roomId TEXT NOT NULL, launchKey TEXT, data TEXT NOT NULL, UNIQUE(roomId, launchKey));
      CREATE TABLE IF NOT EXISTS jobs(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS autonomy(agentId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wakeups(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obligations(key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS obligation_history(key TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(key,revision));
      CREATE TABLE IF NOT EXISTS room_model_policies(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_keepwarm(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_model_policy_resets(roomId TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_model_policy_removed(id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, removedAt TEXT NOT NULL);`);
  }
  obligations(): Obligation[] {
    return (this.db.prepare("SELECT data FROM obligations ORDER BY rowid").all() as { data: string }[]).map(
      (r) => JSON.parse(r.data),
    );
  }
  keepwarm(roomId: string) {
    this.room(roomId);
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='room_keepwarm'")
      .get();
    const row = exists
      ? (this.db.prepare("SELECT revision,data FROM room_keepwarm WHERE roomId=?").get(roomId) as
          | { revision: number; data: string }
          | undefined)
      : undefined;
    return { revision: row?.revision ?? 0, ...KeepWarmPolicy.parse(row ? JSON.parse(row.data) : {}) };
  }
  setKeepwarm(
    roomId: string,
    enabled: boolean,
    actorId: string | null,
    maxPings?: number,
    disabledReason?: string,
  ) {
    if (actorId !== null) throw new Error("Keepwarm settings belong to the Human");
    const current = this.keepwarm(roomId);
    const policy = KeepWarmPolicy.parse({
      enabled,
      maxPings: maxPings ?? current.maxPings,
      minCtx: current.minCtx,
      ...(disabledReason ? { disabledAt: Date.now(), disabledReason } : {}),
    });
    this.db
      .prepare(
        "INSERT INTO room_keepwarm(roomId,revision,data) VALUES(?,?,?) ON CONFLICT(roomId) DO UPDATE SET revision=excluded.revision,data=excluded.data",
      )
      .run(roomId, current.revision + 1, JSON.stringify(policy));
    return this.keepwarm(roomId);
  }
  obligation(key: string): Obligation | undefined {
    const row = this.db.prepare("SELECT data FROM obligations WHERE key=?").get(key) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
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
  wakeup(key: string): WakeRecordValue | undefined {
    const row = this.db.prepare("SELECT data FROM wakeups WHERE key=?").get(key) as
      | { data: string }
      | undefined;
    return row ? JSON.parse(row.data) : undefined;
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
  job(key: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT data FROM jobs WHERE key=?").get(key) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
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

  modelPolicy(roomId: string): { revision: number; saved: boolean; policy: ModelPolicyValue } {
    if (roomId !== GLOBAL_MODEL_POLICY) this.room(roomId);
    const row = this.db.prepare("SELECT revision,data FROM room_model_policies WHERE roomId=?").get(roomId) as
      | { revision: number; data: string }
      | undefined;
    const global = roomId === GLOBAL_MODEL_POLICY ? null : this.modelPolicy(GLOBAL_MODEL_POLICY);
    return {
      revision: row?.revision ?? this.resetRevision(roomId) + (global?.revision ?? 0),
      saved: Boolean(row),
      policy: row
        ? ModelPolicy.parse(upgradeModelPolicy(JSON.parse(row.data)))
        : (global?.policy ?? defaultModelPolicy()),
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
    if (roomId !== GLOBAL_MODEL_POLICY) this.room(roomId);
    let removed: RemovedModelPolicy | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT revision,data FROM room_model_policies WHERE roomId=?")
        .get(roomId) as { revision: number; data: string } | undefined;
      const counter = this.resetRevision(roomId);
      if (
        expected !== undefined &&
        expected !==
          (row?.revision ??
            counter + (roomId === GLOBAL_MODEL_POLICY ? 0 : this.modelPolicy(GLOBAL_MODEL_POLICY).revision))
      )
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
    const warning = modelPolicyWarnings(parsed)[0];
    if (warning) throw new Error(warning.reason);
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
  updateRoomTitle(id: string, expected: string, title: string) {
    const room = this.room(id);
    if (room.title !== expected || room.nativeTitle !== expected) return;
    this.db
      .prepare("UPDATE rooms SET data=? WHERE id=?")
      .run(JSON.stringify({ ...room, title, nativeTitle: title }), id);
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
   * of the same harness still unarchived on this host. A Claude limit records the account it ran on, and releases
   * only members known to run the other named account (apartFromLimit); a limit or member with no
   * known account still holds every member of the harness (all Claude roles hit one limit on 2026-10-21).
   */
  heldUntil(agentId: string, now: number): number | null {
    const asker = this.member(agentId);
    const harness = harnessOf(asker?.provider ?? "");
    if (!harness) return null;
    const rows = this.db
      .prepare(
        "SELECT data FROM members WHERE json_extract(data, '$.provider') LIKE ? AND json_extract(data, '$.archivedAt') IS NULL AND json_extract(data, '$.limited.until') > ?",
      )
      .all(`alliance-${harness}-%`, now) as { data: string }[];
    let until: number | null = null;
    for (const { data } of rows) {
      const limited = (JSON.parse(data) as MemberRecord).limited;
      if (!limited || (harness === "claude" && apartFromLimit(limited.account, asker?.claudeAccounts)))
        continue;
      if (until === null || limited.until > until) until = limited.until;
    }
    return until;
  }
  /** Records which accounts a member can run under; absent means unknown. Writes only a change. */
  noteClaudeAccounts(id: string, accounts: string[] | undefined) {
    const current = this.member(id);
    if (!current || JSON.stringify(current.claudeAccounts) === JSON.stringify(accounts)) return;
    this.saveMember({ ...current, claudeAccounts: accounts });
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
  /** Remember a prompt the plugin sent to a member; only the latest few are kept. */
  notePluginMessage(id: string, messageId: string, at: number) {
    const member = this.member(id);
    if (member)
      this.updateMember(id, {
        pluginMessages: [...(member.pluginMessages ?? []).slice(-31), { id: messageId, at }],
      });
  }
  noteWakeMessage(id: string, messageId: string, source: WakeSource, at: number) {
    const member = this.member(id);
    if (member)
      this.updateMember(id, {
        wakeMessages: [...(member.wakeMessages ?? []).slice(-63), { id: messageId, at, source }],
      });
  }
  noteTurnWake(id: string, turnId: string | null, time: number, promptId?: string) {
    const member = this.member(id);
    if (!member) return;
    const sent = promptId ? member.wakeMessages?.find((m) => m.id === promptId) : undefined;
    const marker: TurnWake = {
      turnId,
      time,
      source: sent?.source ?? (promptId ? "native.plain" : "unknown"),
      ...(promptId ? { promptId } : {}),
    };
    if (JSON.stringify(member.turnWake) === JSON.stringify(marker)) return;
    this.updateMember(id, { turnWake: marker });
    // Measurement failure must not fail a native turn or change its lifecycle.
    try {
      appendFileSync(
        join(this.home, "wake-markers.jsonl"),
        `${JSON.stringify({ agentId: id, provider: member.provider, ...marker })}\n`,
        { mode: 0o600 },
      );
    } catch {
      /* The latest marker remains available in status. */
    }
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
