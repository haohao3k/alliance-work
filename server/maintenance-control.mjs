import { createHash } from "node:crypto";

export const taskIdentity = (agent) => ({
  id: agent.id,
  provider: agent.provider,
  cwd: agent.cwd,
  model: agent.model ?? null,
  thinkingOptionId: agent.thinkingOptionId ?? null,
  effectiveThinkingOptionId: agent.effectiveThinkingOptionId ?? null,
  sessionId: agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null,
});
export const controlBodySha = (body) => createHash("sha256").update(body).digest("hex");

export function rememberControlDispatch(ledger, task, kind, messageId, body, createdAt) {
  ledger.controlDispatches ??= {};
  ledger.controlDispatches[messageId] ??= {
    messageId,
    targetId: task.id,
    holdId: ledger.id,
    kind,
    bodySha256: controlBodySha(body),
    identity: taskIdentity(task.original),
    createdAt,
  };
}
export function acknowledgeControlDispatch(ledger, messageId, at) {
  const dispatch = ledger.controlDispatches?.[messageId];
  if (!dispatch) throw new Error("Unregistered maintenance dispatch");
  dispatch.acknowledgedAt = at;
}

function taskDispatch(ledger, task, kind, id) {
  const registered = ledger.controlDispatches?.[id];
  if (registered) return registered;
  // Records written by the first hash-aware controller also retain per-task receipt fields.
  const receipt = kind === "resume" ? task.resume : task.notice;
  if (!receipt) return null;
  const fallback = id === receipt.fallbackMessageId;
  if (id !== receipt.messageId && !fallback) return null;
  const bodySha256 = fallback ? receipt.fallbackBodySha256 : receipt.bodySha256;
  const acknowledgedAt = fallback ? receipt.fallbackAcknowledgedAt : receipt.acknowledgedAt;
  const acknowledged =
    acknowledgedAt || ["acknowledged", "checkpoint-acknowledged", "verified"].includes(receipt.state);
  if (!["acknowledged", "checkpoint-acknowledged", "verified"].includes(receipt.state)) return null;
  return bodySha256 && acknowledged
    ? {
        messageId: id,
        targetId: task.id,
        holdId: ledger.id,
        kind,
        bodySha256,
        identity: taskIdentity(task.original),
        createdAt: ledger.createdAt,
        acknowledgedAt: acknowledgedAt ?? ledger.updatedAt,
      }
    : null;
}

export function qualifyControlAlias(ledger, task, row, currentAgent) {
  if (row.item.type !== "user_message" || typeof row.item.text !== "string") return null;
  const marker =
    /^\[Alliance maintenance ([a-zA-Z0-9_-]{1,100}) (hold|resume) ([a-zA-Z0-9_-]{1,128}); dispatch ([a-zA-Z0-9_-]{1,128})\]\n/.exec(
      row.item.text,
    );
  if (!marker) return null;
  const [, holdId, kind, targetId, messageId] = marker;
  if (targetId !== task.id || !ledger.controls[task.id]?.includes(messageId)) return null;
  const record = taskDispatch(ledger, task, kind, messageId);
  if (
    !record ||
    record.holdId !== holdId ||
    record.targetId !== task.id ||
    record.kind !== kind ||
    !record.acknowledgedAt
  )
    return null;
  if (controlBodySha(row.item.text) !== record.bodySha256) return null;
  if (row.item.clientMessageId && row.item.clientMessageId !== messageId) return null;
  if (typeof row.item.messageId !== "string" || !row.item.messageId) return null;
  if (
    !currentAgent ||
    JSON.stringify(taskIdentity(currentAgent)) !== JSON.stringify(taskIdentity(task.original))
  )
    return null;
  const current = taskIdentity(currentAgent);
  for (const key of ["id", "provider", "cwd", "sessionId"])
    if (current[key] !== record.identity[key]) return null;
  if (record.holdId === ledger.id && JSON.stringify(current) !== JSON.stringify(record.identity)) return null;
  const timestamp = Date.parse(row.timestamp);
  const created = Date.parse(record.createdAt);
  const acknowledged = Date.parse(record.acknowledgedAt);
  if (
    !Number.isFinite(timestamp) ||
    !Number.isFinite(created) ||
    !Number.isFinite(acknowledged) ||
    acknowledged < created ||
    timestamp < created
  )
    return null;
  return {
    targetId: task.id,
    dispatchId: messageId,
    providerMessageId: row.item.messageId,
    holdId,
    kind,
    bodySha256: record.bodySha256,
    timestamp: row.timestamp,
    identity: record.identity,
  };
}

export function registerControlAliases(ledger, task, timeline, currentAgent, { rejectUnknown = true } = {}) {
  const allowed = new Set([...(task.controlUserIds ?? []), ...ledger.controls[task.id]]);
  const proofs = [];
  for (const row of timeline.entries) {
    if (row.item.type !== "user_message") continue;
    const id = row.item.clientMessageId ?? row.item.messageId;
    if (allowed.has(id)) continue;
    const proof = qualifyControlAlias(ledger, task, row, currentAgent);
    if (!proof) {
      if (rejectUnknown)
        throw new Error(`New product input during maintenance: ${task.id}; original state not overwritten`);
      continue;
    }
    proofs.push(proof);
    allowed.add(proof.providerMessageId);
  }
  for (const proof of proofs) {
    if (!ledger.controls[task.id].includes(proof.providerMessageId))
      ledger.controls[task.id].push(proof.providerMessageId);
  }
  if (proofs.length) {
    ledger.controlAliasQualifications ??= [];
    ledger.controlAliasQualifications.push({
      at: new Date().toISOString(),
      source: "registered-owned-dispatch",
      proofs,
    });
  }
  return proofs;
}
