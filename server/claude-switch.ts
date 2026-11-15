import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { claudeAccountsState, selectedClaudeAccount, selectedClaudeLaunch } from "./claude-accounts.mjs";
import { currentClaudeAccount, jobBlocksClaudeSwitch } from "./claude-runtime.mjs";
import { observeJob } from "./jobs.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";
import type { RoomStore } from "./store";

export type IdleRetirement = (agentId: string, updatedAt: string) => Promise<boolean>;
export type AccountSession = {
  agentId: string;
  roomId: string;
  title: string;
  role: string;
  current: string | null;
  selected: string;
  reason?: string;
  state: "current" | "pending" | "ready" | "unsupported" | "unknown";
};

/** Native guarded retirement is the sole mutation. Never fall back to reload or cancellation. */
export class ClaudeSwitch {
  private switching = new Set<string>();
  private round?: Promise<AccountSession[]>;
  constructor(
    private home: string,
    private store: Pick<RoomStore, "members" | "jobs"> &
      Partial<Pick<RoomStore, "noteClaudeAccounts" | "noteWakeMessage">>,
    private observe = currentClaudeAccount,
    private prepare: (
      ...args: Parameters<typeof selectedClaudeLaunch>
    ) => Promise<{ account: string }> = selectedClaudeLaunch,
  ) {}
  sweep(paseo: PaseoApi, retire?: IdleRetirement) {
    this.round ??= this.run(paseo, retire).finally(() => {
      this.round = undefined;
    });
    return this.round;
  }
  private async run(paseo: PaseoApi, retire?: IdleRetirement): Promise<AccountSession[]> {
    const { config } = await claudeAccountsState(this.home);
    const sessions: AccountSession[] = [];
    const jobs = await Promise.all(this.store.jobs().map((job) => observeJob(job)));
    for (const member of this.store.members()) {
      if (this.switching.has(member.id)) continue;
      if (member.archivedAt || !member.provider.startsWith("alliance-claude-")) continue;
      const selected = selectedClaudeAccount(config, member.role, member.roomId);
      const row: AccountSession = {
        agentId: member.id,
        roomId: member.roomId,
        title: member.id,
        role: member.role,
        current: null,
        selected,
        state: "unknown",
      };
      sessions.push(row);
      // Recorded for the limit hold: which account a prompt to this member can run under.
      const note = (accounts: string[] | undefined) => this.store.noteClaudeAccounts?.(member.id, accounts);
      try {
        const live = (await paseo.agents.ref(member.id).refresh())?.agent;
        if (!live || live.archivedAt) continue;
        row.title = live.title ?? member.id;
        if (live.status === "closed") {
          row.state = "ready";
          note([selected]);
          continue;
        }
        row.current = await this.observe(this.home, member.id);
        // A live process without a verified receipt runs an unknown account.
        note(row.current ? [...new Set([row.current, selected])] : undefined);
        if (row.current === selected) {
          row.state = "current";
          continue;
        }
        // Preserve unobserved legacy login sessions unless a named account is selected.
        if (row.current === null && selected === "legacy") continue;
        row.state = retire ? "pending" : "unsupported";
        if (!retire || live.status !== "idle" || live.activeTurn || live.pendingPermissions.length) continue;
        // Alliance reporting relationships are not native process ownership. A peer's
        // job must not pin its idle HQ to the previous account. Native retirement still
        // checks actual provider work and native descendants before closing anything.
        if (
          (
            await Promise.all(
              jobs
                .filter((job) => job.ownerId === member.id)
                .map((job) => jobBlocksClaudeSwitch(this.home, member.id, job)),
            )
          ).some(Boolean)
        ) {
          row.reason = "Waiting for a dependent or unverified job; independent jobs do not block";
          continue;
        }
        // Re-read selection and verify access before releasing the last usable process.
        const prepared = await this.prepare(this.home, member.role, undefined, member.roomId);
        row.selected = prepared.account;
        if (row.current === prepared.account) {
          row.state = "current";
          note([prepared.account]);
          continue;
        }
        if (await retire(member.id, new Date(live.updatedAt).toISOString())) {
          row.current = null;
          row.state = "ready";
          note([prepared.account]);
        }
      } catch {
        row.state = "unknown"; // Retain custody after uncertain readback/retirement.
        note(undefined);
      }
    }
    for (const row of sessions) {
      const pending = await this.checkpoint(row.agentId);
      if (pending?.phase === "stopped" && !this.switching.has(row.agentId)) {
        try {
          await this.finish(paseo, row.agentId, pending, row);
        } catch {
          row.reason = "Account switch interrupted this turn; resume checkpoint retained for retry";
        }
      } else if (pending?.phase === "sending") {
        row.reason = "Resume delivery needs readback; not automatically sent again";
      }
    }
    return sessions;
  }
  private path(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid agent identity");
    return join(this.home, "claude-switch-checkpoints", `${id}.json`);
  }
  private async checkpoint(id: string): Promise<SwitchCheckpoint | null> {
    try {
      await assertNoLinks(this.path(id));
      return JSON.parse(await readFile(this.path(id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  private async save(id: string, value: SwitchCheckpoint) {
    const path = this.path(id);
    await assertNoLinks(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async finish(paseo: PaseoApi, id: string, pending: SwitchCheckpoint, row: AccountSession) {
    if (!["current", "ready"].includes(row.state)) return;
    const handle = paseo.agents.ref(id);
    const live = (await handle.refresh())?.agent;
    if (!live || live.pendingPermissions.length || live.archivedAt) return;
    if (live.activeTurn) {
      pending.phase = "complete"; // Another prompt already continued this session.
      await this.save(id, pending);
      return;
    }
    // Metadata opens the same persisted native session without sending a model prompt.
    await handle.commands();
    const current = await this.observe(this.home, id);
    const desired = (await this.prepare(this.home, row.role, undefined, row.roomId)).account;
    if (current !== desired) throw new Error("New runtime account not verified; resume retained");
    row.current = current;
    row.selected = desired;
    row.state = "current";
    pending.phase = "sending";
    await this.save(id, pending); // Ambiguous delivery is never automatically repeated.
    this.store.noteWakeMessage?.(id, pending.messageId, "alliance.account-switch", Date.now());
    await handle.send(
      "Human requested an account switch during your turn. Continue the same unfinished assignment from the retained history. Inspect existing files, tool results and background jobs before retrying any action; do not duplicate work. Preserve scope, budgets, ownership and acceptance conditions. This account change does not complete the assignment.",
      { messageId: pending.messageId, activeTurnBehavior: "steer" },
    );
    pending.phase = "complete";
    await this.save(id, pending);
  }
  async switchNow(
    paseo: PaseoApi,
    id: string,
    expectedAccount: string,
    retire: IdleRetirement | undefined,
    stop: ((id: string) => Promise<void>) | undefined,
  ) {
    if (!retire || !stop) throw new Error("Daemon does not support safe account switching");
    if (this.switching.has(id)) throw new Error("This session is already switching accounts");
    await this.round;
    if (this.switching.has(id)) throw new Error("This session is already switching accounts");
    this.switching.add(id);
    try {
      const member = this.store.members().find((m) => m.id === id && !m.archivedAt);
      if (!member?.provider.startsWith("alliance-claude-")) throw new Error("Not an active Claude session");
      const prepared = await this.prepare(this.home, member.role, undefined, member.roomId);
      if (prepared.account !== expectedAccount)
        throw new Error("Account selection changed; refresh and retry");
      const handle = paseo.agents.ref(id);
      const live = (await handle.refresh())?.agent;
      if (!live || live.archivedAt || live.pendingPermissions.length)
        throw new Error("Resolve pending permissions before switching");
      const current = await this.observe(this.home, id);
      if (current === prepared.account) return { status: "current" };
      const jobs = await Promise.all(
        this.store
          .jobs()
          .filter((j) => j.ownerId === id)
          .map((j) => observeJob(j)),
      );
      if ((await Promise.all(jobs.map((job) => jobBlocksClaudeSwitch(this.home, id, job)))).some(Boolean))
        throw new Error(
          "A job depends on this runtime or its ownership is unverified; finish or checkpoint that job first",
        );
      let checkpoint = await this.checkpoint(id);
      if (checkpoint && ["stopping", "sending"].includes(checkpoint.phase))
        throw new Error("Previous switch needs delivery readback; no duplicate stop or resume was sent");
      if (live.activeTurn) {
        if (checkpoint?.phase === "stopped")
          throw new Error("A new turn is already running; no additional stop was sent");
        checkpoint = {
          phase: "stopping",
          messageId: randomUUID(),
          turnId: live.activeTurn.turnId,
          snapshot: live,
          timeline: await handle.timeline.refetch({ direction: "tail", limit: 100 }),
        };
        await this.save(id, checkpoint);
        const fresh = (await handle.refresh())?.agent;
        if (fresh?.activeTurn?.turnId !== checkpoint.turnId) {
          checkpoint.phase = "complete";
          await this.save(id, checkpoint);
          throw new Error("Turn changed during checkpoint; refresh and retry");
        }
        await stop(id);
        checkpoint.phase = "stopped";
        await this.save(id, checkpoint);
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        const next = (await handle.refresh())?.agent;
        if (
          next &&
          !next.activeTurn &&
          !next.pendingPermissions.length &&
          ["idle", "closed"].includes(next.status)
        )
          break;
        await sleep(100);
      }
    } finally {
      this.switching.delete(id);
    }
    const rows = await this.sweep(paseo, retire);
    const row = rows.find((r) => r.agentId === id);
    return { status: row?.state ?? "unknown" };
  }
}

type SwitchCheckpoint = {
  phase: "stopping" | "stopped" | "sending" | "complete";
  messageId: string;
  turnId: string;
  snapshot: unknown;
  timeline: unknown;
};
