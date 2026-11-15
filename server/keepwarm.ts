import type { PaseoApi } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { warmCompanion, warmKey } from "../shared/keepwarm";
import { claudeQuota } from "./claude-quota.mjs";
import { type MemberRecord, type RoomStore, signInHeld } from "./store";

const MIN_IDLE = 45 * 60000;
const MAX_IDLE = 50 * 60000;
export interface WarmAgent {
  status: string;
  archivedAt?: string | null;
  updatedAt?: string | null;
  pendingPermissions?: readonly unknown[];
  providerUnavailable?: boolean;
  activeTurn?: unknown;
  model?: string | null;
  effectiveThinkingOptionId?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number; cachedInputTokens?: number };
}
type Quota = {
  accounts: { id: string; error?: string | null; windows: { label: string; usedPct: number }[] }[];
};

export class KeepWarm {
  private quotas = new Map<string, { at: number; safe: boolean }>();
  constructor(
    private store: RoomStore,
    private now: () => number = Date.now,
    private quota: (account: string) => Promise<Quota> = (accountId) => claudeQuota({ accountId }),
  ) {}

  private hasWork(id: string) {
    return this.store
      .wakeups()
      .some(
        (w) =>
          w.ownerId === id &&
          (["pending", "dispatching", "uncertain"].includes(w.state) ||
            (w.state === "scheduled" && w.dueAt <= this.now())) &&
          !warmKey(w.key) &&
          !warmCompanion(w),
      );
  }
  candidate(m: MemberRecord) {
    const policy = this.store.keepwarm(m.roomId);
    const warm = m.warm;
    const phase = this.store.autonomyOf(m.id)?.phase;
    if (
      !policy.enabled ||
      !/^alliance-claude-(?:lead|hq|supervisor)$/.test(m.provider) ||
      !["lead", "hq", "supervisor"].includes(m.role) ||
      m.archivedAt ||
      m.decision === "accepted" ||
      m.keep ||
      (phase !== undefined && phase !== "waiting") ||
      m.limited ||
      signInHeld(m, this.now()) ||
      this.store.heldUntil(m.id, this.now()) !== null ||
      m.turnInputPending ||
      m.turnReadbackPending ||
      !warm ||
      warm.pending ||
      typeof warm.model !== "string" ||
      !warm.model ||
      (warm.effort !== null && typeof warm.effort !== "string") ||
      typeof warm.account !== "string" ||
      !warm.account ||
      !Array.isArray(warm.messageIds) ||
      m.claudeAccounts?.length !== 1 ||
      m.claudeAccounts[0] !== warm.account ||
      !Number.isFinite(warm.idleSince) ||
      !Number.isFinite(warm.lastAt) ||
      !Number.isInteger(warm.pings) ||
      warm.pings < 0 ||
      warm.pings >= policy.maxPings ||
      (warm.lastAttemptAt !== undefined && this.now() - warm.lastAttemptAt < 5 * 60000) ||
      this.hasWork(m.id)
    )
      return false;
    const idle = this.now() - Math.max(warm.idleSince, m.lastTurnEndedAt ?? 0, warm.lastAt);
    return idle >= MIN_IDLE && idle < MAX_IDLE;
  }
  private async safeQuota(account: string) {
    const cached = this.quotas.get(account);
    if (cached && this.now() - cached.at < 10 * 60000) return cached.safe;
    let safe = false;
    try {
      const q = (await this.quota(account)).accounts.find((a) => a.id === account);
      safe =
        !!q &&
        !q.error &&
        ["Session (5h)", "Weekly"].every((label) => q.windows.some((w) => w.label === label)) &&
        q.windows.every((w) => Number.isFinite(w.usedPct) && w.usedPct >= 0 && w.usedPct < 100);
    } catch {
      /* Unknown quota never spends subscription credits. */
    }
    this.quotas.set(account, { at: this.now(), safe });
    return safe;
  }
  liveEligible(m: MemberRecord, agent: WarmAgent) {
    const warm = m.warm;
    if (!warm || !this.candidate(m)) return false;
    const ctx = agent.lastUsage?.contextWindowUsedTokens;
    const updated = Date.parse(agent.updatedAt ?? "");
    const idle = this.now() - Math.max(updated, warm.idleSince, m.lastTurnEndedAt ?? 0, warm.lastAt);
    return (
      agent.status === "idle" &&
      !agent.archivedAt &&
      !agent.activeTurn &&
      agent.pendingPermissions?.length === 0 &&
      !agent.providerUnavailable &&
      Number.isFinite(updated) &&
      idle >= MIN_IDLE &&
      idle < MAX_IDLE &&
      typeof ctx === "number" &&
      Number.isFinite(ctx) &&
      ctx >= this.store.keepwarm(m.roomId).minCtx &&
      agent.model === warm.model &&
      agent.effectiveThinkingOptionId === warm.effort
    );
  }
  async prepare(api: PaseoApi) {
    if (this.store.readOnly) return [];
    const ready: string[] = [];
    for (const initial of this.store.members()) {
      const warm = initial.warm;
      if (!warm || !this.candidate(initial)) continue;
      const live = await api.agents
        .ref(initial.id)
        .refresh()
        .catch(() => null);
      if (!live || !this.liveEligible(initial, live.agent)) continue;
      if (!(await this.safeQuota(warm.account))) continue;
      const current = this.store.member(initial.id);
      if (current && this.liveEligible(current, live.agent)) ready.push(initial.id);
    }
    return ready;
  }
  /** Resolve a missing start/end hook only from a complete native idle timeline. */
  async recover(api: PaseoApi) {
    if (this.store.readOnly) return;
    for (const m of this.store.members()) {
      const recorded = m.warm;
      const pending = recorded?.pending;
      if (!recorded || !pending || m.turnReadbackPending || this.now() - pending.at < 60000) continue;
      let diagnostic = "Keepwarm awaits native completion/input evidence; real input reclassifies it";
      try {
        const ref = api.agents.ref(m.id);
        const live = await ref.refresh();
        if (!live || live.agent.status !== "idle" || live.agent.activeTurn) continue;
        const page = await ref.timeline.refetch({ direction: "tail", limit: 100, projection: "canonical" });
        if (page.error || page.gap || page.staleCursor) throw new Error("Native timeline unavailable");
        // Recovery has no end-hook generation proof. A truncated tail may omit tools or responses.
        if (page.hasOlder !== false) throw new Error("Incomplete keepwarm generation");
        if (page.entries.some((e) => !Number.isFinite(Date.parse(e.timestamp))))
          throw new Error("Unknown native timestamp");
        const rows = page.entries.filter((e) => Date.parse(e.timestamp) >= pending.at);
        const known = rows.find(
          (e) =>
            e.item.type === "user_message" &&
            (e.item.clientMessageId ?? e.item.messageId) === pending.messageId,
        );
        const current = this.store.member(m.id);
        if (
          current?.warm?.pending?.messageId !== pending.messageId ||
          current.warm.pending.startedAt !== pending.startedAt
        )
          continue;
        const foreign = rows.some(
          (e) =>
            e.item.type === "user_message" &&
            !recorded.messageIds.includes(e.item.clientMessageId ?? e.item.messageId ?? ""),
        );
        if (known?.turnId && !foreign && (pending.turnId === undefined || pending.turnId === known.turnId)) {
          const turn = rows.filter((e) => e.turnId === known.turnId);
          const messages = turn.map((e) => e.item);
          if (
            messages.some((item) => item.type === "assistant_message") &&
            this.complete(m.id, messages, live.agent, Math.max(...turn.map((e) => Date.parse(e.timestamp))))
          )
            continue;
        } else if (!page.hasOlder && !rows.some((e) => e.item.type === "user_message") && !pending.turnId) {
          // A complete, fresh idle history proves an interrupted send never reached the provider.
          this.refused(m.id, pending.messageId);
          continue;
        }
      } catch (error) {
        diagnostic =
          error instanceof Error && error.message === "Incomplete keepwarm generation"
            ? "Keepwarm native history is truncated/incomplete; full generation required, retrying each scheduler round"
            : "Keepwarm native readback unavailable; retrying each scheduler round";
      }
      const warm = this.store.member(m.id)?.warm;
      if (warm?.pending?.messageId === pending.messageId && warm.pending.error !== diagnostic)
        this.store.updateMember(m.id, { warm: { ...warm, pending: { ...warm.pending, error: diagnostic } } });
    }
  }
  claim(id: string, messageId: string, contextTokens: number) {
    const warm = this.store.member(id)?.warm;
    if (!warm) throw new Error("Missing warm baseline");
    this.store.updateMember(id, {
      warm: {
        ...warm,
        pings: warm.pings + 1,
        lastAttemptAt: this.now(),
        messageIds: [...warm.messageIds, messageId].slice(-32),
        pending: {
          messageId,
          at: this.now(),
          contextTokens,
          error: "Keepwarm dispatched; awaiting native input/completion evidence",
        },
      },
    });
  }
  refused(id: string, messageId: string) {
    const warm = this.store.member(id)?.warm;
    if (warm?.pending?.messageId === messageId && !warm.pending.turnId)
      this.store.updateMember(id, { warm: { ...warm, pending: undefined } });
  }
  /** A real turn supplies the baseline; never manufacture one from a later idle observation. */
  baseline(id: string, agent: WarmAgent | undefined, at: number) {
    const m = this.store.member(id);
    if (!m || !/^alliance-claude-/.test(m.provider)) return;
    if (!agent?.model || agent.effectiveThinkingOptionId === undefined || m.claudeAccounts?.length !== 1) {
      this.store.updateMember(id, { warm: undefined });
      return;
    }
    this.store.updateMember(id, {
      warm: {
        idleSince: at,
        pings: 0,
        lastAt: 0,
        messageIds: m.warm?.messageIds ?? [],
        model: agent.model,
        effort: agent.effectiveThinkingOptionId,
        account: m.claudeAccounts[0],
      },
    });
  }
  complete(id: string, timeline: readonly AgentTimelineItem[], agent?: WarmAgent, at = this.now()) {
    const m = this.store.member(id);
    const warm = m?.warm;
    if (!m || !warm) return false;
    const users = timeline.filter((item) => item.type === "user_message");
    if (
      !users.length ||
      !users.every((item) => warm.messageIds.includes(item.clientMessageId ?? item.messageId ?? ""))
    )
      return false;
    const ids = new Set(users.map((item) => item.clientMessageId ?? item.messageId));
    // Historical ping IDs stay transparent, but only the current receipt may settle its generation.
    if (!warm.pending || !ids.has(warm.pending.messageId)) return true;
    const notices = this.store
      .wakeups()
      .some((w) => w.ownerId === id && w.messageId && ids.has(w.messageId) && !warmKey(w.key));
    if (!notices) {
      const ctx = warm.pending.contextTokens ?? agent?.lastUsage?.contextWindowUsedTokens;
      const cached = agent?.lastUsage?.cachedInputTokens;
      const reason = timeline.some((item) => item.type === "tool_call")
        ? "Keepwarm turn called a tool"
        : timeline.filter((item) => item.type === "assistant_message").length > 1
          ? "Keepwarm turn emitted multiple responses"
          : ctx && cached !== undefined && cached > 1.5 * ctx
            ? "Keepwarm turn used multiple requests"
            : undefined;
      if (reason) this.store.setKeepwarm(m.roomId, false, null, undefined, reason);
    }
    this.store.updateMember(id, {
      warm: { ...warm, lastAt: at, pending: undefined },
      turnReadbackPending: undefined,
    });
    return true;
  }
}
