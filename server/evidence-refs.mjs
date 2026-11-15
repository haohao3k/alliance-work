import { realpathSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { inside } from "./worktrees.mjs";

const MAX_FILES = 5000;
const MAX_BYTES = 32 * 1024 * 1024;

/** @typedef {{path: string, document: string, agentId: string | null, cwd: string | null, tree?: boolean, reason?: string, uncertain?: boolean, required?: boolean}} Reference */

function collect(value, found, cwd = null) {
  const queue = [{ value, cwd }];
  while (queue.length) {
    const { value, cwd } = queue.pop();
    if (!value || typeof value !== "object") continue;
    const root = typeof value.candidate?.cwd === "string" ? value.candidate.cwd : cwd;
    if (typeof root === "string" && isAbsolute(root)) found.set(root, true);
    if (typeof value.path === "string" && "digest" in value) {
      if (isAbsolute(value.path)) found.set(value.path, false);
      else if (root) found.set(resolve(root, value.path), false);
    }
    if (typeof value.evidence === "string" && isAbsolute(value.evidence)) found.set(value.evidence, false);
    if (Array.isArray(value.inputs))
      for (const input of value.inputs)
        if (typeof input === "string" && (isAbsolute(input) || root))
          found.set(isAbsolute(input) ? input : resolve(root, input), true);
    for (const item of Object.values(value)) queue.push({ value: item, cwd: root });
  }
}

/** Missing optional directories are normal on old stores; failures to inspect existing evidence are not. */
async function documents(room, budget) {
  const files = [];
  for (const [directory, name] of [
    ["evidence", "report.json"],
    ["dispositions", null],
  ]) {
    const base = join(room.artifacts, directory);
    let entries;
    try {
      const info = await lstat(base);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a plain directory");
      entries = await readdir(base);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`cannot list ${base} (${error.code ?? error.message})`);
    }
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) continue;
      if (++budget.files > MAX_FILES) throw new Error(`evidence scan exceeds ${MAX_FILES} file limit`);
      const path = name ? join(base, entry, name) : join(base, entry);
      if (name) {
        const info = await lstat(join(base, entry));
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error(`cannot inspect ${join(base, entry)} (not a plain directory)`);
      }
      files.push(path);
    }
  }
  return files;
}

/** Recorded reports and dispositions, including their candidate inputs. Unknown content blocks cleanup globally. */
export async function evidenceReferences(rooms) {
  /** @type {Reference[]} */
  const references = [];
  const budget = { files: 0, bytes: 0 };
  for (const room of rooms) {
    let document = room.artifacts;
    try {
      for (document of await documents(room, budget)) {
        const info = await lstat(document);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a plain evidence file");
        if (info.size > MAX_BYTES || budget.bytes + info.size > MAX_BYTES)
          throw new Error("evidence scan exceeds 32 MiB byte limit");
        const bytes = await readFile(document);
        budget.bytes += bytes.length;
        if (budget.bytes > MAX_BYTES) throw new Error("evidence scan exceeds 32 MiB byte limit");
        let value;
        try {
          value = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw new Error("cannot parse evidence JSON");
        }
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("not an evidence object");
        const report = value.verification ?? value;
        const found = new Map([[document, false]]);
        collect(value, found);
        for (const [path, tree] of found)
          references.push({
            path,
            tree,
            document,
            agentId: value.agentId ?? report.agentId ?? null,
            cwd: report.candidate?.cwd ?? null,
          });
      }
    } catch (error) {
      references.push({
        path: document,
        document,
        agentId: null,
        cwd: null,
        uncertain: true,
        reason: `Evidence scan incomplete at ${document}: ${error.code ?? error.message}; retaining data because references are unknown`,
      });
    }
  }
  return references;
}

/** Null only after an acyclic, complete owner chain reaches an archived root. */
function pending(byId, responsibilities, id) {
  const seen = new Set();
  for (let next = id; next !== null && next !== undefined; ) {
    if (seen.has(next)) return `owner cycle at ${next}`;
    seen.add(next);
    const member = byId.get(next);
    if (!member) return `missing owner ${next}`;
    if (!member.archivedAt) return `owner ${next} is still pending`;
    if (responsibilities.has(next)) return `owner ${next} still has ${responsibilities.get(next)}`;
    next = member.ownership ? member.ownership.ownerId : member.parentId;
  }
  return null;
}

function recordReferences(records, kind) {
  /** @type {Reference[]} */
  const references = [];
  for (const value of records) {
    const found = new Map();
    const cwd = typeof value.cwd === "string" && isAbsolute(value.cwd) ? value.cwd : null;
    collect(value, found, cwd);
    for (const [path, tree] of found)
      references.push({
        path,
        tree,
        document: `${kind} ${value.key}`,
        agentId: value.ownerId ?? null,
        cwd,
        required:
          kind === "obligation"
            ? !["fulfilled", "canceled"].includes(value.state)
            : !value.archivedAt && !value.settlement,
      });
  }
  return references;
}

/** Resolve existing ancestors too: a missing receipt still protects its directory through aliases. */
async function referenceReal(path) {
  try {
    return await realpath(path);
  } catch (error) {
    const parent = dirname(path);
    if (error.code !== "ENOENT" || parent === path) throw error;
    return join(await referenceReal(parent), basename(path));
  }
}

/** Binding includes open obligations and jobs independently of their owner's archive state. */
export async function bindingReferences(data) {
  const byId = new Map(data.members.map((member) => [member.id, member]));
  const responsibilities = new Map();
  for (const obligation of data.obligations ?? [])
    if (!["fulfilled", "canceled"].includes(obligation.state) && obligation.ownerId)
      responsibilities.set(obligation.ownerId, `open obligation ${obligation.key}`);
  for (const job of data.jobs ?? [])
    if (!job.archivedAt && !job.settlement && job.ownerId)
      responsibilities.set(job.ownerId, `unsettled job ${job.key}`);
  const pendingReasons = new Map();
  const reasonFor = (id) => {
    if (!pendingReasons.has(id)) pendingReasons.set(id, pending(byId, responsibilities, id));
    return pendingReasons.get(id);
  };
  const owners = new Map();
  for (const member of data.members) {
    if (!member.cwd) continue;
    const cwd = await realpath(member.cwd).catch(() => member.cwd);
    owners.set(cwd, [...(owners.get(cwd) ?? []), member.id]);
  }
  const binding = [];
  for (const key of ["jobs", "obligations"])
    if (!Array.isArray(data[key]))
      binding.push({
        uncertain: true,
        reason: `Evidence scan incomplete: missing ${key} snapshot; retaining data because references are unknown`,
      });
  const references = [
    ...(await evidenceReferences(data.rooms)),
    ...recordReferences(data.obligations ?? [], "obligation"),
    ...recordReferences(data.jobs ?? [], "job"),
  ];
  for (const reference of references) {
    const ids =
      reference.agentId !== null
        ? [reference.agentId]
        : reference.cwd
          ? (owners.get(await realpath(reference.cwd).catch(() => reference.cwd)) ?? [])
          : [];
    const reason = reference.uncertain
      ? reference.reason
      : reference.required
        ? `${reference.document} remains open or unsettled`
        : ids.length
          ? ids.map(reasonFor).find(Boolean)
          : "unknown owner";
    if (!reason) continue;
    let real = null;
    let uncertainty = null;
    try {
      real = await referenceReal(reference.path);
    } catch (error) {
      uncertainty = `Cannot resolve evidence reference ${reference.path} (${error.code ?? "read error"}); retaining data because references are unknown`;
    }
    binding.push({
      ...reference,
      ...(uncertainty ? { uncertain: true } : {}),
      real,
      owner: ids.join(", ") || "unknown owner",
      reason: uncertainty ?? reason,
    });
  }
  return binding;
}

/** Why a target must stay. An incomplete scan cannot rule out references anywhere on this filesystem. */
export function namedUnder(target, binding) {
  let realTarget = target;
  let unresolved = null;
  try {
    realTarget = realpathSync(target);
  } catch (error) {
    unresolved = `Cannot resolve cleanup target ${target} (${error.code ?? "read error"}); retaining data because references are unknown`;
  }
  for (const reference of binding) {
    if (reference.uncertain) return reference.reason;
    if (
      inside(reference.path, target) ||
      (reference.real && inside(reference.real, target)) ||
      inside(reference.path, realTarget) ||
      (reference.real && inside(reference.real, realTarget)) ||
      (reference.tree &&
        (inside(target, reference.path) ||
          (reference.real && inside(target, reference.real)) ||
          inside(realTarget, reference.path) ||
          (reference.real && inside(realTarget, reference.real))))
    )
      return `${reference.path} is named by the evidence of ${reference.owner} (${reference.reason}; ${reference.document})`;
  }
  return unresolved;
}

/** Every file named by this session; an incomplete scan is never reported as an empty set. */
export async function namedFilesUnder(target, rooms, agentId) {
  const references = await evidenceReferences(rooms);
  const unknown = references.find((reference) => reference.uncertain);
  if (unknown) throw new Error(unknown.reason);
  return [
    ...new Set(
      references
        .filter(
          (reference) =>
            reference.agentId === agentId &&
            (inside(reference.path, target) || (reference.tree && inside(target, reference.path))),
        )
        .map((reference) => reference.path),
    ),
  ];
}
