import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, writeFileSync } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { Evidence, validateAnalysisEvidence, validateEvidence } from "../server/evidence.mjs";
import { skillCatalog } from "../server/project-skills.mjs";
import {
  Acceptance,
  type memberLaunch,
  ProductAcceptance,
  type RoleName,
  type RoomRecord,
} from "../shared/contracts";
import { policyInstruction, type TaskDifficulty } from "../shared/model-policy";
import { agentTitle, namingInstruction, workspaceTitle } from "../shared/naming";
import { deliverable, ownerState, responsibleOwner } from "../shared/operations";
import { Autonomy, providerNotice, quotaReset } from "./autonomy";
import { effectiveSkills } from "./bundled-skills.mjs";
import {
  buildIntegrationProof,
  integrationStamp,
  validateIntegrationCurrentSync,
  validateIntegrationProof,
} from "./integration.mjs";
import { observeJob, processIdentity } from "./jobs.mjs";
import { acceptedContributors, authorizeDecision, Lifecycle, type LiveState } from "./lifecycle";
import { Liveness } from "./liveness";
import { lockState } from "./maintenance-lock.mjs";
import { chooseModel } from "./model-policy";
import { Obligations } from "./obligations";
import { verifyProfile } from "./profile-integrity.mjs";
import { scopedMcpServers } from "./scoped-mcp.mjs";
import {
  type MemberRecord,
  newTurn,
  RoomStore,
  type TurnInputReceipt,
  type TurnReadbackReceipt,
} from "./store";
import { userMcpServers } from "./user-mcp.mjs";
import { type CliCommand, cliLine, Wakeups } from "./wakeups";

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
/** Bound native requests and process/file probes without dropping or reordering records. */
async function mapStatus<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await read(items[index]);
      }
    }),
  );
  return results;
}
export function allianceProvider(provider: string): { harness: string; role: RoleName; id: string } | null {
  const match = /^alliance-(codex|claude|pi|agy)-(hq|supervisor|lead|peer|lens)$/.exec(provider);
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
/** Quote a path for a shell command line only when it needs it. */
const shellWord = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
/** The exec line scripts/maintenance.mjs writeLauncher emits: node, release CLI, home. */
const LAUNCHER = /^exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)' --home '((?:[^']|'\\'')*)' "\$@"$/m;
const unquote = (value: string) => value.replaceAll("'\\''", "'");
const usable = (path: string, mode: number) =>
  access(path, mode).then(
    () => true,
    () => false,
  );
/** What the daemon reported when the scheduler last (re)connected. */
export type DaemonInfo = { version: string | null; agentMessageProvenance: boolean };
/** The scheduler's own daemon connection. */
export type SchedulerClient = PaseoApi & { close(): Promise<void> };
export type ConnectDaemon = (home: string, seen: (daemon: DaemonInfo) => void) => Promise<SchedulerClient>;
/** Connects to this installation's daemon and reports its server info after every (re)connect. */
const connectDaemon: ConnectDaemon = async (home, seen) => {
  const installed = JSON.parse(await readFile(join(home, "installation.json"), "utf8"));
  if (installed.home !== home) throw new Error("Installation home mismatch");
  const config = JSON.parse(await readFile(join(installed.paseoHome, "config.json"), "utf8"));
  const client = new DaemonClient({
    url: `ws://${config.daemon.listen}/ws`,
    clientId: "alliance-wakeups",
    clientType: "cli",
    password: process.env.ALLIANCE_PASEO_PASSWORD,
    connectTimeoutMs: 5000,
    // Until connect resolves, the runtime has no client handle to close. Bound this
    // first attempt so a missing daemon cannot trap a scheduler round or shutdown.
    reconnect: { enabled: false },
  });
  // The client stores the server info before it reports the connection.
  const unsubscribe = client.subscribeConnectionStatus((state) => {
    const info = state.status === "connected" ? client.getLastServerInfoMessage() : null;
    if (info)
      seen({
        version: info.version ?? null,
        agentMessageProvenance: info.features?.agentMessageProvenance === true,
      });
  });
  const api = createPaseoApi(client);
  const close = async () => {
    unsubscribe();
    try {
      await api.dispose();
    } finally {
      await client.close();
    }
  };
  try {
    await client.connect();
    client.setReconnectEnabled(true);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return { ...api, close };
};
/**
 * How native sends treat a running receiver on this daemon. Paseo 0.12 marks agent messages
 * (agentMessageProvenance) and steers agent sends by default; 0.11 always replaces the turn.
 * Nothing is said while the version is unknown.
 */
export function sendingRule(daemon: DaemonInfo | null) {
  if (daemon?.agentMessageProvenance)
    return `Paseo ${daemon.version ?? "0.12+"}: send_agent_prompt steers into a running Claude, Codex or Pi turn by default; pass activeTurnBehavior interrupt only to abort it deliberately. AGY receivers are always interrupted.`;
  if (daemon?.version?.startsWith("0.11."))
    return `Paseo ${daemon.version}: any send to a running agent aborts its turn. Send only to idle agents, or for an urgent correction.`;
  return "";
}
export class AllianceRuntime {
  readonly home: string;
  store!: RoomStore;
  wakeups!: Wakeups;
  obligations!: Obligations;
  autonomy!: Autonomy;
  lifecycle!: Lifecycle;
  liveness!: Liveness;
  wakeupHealth: { checkedAt: string | null; error: string | null } = { checkedAt: null, error: null };
  /** The daemon the scheduler last connected to; null until it first connects. */
  daemon: DaemonInfo | null = null;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private wakeClient?: SchedulerClient;
  private wakeRound?: Promise<void>;
  private closing = false;
  private manifest!: Manifest;
  private cli: CliCommand = { command: "alliance-work", managed: false };
  private roomWrite: Promise<unknown> = Promise.resolve();
  constructor(
    home: string,
    private connect: ConnectDaemon = connectDaemon,
  ) {
    this.home = resolve(home || process.env.ALLIANCE_WORK_HOME || join(homedir(), ".alliance-work"));
  }
  async ready() {
    await noLinks(this.home);
    this.manifest = JSON.parse(await readFile(join(this.home, "profiles.json"), "utf8"));
    if (this.manifest.home !== this.home) throw new Error("Alliance manifest belongs to another home");
    this.store = new RoomStore(this.home);
    this.wakeups = new Wakeups(this.store);
    this.obligations = new Obligations(this.store);
    this.autonomy = new Autonomy(this.store, this.wakeups);
    this.lifecycle = new Lifecycle(this.store, this.wakeups, this.autonomy, Date.now, this.manifest.root);
    this.liveness = new Liveness(this.store, this.wakeups);
    this.liveness.daemon = () => this.daemon;
    this.cli = await this.cliCommand();
    this.wakeups.cli = this.autonomy.cli = () => this.cli;
    return this;
  }
  /**
   * The command agents should run. The managed launcher always starts the active release, so it
   * stays right across updates. It is used only when it is this home's own launcher and its Node
   * and CLI exist; `--home` is repeated so the command names this instance (the last value wins).
   * Otherwise the running release's path is the fallback, which is not described as stable.
   */
  async cliCommand(): Promise<CliCommand> {
    const fallback = {
      command: `${shellWord(process.execPath)} ${shellWord(join(this.manifest.root, "scripts/cli.mjs"))} --home ${shellWord(this.home)}`,
      managed: false,
    };
    const installed = await readFile(join(this.home, "installation.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (installed?.home !== this.home || typeof installed.binPath !== "string") return fallback;
    const launcher = installed.binPath;
    const text = await readFile(launcher, "utf8").catch(() => "");
    const exec = text.includes("# Alliance Work managed launcher") ? LAUNCHER.exec(text) : null;
    if (
      !exec ||
      resolve(unquote(exec[3])) !== this.home ||
      !(await usable(launcher, constants.X_OK)) ||
      !(await usable(unquote(exec[1]), constants.X_OK)) ||
      !(await usable(unquote(exec[2]), constants.R_OK))
    )
      return fallback;
    return { command: `${shellWord(launcher)} --home ${shellWord(this.home)}`, managed: true };
  }
  /** Starts the scheduler, a round every 15 s; resolves when the first round ends. */
  startWakeups() {
    if (this.wakeTimer || this.wakeRound || this.closing) return this.wakeRound;
    const round = async () => {
      try {
        this.cli = await this.cliCommand().catch(() => this.cli);
        await this.wakeups.tick();
        this.wakeupHealth = { checkedAt: new Date().toISOString(), error: null };
        // An update waiting for idleness holds this lock; starting turns would starve it. A lock
        // left by a dead or pre-reboot process is ignored so the scheduler cannot stall forever.
        const lock = await lockState(this.home).catch(() => ({ held: false, stale: false }));
        const maintenance = lock.held;
        if (maintenance)
          this.wakeupHealth.error = "Maintenance lock held; scheduled prompts paused until it clears";
        else if (lock.stale)
          this.wakeupHealth.error = "Stale maintenance lock ignored; the next maintenance command removes it";
        if (
          !maintenance &&
          // Also connect once without work: new agents are told how sends behave on this daemon.
          (!this.daemon ||
            this.store.members().some((member) => member.turnReadbackPending) ||
            this.autonomy.list().some((r) => r.phase !== "archived") ||
            this.wakeups.list().some((w) => w.state === "pending" && w.delivery === "idle") ||
            this.lifecycle.pending())
        ) {
          this.wakeClient ??= await this.connect(this.home, (daemon) => {
            this.daemon = daemon;
          });
          if (!this.closing) {
            for (const member of this.store.members())
              if (member.turnReadbackPending)
                await this.reconcileTurnReadback(member.id, this.wakeClient).catch(() => {
                  this.wakeupHealth.error = "Native turn handback awaits readback; retained for retry";
                });
            for (const r of this.autonomy.list())
              if (
                (!r.outcome && this.autonomy.carrying(r.agentId)) ||
                this.store.member(r.agentId)?.turnInputPending
              )
                await this.reconcileTurnInput(r.agentId, this.wakeClient).catch(() => {
                  this.wakeupHealth.error =
                    "Native turn input unknown; inspect the carried handback before deciding";
                });
            await this.autonomy.tick(this.wakeClient).catch(() => {
              this.wakeupHealth.error = "Autonomy sweep incomplete; inspect assignments and native status";
            });
            await this.lifecycle.sweep(this.wakeClient).catch(() => {
              this.wakeupHealth.error = "Lifecycle sweep incomplete; inspect member lifecycle in status";
            });
            // Before delivery, so a silence notice reaches an idle owner in this round.
            await this.liveness.sweep(this.wakeClient).catch(() => {
              this.wakeupHealth.error = "Liveness sweep incomplete; inspect running members in status";
            });
            await this.wakeups.tick(this.wakeClient);
          }
        }
      } catch {
        this.wakeupHealth.error = "Wakeup sweep or native connection failed; obligations retained";
        // Keep obligations durable. No prompt retries on uncertain delivery.
        await this.wakeClient?.close().catch(() => undefined);
        this.wakeClient = undefined;
      } finally {
        this.wakeRound = undefined;
        if (!this.closing) {
          this.wakeTimer = setTimeout(run, 15000);
          this.wakeTimer.unref();
        }
      }
    };
    const run = () => {
      this.wakeTimer = undefined;
      this.wakeRound = round();
    };
    run();
    return this.wakeRound;
  }
  async profile(provider: string) {
    const identity = allianceProvider(provider);
    if (!identity) throw new Error(`Not an Alliance provider: ${provider}`);
    const profile = this.manifest.profiles[identity.id];
    if (!profile) throw new Error(`Profile ${identity.id} is not prepared`);
    await verifyProfile(profile);
    return profile;
  }
  async previewMcp(harness: string, cwd: string) {
    return (harness === "pi" ? scopedMcpServers : userMcpServers)(
      this.home,
      harness,
      this.manifest.root,
      cwd,
    );
  }
  async sessionMcpServers(provider: string, cwd?: string) {
    const profile = await this.profile(provider);
    // Paseo sends a per-thread MCP table to Codex, overriding its CLI table.
    // Claude merges at launch; AGY merges in its isolated session directory.
    if (profile.harness !== "codex") return {};
    const servers = await userMcpServers(this.home, profile.harness, this.manifest.root, cwd);
    return Object.fromEntries(
      Object.entries(servers).map(([name, server]) => [name, { type: "stdio" as const, ...server }]),
    );
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
    const native = await workspace.refresh();
    if (!native) throw new Error("Native workspace is unavailable");
    const title =
      native.title?.trim() ||
      workspaceTitle(input.title.trim() || native.projectDisplayName || basename(cwd));
    // Set only an unnamed workspace. An existing native title is Human-owned.
    if (!native.title?.trim()) await workspace.setTitle(title);
    const id = randomUUID();
    const room: RoomRecord = {
      id,
      title,
      nativeTitle: title,
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
    const skills = skillCatalog(await effectiveSkills(cwd, profile));
    const sending = sendingRule(this.daemon);
    return `${await readFile(join(profile.home, "root-instructions.md"), "utf8")}\n\n# Current Alliance room\nRoom: ${room.id}\nTitle: ${room.title}\nMission: ${room.mission || "Follow the Human's assignment in this conversation."}\nProject: ${room.cwd}\n${namingInstruction(room.title, profile.role)}\nDurable assignments and candidates: ${room.artifacts}\nOnly the enabled skills listed below are selected for this runtime.\nDelegate on this host using native Paseo create_agent. Its provider value is alias/model, for example alliance-codex-peer/gpt-6.1-sol. For another host, use Paseo CLI with an explicit --host and remote workspace. Cross-role aliases are distinct providers: pass settings.modeId explicitly from the target provider catalog, within the assignment permission limits. Consult list_providers for valid modes, model IDs and effort IDs; pass the selected effort explicitly.\n\n${policyInstruction(policy, revision)}\n\n${skills}\n\n${cliLine(await this.cliCommand())} Use its verify/accept commands to bind evidence to the candidate. Run --help for exact arguments.${sending ? `\n\n${sending}` : ""}`;
  }
  async bind(agent: PluginHookAgent) {
    const identity = allianceProvider(agent.provider);
    if (!identity) return;
    const existing = this.store.member(agent.id);
    if (existing?.assignment) {
      if (agent.parentAgentId) {
        this.store.updateMember(agent.id, { parentId: agent.parentAgentId, cwd: agent.cwd });
        if (existing.parentId !== agent.parentAgentId) this.adopted(existing);
      }
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
      if (agent.parentAgentId && existing.parentId !== agent.parentAgentId) this.adopted(existing);
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
    if (agent.parentAgentId) this.autonomy.start(agent.id);
  }
  /**
   * Paseo now reports a native parent for a known member. Paseo opens a new child's session before
   * it reports the parent, so a member that has not run yet is a new child, managed as usual; one
   * that already ran keeps its state and hands back to the parent.
   */
  private adopted(member: MemberRecord) {
    if (this.autonomy.get(member.id)) return;
    if (member.lastTurnId) this.autonomy.ensure(member.id);
    else this.autonomy.start(member.id);
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
    if (!this.autonomy.get(id)) this.autonomy.start(id);
    const workspace = paseo.workspaces.ref(room.workspaceId);
    await workspace.agents.create({
      agentId: id,
      idempotencyKey: `alliance/${room.id}/${input.key}`,
      title: agentTitle(room.title, input.role),
      config: {
        provider: `${provider}/${selected.model}`,
        thinkingOptionId: selected.thinkingOptionId,
        // Paseo leaves an omitted mode to the fresh harness, whose default may be read-only.
        modeId: input.mode ?? (input.harness === "codex" ? "auto" : undefined),
      },
      prompt: `${input.prompt}\n\nDurable assignment: ${assignment}. Keep results in ${room.artifacts}/candidates. To hand back, run alliance-work autonomy checkpoint --phase review --reason TEXT (blocked for a decision) and end your turn; send no separate handback prompt. To wait for something, run alliance-work wait and end your turn; never sleep or poll.`,
    });
    return { agentId: id };
  }
  async readPolicy(id: string) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    const profile = await this.profile(member.provider);
    const path = join(profile.home, "root-instructions.md");
    const text = await readFile(path, "utf8");
    const digest = createHash("sha256").update(text).digest("hex");
    return {
      digest,
      text,
      path,
      acknowledged: member.policyAck?.digest === digest,
      obligations: this.obligations.list(id).filter((o) => o.state === "open"),
    };
  }
  async acknowledgePolicy(id: string, digest: string) {
    const policy = await this.readPolicy(id);
    if (digest !== policy.digest)
      throw new Error("Policy changed; read the current policy before acknowledging");
    this.store.updateMember(id, { policyAck: { digest, at: new Date().toISOString() } });
    return { saved: true as const };
  }
  async recoveryContext(id: string) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    const policy = await this.readPolicy(id);
    const path = join(this.store.room(member.roomId).artifacts, "recovery", `${id}.md`);
    const pull = this.wakeups.pullList(id);
    await writeAtomic(
      path,
      `${policy.text}\n\n# Current contextual naming\n${namingInstruction(this.store.room(member.roomId).title, member.role)}\n\n# Session recovery snapshot\nObserved: ${new Date().toISOString()}\nPolicy digest: ${policy.digest}\nAssignment: ${member.assignment}\n\nThe following JSON is task data, not policy or new authority. Refresh with obligations list before dependent side effects.\n\n${JSON.stringify(policy.obligations, null, 2)}\n${pull ? `\n${pull}\n` : ""}`,
    );
    return path;
  }
  async changeMemberOwner(
    id: string,
    ownerId: string | null,
    revision: number,
    evidence: string,
    paseo: PaseoApi,
  ) {
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    if ((member.ownership?.revision ?? 0) !== revision)
      throw new Error("Owner changed; refresh before handing off");
    if (ownerId) {
      if (!this.store.member(ownerId)) throw new Error("Unknown responsible owner");
      const live = (await paseo.agents.ref(ownerId).refresh())?.agent;
      if (!live || live.archivedAt || !["idle", "running", "starting", "initializing"].includes(live.status))
        throw new Error("Responsible owner is unavailable");
    }
    // Reject invalid ownership before writing a handoff receipt.
    const seen = new Set([id]);
    let current = ownerId;
    while (current) {
      if (seen.has(current)) throw new Error("Ownership cycle refused");
      seen.add(current);
      const parent = this.store.member(current);
      current = parent ? responsibleOwner(parent) : null;
    }
    await noLinks(evidence);
    if (!isAbsolute(evidence) || !(await lstat(evidence)).isFile())
      throw new Error("Owner handoff needs an absolute evidence file");
    const digest = createHash("sha256")
      .update(await readFile(evidence))
      .digest("hex");
    const at = new Date().toISOString();
    const record = join(this.store.room(member.roomId).artifacts, "ownership", `${randomUUID()}.json`);
    await writeAtomic(
      record,
      JSON.stringify(
        {
          agentId: id,
          ownerId,
          previousOwnerId: responsibleOwner(member),
          evidence,
          digest,
          revision: revision + 1,
          at,
        },
        null,
        2,
      ),
    );
    // Async evidence reads may have raced another handoff. Validate the graph again.
    const visited = new Set([id]);
    current = ownerId;
    while (current) {
      if (visited.has(current)) throw new Error("Ownership cycle refused");
      visited.add(current);
      const parent = this.store.member(current);
      current = parent ? responsibleOwner(parent) : null;
    }
    this.store.saveOwnership(id, { ownerId, revision: revision + 1, evidence: record, at }, revision);
    // The new owner is woken for this member's handbacks through its assignment record.
    if (ownerId) this.autonomy.ensure(id);
    return { saved: true as const };
  }
  async list(paseo: PaseoApi) {
    await mapStatus(this.store.rooms(), async (room) => {
      // Older rooms and explicit local edits retain their title until reconciled by the Human.
      if (room.nativeTitle === undefined || room.title !== room.nativeTitle) return;
      try {
        const native = await paseo.workspaces.ref(room.workspaceId).refresh();
        if (native?.title && native.title !== room.title)
          this.store.updateRoomTitle(room.id, room.title, native.title);
      } catch {
        // Naming freshness must not hide custody/status when a native workspace is unavailable.
      }
    });
    const storedMembers = this.store.members();
    const digests = new Map<string, string>();
    for (const member of storedMembers) {
      if (!digests.has(member.provider)) {
        const provider = allianceProvider(member.provider);
        if (!provider) throw new Error(`Unknown Alliance provider: ${member.provider}`);
        const profile = this.manifest.profiles[provider.id];
        digests.set(
          member.provider,
          createHash("sha256")
            .update(await readFile(join(profile.home, "root-instructions.md")))
            .digest("hex"),
        );
      }
    }
    const members = await mapStatus(storedMembers, async (member) => {
      try {
        const refreshed = await paseo.agents.ref(member.id).refresh();
        const agent = refreshed?.agent;
        return {
          ...member,
          title: agent?.title ?? member.role,
          model: agent?.runtimeInfo?.model ?? agent?.model ?? null,
          selectedModel: agent?.model ?? null,
          runtimeModel: agent?.runtimeInfo?.model ?? null,
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
          selectedModel: null,
          runtimeModel: null,
          updatedAt: null,
          archived: false,
          status: "unknown",
          error: (error as Error).message,
        };
      }
    });
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
            product: d.product,
          });
          if (parsed.success && (latest.get(d.agentId)?.at ?? "") < parsed.data.at)
            latest.set(d.agentId, parsed.data);
        } catch {
          /* A corrupt record never becomes an acceptance claim. */
        }
      }
    }
    const live = new Map<string, LiveState>(
      members.map((m) => [
        m.id,
        { status: m.status, archived: m.archived, permissions: m.status === "awaiting_permission" ? 1 : 0 },
      ]),
    );
    const lifecycles = await mapStatus(members, (member) =>
      this.lifecycle.describe(member, live.get(member.id) as LiveState, live).catch((error: Error) => ({
        state: "held" as const,
        blockers: [`lifecycle unknown: ${error.message}`],
      })),
    );
    return {
      rooms: this.store.rooms(),
      members: members.map((member, index) => ({
        ...member,
        ...ownerState(responsibleOwner(member), members),
        ownerRevision: member.ownership?.revision ?? 0,
        ownerEvidence: member.ownership?.evidence ?? null,
        policyDigest: digests.get(member.provider) ?? "",
        policyAcknowledged: member.policyAck?.digest === digests.get(member.provider),
        lastAcceptance: latest.get(member.id) ?? null,
        lastTurnId: member.lastTurnId ?? null,
        decisionBy: member.decisionBy === undefined ? undefined : (member.decisionBy ?? "Human"),
        decisionScope: member.decisionScope ?? null,
        lifecycle: lifecycles[index],
      })),
      autonomy: this.autonomy.list(),
      wakeups: this.wakeups.list(),
      obligations: this.obligations.list().map((o) => ({ ...o, ...ownerState(o.ownerId, members) })),
      wakeupHealth: { ...this.wakeupHealth, daemon: this.daemon },
      jobs: await mapStatus(this.store.jobs(), async (job) => ({
        ...(await observeJob(job)),
        ...ownerState(job.ownerId, members),
      })),
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
    if ((live.agent.pendingPermissions ?? []).length)
      throw new Error("Resolve the pending permission in the native agent chat first");
    // Paseo loads a closed session (e.g. after a daemon restart) when it receives the prompt.
    if (!deliverable(live.agent))
      throw new Error("Recipient must be idle or closed, and unarchived; no prompt sent");
    const pull = this.wakeups.pullList(id);
    await agent
      .send(
        `${prompt}\n\nResume the existing assignment ${member.assignment || "in this conversation"}. Check prior results before repeating side effects.${pull ? `\n\n${pull}` : ""}`,
        // A turn that starts between the readback and this send is steered, not interrupted.
        { messageId: randomUUID(), activeTurnBehavior: "steer" },
      )
      .catch((error: unknown) => {
        // A provider that cannot be steered (AGY on Paseo 0.11) refuses it and receives nothing.
        if (error instanceof Error && /does not support prompt\.steer/.test(error.message))
          throw new Error("Agent is already working. Open its native chat to steer intentionally.");
        throw error;
      });
    return { sent: true as const };
  }
  async trackJob(input: { key: string; roomId: string; ownerId: string; title: string; pid: number }) {
    this.store.room(input.roomId);
    const owner = this.store.member(input.ownerId);
    if (!owner) throw new Error("Job owner must be a known Alliance member");
    const identity = await processIdentity(input.pid);
    if (!identity) throw new Error("Process is no longer running; no job recorded");
    const old = this.store.job(input.key);
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
    const job = this.store.job(key);
    if (!job) throw new Error("Unknown job");
    if (
      this.store
        .wakeups()
        .some(
          (w) =>
            w.obligationKey &&
            w.trigger.kind === "job" &&
            w.trigger.key === key &&
            this.store.obligations().some((o) => o.key === w.obligationKey && o.state === "open"),
        )
    )
      throw new Error("Hand off the linked obligation to transfer its job and pending wakeups atomically");
    this.store.saveJob({ ...job, ownerId, revision: revision + 1 }, revision);
    return { saved: true as const };
  }
  /** Hooks omit per-item identity; native timeline pages retain the turn and timestamp on both supported daemons. */
  private async claudeNotice(
    agentId: string,
    turnId: string | null,
    final: Extract<AgentTimelineItem, { type: "assistant_message" }>,
    startedAt: number | undefined,
    paseo?: PaseoApi,
  ): Promise<{ notice?: string; warning?: string; stale?: true }> {
    try {
      if (!paseo || !turnId || startedAt === undefined)
        throw new Error("native connection or observed turn start unavailable");
      const timeline = paseo.agents.ref(agentId).timeline;
      let cursor: { epoch: string; seq: number } | undefined;
      for (;;) {
        const page = await timeline.refetch({ direction: cursor ? "before" : "tail", cursor, limit: 100 });
        if (page.error || page.gap || page.staleCursor || (cursor && page.epoch !== cursor.epoch))
          throw new Error("native timeline unavailable or changed while reading");
        const found = page.entries.findLast(
          ({ item }) =>
            item.type === "assistant_message" &&
            item.text === final.text &&
            (!final.messageId || item.messageId === final.messageId),
        );
        if (found) {
          if (!found.turnId) throw new Error("native message has no turn identity");
          if (found.turnId !== turnId) return { stale: true };
          // Provider ordinals restart on session reload, even when Paseo keeps the old timeline.
          // The observed start survives a plugin reload. A delayed start hook can reject an early
          // genuine notice conservatively; retain and report that uncertainty instead of a false hold.
          if (!(Date.parse(found.timestamp) >= startedAt))
            throw new Error("native message predates the observed turn start");
          return { notice: final.text.trim() };
        }
        if (!page.hasOlder || !page.startCursor || (cursor && page.startCursor.seq >= cursor.seq))
          throw new Error("the hook's final message was not found in the native timeline");
        cursor = page.startCursor;
      }
    } catch (error) {
      const warning = `Claude provider notice for ${agentId} turn ${turnId ?? "unknown"} was not attributed: ${error instanceof Error ? error.message : "native read failed"}. Native outcome retained; no provider hold inferred. Inspect the native chat.`;
      this.wakeupHealth.error = warning;
      console.warn(warning);
      return { warning };
    }
  }
  /**
   * A 0.12 accepted steer has a canonical user row on the existing turn, with no new start hook.
   * Inspect only a carried turn's generation. Never infer maintenance from the prompt's wording.
   * Cursors bound later sweeps; readback at both decision barriers also covers a steer during review.
   */
  private async readTurnInput(
    id: string,
    turnId: string,
    startedAt: number,
    maintenance: ReadonlySet<string>,
    paseo: PaseoApi,
    checked?: { epoch: string; seq: number },
    endedAt?: number,
  ) {
    const timeline = paseo.agents.ref(id).timeline;
    let cursor: { epoch: string; seq: number } | undefined;
    let newest: { epoch: string; seq: number } | undefined;
    let promptId: string | undefined;
    let complete = false;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await timeline.refetch({
        direction: cursor ? "before" : "tail",
        cursor,
        limit: 100,
        projection: "canonical",
      });
      if (page.error || page.gap || page.staleCursor || (cursor && page.epoch !== cursor.epoch))
        throw new Error("Native timeline changed while identifying turn input; retry the decision");
      newest ??= page.endCursor ?? undefined;
      for (const entry of [...page.entries].reverse()) {
        if (checked && checked.epoch === page.epoch && entry.seqEnd <= checked.seq) {
          complete = true;
          break;
        }
        const timestamp = Date.parse(entry.timestamp);
        if (endedAt !== undefined && timestamp > endedAt) continue;
        if (timestamp < startedAt) {
          complete = true;
          break;
        }
        if (entry.item.type !== "user_message") continue;
        if (!entry.turnId) throw new Error("Native prompt has no turn identity; retry the decision");
        if (entry.turnId !== turnId) continue;
        if (!Number.isFinite(timestamp))
          throw new Error("Native prompt generation unknown; retry the decision");
        const identity = entry.item.clientMessageId ?? entry.item.messageId;
        if (identity && maintenance.has(identity)) continue;
        promptId = identity ?? `${page.epoch}:${entry.seqEnd}`;
        complete = true;
        break;
      }
      if (complete || !page.hasOlder) {
        complete = true;
        break;
      }
      if (!page.startCursor || (cursor && page.startCursor.seq >= cursor.seq))
        throw new Error("Native timeline input cursor unavailable; retry the decision");
      cursor = page.startCursor;
    }
    if (!complete) throw new Error("Native turn input exceeds the readback bound; inspect the native chat");
    return { promptId, cursor: newest };
  }
  private async reconcileTurnInput(id: string, paseo: PaseoApi, expectedTurnId?: string | null) {
    for (let receipt = 0; receipt < 16; receipt++) {
      const pending = this.store.member(id)?.turnInputPending;
      if (!pending) break;
      if (pending.overflow)
        throw new Error(
          "Native input receipt bound exceeded; inspect the chat and explicitly start or checkpoint new work",
        );
      const input = await this.readTurnInput(
        id,
        pending.turnId,
        pending.startedAt,
        new Set(pending.maintenance),
        paseo,
        undefined,
        pending.endedAt,
      );
      const current = this.store.member(id);
      if (current?.turnInputPending?.path === pending.path) {
        if (current.turnInputPending.overflow)
          throw new Error(
            "Native input receipt bound exceeded; inspect the chat and explicitly start or checkpoint new work",
          );
        const following = current.turnInputPending.following ?? [];
        this.store.updateMember(id, { turnInputPending: undefined });
        // Explicit new work/checkpoints supersede the receipt. A later transparent turn may still
        // carry this exact handback: in that case recover the result under it, not over its turn.
        if (
          current.lastTurnId === pending.handbackTurnId &&
          current.resultPath === pending.handbackPath &&
          this.autonomy.carrying(id)
        ) {
          const state = this.autonomy.get(id);
          if (state?.turnId === pending.turnId && current.turnStartedAt === pending.startedAt) {
            if (input.promptId) this.autonomy.prompted(id, pending.turnId, input.promptId);
            this.finishTurn(
              id,
              pending.turnId,
              pending.outcome,
              pending.error,
              pending.path,
              pending.endedAt,
              input.promptId ?? pending.promptId,
            );
          } else if (input.promptId) {
            this.autonomy.delayedHandback(id, pending.outcome);
            this.store.updateMember(id, {
              ...newTurn(pending.turnId),
              lastOutcome: pending.outcome,
              resultPath: pending.path,
              lastTurnEndedAt: pending.endedAt,
            });
          }
        }
        const updated = this.store.member(id);
        if (following.length && updated) {
          const [next, ...rest] = following.map((r) => ({
            ...r,
            handbackTurnId: updated.lastTurnId ?? null,
            handbackPath: updated.resultPath,
          }));
          this.store.updateMember(id, { turnInputPending: { ...next, following: rest } });
        }
      }
    }
    const r = this.autonomy.get(id);
    const member = this.store.member(id);
    if (!r?.turnId || !member || !this.autonomy.carrying(id)) return;
    if (expectedTurnId !== undefined && r.turnId !== expectedTurnId) return;
    const turnId = r.turnId;
    const startedAt = member.turnStartedAt;
    if (startedAt === undefined)
      throw new Error("Native turn input boundary unknown; retry after native readback");
    const maintenance = new Set([
      ...(r.wakeMessages ?? []),
      ...this.wakeups.list().flatMap((w) => (w.ownerId === id && w.messageId ? [w.messageId] : [])),
    ]);
    const input = await this.readTurnInput(id, turnId, startedAt, maintenance, paseo, member.turnInputCursor);
    // A checkpoint, new turn or reload generation that won the readback must retain its own state.
    if (
      this.autonomy.get(id)?.turnId !== turnId ||
      this.store.member(id)?.turnStartedAt !== startedAt ||
      !this.autonomy.carrying(id)
    )
      return;
    if (input.promptId) this.autonomy.prompted(id, turnId, input.promptId);
    if (input.cursor) this.store.updateMember(id, { turnInputCursor: input.cursor });
  }
  async startTurn(agent: PluginHookAgent, turnId: string | null, paseo?: PaseoApi) {
    let turnStartedAt = Date.now();
    await this.bind(agent);
    const previous = this.autonomy.get(agent.id);
    const previousStartedAt = this.store.member(agent.id)?.turnStartedAt;
    const duplicate = Boolean(turnId && previous?.turnId === turnId && !previous.outcome);
    let newGeneration = false;
    if (duplicate && !paseo) return;
    if (paseo && turnId) {
      const live = await paseo.agents
        .ref(agent.id)
        .refresh()
        .catch(() => null);
      const current = this.autonomy.get(agent.id);
      // Native readback may yield to a newer start (including an ordinal reused after reload)
      // or checkpoint. The delayed hook must not replace that winning state.
      if (
        current?.revision !== previous?.revision ||
        current?.turnId !== previous?.turnId ||
        this.store.member(agent.id)?.turnStartedAt !== previousStartedAt
      )
        return;
      const native = live?.agent.activeTurn;
      if (native && native.turnId !== turnId) return;
      const since = native?.startedAt ? Date.parse(native.startedAt) : NaN;
      if (duplicate) {
        // Provider ordinals can restart while an earlier completion is still awaiting readback.
        // Only native evidence of a strictly later generation may supersede that hold.
        if (
          native?.turnId !== turnId ||
          !Number.isFinite(since) ||
          previousStartedAt === undefined ||
          since <= previousStartedAt
        )
          return;
        newGeneration = true;
      }
      // Native start precedes canonical prompt recording, even if this hook was delivered late.
      if (native?.turnId === turnId && Number.isFinite(since)) turnStartedAt = since;
    }
    this.store.updateMember(agent.id, {
      turnStartedAt,
      turnInputCursor: undefined,
      turnReadbackPending: undefined,
    });
    this.autonomy.started(agent.id, turnId, newGeneration);
    // A turn the plugin's wake batch or the agent itself started keeps the phase it found, and the
    // handback before it stands with its decision, unless the turn checkpoints (autonomy.checkpoint).
    if (this.autonomy.carrying(agent.id)) return;
    // Any other turn is new work: the previous decision no longer applies.
    this.store.updateMember(agent.id, newTurn(turnId));
  }
  /** Paseo 0.15 omits hook history. Read only messages attributed to the observed turn generation. */
  private async turnMessages(
    agentId: string,
    turnId: string,
    startedAt: number,
    endedAt: number,
    paseo: PaseoApi,
  ) {
    const messages: AgentTimelineItem[] = [];
    let cursor: { epoch: string; seq: number } | undefined;
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = await paseo.agents.ref(agentId).timeline.refetch({
        direction: cursor ? "before" : "tail",
        cursor,
        limit: 100,
        projection: "canonical",
      });
      if (page.error || page.gap || page.staleCursor || (cursor && page.epoch !== cursor.epoch))
        throw new Error(`Native turn history unavailable: ${page.error ?? "timeline changed"}`);
      let boundary = false;
      for (const entry of [...page.entries].reverse()) {
        const timestamp = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestamp)) throw new Error("Native turn history has no generation timestamp");
        if (timestamp < startedAt) {
          boundary = true;
          break;
        }
        if (timestamp > endedAt) continue;
        if (!entry.turnId && (entry.item.type === "user_message" || entry.item.type === "assistant_message"))
          throw new Error("Native turn history message has no turn identity");
        if (entry.turnId !== turnId) continue;
        if (entry.item.type === "user_message" || entry.item.type === "assistant_message")
          messages.unshift(entry.item);
      }
      if (boundary || !page.hasOlder) return messages;
      if (!page.startCursor || (cursor && page.startCursor.seq >= cursor.seq))
        throw new Error("Native turn history cursor unavailable");
      cursor = page.startCursor;
    }
    throw new Error("Native turn history exceeds the readback bound; inspect the native chat");
  }
  async reconcileTurnReadback(id: string, paseo: PaseoApi) {
    const member = this.store.member(id);
    const pending = member?.turnReadbackPending;
    if (!pending) return;
    if (pending.startedAt !== member.turnStartedAt) return;
    if (pending.awaitEndEvent) throw new Error(pending.error);
    await this.endTurn(pending.agent, pending.turnId, pending.outcome, undefined, paseo, pending);
  }
  async endTurn(
    agent: PluginHookAgent,
    turnId: string | null,
    outcome: PluginTurnOutcome,
    timeline: readonly AgentTimelineItem[] | undefined,
    paseo?: PaseoApi,
    retry?: TurnReadbackReceipt,
  ) {
    const endedAt = retry?.endedAt ?? Date.now();
    const before = this.store.member(agent.id);
    await this.bind(agent);
    const observed = before ?? this.store.member(agent.id);
    const generation = retry ? retry.startedAt : observed?.turnStartedAt;
    let readbackId: string | undefined;
    const ownsReadback = () =>
      !readbackId || this.store.member(agent.id)?.turnReadbackPending?.id === readbackId;
    const clearReadback = () => {
      if (readbackId && ownsReadback()) this.store.updateMember(agent.id, { turnReadbackPending: undefined });
    };
    if (timeline === undefined) {
      if (retry && this.store.member(agent.id)?.turnReadbackPending?.id !== retry.id) return;
      if (this.store.member(agent.id)?.turnStartedAt !== generation) return;
      const pending: TurnReadbackReceipt = {
        id: randomUUID(),
        agent,
        turnId,
        outcome,
        startedAt: generation,
        endedAt,
        error: "Native history read pending",
      };
      readbackId = pending.id;
      this.store.updateMember(agent.id, { turnReadbackPending: pending });
      try {
        if (!paseo || !turnId || generation === undefined)
          throw new Error("Native turn history needs the observed turn identity and start");
        const snapshot = await paseo.agents.ref(agent.id).refresh();
        if (!snapshot) throw new Error("Native agent unavailable during turn readback");
        if (
          snapshot.agent.activeTurn ||
          ["running", "starting", "initializing"].includes(snapshot.agent.status)
        ) {
          pending.awaitEndEvent = true;
          throw new Error("Completion observed an active native turn; awaiting its own end event");
        }
        timeline = await this.turnMessages(agent.id, turnId, generation, endedAt, paseo);
      } catch (error) {
        pending.error = error instanceof Error ? error.message : "history read failed";
        if (this.store.member(agent.id)?.turnReadbackPending?.id === pending.id)
          this.store.updateMember(agent.id, { turnReadbackPending: pending });
        this.wakeupHealth.error = `Turn handback pending: ${pending.error}`;
        throw error;
      }
      // A late end hook or history request must not overwrite a new turn, including reused ordinals.
      const live = this.store.member(agent.id);
      if (
        live?.turnStartedAt !== generation ||
        live?.lastTurnId !== observed?.lastTurnId ||
        live?.turnReadbackPending?.id !== pending.id
      )
        return;
    }
    let inputUnknown = false;
    if (paseo)
      await this.reconcileTurnInput(agent.id, paseo, turnId).catch((error) => {
        inputUnknown = true;
        this.wakeupHealth.error = `Native turn input unknown: ${error instanceof Error ? error.message : "read failed"}`;
      });
    const member = this.store.member(agent.id);
    if (!member) return;
    if (member.turnStartedAt !== generation || !ownsReadback()) return;
    const room = this.store.room(member.roomId);
    const eventId = createHash("sha256")
      .update(
        `${agent.id}:${turnId ?? randomUUID()}:${member.turnStartedAt ?? "legacy"}:${outcome.kind}:${readbackId ?? "legacy"}`,
      )
      .digest("hex")
      .slice(0, 24);
    const path = join(room.artifacts, "turns", `${eventId}.json`);
    // Keep the final response, not a second copy of the entire tool transcript.
    const final = timeline.findLast((item) => item.type === "assistant_message");
    // Native readback already proves turn identity and generation. Legacy populated hook arrays
    // still need the separate attribution check, especially for promptless autonomous turns.
    const start = timeline.findLastIndex((item) => item.type === "user_message");
    const prompt = timeline[start];
    const own = timeline.findLast(
      (item, index): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        index > start && item.type === "assistant_message",
    );
    const attributed =
      outcome.kind === "completed" &&
      allianceProvider(agent.provider)?.harness === "claude" &&
      own &&
      providerNotice(own.text)
        ? readbackId
          ? { notice: own.text.trim() }
          : await this.claudeNotice(agent.id, turnId, own, member.turnStartedAt, paseo)
        : {};
    const notice = attributed.notice;
    await writeAtomic(
      path,
      `${JSON.stringify(
        {
          agentId: agent.id,
          turnId,
          outcome,
          final: attributed.stale ? null : (final ?? null),
          ...(attributed.warning ? { warning: attributed.warning } : {}),
        },
        null,
        2,
      )}\n`,
    );
    const kind = notice ? "failed" : outcome.kind;
    const error = notice ?? (outcome.kind === "failed" ? outcome.error.message : undefined);
    // A turn Claude Code started by itself has no prompt of its own: Paseo records its task
    // notification as a tool call, so the last user message belongs to an earlier turn.
    const promptId =
      this.autonomy.get(agent.id)?.workPromptId ??
      (prompt?.type === "user_message" && !turnId?.startsWith("autonomous")
        ? (prompt.clientMessageId ?? prompt.messageId)
        : undefined);
    const current = this.store.member(agent.id);
    if (
      inputUnknown &&
      turnId &&
      member.turnStartedAt !== undefined &&
      outcome.kind !== "canceled" &&
      this.autonomy.carrying(agent.id) &&
      current &&
      current.turnStartedAt === generation &&
      ownsReadback() &&
      current.lastTurnId === member.lastTurnId &&
      current.resultPath === member.resultPath
    ) {
      // Keep a bounded queue across an outage. Overflow stays visibly held, never silently drops
      // unresolved new work into a previously accepted handback.
      const receipt: TurnInputReceipt = {
        turnId,
        startedAt: member.turnStartedAt,
        outcome: kind,
        error,
        path,
        endedAt: Date.now(),
        promptId,
        maintenance: [
          ...new Set([
            ...(this.autonomy.get(agent.id)?.wakeMessages ?? []),
            ...this.wakeups
              .list()
              .flatMap((w) => (w.ownerId === agent.id && w.messageId ? [w.messageId] : [])),
          ]),
        ],
        handbackTurnId: member.lastTurnId ?? null,
        handbackPath: member.resultPath,
      };
      const pending = current.turnInputPending;
      if (!pending) this.store.updateMember(agent.id, { turnInputPending: receipt });
      else if (![pending, ...(pending.following ?? [])].some((r) => r.path === path))
        this.store.updateMember(agent.id, {
          turnInputPending:
            (pending.following?.length ?? 0) >= 15
              ? { ...pending, overflow: true }
              : { ...pending, following: [...(pending.following ?? []), receipt] },
        });
      clearReadback();
      return;
    }
    const latest = this.store.member(agent.id);
    if (latest?.turnStartedAt !== generation || latest?.lastTurnId !== member.lastTurnId || !ownsReadback())
      return;
    this.finishTurn(agent.id, turnId, kind, error, path, endedAt, promptId);
    clearReadback();
  }
  private finishTurn(
    id: string,
    turnId: string | null,
    kind: string,
    error: string | undefined,
    path: string,
    now: number,
    promptId?: string,
  ) {
    const current = this.store.member(id);
    // A turn that kept the phase and recorded no checkpoint leaves the member's handback standing:
    // its file is written above, but the result stays the handback's. It is recorded as new work
    // only if it ends as such (autonomy.ended).
    const carried = this.autonomy.carrying(id) && this.autonomy.get(id)?.turnId === turnId;
    if (carried || !current?.lastTurnId || current.lastTurnId === turnId) {
      const result = { lastOutcome: kind, resultPath: path, lastTurnEndedAt: now };
      if (!carried) this.store.updateMember(id, result);
      this.autonomy.ended(id, turnId, kind, error, promptId);
      if (carried && !this.autonomy.carrying(id))
        this.store.updateMember(id, { ...newTurn(turnId), ...result });
      // Recorded after the assignment saw the limit that held its harness before this turn.
      const until = quotaReset(error, now);
      this.store.updateMember(id, {
        limited: until === null ? undefined : { until, messageId: promptId ?? null },
      });
    }
  }
  /** Keep an agent open regardless of acceptance. Its owner chain, the Human or itself may set it. */
  keep(id: string, keep: boolean, actorId: string | null) {
    if (actorId !== id) authorizeDecision(this.store, id, actorId);
    this.store.updateMember(id, {
      keep: keep ? { by: actorId ?? "Human", at: new Date().toISOString() } : undefined,
    });
    return { saved: true as const };
  }
  async disposition(
    id: string,
    decision: "accepted" | "rejected",
    candidate: string,
    evidence: string,
    claim: unknown,
    actorId: string | null | undefined,
    paseo?: PaseoApi,
    integrationPlan?: unknown,
    analysisRoot?: string,
  ) {
    // CLIs before 0.1.16 never say who decides. Treating that as the Human would let any agent
    // holding an old release path accept itself, so refuse and name the current command.
    if (actorId === undefined)
      throw new Error(
        `This Alliance CLI is older than 0.1.16 and does not identify who is deciding, so nothing was recorded. Run the same command with: ${(await this.cliCommand()).command}`,
      );
    const member = this.store.member(id);
    if (!member) throw new Error("Unknown Alliance member");
    authorizeDecision(this.store, id, actorId);
    // A decision covers the turn the owner reviewed. Work still running is not reviewable yet, but a
    // turn that only keeps the phase leaves the handback it found standing (autonomy.carrying).
    const turn = member.lastTurnId ?? null;
    const midTurn = async () => {
      if (this.store.member(id)?.turnReadbackPending)
        throw new Error("Native turn handback awaits readback; retry after history recovers");
      if (!paseo) {
        if (this.store.member(id)?.turnInputPending)
          throw new Error("Native turn input awaits reconciliation");
        return false;
      }
      let live: Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>;
      try {
        live = await paseo.agents.ref(id).refresh();
      } catch {
        throw new Error("Agent state unknown; retry the decision");
      }
      const running = live ? ["running", "starting", "initializing"].includes(live.agent.status) : false;
      if (this.autonomy.carrying(id) || this.store.member(id)?.turnInputPending)
        await this.reconcileTurnInput(id, paseo);
      const current = this.store.member(id);
      const native = live?.agent.activeTurn;
      if (
        running &&
        native &&
        (native.turnId !== this.autonomy.get(id)?.turnId ||
          (native.startedAt && Date.parse(native.startedAt) !== current?.turnStartedAt))
      )
        return true;
      return (
        (running && !this.autonomy.carrying(id)) ||
        (current?.lastTurnId ?? null) !== turn ||
        current?.resultPath !== member.resultPath
      );
    };
    if (await midTurn()) throw new Error("Agent is mid-turn; decide after it hands back");
    const room = this.store.room(member.roomId);
    if (analysisRoot && (decision !== "accepted" || claim !== undefined || integrationPlan !== undefined))
      throw new Error("Analysis root is for technical analysis acceptance only, never product acceptance");
    const report =
      decision === "accepted"
        ? analysisRoot
          ? await validateAnalysisEvidence(evidence, analysisRoot, room.artifacts, candidate)
          : await validateEvidence(evidence, member.cwd ?? room.cwd, candidate)
        : null;
    const product = claim === undefined ? undefined : ProductAcceptance.parse(claim);
    if (product && (decision !== "accepted" || report?.kind !== "runtime"))
      throw new Error(
        "Product acceptance requires candidate-bound runtime evidence; test/analysis PASS is technical only",
      );
    if (integrationPlan !== undefined && !product)
      throw new Error("Integration proof requires product acceptance");
    const contributors = product ? acceptedContributors(this.store, id) : [];
    const contributorsStamp = integrationStamp(contributors);
    const assertContributors = () => {
      if (!product) return;
      const fresh = acceptedContributors(this.store, id);
      if (integrationStamp(fresh) !== contributorsStamp)
        throw new Error("Accepted contributions changed during product review; verify and accept again");
      if (
        fresh.some((child) => {
          const member = this.store.member(child.agentId);
          return member?.turnInputPending || member?.turnReadbackPending;
        })
      )
        throw new Error("Contributor native turn awaits reconciliation before product acceptance");
    };
    assertContributors();
    const integration =
      product && report
        ? await buildIntegrationProof({ report, contributors, plan: integrationPlan })
        : undefined;
    const verificationBytes = product ? await readFile(evidence) : undefined;
    if (
      verificationBytes &&
      JSON.stringify(Evidence.parse(JSON.parse(verificationBytes.toString()))) !== JSON.stringify(report)
    )
      throw new Error("Runtime verification report changed during product review");
    const verificationArtifact = verificationBytes
      ? { path: evidence, digest: createHash("sha256").update(verificationBytes).digest("hex") }
      : undefined;
    const path = join(room.artifacts, "dispositions", `${randomUUID()}.json`);
    const at = new Date().toISOString();
    const record = `${JSON.stringify(
      {
        agentId: id,
        decision,
        decidedBy: actorId ?? "Human",
        candidate,
        evidence,
        analysisRoot,
        verification: report,
        verificationArtifact,
        product,
        integration,
        at,
      },
      null,
      2,
    )}\n`;
    await noLinks(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (product && report) {
      await validateEvidence(evidence, member.cwd ?? room.cwd, candidate);
      if (integration) await validateIntegrationProof(integration, report);
    }
    // Authority or the turn may have changed while evidence was validated. Recheck, then write
    // with no await in between so a later turn that is new work clears this decision.
    if (await midTurn()) throw new Error("Agent started a new turn; review it before deciding");
    if (product && report && verificationArtifact)
      validateIntegrationCurrentSync(report, integration, [verificationArtifact], this.manifest.root);
    authorizeDecision(this.store, id, actorId);
    assertContributors();
    if (
      (this.store.member(id)?.lastTurnId ?? null) !== turn ||
      this.store.member(id)?.resultPath !== member.resultPath
    )
      throw new Error("Agent started a new turn; review it before deciding");
    // Publish only after all checks. No failed review is visible as a historical acceptance.
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, record, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    this.store.updateMember(id, {
      decision,
      decisionEvidence: path,
      decisionBy: actorId,
      decisionAt: at,
      decisionTurnId: turn,
      decisionScope: decision === "accepted" ? (product ? "product" : "technical") : undefined,
      decisionIntegration: product
        ? {
            contributorsStamp,
            contributors,
            dispositionDigest: createHash("sha256").update(record).digest("hex"),
          }
        : undefined,
    });
    this.wakeups.decided(id);
    this.autonomy.decided(id);
    return { saved: true as const };
  }
  async close() {
    this.closing = true;
    clearTimeout(this.wakeTimer);
    await this.autonomy?.stop();
    await this.lifecycle?.stop();
    await this.liveness?.stop();
    await this.wakeups?.stop();
    await this.wakeRound;
    await this.wakeClient?.close();
    this.store?.close();
  }
}
