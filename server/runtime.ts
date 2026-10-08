import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { memberLaunch, RoleName, RoomRecord } from "../shared/contracts";
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
    await noLinks(profile.home);
    for (const [path, expected] of Object.entries(profile.files)) {
      await noLinks(path);
      if (
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex") !== expected
      )
        throw new Error(`Managed profile changed: ${path}`);
    }
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
  async roomFor(cwd: string): Promise<RoomRecord> {
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
    throw new Error(
      matches.length
        ? "Several rooms match this worktree. Open a room for this checkout before launching."
        : "Create an Alliance room for this checkout before launching an Alliance role.",
    );
  }
  async createRoom(input: { title: string; cwd: string; mission: string }, paseo: PaseoApi) {
    if (!isAbsolute(input.cwd)) throw new Error("Project directory must be absolute");
    const cwd = await realpath(input.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new Error("Project directory is not a directory");
    if (this.store.rooms().some((room) => room.cwd === cwd))
      throw new Error("This checkout already has an Alliance room");
    const workspace = await paseo.workspaces.open(cwd);
    const id = randomUUID();
    const room: RoomRecord = {
      id,
      title: input.title,
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
  async instruction(provider: string, cwd: string) {
    const profile = await this.profile(provider);
    const room = await this.roomFor(cwd);
    return `${await readFile(join(profile.home, "root-instructions.md"), "utf8")}\n\n# Current Alliance room\nRoom: ${room.id}\nTitle: ${room.title}\nMission: ${room.mission}\nProject: ${room.cwd}\nDurable assignments and candidates: ${room.artifacts}\nYour exact Seatwork skill files: ${join(profile.home, "skills")}\nAll delegation uses native Paseo create_agent and providers alliance-{codex|claude|pi}-{hq|supervisor|lead|peer|lens}. Keep the existing model unless a different one fits the work better. Consult list_providers for valid model IDs.\n`;
  }
  async bind(agent: PluginHookAgent) {
    const identity = allianceProvider(agent.provider);
    if (!identity) return;
    const existing = this.store.member(agent.id);
    if (existing) {
      if (agent.parentAgentId) this.store.updateMember(agent.id, { parentId: agent.parentAgentId });
      return;
    }
    const room = await this.roomFor(agent.cwd);
    this.store.saveMember({
      id: agent.id,
      roomId: room.id,
      role: identity.role,
      provider: agent.provider,
      parentId: agent.parentAgentId,
      assignment: "",
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
    const id = previous?.id ?? randomUUID();
    const assignment = join(room.artifacts, "assignments", `${id}.md`);
    if (!previous) {
      await writeAtomic(assignment, `# Assignment ${id}\n\nRole: ${input.role}\n\n${input.prompt}\n`);
      this.store.saveMember({
        id,
        roomId: room.id,
        role: input.role,
        provider,
        parentId: null,
        assignment,
        lastOutcome: null,
        resultPath: null,
        decision: "open",
        decisionEvidence: null,
        launchKey: input.key,
        launchHash: hash,
      });
    }
    const workspace = paseo.workspaces.ref(room.workspaceId);
    await workspace.agents.create({
      agentId: id,
      idempotencyKey: `alliance/${room.id}/${input.key}`,
      title: `[${input.role}] ${room.title}`,
      config: {
        provider: `${provider}/${input.model}`,
        thinkingOptionId: input.thinking,
        modeId: input.mode,
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
          return {
            ...member,
            status: refreshed?.agent.status ?? "unavailable",
            error: refreshed?.agent.lastError ?? null,
          };
        } catch (error) {
          return { ...member, status: "unknown", error: (error as Error).message };
        }
      }),
    );
    return { rooms: this.store.rooms(), members };
  }
  async resume(id: string, prompt: string, paseo: PaseoApi) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    const agent = paseo.agents.ref(id);
    const live = await agent.refresh();
    if (!live) throw new Error("Agent is unavailable; its assignment remains open");
    if (["running", "starting", "initializing"].includes(live.agent.status))
      throw new Error("Agent is already working. Open its native chat to steer intentionally.");
    if ((live.agent.pendingPermissions ?? []).length)
      throw new Error("Resolve the pending permission in the native agent chat first");
    await agent.send(
      `${prompt}\n\nResume the existing assignment ${member.assignment || "in this conversation"}. Check prior results before repeating side effects.`,
      { messageId: randomUUID() },
    );
    return { sent: true as const };
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
    const path = join(room.artifacts, "dispositions", `${randomUUID()}.json`);
    await writeAtomic(
      path,
      JSON.stringify({ agentId: id, decision, candidate, evidence, at: new Date().toISOString() }, null, 2) +
        "\n",
    );
    this.store.updateMember(id, { decision, decisionEvidence: path });
    return { saved: true as const };
  }
  close() {
    this.store?.close();
  }
}
