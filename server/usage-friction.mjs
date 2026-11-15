import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readUsageDatabase, sqliteSnapshotBasis } from "./usage-sqlite.mjs";

const DAY = 86400000;
const number = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
const timestamp = (v) => (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN);
function weekOf(time, tz) {
  const date = new Date(time + tz * 3600000);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
const ownerOf = (m) => (m.ownership ? m.ownership.ownerId : m.parentId);

// Mirrors the durable part of Lifecycle.needsHuman. Live native archive/unseen-turn information
// is unavailable to this offline command, so this is explicitly a stored-state estimate.
function humanWaiting(members, autonomy, wakeups, obligations, now) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const byAgent = new Map(autonomy.map((a) => [a.agentId, a]));
  return members.filter((m) => {
    const since = timestamp(m.lastTurnEndedAt ?? m.staleSince);
    if (
      m.archivedAt ||
      m.decision !== "open" ||
      m.lastOutcome !== "completed" ||
      !m.lastTurnId ||
      !(now - since >= 2 * DAY)
    )
      return false;
    const a = byAgent.get(m.id);
    if (a && ["active", "archived"].includes(a.phase)) return false;
    if (a?.phase === "waiting") {
      if (obligations.some((o) => o.key === a.obligationKey && o.state === "open" && o.ownerId === m.id))
        return false;
      if (
        wakeups.some(
          (w) =>
            w.ownerId === m.id &&
            w.delivery === "idle" &&
            ["scheduled", "pending", "dispatching"].includes(w.state),
        )
      )
        return false;
      if (
        members.some(
          (c) =>
            ownerOf(c) === m.id &&
            !c.archivedAt &&
            c.lastOutcome === null &&
            (c.lastTurnId ||
              (byAgent.get(c.id)?.turnId === null &&
                byAgent.get(c.id).outcome === null &&
                now - byAgent.get(c.id).updatedAt < 10 * 60000)),
        )
      )
        return false;
    }
    const owners = [];
    const visited = new Set([m.id]);
    let owner = ownerOf(m);
    while (owner && !visited.has(owner)) {
      visited.add(owner);
      const parent = byId.get(owner);
      if (!parent) break;
      if (!parent.archivedAt) owners.push(owner);
      owner = ownerOf(parent);
    }
    if (!owners.length) return true;
    const r = m.remind?.turnId === m.lastTurnId ? m.remind : null;
    return Boolean(r && owners.every((id) => (r.owners?.[id] ?? 0) >= 3) && (!r.at || now - r.at >= DAY));
  }).length;
}

export async function collectFriction({ home, since, until, tz = 0, now = Date.now() }) {
  const result = {
    available: false,
    sqlite_snapshot: sqliteSnapshotBasis,
    snapshot_at: new Date(now).toISOString(),
    basis:
      "Retained local records only; weeks start Monday in the selected timezone. review.wait/superseded use handback-created cohorts and first disposition before the next handback. review.reject uses disposition time. review.defer is the retained cumulative snapshot grouped by its latest update, not weekly defer events. human.waiting is a current stored-state estimate (no native readback), available only in the current week; historical snapshots are unavailable. Retention and missing dispositions may undercount.",
    metric_basis: {
      "review.wait":
        "Milliseconds from one retained handback-created cohort to its first disposition, bounded by the next handback when legacy dispositions lack turn IDs; p50/p90 nearest rank.",
      "review.superseded":
        "Retained handback cohorts canceled as Turn superseded or decided without a matching disposition; inference, not an explicit superseded event.",
      "review.reject":
        "Rejected disposition events, by disposition timestamp; repeated rejections are separate rounds.",
      "review.defer":
        "Retained cumulative wakeup.defers snapshot, assigned to the wakeup latest-update week; not weekly defer event counts.",
      "human.waiting":
        "Current stored-state estimate as of snapshot_at; no native readback or historical snapshots. Null outside the current snapshot window or with missing source tables.",
    },
    coverage: {
      unreadable_store: 0,
      store_unavailable_reason: /** @type {string|null} */ (null),
      missing_tables: [],
      bad_records: 0,
      unreadable_dispositions: 0,
      unmatched_reviews: 0,
      terminal_wakeup_retention_ms: 7 * DAY,
      oldest_retained_review_at: /** @type {string|null} */ (null),
      newest_retained_review_at: /** @type {string|null} */ (null),
    },
    weeks:
      /** @type {Array<{week: string, "review.wait": {samples: number|null, p50_ms: number|null, p90_ms: number|null}, "review.superseded": number|null, "review.reject": number|null, "review.defer": number|null, "human.waiting": number|null, rejecting_agents: number, max_reject_rounds: number}>} */ ([]),
  };
  let db;
  const tables = {};
  try {
    db = await readUsageDatabase(join(home, "rooms.sqlite"));
    db.exec("BEGIN");
    for (const table of ["rooms", "members", "wakeups", "autonomy", "obligations"]) {
      const rows = [];
      try {
        for (const row of db.prepare(`SELECT data FROM ${table}`).iterate()) {
          try {
            rows.push(JSON.parse(row.data));
          } catch {
            result.coverage.bad_records++;
          }
        }
      } catch {
        result.coverage.missing_tables.push(table);
      }
      tables[table] = rows;
    }
    result.available = true;
  } catch (error) {
    result.coverage.unreadable_store++;
    result.coverage.store_unavailable_reason = error.code?.startsWith("USAGE_SQLITE_")
      ? error.message
      : "unreadable";
  } finally {
    db?.close();
  }
  if (!result.available) return result;
  const weeks = new Map();
  const bucket = (time) => {
    if (!Number.isFinite(time) || time < since || time >= until) return null;
    const key = weekOf(time, tz);
    if (!weeks.has(key))
      weeks.set(key, {
        week: key,
        "review.wait": [],
        "review.superseded": 0,
        "review.reject": 0,
        "review.defer": 0,
        "human.waiting": null,
        rejections: new Map(),
      });
    return weeks.get(key);
  };
  // Empty weeks are real zeroes for retained events; missing store/tables are reported separately.
  for (let at = since; at < until; at += DAY) bucket(at);
  bucket(until - 1);
  const dispositions = new Map();
  const seenFiles = new Set();
  for (const room of tables.rooms) {
    if (typeof room.artifacts !== "string") continue;
    const root = join(room.artifacts, "dispositions");
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(root, entry.name);
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      try {
        const d = JSON.parse(await readFile(path, "utf8"));
        const time = timestamp(d.at);
        if (
          typeof d.agentId !== "string" ||
          !["accepted", "rejected"].includes(d.decision) ||
          !Number.isFinite(time)
        ) {
          result.coverage.bad_records++;
          continue;
        }
        const list = dispositions.get(d.agentId) ?? [];
        list.push({ time, turnId: d.turnId ?? d.decisionTurnId });
        dispositions.set(d.agentId, list);
        const b = bucket(time);
        if (b && d.decision === "rejected") {
          b["review.reject"]++;
          b.rejections.set(d.agentId, (b.rejections.get(d.agentId) ?? 0) + 1);
        }
      } catch {
        result.coverage.unreadable_dispositions++;
      }
    }
  }
  const reviews = new Map();
  for (const w of tables.wakeups) {
    const b = bucket(timestamp(w.updatedAt));
    if (b) b["review.defer"] += number(w.defers);
    if (w.trigger?.kind !== "turn" || !w.trigger.agentId || !w.trigger.turnId) continue;
    const key = `${w.trigger.agentId}\0${w.trigger.turnId}`;
    const previous = reviews.get(key);
    // More than one owner/reminder can refer to the same handback: it is one review episode.
    if (!previous || w.createdAt < previous.createdAt) reviews.set(key, w);
  }
  const reviewTimes = [...reviews.values()].map((w) => timestamp(w.createdAt)).filter(Number.isFinite);
  if (reviewTimes.length) {
    result.coverage.oldest_retained_review_at = new Date(Math.min(...reviewTimes)).toISOString();
    result.coverage.newest_retained_review_at = new Date(Math.max(...reviewTimes)).toISOString();
  }
  const byAgent = new Map();
  for (const w of reviews.values()) {
    const list = byAgent.get(w.trigger.agentId) ?? [];
    list.push(w);
    byAgent.set(w.trigger.agentId, list);
  }
  for (const [id, list] of byAgent) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    const decisions = (dispositions.get(id) ?? []).sort((a, b) => a.time - b.time);
    for (let i = 0; i < list.length; i++) {
      const w = list[i];
      const b = bucket(timestamp(w.createdAt));
      if (!b) continue;
      const end = list[i + 1]?.createdAt ?? Infinity;
      const d = decisions.find(
        (d) =>
          d.time >= w.createdAt &&
          d.time < until &&
          (d.turnId ? d.turnId === w.trigger.turnId : d.time < end),
      );
      if (d) b["review.wait"].push(d.time - w.createdAt);
      else {
        result.coverage.unmatched_reviews++;
        if (w.state === "canceled" && w.updatedAt < until && w.note === "Turn superseded or decided")
          b["review.superseded"]++;
      }
    }
  }
  const current = now >= since && until >= now - 60000 ? bucket(Math.min(now, until - 1)) : null;
  if (
    current &&
    !["members", "autonomy", "wakeups", "obligations"].some((t) => result.coverage.missing_tables.includes(t))
  )
    current["human.waiting"] = humanWaiting(
      tables.members,
      tables.autonomy,
      tables.wakeups,
      tables.obligations,
      now,
    );
  result.weeks = [...weeks.values()]
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((b) => {
      const wait = b["review.wait"].sort((a, b) => a - b);
      const percentile = (p) => (wait.length ? wait[Math.ceil(wait.length * p) - 1] : null);
      const weekEnd = Date.parse(`${b.week}T00:00:00Z`) - tz * 3600000 + 7 * DAY;
      const noWakeups = result.coverage.missing_tables.includes("wakeups");
      const oldEmpty =
        weekEnd < now - 7 * DAY && !wait.length && !b["review.superseded"] && !b["review.defer"];
      return {
        week: b.week,
        "review.wait": {
          samples: noWakeups || oldEmpty ? null : wait.length,
          p50_ms: percentile(0.5),
          p90_ms: percentile(0.9),
        },
        "review.superseded": noWakeups || oldEmpty ? null : b["review.superseded"],
        "review.reject": result.coverage.missing_tables.includes("rooms") ? null : b["review.reject"],
        "review.defer": noWakeups || oldEmpty ? null : b["review.defer"],
        "human.waiting": b["human.waiting"],
        rejecting_agents: b.rejections.size,
        max_reject_rounds: Math.max(0, ...b.rejections.values()),
      };
    });
  return result;
}
