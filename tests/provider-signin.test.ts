import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { AllianceRuntime } from "../server/runtime";
import { temporary } from "./temp";

const AUTH = "Antigravity authentication failed. Run `agy` and sign in, then retry.";

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T18:39:00Z") });
  const home = await temporary("alliance-signin-");
  await writeFile(join(home, "profiles.json"), JSON.stringify({ home, root: home, profiles: {} }));
  const runtime = await new AllianceRuntime(home).ready();
  runtime.store.addRoom({
    id: "room",
    cwd: home,
    artifacts: home,
    title: "Sign-in",
    mission: "",
    workspaceId: "w",
    createdAt: "now",
  });
  for (const [id, role, parentId, provider] of [
    ["owner", "lead", null, "alliance-claude-lead"],
    ["peer", "peer", "owner", "alliance-agy-peer"],
  ] as const)
    runtime.store.saveMember({
      id,
      role,
      parentId,
      provider,
      roomId: "room",
      assignment: "brief.md",
      cwd: home,
      decision: "open",
      decisionEvidence: null,
      lastOutcome: null,
      resultPath: null,
      launchKey: null,
      launchHash: null,
    });
  const sent: { id: string; text: string }[] = [];
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: { status: "idle", archivedAt: null, pendingPermissions: [], activeTurn: null },
        }),
        send: async (text: string) => {
          sent.push({ id, text });
        },
      }),
    },
  } as unknown as PaseoApi;
  const agent = {
    id: "peer",
    provider: "alliance-agy-peer",
    cwd: home,
    workspaceId: "w",
    parentAgentId: "owner",
    title: null,
  };
  const advance = (ms: number) => t.mock.timers.setTime(Date.now() + ms);
  runtime.autonomy.start("peer");
  return { runtime, api, agent, sent, advance, home };
}

test("a signed-out provider's endless refusals hold the member, notify once and clear when a turn completes", async (t) => {
  const f = await fixture(t);
  // Paseo's finish-subscription retry re-sent a new message every ~7 s for hours; each failed before
  // any turn started, so no turn id existed to read back.
  for (let i = 0; i < 400; i++) {
    f.advance(7200);
    await f.runtime.endTurn(f.agent, null, { kind: "failed", error: { message: AUTH } }, undefined, f.api);
  }
  const held = f.runtime.store.member("peer")?.signIn;
  assert.ok(held && held.until > Date.now(), "the member is held");
  assert.match(held.reason, /agy/);
  assert.ok(held.holds >= 2 && held.holds <= 3, "holds lengthen, they do not repeat every failure");
  const notices = f.runtime.wakeups.list().filter((w) => w.key.startsWith("signin-"));
  assert.equal(notices.length, 1, "one notice per streak, not one per failure");
  assert.equal(notices[0].ownerId, "owner");
  assert.deepEqual(await readdir(join(f.home, "turns")).catch(() => []), [], "no turn record per failure");

  // Nothing Alliance sends reaches the held member.
  f.runtime.wakeups.add({
    key: "wait-held",
    roomId: "room",
    ownerId: "peer",
    reason: "Check the child",
    trigger: { kind: "time", at: Date.now() },
    delivery: "idle",
  });
  await f.runtime.wakeups.tick(f.api);
  await f.runtime.wakeups.tick(f.api);
  assert.deepEqual(
    f.sent.filter((m) => m.id === "peer"),
    [],
  );
  assert.equal(f.sent.filter((m) => m.id === "owner").length, 1, "the owner heard once");
  assert.match(f.sent[0].text, /agy/);

  // A completed turn of the same harness proves the sign-in works again.
  await f.runtime.startTurn(f.agent, "after-login", f.api);
  await f.runtime.endTurn(f.agent, "after-login", { kind: "completed" }, []);
  assert.equal(f.runtime.store.member("peer")?.signIn, undefined);
  await f.runtime.wakeups.tick(f.api);
  assert.equal(f.sent.filter((m) => m.id === "peer").length, 1);
});

test("transient failures and limits never hold a member", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    f.advance(1000);
    await f.runtime.startTurn(f.agent, `turn-${i}`, f.api);
    await f.runtime.endTurn(
      f.agent,
      `turn-${i}`,
      { kind: "failed", error: { message: i % 2 ? "socket hang up" : "overloaded_error" } },
      [],
    );
  }
  assert.equal(f.runtime.store.member("peer")?.signIn, undefined);
});

test("sign-in failures of started turns also hold the member", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    f.advance(60000);
    await f.runtime.startTurn(f.agent, `turn-${i}`, f.api);
    await f.runtime.endTurn(f.agent, `turn-${i}`, { kind: "failed", error: { message: AUTH } }, []);
  }
  assert.ok((f.runtime.store.member("peer")?.signIn?.until ?? 0) > Date.now());
});
