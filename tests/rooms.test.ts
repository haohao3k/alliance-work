import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles, verifyProfile } from "../scripts/profiles.mjs";
import { composeInstruction } from "../server/instructions";
import { AllianceRuntime } from "../server/runtime";
import { temporary } from "./temp";

function member(runtime: AllianceRuntime, id: string) {
  const record = runtime.store.member(id);
  assert(record, "Assigned member must exist");
  return record;
}

async function fixture() {
  const root = await temporary("alliance-test-");
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const manifest = await prepareProfiles({
    home,
    isolatedRoot: join(root, "profiles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  const runtime = await new AllianceRuntime(home).ready();
  let creates = 0,
    sends = 0,
    status = "idle";
  const identities = new Set<string>();
  const launchConfigs: { modeId?: string }[] = [];
  const workspace = {
    id: "workspace-1",
    agents: {
      create: async (input: { agentId: string; config: { modeId?: string } }) => {
        launchConfigs.push(input.config);
        if (!identities.has(input.agentId)) {
          creates++;
          identities.add(input.agentId);
        }
        return { id: input.agentId };
      },
    },
  };
  const paseo = {
    workspaces: { open: async () => workspace, ref: () => workspace },
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status, pendingPermissions: [], lastError: null } }),
        send: async () => {
          sends++;
        },
      }),
    },
  } as unknown as PaseoApi;
  const room = await runtime.createRoom(
    { cwd, title: "Example", mission: "Deliver a verified result" },
    paseo,
  );
  return {
    root,
    home,
    cwd,
    manifest,
    runtime,
    paseo,
    room,
    count: () => ({ creates, sends }),
    launchConfigs,
    status: (next: string) => {
      status = next;
    },
  };
}
test("role homes own exact Seatwork bytes and never inherit ambient credentials or instructions", async () => {
  const f = await fixture();
  try {
    const profile = f.manifest.profiles["codex-peer"];
    await verifyProfile(profile);
    assert.equal(profile.skillDirectories.length, 5);
    const env = profileEnvironment(profile, f.home, {
      HOME: "/daily",
      CODEX_HOME: "/daily/codex",
      ANTHROPIC_API_KEY: "daily-secret",
      PI_CODING_AGENT_DIR: "/daily/pi",
      PATH: "/bin",
      PASEO_AGENT_ID: "agent",
    });
    assert.equal(env.HOME, profile.osHome);
    assert.equal(env.CODEX_HOME, profile.home);
    assert(!("ANTHROPIC_API_KEY" in env));
    assert.equal(env.PASEO_AGENT_ID, "agent");
    const skill = join(profile.home, "skills/slp-evidence-report/SKILL.md");
    const expected = await readFile(
      join(import.meta.dirname, "../vendor/seatwork/skills/peer/slp-evidence-report/SKILL.md"),
    );
    assert.deepEqual(await readFile(skill), expected);
    await writeFile(skill, "modified");
    await assert.rejects(verifyProfile(profile), /changed/);
  } finally {
    f.runtime.close();
  }
});
test("symlink skill additions are rejected instead of falling back to a shared home", async () => {
  const f = await fixture();
  try {
    const profile = f.manifest.profiles["pi-peer"];
    await symlink(f.cwd, join(profile.home, "skills", "daily"));
    await assert.rejects(verifyProfile(profile), /Unmanaged skill/);
  } finally {
    f.runtime.close();
  }
});
test("a retried launch keeps one native agent and the durable assignment", async () => {
  const f = await fixture();
  try {
    const input = {
      roomId: f.room.id,
      key: "one-assignment",
      role: "peer" as const,
      harness: "codex" as const,
      model: "test-model",
      prompt: "Produce an artifact and verification.",
    };
    const first = await f.runtime.launch(input, f.paseo);
    const second = await f.runtime.launch(input, f.paseo);
    assert.equal(first.agentId, second.agentId);
    assert.equal(f.count().creates, 1);
    assert.equal(
      f.launchConfigs[0].modeId,
      "auto",
      "Fresh Codex homes need an explicit workspace-write mode",
    );
    assert.match(await readFile(member(f.runtime, first.agentId).assignment, "utf8"), /Produce an artifact/);
    await assert.rejects(
      f.runtime.launch({ ...input, prompt: "Different work" }, f.paseo),
      /different assignment/,
    );
  } finally {
    f.runtime.close();
  }
});
test("an explicit Codex permission mode survives Alliance launch", async () => {
  const f = await fixture();
  try {
    await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "explicit-mode",
        role: "peer",
        harness: "codex",
        model: "test-model",
        prompt: "Inspect only",
        mode: "read-only",
      },
      f.paseo,
    );
    assert.equal(f.launchConfigs[0].modeId, "read-only");
  } finally {
    f.runtime.close();
  }
});
test("canceled/failed/completed turns preserve ownership and never accept their own artifact, across restart", async () => {
  const f = await fixture();
  const { agentId } = await f.runtime.launch(
    { roomId: f.room.id, key: "work", role: "peer", harness: "codex", model: "test-model", prompt: "Task" },
    f.paseo,
  );
  const agent = {
    id: agentId,
    provider: "alliance-codex-peer",
    cwd: f.cwd,
    workspaceId: "workspace-1",
    parentAgentId: null,
    title: "Peer",
  };
  for (const outcome of [
    { kind: "canceled" as const, reason: "interrupted" },
    { kind: "failed" as const, error: { message: "offline" } },
    { kind: "completed" as const },
  ]) {
    await f.runtime.endTurn(agent, outcome.kind, outcome, []);
    assert.equal(member(f.runtime, agentId).decision, "open");
  }
  f.runtime.close();
  const reopened = await new AllianceRuntime(f.home).ready();
  try {
    assert.equal(member(reopened, agentId).lastOutcome, "completed");
    assert.equal(member(reopened, agentId).decision, "open");
    await reopened.disposition(agentId, "accepted", "sha:123", "Integration check passed");
    assert.equal(member(reopened, agentId).decision, "accepted");
    const disposition = member(reopened, agentId).decisionEvidence;
    assert(disposition);
    await reopened.startTurn(agent, "next-turn");
    assert.equal(member(reopened, agentId).decision, "open");
    assert.equal(member(reopened, agentId).resultPath, null);
    assert.equal(JSON.parse(await readFile(disposition, "utf8")).candidate, "sha:123");
  } finally {
    reopened.close();
  }
});
test("resume refuses to interrupt active work and late turn receipts cannot overwrite the current run", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "work", role: "peer", harness: "codex", model: "test-model", prompt: "Task" },
      f.paseo,
    );
    f.status("running");
    await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /already working/);
    assert.equal(f.count().sends, 0);
    f.runtime.store.updateMember(agentId, { lastTurnId: "new", lastOutcome: null });
    await f.runtime.endTurn(
      {
        id: agentId,
        provider: "alliance-codex-peer",
        cwd: f.cwd,
        workspaceId: "workspace-1",
        parentAgentId: null,
        title: null,
      },
      "old",
      { kind: "completed" },
      [],
    );
    assert.equal(member(f.runtime, agentId).lastOutcome, null);
    f.status("idle");
    await f.runtime.resume(agentId, "Continue", f.paseo);
    assert.equal(f.count().sends, 1);
  } finally {
    f.runtime.close();
  }
});

test("native inheritance replaces the generated role without duplicating it or losing caller instructions", () => {
  const supervisor = composeInstruction("SUPERVISOR_ROLE", "HUMAN_CONSTRAINT");
  const peer = composeInstruction("PEER_ROLE", supervisor);
  assert(!peer.includes("SUPERVISOR_ROLE"));
  assert(peer.includes("PEER_ROLE"));
  assert(peer.includes("HUMAN_CONSTRAINT"));
  assert.equal(composeInstruction("PEER_ROLE", peer), peer);
});
