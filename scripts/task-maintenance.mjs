import {
  acknowledgeControlDispatch,
  controlBodySha,
  registerControlAliases,
  rememberControlDispatch,
  taskIdentity,
} from "../server/maintenance-control.mjs";

export { taskIdentity } from "../server/maintenance-control.mjs";

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readMaintenanceHold, saveMaintenanceHold } from "../server/maintenance-hold.mjs";
import { assertNoLinks } from "../server/profile-integrity.mjs";
import { atomicWrite } from "./profiles.mjs";

const quiet = (agent) =>
  ["idle", "closed", "stopped", "error", "archived"].includes(agent.status) && !agent.activeTurn;
function sameIdentity(original, current) {
  const before = taskIdentity(original),
    after = taskIdentity(current);
  if (JSON.stringify(before) !== JSON.stringify(after) || current.archivedAt)
    throw new Error(`Maintenance session identity changed: ${original.id}; hold retained`);
}
const hasMessage = (timeline, id, aliases = []) =>
  timeline.entries?.some(
    ({ item }) =>
      item.type === "user_message" &&
      (item.clientMessageId === id || item.messageId === id || aliases.includes(item.messageId)),
  ) === true;
const now = (adapter) => adapter.now?.() ?? Date.now();
const wait = (adapter, ms) =>
  adapter.sleep ? adapter.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
function holdPrompt(ledger, task) {
  return `[Alliance maintenance ${ledger.id} hold ${task.id}; dispatch ${task.notice.fallbackMessageId ?? task.notice.messageId}]\nThe Human requested runtime maintenance: ${ledger.reason}. At the next safe boundary, write a concise durable checkpoint to ${task.checkpointFile}: unfinished outcome, files/results, commands/processes still running, ownership, constraints/budgets and exact next step. Preserve background jobs and product obligations; do not mark the product complete, cancel work or change model/budget. End this turn and wait for the explicit maintenance resume in this same session. Do not start further work while held. This is a maintenance checkpoint, not a new product assignment.`;
}
function resumePrompt(ledger, task, result, reason) {
  return `[Alliance maintenance ${ledger.id} resume ${task.id}; dispatch ${task.resume.messageId}]\n${result === "updated" ? "The update command and native health verification completed." : "The native runtime passed recovery health verification."} ${reason}\nContinue the same unfinished assignment in this retained session. Read your checkpoint at ${task.checkpointFile} and the saved responsibility/timeline evidence in ${task.directory}. Maintenance ledger: ${join(task.directory, "..", "ledger.json")}.${ledger.externalEvidence ? ` Process/child custody evidence: ${ledger.externalEvidence.path} (SHA256 ${ledger.externalEvidence.sha256}).` : ""} Inspect current files, git state, results and background processes before repeating any work. Preserve original provider/model/effort, scope, ownership, budgets, acceptance and Human constraints. If work finished during the checkpoint, report its actual remaining review or acceptance instead of repeating it. This maintenance message does not accept or complete a product milestone.`;
}
function carryOwnedDispatches(ledger, previous) {
  if (!previous) return;
  const registry = { id: previous.id, controlDispatches: ledger.controlDispatches };
  for (const task of previous.targets) {
    const createdAt = previous.createdAt;
    const remember = (kind, id, body, acknowledgedAt) => {
      if (!id) return;
      rememberControlDispatch(registry, task, kind, id, body, createdAt);
      if (!registry.controlDispatches[id].acknowledgedAt)
        acknowledgeControlDispatch(registry, id, acknowledgedAt ?? previous.updatedAt);
    };
    if (task.notice?.state === "acknowledged")
      remember(
        "hold",
        task.notice.messageId,
        holdPrompt(previous, { ...task, notice: { ...task.notice, fallbackMessageId: undefined } }),
        task.notice.acknowledgedAt,
      );
    if (task.notice?.state === "checkpoint-acknowledged")
      remember(
        "hold",
        task.notice.fallbackMessageId,
        holdPrompt(previous, task),
        task.notice.fallbackAcknowledgedAt,
      );
    if (["acknowledged", "verified"].includes(task.resume?.state))
      remember(
        "resume",
        task.resume.messageId,
        resumePrompt(
          previous,
          task,
          previous.resumeResult ?? (previous.updateVerifiedAt ? "updated" : "recovered"),
          previous.resumeReason ?? "Verified maintenance recovery",
        ),
        task.resume.acknowledgedAt,
      );
  }
}

async function persist(home, ledger, adapter) {
  ledger.updatedAt = new Date(now(adapter)).toISOString();
  await saveMaintenanceHold(home, ledger);
}
async function evidence(task, adapter, label) {
  const agent = await adapter.get(task.id);
  if (!agent) throw new Error(`Maintenance native session missing: ${task.id}`);
  sameIdentity(task.original, agent);
  const timeline = await adapter.timeline(task.id);
  await atomicWrite(
    join(task.directory, `${label}.json`),
    `${JSON.stringify({ agent, timeline }, null, 2)}\n`,
  );
  return { agent, timeline };
}

export async function holdTasks(home, adapter, options = {}) {
  const reason = options.reason?.trim();
  if (!reason) throw new Error("Maintenance needs --reason");
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3600000)
    throw new Error("Maintenance --timeout-ms must be between 0 and 3600000");
  const previous = await readMaintenanceHold(home);
  const extending = Boolean(options.includeNew && previous && previous.phase !== "complete");
  if (
    extending &&
    (options.key !== previous.id ||
      !["failed", "held"].includes(previous.phase) ||
      previous.targets.some((task) => task.phase !== "held"))
  )
    throw new Error(
      "--include-new needs the matching failed/held operation with all earlier tasks still held",
    );
  if (previous && previous.phase !== "complete" && !extending) {
    if (previous.phase === "held") return previous;
    throw new Error(
      `Maintenance ${previous.id} is ${previous.phase}; recover with maintenance resume before another hold`,
    );
  }
  if (!extending && options.key && previous?.id === options.key) return previous;
  const id = extending ? previous.id : (options.key ?? randomUUID());
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid maintenance --key");
  const directory = join(home, "maintenance-holds", id);
  await assertNoLinks(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const externalEvidence = options.evidence ? await readFile(options.evidence) : null;
  const evidenceRecord = externalEvidence
    ? {
        path: options.evidence,
        sha256: createHash("sha256").update(externalEvidence).digest("hex"),
        bytes: externalEvidence.length,
      }
    : null;
  const snapshot = await adapter.snapshot();
  const agents = await adapter.list();
  const previousIds = new Set(extending ? previous.targets.map((task) => task.id) : []);
  const targets = agents
    .filter((agent) => !quiet(agent) && !agent.archivedAt && !agent.internal && !previousIds.has(agent.id))
    .map((original) => {
      const taskDirectory = join(directory, original.id);
      return {
        id: original.id,
        original,
        externalEvidence: evidenceRecord,
        directory: taskDirectory,
        checkpointFile: join(taskDirectory, "checkpoint.md"),
        phase: "holding",
        notice: { state: "pending", messageId: randomUUID() },
        resume: { state: "pending", messageId: randomUUID() },
      };
    });
  const ledger = extending
    ? previous
    : {
        version: 1,
        id,
        phase: "holding",
        reason,
        createdAt: new Date(now(adapter)).toISOString(),
        updatedAt: new Date(now(adapter)).toISOString(),
        targets,
        externalEvidence: evidenceRecord,
        snapshot,
        originalAgents: agents,
        controls: previous?.controls ?? {},
        controlDispatches: previous?.controlDispatches ?? {},
        interrupt: Boolean(options.interrupt),
      };
  carryOwnedDispatches(ledger, previous);
  if (extending) {
    const targetIds = new Set(targets.map((task) => task.id));
    const originalResponsibilities = ledger.snapshot.responsibilities;
    const freshResponsibilities = snapshot.responsibilities;
    if (originalResponsibilities && freshResponsibilities) {
      for (const field of ["members", "autonomy"]) {
        const identity = field === "members" ? "id" : "agentId";
        originalResponsibilities[field] = [
          ...originalResponsibilities[field].filter((row) => !targetIds.has(row[identity])),
          ...freshResponsibilities[field].filter((row) => targetIds.has(row[identity])),
        ];
      }
    }
    ledger.extensions ??= [];
    ledger.extensions.push({
      at: new Date(now(adapter)).toISOString(),
      reason,
      targets: targets.map((task) => task.id),
      snapshot,
      agents,
      externalEvidence: evidenceRecord,
    });
    ledger.targets.push(...targets);
    ledger.phase = "holding";
    ledger.error = undefined;
    // A new target needs reconciliation too; a previous audit remains preserved in the extension history.
    if (ledger.reconciledAt) throw new Error("Already reconciled hold cannot capture new tasks");
  }
  for (const task of targets) {
    await assertNoLinks(task.directory);
    await mkdir(task.directory, { recursive: true, mode: 0o700 });
    ledger.controls[task.id] = [
      ...(ledger.controls[task.id] ?? []),
      task.notice.messageId,
      task.resume.messageId,
    ];
  }
  await persist(home, ledger, adapter);
  await adapter.pause?.(ledger);
  try {
    for (const task of targets) {
      const before = await evidence(task, adapter, "before-hold");
      task.controlUserIds = before.timeline.entries
        .filter(({ item }) => item.type === "user_message")
        .flatMap(({ item }) => [item.clientMessageId, item.messageId])
        .filter((id) => typeof id === "string");
      task.controlBoundary = {
        epoch: before.timeline.epoch ?? null,
        seq: before.timeline.endCursor?.seq ?? before.timeline.endSeq ?? null,
      };
      if (adapter.baselineUserIds)
        task.controlUserIds = await adapter.baselineUserIds(task.id, task.controlBoundary);
    }
    await persist(home, ledger, adapter);
    for (const task of targets) {
      const fresh = { agent: await adapter.get(task.id) };
      if (!fresh.agent) throw new Error(`Maintenance native session missing: ${task.id}`);
      sameIdentity(task.original, fresh.agent);
      if (quiet(fresh.agent)) {
        task.phase = "held";
        task.notice.state = "already-idle";
        await persist(home, ledger, adapter);
        continue;
      }
      task.notice.state = "sending";
      const body = holdPrompt(ledger, task);
      task.notice.bodySha256 = controlBodySha(body);
      rememberControlDispatch(
        ledger,
        task,
        "hold",
        task.notice.messageId,
        body,
        new Date(now(adapter)).toISOString(),
      );
      await persist(home, ledger, adapter);
      try {
        await adapter.send(task.id, body, {
          messageId: task.notice.messageId,
          activeTurnBehavior: "steer",
        });
        task.notice.state = "acknowledged";
        task.notice.acknowledgedAt = new Date(now(adapter)).toISOString();
        acknowledgeControlDispatch(ledger, task.notice.messageId, task.notice.acknowledgedAt);
      } catch (error) {
        task.notice.error = error.message;
        task.notice.state = /does not support prompt\.steer/.test(error.message)
          ? "unsupported"
          : "uncertain";
      }
      await persist(home, ledger, adapter);
    }
    const deadline = now(adapter) + timeoutMs;
    for (;;) {
      let running = false;
      for (const task of targets.filter((task) => task.phase !== "held")) {
        const agent = await adapter.get(task.id);
        if (!agent) throw new Error(`Maintenance native session missing: ${task.id}`);
        sameIdentity(task.original, agent);
        if (quiet(agent)) {
          await evidence(task, adapter, "checkpoint");
          task.phase = "held";
          task.cooperative = await readFile(task.checkpointFile, "utf8")
            .then((text) => Boolean(text.trim()))
            .catch((error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            });
        } else running = true;
      }
      await persist(home, ledger, adapter);
      if (!running || now(adapter) >= deadline) break;
      await wait(adapter, Math.min(1000, deadline - now(adapter)));
    }
    const unsupported = targets.filter(
      (task) => task.phase !== "held" && task.notice.state === "unsupported",
    );
    if (options.interrupt && unsupported.length) {
      for (const task of unsupported) {
        await evidence(task, adapter, "before-checkpoint-interrupt");
        task.interrupt = { state: "sending", at: new Date(now(adapter)).toISOString() };
        await persist(home, ledger, adapter);
        await adapter.stop(task.id);
        task.notice.fallbackMessageId = randomUUID();
        ledger.controls[task.id].push(task.notice.fallbackMessageId);
        task.notice.state = "checkpoint-sending";
        const body = holdPrompt(ledger, task);
        task.notice.fallbackBodySha256 = controlBodySha(body);
        rememberControlDispatch(
          ledger,
          task,
          "hold",
          task.notice.fallbackMessageId,
          body,
          new Date(now(adapter)).toISOString(),
        );
        await persist(home, ledger, adapter);
        await adapter.send(task.id, body, {
          messageId: task.notice.fallbackMessageId,
          activeTurnBehavior: "interrupt",
        });
        task.notice.state = "checkpoint-acknowledged";
        task.notice.fallbackAcknowledgedAt = new Date(now(adapter)).toISOString();
        acknowledgeControlDispatch(ledger, task.notice.fallbackMessageId, task.notice.fallbackAcknowledgedAt);
        await persist(home, ledger, adapter);
      }
      const checkpointDeadline = now(adapter) + Math.min(timeoutMs, 30000);
      for (;;) {
        let pending = false;
        for (const task of unsupported.filter((task) => task.phase !== "held")) {
          const current = await evidence(task, adapter, "checkpoint-fallback");
          if (quiet(current.agent)) {
            task.phase = "held";
            task.interrupt.state = "verified";
          } else pending = true;
        }
        await persist(home, ledger, adapter);
        if (!pending || now(adapter) >= checkpointDeadline) break;
        await wait(adapter, Math.min(1000, checkpointDeadline - now(adapter)));
      }
    }
    for (const task of targets.filter((task) => task.phase !== "held")) {
      if (!options.interrupt)
        throw new Error(
          `Checkpoint timeout for ${task.id}; hold retained, --interrupt authorizes native stop`,
        );
      await evidence(task, adapter, "before-interrupt");
      task.interrupt = { state: "sending", at: new Date(now(adapter)).toISOString() };
      await persist(home, ledger, adapter);
      await adapter.stop(task.id);
      const fresh = await evidence(task, adapter, "after-interrupt");
      if (!quiet(fresh.agent)) throw new Error(`Native stop not confirmed for ${task.id}; hold retained`);
      task.interrupt.state = "verified";
      task.phase = "held";
      await persist(home, ledger, adapter);
    }
    const unexpected = (await adapter.list()).filter(
      (agent) => !quiet(agent) && !agent.archivedAt && !agent.internal,
    );
    if (unexpected.length)
      throw new Error(
        `New running tasks during maintenance: ${unexpected.map((a) => a.id).join(", ")}; hold retained`,
      );
    ledger.phase = "held";
    await persist(home, ledger, adapter);
    return ledger;
  } catch (error) {
    ledger.phase = "failed";
    ledger.error = error.message;
    await persist(home, ledger, adapter);
    throw error;
  }
}

export async function resumeTasks(home, adapter, options = {}) {
  let ledger = await readMaintenanceHold(home);
  if (!ledger || ledger.phase === "complete") return ledger;
  const health = await adapter.health();
  if (!health?.ok) throw new Error("Native runtime health unverified; maintenance hold retained");
  const refreshed = await readMaintenanceHold(home);
  if (!refreshed || refreshed.id !== ledger.id)
    throw new Error("Maintenance ledger changed during health verification");
  ledger = refreshed;
  ledger.recoveryHealth = health;
  ledger.resumeReason = options.reason ?? "Verified maintenance recovery";
  ledger.resumeResult = options.result ?? "recovered";
  ledger.phase = "resuming";
  await persist(home, ledger, adapter);
  for (const task of ledger.targets) {
    if (task.resume.state === "verified") continue;
    try {
      let current = await evidence(task, adapter, "before-resume");
      if (
        registerControlAliases(ledger, task, current.timeline, current.agent, { rejectUnknown: false }).length
      )
        await persist(home, ledger, adapter);
      if (task.resume.state !== "pending") {
        if (
          !hasMessage(
            current.timeline,
            task.resume.messageId,
            ledger.controlAliasQualifications?.flatMap((event) =>
              event.proofs
                .filter((p) => p.dispatchId === task.resume.messageId)
                .map((p) => p.providerMessageId),
            ) ?? [],
          )
        )
          throw new Error(
            `Resume delivery uncertain for ${task.id}; inspect native timeline, no duplicate prompt sent`,
          );
      } else {
        // A maintenance resume must not interrupt a turn started independently by the Human.
        if (!quiet(current.agent))
          throw new Error(`Session ${task.id} is already active; inspect before resuming`);
        task.phase = "resuming";
        task.resume.state = "sending";
        const body = resumePrompt(ledger, task, options.result, ledger.resumeReason);
        task.resume.bodySha256 = controlBodySha(body);
        rememberControlDispatch(
          ledger,
          task,
          "resume",
          task.resume.messageId,
          body,
          new Date(now(adapter)).toISOString(),
        );
        await persist(home, ledger, adapter);
        await adapter.send(task.id, resumePrompt(ledger, task, options.result, ledger.resumeReason), {
          messageId: task.resume.messageId,
        });
        task.resume.state = "acknowledged";
        task.resume.acknowledgedAt = new Date(now(adapter)).toISOString();
        acknowledgeControlDispatch(ledger, task.resume.messageId, task.resume.acknowledgedAt);
        await persist(home, ledger, adapter);
      }
      const deadline = now(adapter) + 15000;
      for (;;) {
        current = await evidence(task, adapter, "resume-readback");
        if (
          registerControlAliases(ledger, task, current.timeline, current.agent, { rejectUnknown: false })
            .length
        )
          await persist(home, ledger, adapter);
        if (current.agent.status === "error")
          throw new Error(
            `Resumed native task failed: ${task.id}; inspect timeline, no duplicate prompt sent`,
          );
        const rows = current.timeline.entries ?? [];
        const promptIndex = rows.findIndex(
          ({ item }) =>
            item.type === "user_message" &&
            (item.clientMessageId === task.resume.messageId ||
              item.messageId === task.resume.messageId ||
              (ledger.controlAliasQualifications ?? []).some((event) =>
                event.proofs.some(
                  (p) => p.dispatchId === task.resume.messageId && p.providerMessageId === item.messageId,
                ),
              )),
        );
        const completed =
          promptIndex >= 0 &&
          rows
            .slice(promptIndex + 1)
            .some(({ item }) => item.type === "assistant_message" || item.type === "tool_call");
        const active =
          Boolean(current.agent.activeTurn) ||
          ["running", "starting", "initializing"].includes(current.agent.status);
        if (promptIndex >= 0 && (active || completed)) {
          task.resume.executionObserved = active ? "active" : "completed";
          break;
        }
        if (now(adapter) >= deadline)
          throw new Error(
            `Resume execution not observed for ${task.id}; hold retained, no duplicate prompt sent`,
          );
        await wait(adapter, 500);
      }
      task.resume.state = "verified";
      task.resume.readback = {
        status: current.agent.status,
        activeTurn: current.agent.activeTurn ?? null,
        promptObserved: true,
        identity: taskIdentity(current.agent),
      };
      task.phase = "resumed";
      await persist(home, ledger, adapter);
    } catch (error) {
      ledger.phase = "failed";
      ledger.error = error.message;
      await persist(home, ledger, adapter);
      throw error;
    }
  }
  ledger.phase = "complete";
  await persist(home, ledger, adapter);
  await adapter.release?.(ledger);
  return ledger;
}

export async function runTaskMaintenance(home, adapter, options = {}) {
  const hold = await holdTasks(home, adapter, options);
  if (hold.phase === "complete") return hold;
  const running = (await adapter.list()).filter(
    (agent) => !quiet(agent) && !agent.archivedAt && !agent.internal,
  );
  if (running.length)
    throw new Error(`New running tasks before update: ${running.map((a) => a.id).join(", ")}; hold retained`);
  hold.phase = "updating";
  await persist(home, hold, adapter);
  try {
    if (!options.update) throw new Error("maintenance run requires an update command after --");
    const updateResult = await options.update(hold);
    const current = await readMaintenanceHold(home);
    if (!current || current.id !== hold.id)
      throw new Error("Maintenance ledger changed while the update ran");
    Object.assign(hold, current);
    hold.updateResult = updateResult;
    hold.updateVerifiedAt = new Date(now(adapter)).toISOString();
    await persist(home, hold, adapter);
    return await resumeTasks(home, adapter, { result: "updated", reason: options.reason });
  } catch (error) {
    const latest = await readMaintenanceHold(home);
    latest.phase = "failed";
    latest.error = error.message;
    await persist(home, latest, adapter);
    throw error;
  }
}
