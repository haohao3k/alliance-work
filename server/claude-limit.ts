import { createHash } from "node:crypto";
import { pauseKind } from "../shared/autonomy";
import { allowedModel, isEconomicalOwnerModel } from "../shared/model-policy";
import { apartFromLimit, harnessOf, responsibleOwner } from "../shared/operations";
import { claudeAccountsState } from "./claude-accounts.mjs";
import { type MemberRecord, type RoomStore, signInHeld } from "./store";
import type { Wakeups } from "./wakeups";

const HOUR = 3600000;
const NAMED = ["5x", "20x"];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const limitKey = (identity: string) =>
  `quota-limit-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
const memberLimitKey = (member: MemberRecord) => limitKey(`${member.id}:${member.limited?.until}`);

/** Known Claude accounts share a reset; preserve any notice queued before account attribution. */
export function quotaNoticeKey(member: MemberRecord, store?: RoomStore) {
  const account = member.limited?.account;
  if (!store || harnessOf(member.provider) !== "claude" || !account || !NAMED.includes(account))
    return memberLimitKey(member);
  for (const peer of store.members())
    if (
      harnessOf(peer.provider) === "claude" &&
      peer.limited?.account === account &&
      peer.limited.until === member.limited?.until &&
      store.wakeup(memberLimitKey(peer))
    )
      return memberLimitKey(peer);
  return limitKey(`claude-account:${account}:${member.limited?.until}`);
}

/** Owners only: a peer sharing a room is not authority to reassign another peer's work. */
export function quotaContacts(store: RoomStore, reporter: MemberRecord) {
  const result = store
    .members(reporter.roomId)
    .filter((m) => m.role === "hq")
    .map((m) => m.id);
  const seen = new Set([reporter.id]);
  let owner = responsibleOwner(reporter);
  while (owner && !seen.has(owner)) {
    result.push(owner);
    seen.add(owner);
    const member = store.member(owner);
    owner = member ? responsibleOwner(member) : null;
  }
  return [...new Set(result)].filter((id) => id !== reporter.id);
}

/** The same guards apply at creation, at delivery and in the Human's status view. */
export function quotaContact(
  store: RoomStore,
  reporter: MemberRecord,
  now: number,
  available: (id: string) => boolean = () => true,
) {
  const harness = harnessOf(reporter.provider);
  return (
    quotaContacts(store, reporter).find((id) => {
      const m = store.member(id);
      const run = store.autonomyOf(id);
      return (
        m &&
        !m.archivedAt &&
        harnessOf(m.provider) &&
        (harnessOf(m.provider) !== harness ||
          (harness === "claude" && apartFromLimit(reporter.limited?.account, m.claudeAccounts))) &&
        !m.turnReadbackPending &&
        !signInHeld(m, now) &&
        !m.approvals?.length &&
        store.heldUntil(id, now) === null &&
        run?.phase !== "archived" &&
        !(run && pauseKind(run) === "cancel" && run.outcome === "canceled") &&
        available(id)
      );
    }) ?? null
  );
}

/** A projection also used by needsHuman; it never changes a provider, assignment or retry. */
export function quotaNotice(store: RoomStore, id: string, now: number, available?: (id: string) => boolean) {
  const member = store.member(id);
  const limit = member?.limited;
  const harness = member && harnessOf(member.provider);
  if (!member || member.archivedAt || !harness || !limit || limit.until <= now) return null;
  const ownerId = quotaContact(store, member, now, available);
  const successful = store.members().flatMap((member) => {
    const turn =
      member.lastSuccessfulTurn ??
      (member.lastOutcome === "completed" && member.lastTurnEndedAt !== undefined
        ? { endedAt: member.lastTurnEndedAt, provider: member.provider, model: member.launchModel }
        : null);
    return turn && turn.endedAt >= now - HOUR && turn.endedAt <= now ? [{ member, turn }] : [];
  });
  const recent = [...new Set(successful.map(({ turn }) => harnessOf(turn.provider)).filter(Boolean))].sort();
  const policy = store.modelPolicy(member.roomId);
  const routes = policy.policy.routes
    .filter(
      (r) =>
        r.role === member.role &&
        r.harness !== harness &&
        allowedModel(r.harness, r.model) &&
        successful.some(
          ({ member: m, turn }) =>
            harnessOf(turn.provider) === r.harness &&
            !m.archivedAt &&
            !signInHeld(m, now) &&
            store.heldUntil(m.id, now) === null,
        ),
    )
    .sort((a, b) => a.priority - b.priority);
  const route = routes.find((r) => r.difficulties.length === 4);
  // Owners have no worker allowlist. Only suggest an economical model actually seen working here.
  const ownerModel = ["hq", "supervisor", "lead"].includes(member.role)
    ? successful.find(({ member: m, turn }) => {
        const h = harnessOf(turn.provider);
        return (
          h &&
          h !== harness &&
          turn.model &&
          isEconomicalOwnerModel(h, turn.model) &&
          !m.archivedAt &&
          store.heldUntil(m.id, now) === null
        );
      })
    : undefined;
  const ownerHarness = ownerModel && harnessOf(ownerModel.turn.provider);
  const target = route
    ? { harness: route.harness, model: route.model, effort: route.effort }
    : ownerModel?.turn.model && ownerHarness
      ? {
          harness: ownerHarness,
          model: ownerModel.turn.model,
          effort: policy.policy.leadEffort,
        }
      : null;
  const checkpoint = store.autonomyOf(id);
  const brief = `Replacement for ${id}. Read durable assignment ${member.assignment}. Read its full checkpoint with alliance-work autonomy list; checkpoint data ${JSON.stringify(checkpoint ? { phase: checkpoint.phase, reason: checkpoint.reason.slice(0, 240) } : null)}. Preserve the assignment's authority, model restrictions, worktree and prior results; reconcile ownership before side effects.`;
  const command = target
    ? `paseo agent run --no-wait --cwd ${quote(member.cwd ?? store.room(member.roomId).cwd)} --provider ${quote(`alliance-${target.harness}-${member.role}/${target.model}`)} --thinking ${quote(target.effort)} ${quote(brief)}`
    : null;
  const account = limit.account;
  const accountAdvice: string[] = [];
  if (harness === "claude" && account && NAMED.includes(account)) {
    const affected = store
      .members()
      .filter(
        (m) =>
          !m.archivedAt && harnessOf(m.provider) === "claude" && !apartFromLimit(account, m.claudeAccounts),
      );
    const listed = affected
      .slice(0, 8)
      .map((m) => `${m.role} ${m.id}`)
      .join(", ");
    const other = account === "5x" ? "20x" : "5x";
    accountAdvice.push(
      `Affected members: ${listed}${affected.length > 8 ? `; and ${affected.length - 8} more` : ""}.`,
    );
    accountAdvice.push(
      `Only the Human may select the other account after confirming it is provisioned and not limited: alliance-work accounts select ${member.role} ${other}. Its quota was not read.`,
    );
  }
  const reason = [
    `${harness}${limit.account ? ` account ${limit.account}` : ""} quota depleted until ${new Date(limit.until).toISOString()}; reported by ${member.role} ${id} in ${member.roomId}.`,
    ...accountAdvice,
    `Recorded successful turns on this host within 1h: ${recent.join(", ") || "none"}. This is evidence of recent work, not available quota or a live catalog check. Legacy records expose only their latest completed turn.`,
    target
      ? `Policy revision ${policy.revision}: ${target.harness}/${target.model}, ${target.effort}${route ? `; ${member.role} priority ${route.priority}, all difficulties` : "; economical owner model, worker routes do not apply"}. Owner must confirm sufficiency and live model/mode availability before running:\n${command}`
      : `Policy revision ${policy.revision}: no confirmed replacement route for ${member.role}. ${
          routes.length
            ? `Difficulty-specific candidates: ${routes
                .slice(0, 3)
                .map((r) => `${r.harness}/${r.model} ${r.effort} (${r.difficulties.join(",")})`)
                .join("; ")}. `
            : ""
        }Owner/Human must assess a route in the live catalog. Assignment: ${member.assignment}; checkpoint: alliance-work autonomy list.`,
    "Alliance never switches providers automatically; scheduled retries and assignment authority remain in place.",
  ].join("\n\n");
  return { key: quotaNoticeKey(member, store), ownerId, harness, until: limit.until, reason, command };
}

/** Compatible entry point for every harness, including Claude with an unknown or legacy account. */
export function announceAccountLimit(
  store: RoomStore,
  wakes: Wakeups,
  home: string,
  id: string,
  now: number,
): Promise<void> {
  return announce(store, wakes, home, id, now).catch(() => undefined);
}
async function announce(store: RoomStore, wakes: Wakeups, home: string, id: string, now: number) {
  const reporter = store.member(id);
  const notice = quotaNotice(store, id, now);
  if (!reporter || !notice?.ownerId || wakes.list().some((w) => w.key === notice.key)) return;
  let reason = notice.reason;
  const account = store.member(id)?.limited?.account;
  if (notice.harness === "claude" && account && NAMED.includes(account)) {
    // Sibling advice is optional: corrupt/locked account metadata must not suppress the quota notice.
    try {
      const other = account === "5x" ? "20x" : "5x";
      const { config } = await claudeAccountsState(home);
      if (
        (config.accounts as string[]).includes(other) &&
        !store
          .members()
          .some(
            (m) =>
              harnessOf(m.provider) === "claude" &&
              m.limited &&
              m.limited.until > now &&
              m.limited.account !== account,
          )
      )
        reason += `\n\nClaude account ${other} is provisioned on this host and has no recorded limit; its quota was not read.`;
    } catch {
      /* The general notice still reaches its owner. */
    }
  }
  queueQuotaNotice(store, wakes, id, now, reason);
}

/** A quota without a recipient remains in member.limited; each wake sweep rechecks its custody. */
export function queueQuotaNotice(store: RoomStore, wakes: Wakeups, id: string, now: number, advice?: string) {
  const notice = quotaNotice(store, id, now);
  if (!notice?.ownerId || wakes.list().some((w) => w.key === notice.key)) return;
  let reason = advice ?? notice.reason;
  if (reason.length > 2000) reason = notice.reason;
  // Never send a truncated shell command. Status retains the complete assignment and checkpoint.
  if (reason.length > 2000)
    reason = `${notice.harness} quota depleted until ${new Date(notice.until).toISOString()}. Read the assignment and checkpoint for ${id} in alliance-work status --json, then assess a replacement route in the live catalog. Alliance never switches providers automatically.`;
  const owner = store.member(notice.ownerId);
  if (!owner) return;
  try {
    wakes.add({
      key: notice.key,
      roomId: owner.roomId,
      ownerId: notice.ownerId,
      reason,
      trigger: { kind: "time", at: now },
      delivery: "idle",
      expiresAt: notice.until,
    });
  } catch {
    /* A concurrent announcement or ownership change is reconciled by status/the next outcome. */
  }
}
