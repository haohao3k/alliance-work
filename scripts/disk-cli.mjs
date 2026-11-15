import { existsSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bindingReferences, namedUnder } from "../server/evidence-refs.mjs";
import {
  cleanOwnScratch,
  emptyDirectory,
  installationScratch,
  measure,
  ownScratch,
  scratchPath,
  scratchRoot,
} from "../server/scratch.mjs";
import { holders, inside, inspectWorktree, removeWorktree, worktreeRoot } from "../server/worktrees.mjs";

/**
 * `scratch clean`, `disk` and `cleanup worktrees|scratch`.
 * `disk` and the dry runs only read. Deleting needs --apply from the Human, and each item is judged again
 * from a fresh read of the store, Git and the process table right before it is removed.
 */

const human = (bytes) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GiB`
    : bytes >= 2 ** 20
      ? `${(bytes / 2 ** 20).toFixed(1)} MiB`
      : bytes >= 2 ** 10
        ? `${(bytes / 2 ** 10).toFixed(1)} KiB`
        : `${bytes} B`;

/** Rooms and members, read straight from the store so a stopped daemon does not matter. */
export function snapshot(home) {
  const path = join(home, "rooms.sqlite");
  if (!existsSync(path)) return { rooms: [], members: [], jobs: [], obligations: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    const optional = (table) =>
      tables.has(table)
        ? db
            .prepare(`SELECT data FROM ${table}`)
            .all()
            .map((row) => JSON.parse(row.data))
        : [];
    return {
      jobs: optional("jobs"),
      obligations: optional("obligations"),
      rooms: db
        .prepare("SELECT data FROM rooms")
        .all()
        .map((row) => JSON.parse(row.data)),
      members: db
        .prepare("SELECT data FROM members")
        .all()
        .map((row) => JSON.parse(row.data)),
    };
  } finally {
    db.close();
  }
}

export const realOrSelf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/** A member is cleanable exactly while Paseo reports it archived; a reopened member stops being so. */
export const archived = (member) => Boolean(member.archivedAt);

export function scratchOf(home, member, env) {
  try {
    return scratchPath(home, member.roomId, member.id, { env });
  } catch {
    return null;
  }
}

/** Worktrees that members work in, one entry per checkout, with every member that uses it. */
export function worktreeUnits(data, options) {
  const units = new Map();
  const roomRoots = new Set(data.rooms.map((room) => realOrSelf(room.cwd)));
  let unknown = 0;
  for (const member of data.members) {
    const root = member.cwd ? worktreeRoot(member.cwd) : null;
    if (!root) {
      if (archived(member)) unknown += 1;
      continue;
    }
    const unit = units.get(root.top) ?? { path: root.top, members: [] };
    unit.members.push(member);
    units.set(root.top, unit);
  }
  const live = data.members.filter((member) => !archived(member) && member.cwd);
  const result = [];
  for (const unit of units.values()) {
    if (!unit.members.some(archived)) continue;
    const state = inspectWorktree(unit.path, { base: options.base });
    const blockers = [...state.blockers];
    const users = live.filter((member) => inside(realOrSelf(member.cwd), unit.path));
    for (const member of users) blockers.push(`in use by member ${member.id} (not archived)`);
    if (roomRoots.has(unit.path)) blockers.push("is a room's project directory");
    result.push({
      ...state,
      members: unit.members.map((member) => member.id),
      structural: [
        ...(state.structural ?? []),
        ...users.map((member) => `in use by member ${member.id} (not archived)`),
        ...(roomRoots.has(unit.path) ? ["is a room's project directory"] : []),
      ],
      blockers,
      eligible: blockers.length === 0 && state.removable,
    });
  }
  return { units: result, unknown };
}

const brief = (unit) => ({
  path: unit.path,
  branch: unit.branch ?? null,
  head: unit.head ?? null,
  members: unit.members,
  kind: unit.kind,
  clean: unit.clean ?? null,
  merged: unit.merged ?? null,
  mergeTarget: unit.mergeTarget ?? null,
  ignoredEntries: unit.ignoredEntries ?? 0,
  inUse: unit.inUse ?? [],
  eligible: unit.eligible && !(unit.inUse?.length || unit.inUseUnknown),
  blockers: [
    ...unit.blockers,
    ...(unit.inUse?.length ? [`in use by process ${unit.inUse.join(", ")}`] : []),
    ...(unit.inUseUnknown ? ["cannot tell whether a process uses it (lsof/ps unavailable)"] : []),
  ],
});

function withHolders(units) {
  const scan = holders(units.map((unit) => unit.path));
  for (const unit of units) {
    unit.inUse = [...new Set(scan.holders.filter((h) => inside(h.path, unit.path)).map((h) => h.pid))];
    unit.inUseUnknown = !scan.ok;
  }
  return units;
}

export async function diskReport(home, options = {}) {
  const env = options.env ?? process.env;
  const data = snapshot(home);
  const known = new Set(data.members.map((member) => `${member.roomId}/${member.id}`));
  const scan = holders(data.members.filter(archived).flatMap((member) => scratchOf(home, member, env) ?? []));
  const rooms = [];
  for (const room of data.rooms) {
    const members = [];
    for (const member of data.members.filter((entry) => entry.roomId === room.id)) {
      const path = scratchOf(home, member, env);
      const size = path ? await measure(path) : { exists: false, bytes: 0, files: 0, newest: 0 };
      members.push({
        id: member.id,
        role: member.role,
        archived: archived(member),
        scratch: {
          path,
          exists: size.exists,
          bytes: size.bytes,
          files: size.files,
          lastWrite: size.newest ? new Date(size.newest).toISOString() : null,
          cleanable: archived(member) && size.exists,
          inUse: path ? scan.holders.some((h) => inside(h.path, path)) : false,
        },
      });
    }
    rooms.push({
      id: room.id,
      title: room.title,
      cwd: room.cwd,
      scratchBytes: members.reduce((sum, member) => sum + member.scratch.bytes, 0),
      cleanableBytes: members.reduce((sum, m) => sum + (m.scratch.cleanable ? m.scratch.bytes : 0), 0),
      members,
    });
  }
  // Directories in this installation's namespace that no member record explains.
  const orphans = [];
  const base = installationScratch(home, { env });
  if (existsSync(base))
    for (const roomId of readdirSync(base))
      for (const agentId of readdirSync(join(base, roomId)).filter(
        (name) => !known.has(`${roomId}/${name}`),
      )) {
        const path = join(base, roomId, agentId);
        orphans.push({ path, bytes: (await measure(path)).bytes });
      }
  const { units, unknown } = worktreeUnits(data, options);
  const worktrees = withHolders(units).map(brief);
  return {
    home,
    scratchRoot: scratchRoot(env),
    rooms,
    orphanScratch: orphans,
    worktrees,
    archivedWithoutKnownCheckout: unknown,
    totals: {
      scratchBytes: rooms.reduce((sum, room) => sum + room.scratchBytes, 0),
      cleanableScratchBytes: rooms.reduce((sum, room) => sum + room.cleanableBytes, 0),
      orphanScratchBytes: orphans.reduce((sum, orphan) => sum + orphan.bytes, 0),
      worktreesOfArchivedMembers: worktrees.length,
      removableWorktrees: worktrees.filter((unit) => unit.eligible).length,
    },
  };
}

function renderReport(report) {
  const lines = [
    `Scratch root ${report.scratchRoot}  (read-only report; nothing is deleted)`,
    `Scratch ${human(report.totals.scratchBytes)}, cleanable (archived members) ${human(report.totals.cleanableScratchBytes)}`,
  ];
  for (const room of report.rooms) {
    lines.push(
      "",
      `Room ${room.title} (${room.id})  scratch ${human(room.scratchBytes)}, cleanable ${human(room.cleanableBytes)}`,
    );
    for (const member of room.members) {
      if (!member.scratch.exists && !member.archived) continue;
      lines.push(
        `  ${member.id} ${member.role} ${member.archived ? "archived" : "active"}  ${human(member.scratch.bytes)}${member.scratch.cleanable ? "  cleanable" : ""}${member.scratch.inUse ? "  (a process still uses it)" : ""}`,
      );
    }
  }
  if (report.orphanScratch.length)
    lines.push(
      "",
      `Scratch with no member record (listed only, never cleaned): ${report.orphanScratch.length}`,
      ...report.orphanScratch.map((o) => `  ${o.path}  ${human(o.bytes)}`),
    );
  lines.push(
    "",
    `Worktrees of archived members: ${report.worktrees.length}, removable now: ${report.totals.removableWorktrees}`,
  );
  for (const unit of report.worktrees)
    lines.push(
      `  ${unit.eligible ? "removable" : "keep     "} ${unit.path}  ${unit.branch ?? "(detached)"}  clean=${unit.clean} merged=${unit.merged}${unit.eligible ? "" : `  — ${unit.blockers.join("; ")}`}`,
    );
  if (report.archivedWithoutKnownCheckout)
    lines.push(
      `  (${report.archivedWithoutKnownCheckout} archived members have no recorded checkout and are not listed)`,
    );
  lines.push(
    "",
    "Remove with: alliance-work cleanup worktrees --apply, alliance-work cleanup scratch --apply (Human, outside an agent session).",
  );
  return lines.join("\n");
}

function requireHuman(env) {
  if (env.PASEO_AGENT_ID || env.ALLIANCE_ROLE || env.ALLIANCE_BOUND_ROOM)
    throw new Error(
      "cleanup --apply deletes other sessions' data and belongs to the Human; run it outside an agent session. Dry run is open to everyone.",
    );
}

/** Every archived member's scratch, judged now; `apply` removes those that are still safe. */
export async function cleanupScratch(home, options = {}) {
  const env = options.env ?? process.env;
  const apply = Boolean(options.apply);
  if (apply) requireHuman(env);
  const items = [];
  const plan = async () => {
    const data = snapshot(home);
    const candidates = data.members.filter(archived).flatMap((member) => {
      const path = scratchOf(home, member, env);
      return path ? [{ member, path }] : [];
    });
    return candidates;
  };
  const candidates = await plan();
  const binding = await bindingReferences(snapshot(home));
  for (const { member, path } of candidates) {
    const size = await measure(path);
    if (!size.exists) continue;
    const item = { agent: member.id, room: member.roomId, path, bytes: size.bytes, action: "would-remove" };
    const scan = holders([path]);
    const named = namedUnder(path, binding);
    if (named) Object.assign(item, { action: "keep", reason: named });
    else if (!scan.ok)
      Object.assign(item, { action: "keep", reason: "cannot tell whether a process uses it" });
    else if (scan.holders.length)
      Object.assign(item, {
        action: "keep",
        reason: `in use by process ${[...new Set(scan.holders.map((h) => h.pid))].join(", ")}`,
      });
    if (apply && item.action === "would-remove") {
      // Fresh judgement right before removing.
      const again = snapshot(home).members.find((entry) => entry.id === member.id);
      const check = holders([path]);
      const nowNamed = namedUnder(path, await bindingReferences(snapshot(home)));
      if (!again || !archived(again)) Object.assign(item, { action: "keep", reason: "no longer archived" });
      else if (nowNamed) Object.assign(item, { action: "keep", reason: nowNamed });
      else if (!check.ok || check.holders.length) Object.assign(item, { action: "keep", reason: "in use" });
      else {
        try {
          const info = await lstat(path);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("not a plain directory");
          const result = await emptyDirectory(path, { self: true });
          Object.assign(item, { action: result.skipped.length ? "partial" : "removed", bytes: result.bytes });
          try {
            rmdirSync(dirname(path));
          } catch {
            // The room directory still holds other sessions.
          }
        } catch (error) {
          Object.assign(item, { action: "keep", reason: error.message });
        }
      }
    }
    items.push(item);
  }
  return { apply, items };
}

export async function cleanupWorktrees(home, options = {}) {
  const env = options.env ?? process.env;
  const apply = Boolean(options.apply);
  if (apply) requireHuman(env);
  const { units } = worktreeUnits(snapshot(home), options);
  const listed = withHolders(units).map(brief);
  const binding = await bindingReferences(snapshot(home));
  const items = [];
  for (const unit of listed) {
    const named = namedUnder(unit.path, binding);
    if (named) Object.assign(unit, { eligible: false, blockers: [...unit.blockers, named] });
    const item = { ...unit, action: unit.eligible ? "would-remove" : "keep" };
    if (apply && unit.eligible) {
      // Fresh judgement right before removing: store, Git and processes again.
      const data = snapshot(home);
      const mine = {
        rooms: data.rooms,
        members: data.members.filter(
          (m) => unit.members.includes(m.id) || (m.cwd && inside(realOrSelf(m.cwd), unit.path)),
        ),
      };
      const fresh = worktreeUnits(mine, options).units.find((entry) => entry.path === unit.path);
      const [now] = fresh ? withHolders([fresh]).map(brief) : [];
      const nowNamed = namedUnder(unit.path, await bindingReferences(data));
      if (now && nowNamed) Object.assign(now, { eligible: false, blockers: [...now.blockers, nowNamed] });
      if (!now?.eligible) {
        Object.assign(item, {
          action: "keep",
          blockers: now?.blockers ?? ["no longer a candidate"],
          eligible: false,
        });
      } else {
        const result = removeWorktree({ ...fresh });
        Object.assign(
          item,
          result.removed ? { action: "removed" } : { action: "refused", reason: result.reason },
        );
      }
    }
    items.push(item);
  }
  return { apply, items };
}

function renderCleanup(result, noun) {
  const verb = result.apply ? "" : "DRY RUN, nothing deleted. ";
  const lines = [`${verb}${noun}: ${result.items.length} of archived members`];
  for (const item of result.items)
    lines.push(
      `  ${item.action.padEnd(12)} ${item.path}${item.bytes !== undefined ? `  ${human(item.bytes)}` : ""}${item.reason ? `  — ${item.reason}` : ""}${item.blockers?.length ? `  — ${item.blockers.join("; ")}` : ""}`,
    );
  if (!result.apply)
    lines.push("Add --apply (Human, outside an agent session) to remove the 'would-remove' items.");
  return lines.join("\n");
}

/** Entry point from cli.mjs. Returns a string, or an object when --json is given. */
export async function diskCommand(home, positional, flags, env = process.env) {
  const [command, action] = positional;
  const json = Boolean(flags["--json"]);
  const options = { env, base: flags["--base"], apply: Boolean(flags["--apply"]) };
  if (flags["--apply"] && flags["--dry-run"]) throw new Error("Choose --apply or --dry-run, not both");
  if (command === "scratch") {
    if (action !== "clean") throw new Error("Usage: alliance-work scratch clean [PATH]");
    const own = await ownScratch(home, env);
    const aim = own ? (positional[2] ? resolve(own, positional[2]) : own) : null;
    const reason = aim ? namedUnder(aim, await bindingReferences(snapshot(home))) : null;
    if (reason)
      throw new Error(
        `Warning: ${reason}; nothing was removed. Preserve the evidence or record replacement evidence before cleaning.`,
      );
    const result = await cleanOwnScratch(home, env, positional[2]);
    return json
      ? result
      : `${positional[2] ? "Removed" : "Emptied"} ${result.path}: ${result.removed} entries, ${human(result.bytes)}${result.skipped.length ? `; left ${result.skipped.length} (other filesystem or unremovable)` : ""}`;
  }
  if (command === "disk") {
    const report = await diskReport(home, options);
    return json ? report : renderReport(report);
  }
  if (command === "cleanup" && action === "artifacts") {
    const { cleanupArtifacts, renderArtifacts } = await import("./artifacts-cli.mjs");
    const result = await cleanupArtifacts(home, {
      env,
      apply: options.apply,
      scope: flags["--scope"],
      older: flags["--older"],
      includePrimary: Boolean(flags["--include-primary"]),
      base: flags["--base"],
    });
    return json ? result : renderArtifacts(result);
  }
  if (command === "cleanup" && action === "worktrees") {
    const result = await cleanupWorktrees(home, options);
    return json ? result : renderCleanup(result, "Worktrees");
  }
  if (command === "cleanup" && action === "scratch") {
    const result = await cleanupScratch(home, options);
    return json ? result : renderCleanup(result, "Scratch directories");
  }
  throw new Error("Usage: alliance-work scratch clean | disk | cleanup worktrees|scratch [--apply]");
}
