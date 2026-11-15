import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { harnessOf } from "../shared/operations";
import { availableOwner } from "./lifecycle";
import type { MemberRecord, RoomStore } from "./store";
import type { Wakeups } from "./wakeups";

/**
 * A provider that is signed out fails every prompt the same way until someone signs in again, so
 * resending only makes noise (a Mac mini logged ~980 such failures an hour on 2026-11-11). The
 * member is left alone after a few of them, for longer each time a later try fails again, and
 * until a turn of the same harness on this host completes.
 */
const FAILURES_BEFORE_HOLD = 3;
const HOLD_MS = 30 * 60000;
const HOLD_MAX_MS = 6 * 3600000;
/** A failure this long after the last one starts a new streak. */
const STREAK_MS = 24 * 3600000;
/** While held, failures only refresh `lastAt` this often. */
const REFRESH_MS = 60000;
const NOTICE_MS = 6 * 3600000;

/** Provider messages that mean "sign in again" (not a limit, not a transient error). */
const SIGN_IN =
  /Antigravity authentication failed|not logged in|please run \/login|failed to authenticate|authentication_error|invalid (?:authentication credentials|bearer token|x-api-key)|\b401\b[^\n]{0,40}unauthori[sz]ed|unauthori[sz]ed[^\n]{0,20}\b401\b|refresh token (?:was |has |is )?(?:already )?(?:used|expired|revoked)|sign in again/i;
export const providerSignIn = (error: string | null | undefined) => Boolean(error && SIGN_IN.test(error));

const LOGIN: Record<string, string> = {
  agy: "run `agy` and sign in",
  claude: "run `claude` and sign in with /login",
  codex: "run `codex login`",
  pi: "sign in to the Pi provider",
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class SignIn {
  constructor(
    private store: RoomStore,
    private wakes: Wakeups,
    private now: () => number = Date.now,
  ) {}
  /** A prompt to this member failed on sign-in. Repeats while held are absorbed, not recorded again. */
  failed(id: string, error: string) {
    const member = this.store.member(id);
    const harness = harnessOf(member?.provider ?? "");
    if (!member || !harness) return;
    const now = this.now();
    const prior = member.signIn && now - member.signIn.lastAt < STREAK_MS ? member.signIn : undefined;
    if (prior && now < prior.until) {
      if (now - prior.lastAt >= REFRESH_MS)
        this.store.updateMember(id, { signIn: { ...prior, lastAt: now } });
      return;
    }
    const failures = (prior?.failures ?? 0) + 1;
    const since = prior?.since ?? now;
    if (failures < FAILURES_BEFORE_HOLD) {
      this.store.updateMember(id, {
        signIn: { since, lastAt: now, failures, holds: prior?.holds ?? 0, until: 0, reason: "" },
      });
      return;
    }
    const holds = (prior?.holds ?? 0) + 1;
    const until = now + Math.min(HOLD_MS * 2 ** (holds - 1), HOLD_MAX_MS);
    const host = hostname();
    const reason = `${harness} sign-in failed on ${host}: ${error.split("\n", 1)[0].slice(0, 200)}. On that host, ${LOGIN[harness]}. Alliance prompts this member again after ${new Date(until).toISOString()}, or when a ${harness} turn completes there.`;
    this.store.updateMember(id, { signIn: { since, lastAt: now, failures, holds, until, reason } });
    if (holds === 1) this.notify(member, harness, host, since, until);
  }
  /** One notice per owner and harness. It says what the Human has to do, and what Alliance cannot stop. */
  private notify(member: MemberRecord, harness: string, host: string, since: number, until: number) {
    const owner = availableOwner(this.store, member.id);
    if (!owner) return;
    const key = `signin-${sha256(`${owner}:${harness}:${Math.floor(since / NOTICE_MS)}`).slice(0, 32)}`;
    if (this.wakes.list().some((w) => w.key === key)) return;
    try {
      this.wakes.add({
        key,
        roomId: this.store.member(owner)?.roomId ?? member.roomId,
        ownerId: owner,
        reason: `${member.role} ${member.id} cannot use ${harness} on ${host}: signed out. Human: ${LOGIN[harness]} on ${host}. Alliance stopped prompting it until ${new Date(until).toISOString()} and resumes by itself after a ${harness} turn completes there. This does not stop a retry loop inside the Paseo daemon ("Retrying finish subscription" in its log): signing in, or archiving the agent, does.`,
        trigger: { kind: "time", at: this.now() },
        delivery: "idle",
        expiresAt: this.now() + NOTICE_MS,
      });
    } catch {
      /* A cross-room owner may not be authorized; the member's status still names the problem. */
    }
  }
  /** A turn of this member's harness completed on this host: it is signed in again. */
  recovered(id: string) {
    const harness = harnessOf(this.store.member(id)?.provider ?? "");
    if (!harness) return;
    for (const member of this.store.members())
      if (member.signIn && harnessOf(member.provider) === harness)
        this.store.updateMember(member.id, { signIn: undefined });
  }
}
