import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { launchPlan, profileEnvironment } from "../scripts/launch.mjs";
import { prepareProfiles, verifyProfile } from "../scripts/profiles.mjs";
import { runVerification } from "../server/evidence.mjs";
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
  let archivedAt: string | null = null;
  const identities = new Set<string>();
  const launchConfigs: { modeId?: string; thinkingOptionId?: string }[] = [];
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
    providers: {
      listModels: async (provider: string) => ({
        models: ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5", "claude-sonnet-5-5"].map((id) => ({
          provider,
          id,
          label: id,
          thinkingOptions: ["low", "medium", "high", "xhigh"].map((id) => ({ id, label: id })),
        })),
      }),
    },
    workspaces: { open: async () => workspace, ref: (id: string) => ({ ...workspace, id }) },
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status, archivedAt, pendingPermissions: [], lastError: null } }),
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
    archived: (value: boolean) => {
      archivedAt = value ? new Date().toISOString() : null;
    },
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
    assert.equal(profile.skillDirectories.length, 7);
    const env = profileEnvironment(profile, f.home, {
      HOME: "/daily",
      CODEX_HOME: "/daily/codex",
      ANTHROPIC_API_KEY: "daily-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "daily-oauth",
      PI_CODING_AGENT_DIR: "/daily/pi",
      PATH: "/bin",
      PASEO_AGENT_ID: "agent",
    });
    assert.equal(env.HOME, profile.osHome);
    assert.equal(env.CODEX_HOME, profile.home);
    assert(!("ANTHROPIC_API_KEY" in env));
    assert(!("CLAUDE_CODE_OAUTH_TOKEN" in env));
    const explicit = { CLAUDE_CODE_OAUTH_TOKEN: "explicit-test-token" };
    assert.equal(
      profileEnvironment(f.manifest.profiles["claude-peer"], f.home, {}, explicit).CLAUDE_CODE_OAUTH_TOKEN,
      explicit.CLAUDE_CODE_OAUTH_TOKEN,
    );
    assert.throws(() => profileEnvironment(profile, f.home, {}, explicit), /Unsupported/);
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
test("role credentials reject shared permissions, links and malformed JSON without leaking bytes", async () => {
  const f = await fixture();
  try {
    const path = join(f.manifest.profiles["claude-peer"].home, "credentials.env.json");
    await writeFile(path, '{"CLAUDE_CODE_OAUTH_TOKEN":"test-secret"}', { mode: 0o644 });
    await chmod(path, 0o644);
    await assert.rejects(launchPlan(f.home, "claude-peer", ["auth", "status"]), /owner-only/);
    await chmod(path, 0o600);
    const plan = await launchPlan(f.home, "claude-peer", ["auth", "status"]);
    assert.equal(plan.env.CLAUDE_CODE_OAUTH_TOKEN, "test-secret");
    await writeFile(path, '{"CLAUDE_CODE_OAUTH_TOKEN":"test-secret"');
    await assert.rejects(
      launchPlan(f.home, "claude-peer", ["auth", "status"]),
      (error: Error) => error.message.includes("invalid") && !error.message.includes("test-secret"),
    );
    const linked = join(f.manifest.profiles["claude-lens"].home, "credentials.env.json");
    await symlink(path, linked);
    await assert.rejects(launchPlan(f.home, "claude-lens", ["auth", "status"]), /Symlink/);
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
      model: "gpt-6.1-sol",
      prompt: "Produce an artifact and verification.",
    };
    const first = await f.runtime.launch(input, f.paseo);
    const settings = f.runtime.store.modelPolicy(f.room.id);
    for (const route of settings.policy.routes) {
      if (route.model === "gpt-6.1-sol") {
        route.difficulties = route.effort === "medium" ? ["routine", "standard"] : ["complex"];
      }
    }
    f.runtime.store.saveModelPolicy(f.room.id, settings.policy, settings.revision);
    const second = await f.runtime.launch(input, f.paseo);
    assert.equal(first.agentId, second.agentId);
    assert.equal(f.count().creates, 1);
    assert.equal(f.launchConfigs[0].thinkingOptionId, "high");
    assert.equal(
      f.launchConfigs[1].thinkingOptionId,
      "high",
      "Retries retain their resolved route despite changed preferences",
    );
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
        model: "gpt-6.1-sol",
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
test("Lead can explicitly choose a worker model and effort", async () => {
  const f = await fixture();
  try {
    const result = await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "flexible-lead",
        role: "lead",
        harness: "codex",
        model: "gpt-6.1-sol",
        thinking: "xhigh",
        prompt: "Own this workstream",
      },
      f.paseo,
    );
    assert.equal(f.count().creates, 1);
    assert.equal(f.runtime.store.member(result.agentId)?.launchModel, "gpt-6.1-sol");
    assert.equal(f.launchConfigs[0].thinkingOptionId, "xhigh");
  } finally {
    f.runtime.close();
  }
});

test("canceled/failed/completed turns preserve ownership and never accept their own artifact, across restart", async () => {
  const f = await fixture();
  const { agentId } = await f.runtime.launch(
    { roomId: f.room.id, key: "work", role: "peer", harness: "codex", model: "gpt-6.1-sol", prompt: "Task" },
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
    execFileSync("git", ["init", "-q", f.cwd]);
    const proof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "proof"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "disposition-persistence",
    });
    await reopened.disposition(agentId, "accepted", proof.report.candidate.digest, proof.path);
    assert.equal(member(reopened, agentId).decision, "accepted");
    const disposition = member(reopened, agentId).decisionEvidence;
    assert(disposition);
    await reopened.startTurn(agent, "next-turn");
    assert.equal(member(reopened, agentId).decision, "open");
    assert.equal(member(reopened, agentId).resultPath, null);
    const display = (await reopened.list(f.paseo)).members.find((m) => m.id === agentId);
    assert.equal(display?.decision, "open");
    assert.equal(display?.lastAcceptance?.kind, "test");
    assert.equal(display?.lastAcceptance?.candidate, proof.report.candidate.digest);
    assert.equal(JSON.parse(await readFile(disposition, "utf8")).candidate, proof.report.candidate.digest);
  } finally {
    reopened.close();
  }
});
test("resume refuses to interrupt active work and late turn receipts cannot overwrite the current run", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      {
        roomId: f.room.id,
        key: "work",
        role: "peer",
        harness: "codex",
        model: "gpt-6.1-sol",
        prompt: "Task",
      },
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

test("native Alliance launch creates a missing room once and reuses it across concurrent starts and restart", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "new-project");
    await mkdir(cwd);
    const alias = join(f.root, "project-alias");
    await symlink(cwd, alias);
    const instructions = await Promise.all([
      f.runtime.instruction("alliance-codex-hq", cwd, f.paseo),
      f.runtime.instruction("alliance-codex-hq", alias, f.paseo),
    ]);
    const first = await f.runtime.roomFor(cwd);
    const second = await f.runtime.roomFor(alias);
    assert.equal(first.id, second.id);
    assert(instructions.every((instruction) => instruction.includes(first.id)));
    assert.equal(f.runtime.store.rooms().length, 2);
    const instruction = await f.runtime.instruction("alliance-codex-hq", cwd, f.paseo);
    assert(instruction.includes(first.id));
    assert.equal(f.runtime.store.rooms().length, 2);
    // Re-adding a known path cannot replace the original mission or workspace.
    const known = await f.runtime.createRoom(
      { cwd: f.cwd, title: "Overwrite", mission: "Overwrite" },
      f.paseo,
    );
    assert.deepEqual(known, f.room);
    const reopened = await new AllianceRuntime(f.home).ready();
    try {
      assert.equal((await reopened.ensureRoom(cwd, f.paseo)).id, first.id);
      assert.equal(reopened.store.rooms().length, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.runtime.close();
  }
});

test("a resumed native session binds a missing room to its existing workspace", async () => {
  const f = await fixture();
  try {
    const cwd = join(f.root, "resumed-project");
    await mkdir(cwd);
    const room = await f.runtime.ensureRoom(cwd, f.paseo, "existing-workspace");
    // A reference to the actual workspace must be used rather than opening another one.
    assert.equal(room.workspaceId, "existing-workspace");
    await assert.rejects(f.runtime.ensureRoom(join(cwd, "missing"), f.paseo));
    assert.equal(f.runtime.store.rooms().length, 2);
  } finally {
    f.runtime.close();
  }
});

test("a linked Git worktree reuses its project's room; ambiguous roots never create another room", async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: f.cwd, stdio: "pipe" });
    git("init");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    );
    const worktree = join(f.root, "worktree");
    git("worktree", "add", "-b", "worker", worktree);
    assert.equal((await f.runtime.ensureRoom(worktree, f.paseo)).id, f.room.id);
    assert.equal(f.runtime.store.rooms().length, 1);
    // An explicit separate room is allowed; it makes a third linked checkout ambiguous.
    await f.runtime.createRoom({ cwd: worktree, title: "Separate", mission: "Separate scope" }, f.paseo);
    const third = join(f.root, "third");
    git("worktree", "add", "-b", "other", third);
    await assert.rejects(f.runtime.ensureRoom(third, f.paseo), /Several rooms/);
    assert.equal(f.runtime.store.rooms().length, 2);
    assert.equal((await f.runtime.ensureRoom(worktree, f.paseo)).title, "Separate");
  } finally {
    f.runtime.close();
  }
});

test("acceptance refuses invented candidate and evidence identities", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "proof", role: "peer", harness: "codex", prompt: "Verify an outcome" },
      f.paseo,
    );
    await assert.rejects(f.runtime.disposition(agentId, "accepted", "invented", "not-a-report"));
  } finally {
    f.runtime.close();
  }
});

test("resume refuses unknown, archived and closed recipients without sending a prompt", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "safe-resume", role: "peer", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    for (const status of ["unknown", "unavailable", "closed", "stopped", "awaiting_permission"]) {
      f.status(status);
      await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /idle|unavailable|permission/i);
    }
    f.status("idle");
    f.archived(true);
    await assert.rejects(f.runtime.resume(agentId, "Continue", f.paseo), /unarchived/);
    assert.equal(f.count().sends, 0);
  } finally {
    f.runtime.close();
  }
});

test("tracked processes survive reload, expose missing owners and refuse stale ownership edits", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "job-owner", role: "lead", harness: "codex", prompt: "Own the job" },
      f.paseo,
    );
    await f.runtime.trackJob({
      key: "long-run",
      roomId: f.room.id,
      ownerId: agentId,
      title: "External controller",
      pid: process.pid,
    });
    const first = (await f.runtime.list(f.paseo)).jobs[0];
    assert.equal(first.state, "running");
    assert.equal(first.ownerStatus, "available");
    f.status("closed");
    assert.equal((await f.runtime.list(f.paseo)).jobs[0].ownerStatus, "needs-owner");
    await assert.rejects(f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo), /unavailable/);
    f.status("idle");
    await f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo);
    await assert.rejects(f.runtime.changeJobOwner("long-run", agentId, 1, f.paseo), /changed/);
    assert.equal(f.count().sends, 0, "Tracking never dispatches work or interrupts an owner");
    const reopened = await new AllianceRuntime(f.home).ready();
    try {
      assert.equal((await reopened.list(f.paseo)).jobs[0].revision, 2);
    } finally {
      reopened.close();
    }
  } finally {
    f.runtime.close();
  }
});

test("explicit ownership survives native rebinding and rejects stale or cyclic handoffs", async () => {
  const f = await fixture();
  try {
    const create = async (key: string) =>
      (
        await f.runtime.launch(
          { roomId: f.room.id, key, role: "lead", harness: "codex", prompt: "Own outcome" },
          f.paseo,
        )
      ).agentId;
    const lead = await create("lead"),
      hq = await create("hq");
    const evidence = join(f.root, "handoff.md");
    await writeFile(evidence, "Human assigns HQ to own Lead acceptance.");
    await f.runtime.changeMemberOwner(lead, hq, 0, evidence, f.paseo);
    await f.runtime.bind({
      id: lead,
      provider: "alliance-codex-lead",
      cwd: f.cwd,
      workspaceId: "workspace-1",
      parentAgentId: null,
      title: null,
    });
    const current = (await f.runtime.list(f.paseo)).members.find((m) => m.id === lead);
    assert(current);
    assert.equal(current.ownerId, hq);
    assert.equal(current.ownerRevision, 1);
    await assert.rejects(f.runtime.changeMemberOwner(lead, null, 0, evidence, f.paseo), /changed/);
    await assert.rejects(f.runtime.changeMemberOwner(hq, lead, 0, evidence, f.paseo), /cycle/);
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("policy acknowledgement is revision-bound and never starts or changes a native turn", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "policy", role: "lead", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    const policy = await f.runtime.readPolicy(agentId);
    assert.equal(policy.acknowledged, false);
    await assert.rejects(f.runtime.acknowledgePolicy(agentId, "0".repeat(64)), /changed/);
    await f.runtime.acknowledgePolicy(agentId, policy.digest);
    assert.equal((await f.runtime.readPolicy(agentId)).acknowledged, true);
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("session recovery restores open obligations under the current common policy without prompting owners", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "recover", role: "peer", harness: "codex", prompt: "Work" },
      f.paseo,
    );
    const evidence = join(f.root, "handoff.md");
    await writeFile(evidence, "Human now owns the next decision.");
    await f.runtime.obligations.add(
      {
        key: "future-work",
        roomId: f.room.id,
        ownerId: agentId,
        assignment: member(f.runtime, agentId).assignment,
        authority: "Human brief",
        nextAction: "Review accepted scope",
        closeWhen: "Review recorded",
        conditions: [{ id: "permission", requires: "Human decides scope" }],
      },
      f.paseo,
    );
    const first = await f.runtime.recoveryContext(agentId);
    assert((await readFile(first, "utf8")).includes("future-work"));
    const policy = await f.runtime.readPolicy(agentId);
    assert.equal(policy.obligations.length, 1);
    assert.equal(policy.obligations[0].blockedOn.length, 1);
    f.archived(true);
    assert.equal((await f.runtime.list(f.paseo)).obligations[0].ownerStatus, "needs-owner");
    await f.runtime.obligations.action(
      { key: "future-work", ownerId: agentId, revision: 1, action: "handoff", nextOwnerId: null, evidence },
      f.paseo,
    );
    await f.runtime.recoveryContext(agentId);
    assert(!(await readFile(first, "utf8")).includes('"key": "future-work"'));
    assert.equal((await f.runtime.list(f.paseo)).obligations[0].ownerStatus, "human");
    assert.equal(f.count().sends, 0);
  } finally {
    await f.runtime.close();
  }
});

test("product acceptance needs runtime proof and retains the observed journey separately from technical PASS", async () => {
  const f = await fixture();
  try {
    const { agentId } = await f.runtime.launch(
      { roomId: f.room.id, key: "product", role: "lead", harness: "codex", prompt: "Deliver product" },
      f.paseo,
    );
    execFileSync("git", ["init", "-q", f.cwd]);
    const proof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "technical"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "check",
      kind: "test",
    });
    const product = {
      outcome: "Operator reads a saved result",
      journey: "Open saved run, inspect result and limitations",
      reviewer: "Human",
      remaining: ["External integration untested"],
    };
    await assert.rejects(
      f.runtime.disposition(agentId, "accepted", proof.report.candidate.digest, proof.path, product),
      /runtime/,
    );
    const runtimeProof = await runVerification({
      cwd: f.cwd,
      output: join(f.root, "runtime"),
      command: [process.execPath, "-e", "process.exit(0)"],
      scenario: "fixture journey",
      kind: "runtime",
    });
    await f.runtime.disposition(
      agentId,
      "accepted",
      runtimeProof.report.candidate.digest,
      runtimeProof.path,
      product,
    );
    const decisionEvidence = member(f.runtime, agentId).decisionEvidence;
    assert(decisionEvidence);
    const record = JSON.parse(await readFile(decisionEvidence, "utf8"));
    assert.deepEqual(record.product, product);
    assert.equal(
      (await f.runtime.list(f.paseo)).members.find((m) => m.id === agentId)?.lastAcceptance?.product?.outcome,
      product.outcome,
    );
  } finally {
    await f.runtime.close();
  }
});
