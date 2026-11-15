import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { describe, findArtifacts, parseAge } from "../server/artifacts.mjs";
import { bindingReferences, namedUnder } from "../server/evidence-refs.mjs";
import { emptyDirectory, ownScratch } from "../server/scratch.mjs";
import { ancestors, git, holders, inside, worktreeRoot } from "../server/worktrees.mjs";
import { archived, realOrSelf, scratchOf, snapshot, worktreeUnits } from "./disk-cli.mjs";
import { projectRoot } from "./profiles.mjs";

/**
 * `cleanup artifacts`: rebuildable build and dependency directories (node_modules, target, .venv, caches).
 * Lists by default. Scopes are fixed by who runs it: a session may apply only inside its own scratch;
 * the Human may apply to the scratch and worktrees of archived members, and to primary checkouts only
 * with --include-primary. Nothing is removed that a process uses, that Git tracks (or does not ignore) in
 * a checkout, that is a symlink, or that belongs to the Alliance installation or the running code.
 */

const SCOPES = ["own-scratch", "archived", "archived-scratch", "archived-worktrees"];
const DEFAULT_AGE = "1d";

const human = (bytes) =>
  bytes >= 2 ** 30
    ? `${(bytes / 2 ** 30).toFixed(1)} GiB`
    : bytes >= 2 ** 20
      ? `${(bytes / 2 ** 20).toFixed(1)} MiB`
      : bytes >= 2 ** 10
        ? `${(bytes / 2 ** 10).toFixed(1)} KiB`
        : `${bytes} B`;
const days = (seconds) =>
  seconds === null
    ? "?"
    : seconds >= 86_400
      ? `${Math.floor(seconds / 86_400)}d`
      : `${Math.floor(seconds / 3600)}h`;

/** Absolute paths the cleanup must never touch or sit above: the home, its installations, the code in use. */
function protectedPaths(home) {
  const paths = [home, projectRoot];
  try {
    const record = JSON.parse(readFileSync(join(home, "installation.json"), "utf8"));
    const walk = (value) => {
      if (typeof value === "string" && value.startsWith("/")) paths.push(value);
      else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item);
    };
    walk(record);
  } catch {
    // No installation record: the home and the running code are still protected.
  }
  return paths.map(realOrSelf);
}

/** The places to look in, each with a check that is repeated right before anything is removed. */
async function roots(home, scope, options) {
  const env = options.env;
  const list = [];
  if (scope === "own-scratch") {
    const path = await ownScratch(home, env, "cleanup artifacts");
    if (path)
      list.push({
        kind: "own-scratch",
        path,
        ignorePids: ancestors(),
        validate: async () =>
          (await ownScratch(home, env, "cleanup artifacts")) === path ? null : "scratch changed",
      });
    return list;
  }
  const data = snapshot(home);
  if (scope === "archived" || scope === "archived-scratch")
    for (const member of data.members.filter(archived)) {
      const path = scratchOf(home, member, env);
      if (!path) continue;
      list.push({
        kind: "archived-scratch",
        path,
        member: member.id,
        validate: async () => {
          const again = snapshot(home).members.find((entry) => entry.id === member.id);
          return again && archived(again) ? null : "member is no longer archived";
        },
      });
    }
  if (scope === "archived" || scope === "archived-worktrees")
    for (const unit of worktreeUnits(data, options).units) {
      list.push({
        kind: "archived-worktree",
        path: unit.path,
        git: true,
        skip: unit.structural.length ? unit.structural.join("; ") : null,
        validate: async () => {
          const fresh = snapshot(home);
          const mine = {
            rooms: fresh.rooms,
            members: fresh.members.filter(
              (m) => unit.members.includes(m.id) || (m.cwd && inside(realOrSelf(m.cwd), unit.path)),
            ),
          };
          const again = worktreeUnits(mine, options).units.find((entry) => entry.path === unit.path);
          return again && !again.structural.length
            ? null
            : `no longer an archived worktree (${again?.structural.join("; ") ?? "gone"})`;
        },
      });
    }
  if (options.includePrimary)
    for (const room of data.rooms) {
      const top = worktreeRoot(room.cwd);
      if (!top || top.linked) continue;
      list.push({
        kind: "primary-checkout",
        path: top.top,
        git: true,
        validate: async () => {
          const again = snapshot(home).rooms.find((entry) => entry.id === room.id);
          const now = again ? worktreeRoot(again.cwd) : null;
          return now && !now.linked && now.top === top.top ? null : "no longer the room's primary checkout";
        },
      });
    }
  return list;
}

/** Why a candidate must stay, from facts read now; null when it may go. */
async function verdict(candidate, root, protectedList, olderSeconds, measured, binding) {
  const info = await lstat(candidate.path).catch(() => null);
  if (!info) return "gone";
  if (info.isSymbolicLink() || !info.isDirectory()) return "not a plain directory";
  if (realOrSelf(candidate.path) !== candidate.path || !inside(candidate.path, realOrSelf(root.path)))
    return "resolves outside its scope";
  if (protectedList.some((path) => inside(candidate.path, path) || inside(path, candidate.path)))
    return "belongs to the Alliance installation or the running code";
  if (measured.ageSeconds !== null && measured.ageSeconds < olderSeconds)
    return `written ${days(measured.ageSeconds)} ago, younger than the threshold`;
  const named = namedUnder(candidate.path, binding);
  if (named) return named;
  if (root.git) {
    const top = worktreeRoot(root.path)?.top ?? root.path;
    const relative = candidate.path.slice(top.length + 1);
    if (git(["ls-files", "--", relative], { cwd: top }).out) return "Git tracks files in it";
    if (!git(["check-ignore", "-q", "--", relative], { cwd: top }).ok) return "not ignored by Git";
  }
  return null;
}

function usedBy(candidate, root) {
  const scan = holders([candidate.path, candidate.parent], { ignorePids: root.ignorePids });
  if (!scan.ok) return "cannot tell whether a process uses it (lsof/ps unavailable)";
  const pids = [...new Set(scan.holders.map((h) => h.pid))];
  return pids.length ? `in use by process ${pids.join(", ")}` : null;
}

export async function cleanupArtifacts(home, options = {}) {
  const env = options.env ?? process.env;
  const agentSession = Boolean(env.PASEO_AGENT_ID || env.ALLIANCE_ROLE || env.ALLIANCE_BOUND_ROOM);
  const scope = options.scope ?? (agentSession ? "own-scratch" : "archived");
  if (!SCOPES.includes(scope)) throw new Error(`Unknown --scope ${scope}; use ${SCOPES.join(", ")}`);
  if (scope === "own-scratch" && !agentSession)
    throw new Error("--scope own-scratch is a session's own scratch; outside a session use --scope archived");
  if (agentSession && options.includePrimary)
    throw new Error("--include-primary belongs to the Human; run it outside an agent session.");
  if (options.apply && agentSession && scope !== "own-scratch")
    throw new Error(
      "A session may apply cleanup artifacts only inside its own scratch; archived members' data and checkouts belong to the Human.",
    );
  const olderSeconds = parseAge(options.older ?? DEFAULT_AGE);
  const apply = Boolean(options.apply);
  const guard = protectedPaths(home);
  const places = await roots(home, scope, { ...options, env });
  const items = [];
  const binding = await bindingReferences(snapshot(home));
  let young = 0;
  for (const root of places) {
    if (root.skip) {
      items.push({
        root: root.path,
        kind: root.kind,
        action: "keep",
        path: root.path,
        reason: root.skip,
        bytes: 0,
      });
      continue;
    }
    const found = await findArtifacts(root.path).catch(() => []);
    for (const candidate of found) {
      const measured = await describe(candidate);
      const reason =
        (await verdict(candidate, root, guard, olderSeconds, measured, binding)) ?? usedBy(candidate, root);
      if (reason?.includes("younger than the threshold")) {
        young += 1;
        continue;
      }
      items.push({
        path: candidate.path,
        type: candidate.type,
        kind: root.kind,
        root: root.path,
        bytes: measured.bytes,
        ageSeconds: measured.ageSeconds,
        action: reason ? "keep" : "would-remove",
        ...(reason ? { reason } : {}),
      });
      if (!apply || reason) continue;
      // Judged again right before removal: scope, age, Git, processes.
      const item = items[items.length - 1];
      const stale =
        (await root.validate()) ??
        (await verdict(
          candidate,
          root,
          guard,
          olderSeconds,
          await describe(candidate),
          await bindingReferences(snapshot(home)),
        )) ??
        usedBy(candidate, root);
      if (stale) Object.assign(item, { action: "keep", reason: stale });
      else {
        try {
          const result = await emptyDirectory(candidate.path, { self: true });
          Object.assign(item, { action: result.skipped.length ? "partial" : "removed", bytes: result.bytes });
        } catch (error) {
          Object.assign(item, { action: "keep", reason: error.message });
        }
      }
    }
  }
  const sum = (action) =>
    items.filter((item) => item.action === action).reduce((n, item) => n + item.bytes, 0);
  return {
    apply,
    scope,
    older: options.older ?? DEFAULT_AGE,
    items,
    youngerSkipped: young,
    totals: {
      wouldRemoveBytes: sum("would-remove"),
      removedBytes: sum("removed"),
      kept: items.filter((item) => item.action === "keep").length,
    },
  };
}

export function renderArtifacts(result) {
  const lines = [
    `${result.apply ? "" : "DRY RUN, nothing deleted. "}Rebuildable artifacts, scope ${result.scope}, written at least ${result.older} ago`,
  ];
  for (const item of result.items)
    lines.push(
      `  ${item.action.padEnd(12)} ${item.path}  ${human(item.bytes)}${item.type ? `  ${item.type}` : ""}${item.ageSeconds !== undefined ? `  ${days(item.ageSeconds)}` : ""}${item.reason ? `  — ${item.reason}` : ""}`,
    );
  lines.push(
    result.apply
      ? `Removed ${human(result.totals.removedBytes)}; kept ${result.totals.kept}.`
      : `Would remove ${human(result.totals.wouldRemoveBytes)}; kept ${result.totals.kept}${result.youngerSkipped ? `; ${result.youngerSkipped} younger than ${result.older} not listed` : ""}. Add --apply to remove.`,
  );
  return lines.join("\n");
}
