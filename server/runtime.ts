import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { validateEvidence } from "../server/evidence.mjs";
import { projectSkills, skillCatalog } from "../server/project-skills.mjs";
import { Acceptance, type memberLaunch, type RoleName, type RoomRecord } from "../shared/contracts";
import { policyInstruction, type TaskDifficulty } from "../shared/model-policy";
import { ownerState } from "../shared/operations";
import { observeJob, processIdentity } from "./jobs.mjs";
import { chooseModel } from "./model-policy";
import { verifyProfile } from "./profile-integrity.mjs";
import { RoomStore } from "./store";

interface Profile {
  home: string;
  osHome: string;
  role: RoleName;
  harness: string;
  files: Record<string, string>;
  skillDirectories: string[];
  executable: string;
}
interface Manifest {
  home: string;
  root: string;
  profiles: Record<string, Profile>;
}
const execute = promisify(execFile);
export function allianceProvider(provider: string): { harness: string; role: RoleName; id: string } | null {
  const match = /^alliance-(codex|claude|pi)-(hq|supervisor|lead|peer|lens)$/.exec(provider);
  return match ? { harness: match[1], role: match[2] as RoleName, id: `${match[1]}-${match[2]}` } : null;
}
async function noLinks(path: string) {
  for (let current = resolve(path); current !== dirname(current); current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Alliance refuses symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function writeAtomic(path: string, text: string) {
  await noLinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
async function gitRoot(cwd: string) {
  try {
    return resolve(
      cwd,
      (
        await execute("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd,
          timeout: 3000,
        })
      ).stdout.trim(),
    );
  } catch {
    return null;
  }
}
export class AllianceRuntime {
  readonly home: string;
  store!: RoomStore;
  private manifest!: Manifest;
  private roomWrite: Promise<unknown> = Promise.resolve();
  constructor(home: string) {
    this.home = resolve(home || process.env.ALLIANCE_WORK_HOME || join(homedir(), ".alliance-work"));
  }
  async ready() {
    await noLinks(this.home);
    this.manifest = JSON.parse(await readFile(join(this.home, "profiles.json"), "utf8"));
    if (this.manifest.home !== this.home) throw new Error("Alliance manifest belongs to another home");
    this.store = new RoomStore(this.home);
    return this;
  }
  async profile(provider: string) {
    const identity = allianceProvider(provider);
    if (!identity) throw new Error(`Not an Alliance provider: ${provider}`);
    const profile = this.manifest.profiles[identity.id];
    if (!profile) throw new Error(`Profile ${identity.id} is not prepared`);
    await verifyProfile(profile);
    return profile;
  }
  profiles() {
    return {
      home: this.home,
      profiles: Object.entries(this.manifest.profiles).map(([id, profile]) => ({
        id,
        home: profile.home,
        skills: profile.skillDirectories.length,
      })),
    };
  }
  async modelCatalog(roomId: string, harness: string, role: RoleName, paseo: PaseoApi) {
    const room = this.store.room(roomId);
    const result = await paseo.providers.listModels(`alliance-${harness}-${role}`, { cwd: room.cwd });
    if (result.error || !result.models) throw new Error(result.error || "Provider model catalog unavailable");
    return result.models;
  }
  async selectModel(
    roomId: string,
    provider: string,
    paseo: PaseoApi,
    model?: string,
    effort?: string,
    difficulty?: TaskDifficulty,
  ) {
    const identity = allianceProvider(provider);
    if (!identity) throw new Error("Not an Alliance provider");
    const catalog = await this.modelCatalog(roomId, identity.harness, identity.role, paseo);
    return chooseModel(
      this.store.modelPolicy(roomId).policy,
      identity.role,
      identity.harness,
      catalog,
      model,
      effort,
      difficulty,
    );
  }
  private async findRoom(cwd: string): Promise<RoomRecord | null> {
    const path = await realpath(cwd);
    const rooms = this.store.rooms();
    const exact = rooms.find((room) => room.cwd === path);
    if (exact) return exact;
    const common = await gitRoot(path);
    const matches = common
      ? (
          await Promise.all(rooms.map(async (room) => ((await gitRoot(room.cwd)) === common ? room : null)))
        ).filter((room): room is RoomRecord => Boolean(room))
      : [];
    if (matches.length === 1) return matches[0];
    if (matches.length)
      throw new Error("Several rooms match this worktree. Add this checkout explicitly to choose its room.");
    return null;
  }
  async roomFor(cwd: string): Promise<RoomRecord> {
    const room = await this.findRoom(cwd);
    if (!room) throw new Error("No Alliance room exists for this checkout");
    return room;
  }
  private serializeRoom<T>(write: () => Promise<T>): Promise<T> {
    const next = this.roomWrite.then(write);
    this.roomWrite = next.catch(() => {});
    return next;
  }
  async ensureRoom(cwd: string, paseo: PaseoApi, workspaceId?: string | null) {
    return this.serializeRoom(async () => {
      const existing = await this.findRoom(cwd);
      return existing ?? this.saveRoom({ cwd, title: basename(cwd), mission: "" }, paseo, workspaceId);
    });
  }
  async createRoom(input: { title: string; cwd: string; mission: string }, paseo: PaseoApi) {
    return this.serializeRoom(() => this.saveRoom(input, paseo));
  }
  private async saveRoom(
    input: { title: string; cwd: string; mission: string },
    paseo: PaseoApi,
    workspaceId?: string | null,
  ) {
    if (!isAbsolute(input.cwd)) throw new Error("Project directory must be absolute");
    const cwd = await realpath(input.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new Error("Project directory is not a directory");
    const existing = this.store.rooms().find((room) => room.cwd === cwd);
    if (existing) return existing;
    const workspace = workspaceId ? paseo.workspaces.ref(workspaceId) : await paseo.workspaces.open(cwd);
    const id = randomUUID();
    const room: RoomRecord = {
      id,
      title: input.title.trim() || basename(cwd),
      cwd,
      workspaceId: workspace.id,
      mission: input.mission,
      artifacts: join(this.home, "rooms", id),
      createdAt: new Date().toISOString(),
    };
    await writeAtomic(
      join(room.artifacts, "mission.md"),
      `# ${room.title}\n\n${room.mission}\n\nProject: ${room.cwd}\n`,
    );
    this.store.addRoom(room);
    return room;
  }
  async instruction(provider: string, cwd: string, paseo?: PaseoApi) {
    const profile = await this.profile(provider);
    const room = paseo ? await this.ensureRoom(cwd, paseo) : await this.roomFor(cwd);
    const { policy, revision } = this.store.modelPolicy(room.id);
    const skills = skillCatalog(await projectSkills(cwd));
    return `${await readFile(join(profile.home, "root-instructions.md"), "utf8")}\n\n# Current Alliance room\nRoom: ${room.id}\nTitle: ${room.title}\nMission: ${room.mission || "Follow the Human's assignment in this conversation."}\nProject: ${room.cwd}\nDurable assignments and candidates: ${room.artifacts}\nYour exact Seatwork skill files: ${join(profile.home, "skills")}\nDelegate on this host using native Paseo create_agent. Its provider value is alias/model, for example alliance-codex-peer/gpt-6.1-sol. For another host, use Paseo CLI with an explicit --host and remote workspace. Cross-role aliases are distinct providers: pass settings.modeId explicitly from the target provider catalog, within the assignment permission limits. Consult list_providers for valid modes, model IDs and effort IDs; pass the selected effort explicitly.\n\n${policyInstruction(policy, revision)}\n\n${skills}\n\nAlliance CLI: ${process.execPath} ${join(this.manifest.root, "scripts/cli.mjs")} --home ${this.home}. Use its verify/accept commands to bind evidence to the candidate. Run --help for exact arguments.`;
  }
  async bind(agent: PluginHookAgent) {
    const identity = allianceProvider(agent.provider);
    if (!identity) return;
    const existing = this.store.member(agent.id);
    if (existing?.assignment) {
      if (agent.parentAgentId)
        this.store.updateMember(agent.id, { parentId: agent.parentAgentId, cwd: agent.cwd });
      return;
    }
    const room = await this.roomFor(agent.cwd);
    const assignment = join(room.artifacts, "assignments", `${agent.id}.md`);
    await writeAtomic(
      assignment,
      `# Native assignment ${agent.id}\n\nOwner: ${agent.parentAgentId ?? "Human"}\nAgent: ${agent.id}\nCheckout: ${agent.cwd}\n\nThe native conversation is the authority for the Human's outcome and subsequent direction.\nRead get_agent_activity for this agent; save acceptance conditions and substantive handbacks here or link the owner's brief.\nInitial chat text is not exposed by Paseo's create hook; this record does not invent it.\n`,
    );
    if (existing) {
      this.store.updateMember(agent.id, {
        assignment,
        cwd: agent.cwd,
        parentId: agent.parentAgentId ?? existing.parentId,
      });
      return;
    }
    this.store.saveMember({
      id: agent.id,
      roomId: room.id,
      role: identity.role,
      provider: agent.provider,
      parentId: agent.parentAgentId,
      assignment,
      cwd: agent.cwd,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
    });
  }
  async launch(input: RpcInput<typeof memberLaunch>, paseo: PaseoApi) {
    const room = this.store.room(input.roomId);
    const provider = `alliance-${input.harness}-${input.role}`;
    await this.profile(provider);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.store.byLaunch(room.id, input.key);
    if (previous && previous.launchHash !== hash)
      throw new Error("Launch key already belongs to a different assignment");
    const selected = await this.selectModel(
      room.id,
      provider,
      paseo,
      previous?.launchModel ?? input.model,
      previous?.launchEffort ?? input.thinking,
      input.difficulty,
    );
    const id = previous?.id ?? randomUUID();
    const assignment = join(room.artifacts, "assignments", `${id}.md`);
    if (!previous) {
      await writeAtomic(
        assignment,
        `# Assignment ${id}\n\nRole: ${input.role}\nModel: ${provider}/${selected.model}\nEffort: ${selected.thinkingOptionId ?? "provider default"}\nDifficulty: ${input.difficulty ?? "owner-assessed"}\nPolicy revision: ${this.store.modelPolicy(room.id).revision}\n\n${input.prompt}\n`,
      );
      this.store.saveMember({
        id,
        roomId: room.id,
        role: input.role,
        provider,
        parentId: null,
        assignment,
        cwd: room.cwd,
        lastOutcome: null,
        resultPath: null,
        decision: "open",
        decisionEvidence: null,
        launchKey: input.key,
        launchHash: hash,
        launchModel: selected.model,
        launchEffort: selected.thinkingOptionId,
      });
    }
    const workspace = paseo.workspaces.ref(room.workspaceId);
    await workspace.agents.create({
      agentId: id,
      idempotencyKey: `alliance/${room.id}/${input.key}`,
      title: `[${input.role}] ${room.title}`,
      config: {
        provider: `${provider}/${selected.model}`,
        thinkingOptionId: selected.thinkingOptionId,
        // Paseo leaves an omitted mode to the fresh harness, whose default may be read-only.
        modeId: input.mode ?? (input.harness === "codex" ? "auto" : undefined),
      },
      prompt: `${input.prompt}\n\nDurable assignment: ${assignment}. Keep results in ${room.artifacts}/candidates before handing back.`,
    });
    return { agentId: id };
  }
  async list(paseo: PaseoApi) {
    const members = await Promise.all(
      this.store.members().map(async (member) => {
        try {
          const refreshed = await paseo.agents.ref(member.id).refresh();
          const agent = refreshed?.agent;
          return {
            ...member,
            title: agent?.title ?? member.role,
            model: agent?.runtimeInfo?.model ?? agent?.model ?? null,
            updatedAt: agent?.updatedAt ? String(agent.updatedAt) : null,
            archived: agent?.archivedAt != null,
            status: agent?.pendingPermissions?.length
              ? "awaiting_permission"
              : (agent?.status ?? "unavailable"),
            error: agent?.lastError ?? null,
          };
        } catch (error) {
          return {
            ...member,
            title: member.role,
            model: null,
            updatedAt: null,
            archived: false,
            status: "unknown",
            error: (error as Error).message,
          };
        }
      }),
    );
    const latest = new Map<string, NonNullable<ReturnType<RoomStore["member"]>>["lastAcceptance"]>();
    for (const room of this.store.rooms()) {
      const directory = join(room.artifacts, "dispositions");
      const names = await readdir(directory).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try {
          const d = JSON.parse(await readFile(join(directory, name), "utf8"));
          if (!d.agentId || !d.at || !["accepted", "rejected"].includes(d.decision)) continue;
          const parsed = Acceptance.safeParse({
            decision: d.decision,
            kind: d.verification?.kind ?? null,
            candidate: d.candidate,
            target: d.verification?.target ?? null,
            at: d.at,
            evidence: join(directory, name),
          });
          if (parsed.success && (latest.get(d.agentId)?.at ?? "") < parsed.data.at)
            latest.set(d.agentId, parsed.data);
        } catch {
          /* A corrupt record never becomes an acceptance claim. */
        }
      }
    }
    return {
      rooms: this.store.rooms(),
      members: members.map((member) => ({
        ...member,
        ...ownerState(member.parentId, members),
        lastAcceptance: latest.get(member.id) ?? null,
      })),
      jobs: await Promise.all(
        this.store
          .jobs()
          .map(async (job) => ({ ...(await observeJob(job)), ...ownerState(job.ownerId, members) })),
      ),
    };
  }
  async resume(id: string, prompt: string, paseo: PaseoApi) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    const agent = paseo.agents.ref(id);
    const live = await agent.refresh();
    if (!live) throw new Error("Agent is unavailable; its assignment remains open");
    if (["running", "starting", "initializing"].includes(live.agent.status))
      throw new Error("Agent is already working. Open its native chat to steer intentionally.");
    if (live.agent.archivedAt || live.agent.status !== "idle")
      throw new Error("Recipient must be idle and unarchived; no prompt sent");
    if ((live.agent.pendingPermissions ?? []).length)
      throw new Error("Resolve the pending permission in the native agent chat first");
    await agent.send(
      `${prompt}\n\nResume the existing assignment ${member.assignment || "in this conversation"}. Check prior results before repeating side effects.`,
      { messageId: randomUUID() },
    );
    return { sent: true as const };
  }
  async trackJob(input: { key: string; roomId: string; ownerId: string; title: string; pid: number }) {
    this.store.room(input.roomId);
    const owner = this.store.member(input.ownerId);
    if (!owner) throw new Error("Job owner must be a known Alliance member");
    const identity = await processIdentity(input.pid);
    if (!identity) throw new Error("Process is no longer running; no job recorded");
    const old = this.store.jobs().find((job) => job.key === input.key);
    if (old) {
      if (
        old.pid !== input.pid ||
        old.processIdentity !== identity ||
        old.roomId !== input.roomId ||
        old.ownerId !== input.ownerId
      )
        throw new Error("Job key already belongs to another run or owner");
      return { saved: true as const };
    }
    this.store.saveJob({
      ...input,
      processIdentity: identity,
      recordedAt: new Date().toISOString(),
      revision: 1,
    });
    return { saved: true as const };
  }
  async changeJobOwner(key: string, ownerId: string, revision: number, paseo: PaseoApi) {
    if (!this.store.member(ownerId)) throw new Error("Unknown Alliance owner");
    const live = await paseo.agents.ref(ownerId).refresh();
    if (
      !live?.agent ||
      live.agent.archivedAt ||
      !["idle", "running", "starting", "initializing"].includes(live.agent.status)
    )
      throw new Error("New owner is unavailable");
    const job = this.store.jobs().find((job) => job.key === key);
    if (!job) throw new Error("Unknown job");
    this.store.saveJob({ ...job, ownerId, revision: revision + 1 }, revision);
    return { saved: true as const };
  }
  async startTurn(agent: PluginHookAgent, turnId: string | null) {
    await this.bind(agent);
    this.store.updateMember(agent.id, {
      lastTurnId: turnId,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
    });
  }
  async endTurn(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: PluginTurnOutcome,
    timeline: readonly AgentTimelineItem[],
  ) {
    await this.bind(agent);
    const member = this.store.member(agent.id);
    if (!member) return;
    const room = this.store.room(member.roomId);
    const eventId = createHash("sha256")
      .update(`${agent.id}:${turnId ?? randomUUID()}:${outcome.kind}`)
      .digest("hex")
      .slice(0, 24);
    const path = join(room.artifacts, "turns", `${eventId}.json`);
    // Keep the final response, not a second copy of the entire tool transcript.
    const final = [...timeline].reverse().find((item) => item.type === "assistant_message");
    await writeAtomic(
      path,
      JSON.stringify({ agentId: agent.id, turnId, outcome, final: final ?? null }, null, 2) + "\n",
    );
    const current = this.store.member(agent.id);
    if (!current?.lastTurnId || current.lastTurnId === turnId)
      this.store.updateMember(agent.id, { lastOutcome: outcome.kind, resultPath: path });
  }
  async disposition(id: string, decision: "accepted" | "rejected", candidate: string, evidence: string) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    const room = this.store.room(member.roomId);
    const report =
      decision === "accepted" ? await validateEvidence(evidence, member.cwd ?? room.cwd, candidate) : null;
    const path = join(room.artifacts, "dispositions", `${randomUUID()}.json`);
    await writeAtomic(
      path,
      JSON.stringify(
        { agentId: id, decision, candidate, evidence, verification: report, at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    this.store.updateMember(id, { decision, decisionEvidence: path });
    return { saved: true as const };
  }
  close() {
    this.store?.close();
  }
}
