#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Evidence, runVerification } from "../server/evidence.mjs";
import { inspectFailureEval, runFailureEval } from "../server/failure-evals.mjs";
import { runFeatureVerification } from "../server/feature-verification.mjs";
import { projectSkills, registerSkill } from "../server/project-skills.mjs";
import { authStatus, setAuthSource } from "./auth.mjs";
import { downloadRelease, isNewerRelease, releaseInfo, run } from "./distribution.mjs";
import { activate, doctor, installation, withMaintenance } from "./maintenance.mjs";
import { instanceState, requireIdle } from "./paseo.mjs";
import { projectRoot } from "./profiles.mjs";

const args = process.argv.slice(2);
const flags = {};
const positional = [];
let checkCommand = [];
const repeated = { "--input": [], "--artifact": [], "--unverified": [], "--feature": [] };
const values = new Set([
  "--home",
  "--room",
  "--owner",
  "--evidence",
  "--digest",
  "--product",
  "--file",
  "--obligation",
  "--pid",
  "--key",
  "--title",
  "--revision",
  "--reason",
  "--at",
  "--job",
  "--turn",
  "--delivery",
  "--every-ms",
  "--max-runs",
  "--expires",
  "--next-owner",
  "--paseo-home",
  "--port",
  "--bin-dir",
  "--isolated-root",
  "--codex-auth-from",
  "--from",
  "--version-tag",
  "--project",
  "--output",
  "--scenario",
  "--kind",
  "--target",
  "--agent",
  "--report",
  "--assignment",
  "--timeout-ms",
  "--map",
  "--suite",
]);
const switches = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--check",
  "--refresh",
  "--separate",
  "--separate-auth",
  "--json",
]);
const help = `Alliance Work — isolated agent rooms on native Paseo

  alliance-work install [--codex-auth-from ~/.codex]
  alliance-work setup                 Check installed profiles and runtime
  alliance-work setup --refresh       Rebuild managed files and reload when idle
  alliance-work auth status           Inspect the shared Codex source, without secrets
  alliance-work auth codex --from ~/.codex
  alliance-work auth codex --separate Use independent role logins
  alliance-work login codex lead      Log in to a separate role (any of the five roles)
  alliance-work login claude peer
  alliance-work login pi peer         Open Pi; use /login
  alliance-work doctor                Verify homes, capabilities, pinned source and live plugin
  alliance-work status                Read agents, owners, decisions and tracked processes
  alliance-work members owner --agent ID --owner ID|Human --revision N --evidence HANDOFF_FILE
  alliance-work policy read --agent ID
  alliance-work policy ack --agent ID --digest SHA256
  alliance-work obligations list [--owner ID|Human]
  alliance-work obligations add --file OBLIGATION.json
  alliance-work obligations action --file ACTION.json
  alliance-work obligations history --key KEY
  alliance-work jobs track --room ID --owner AGENT --pid PID --key RUN_ID --title TITLE
  alliance-work jobs owner --key RUN_ID --owner AGENT --revision N
  alliance-work wakeups list
  alliance-work wakeups add --room ID --owner AGENT --key KEY --reason TEXT --at ISO_TIME
  alliance-work wakeups add --room ID --owner AGENT --key KEY --reason TEXT --job RUN_ID
  alliance-work wakeups add --room ID --owner AGENT --key KEY --reason TEXT --agent CHILD --turn TURN_ID
  alliance-work wakeups take --owner AGENT
  alliance-work wakeups ack|cancel --key KEY --owner AGENT --revision N
  alliance-work wakeups owner --key KEY --owner OLD --next-owner NEW --revision N
  alliance-work update --check        Read latest private GitHub release; change nothing
  alliance-work update                Verify, stage, check and activate the latest release
  alliance-work rollback              Activate the previous installation when idle
  alliance-work skills list [--project PATH]
  alliance-work skills add .agents/skills/NAME [--project PATH]
  alliance-work verify --scenario NAME [--project PATH] -- COMMAND [ARGS...]
  alliance-work verify --map .alliance/features.json [--feature ID] [--project PATH]
  alliance-work eval --suite .alliance/evals/failure.json [--project PATH]
  alliance-work eval inspect --report /absolute/eval.json [--project PATH]
  alliance-work accept --agent ID --report /absolute/report.json [--product /absolute/journey.json]

Verification options: --kind test|runtime|analysis (default test), --target LABEL,
  --input FILE (repeat for ignored runtime inputs), --artifact FILE (repeat),
  --unverified REASON (repeat), --output DIR (outside checkout), --timeout-ms 600000.
Commands run directly without a shell. Lead chooses checks and review depth.
PASS describes the selected check, not untested product behavior. Changed candidates
or artifacts cannot reuse an old report. Project skills apply to new sessions.

Options: --home PATH, --paseo-home PATH, --bin-dir PATH, --port 6771,
         --codex-auth-from PATH, --separate-auth, --json
Requires Node 24+ and native Codex/Claude. Pi is bundled; updates use authenticated gh.
Paseo is pinned per release. Maintenance never restarts a running daemon.
`;
try {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      checkCommand = args.slice(i + 1);
      break;
    }
    if (Object.hasOwn(repeated, arg)) {
      if (!args[i + 1]) throw new Error(`Missing value for ${arg}`);
      repeated[arg].push(args[++i]);
    } else if (values.has(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      flags[arg] = args[++i];
    } else if (switches.has(arg)) flags[arg] = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  if (flags["--version"] || flags["-v"]) {
    console.log(pkg.version);
    process.exit(0);
  }
  const command = positional[0];
  if (!command || flags["--help"] || flags["-h"]) {
    console.log(help);
    process.exit(0);
  }
  const home = resolve(
    flags["--home"] ?? process.env.ALLIANCE_WORK_HOME ?? join(homedir(), ".alliance-work"),
  );
  const output = (value) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  const installOptions = {
    home,
    paseoHome: flags["--paseo-home"],
    port: flags["--port"],
    binDir: flags["--bin-dir"],
    isolatedRoot: flags["--isolated-root"],
    authFrom: flags["--codex-auth-from"],
    separateAuth: !!flags["--separate-auth"],
  };
  if (command === "skills") {
    const cwd = resolve(flags["--project"] ?? process.cwd());
    if (positional[1] === "add" && positional[2]) output(await registerSkill(cwd, positional[2]));
    else if (positional[1] !== "list")
      throw new Error("Usage: alliance-work skills list | skills add .agents/skills/NAME");
    const bundle = await projectSkills(cwd);
    output({
      root: bundle.root,
      revision: bundle.digest,
      skills: bundle.skills.map(({ name, description, directory }) => ({ name, description, directory })),
    });
  } else if (command === "verify") {
    const timeoutMs = Number(flags["--timeout-ms"] ?? 600000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid verification timeout");
    if (flags["--map"] && checkCommand.length) throw new Error("Choose --map or a command, not both");
    if (!flags["--map"] && repeated["--feature"].length) throw new Error("--feature requires --map");
    const result = await (flags["--map"] ? runFeatureVerification : runVerification)({
      map: flags["--map"],
      features: repeated["--feature"],
      cwd: resolve(flags["--project"] ?? process.cwd()),
      output: resolve(
        flags["--output"] ?? join(process.env.ALLIANCE_ARTIFACTS ?? home, "evidence", randomUUID()),
      ),
      command: checkCommand,
      scenario: flags["--scenario"],
      kind: flags["--kind"] ?? "test",
      target: flags["--target"],
      inputs: repeated["--input"],
      artifacts: repeated["--artifact"],
      unverified: repeated["--unverified"],
      assignment: flags["--assignment"] ?? process.env.ALLIANCE_ASSIGNMENT ?? null,
      agentId: process.env.PASEO_AGENT_ID ?? null,
      timeoutMs,
    });
    output({
      report: result.path,
      candidate: result.report.candidate.digest,
      verdict: result.report.verdict,
      kind: result.report.kind,
      unverified: result.report.unverified,
      coverage: result.coverage ? { ...result.coverage, artifacts: undefined } : undefined,
    });
    if (result.report.verdict !== "PASS") process.exitCode = 1;
  } else if (command === "eval") {
    const cwd = resolve(flags["--project"] ?? process.cwd());
    if (positional[1] === "inspect") {
      if (!flags["--report"]) throw new Error("eval inspect requires --report");
      const report = await inspectFailureEval(resolve(flags["--report"]), cwd);
      output({ report: resolve(flags["--report"]), ...report.summary });
    } else {
      if (!flags["--suite"]) throw new Error("eval requires --suite");
      const destination = resolve(
        flags["--output"] ?? join(process.env.ALLIANCE_ARTIFACTS ?? home, "evals", randomUUID()),
      );
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const result = await runFailureEval({ cwd, suite: flags["--suite"], output: destination });
      output({ report: result.path, ...result.report.summary });
      if (!["IMPROVED", "NO_CHANGE"].includes(result.report.summary.outcome)) process.exitCode = 1;
    }
  } else if (["status", "jobs", "wakeups", "members", "policy", "obligations"].includes(command)) {
    const current = await installation(home);
    if (!current) throw new Error("No Alliance installation exists for this home");
    const config = JSON.parse(await readFile(join(current.paseoHome, "config.json"), "utf8"));
    let method = "rooms.list",
      input = {};
    if (command === "obligations") {
      const action = positional[1];
      if (action === "list") {
        method = "obligations.list";
        input = flags["--owner"] ? { ownerId: flags["--owner"] === "Human" ? null : flags["--owner"] } : {};
      } else if (action === "history" && flags["--key"]) {
        method = "obligations.history";
        input = { key: flags["--key"] };
      } else if (["add", "action"].includes(action) && flags["--file"]) {
        method = `obligations.${action}`;
        input = JSON.parse(await readFile(resolve(flags["--file"]), "utf8"));
      } else
        throw new Error(
          "Usage: obligations list [--owner ID|Human] | add|action --file FILE | history --key KEY",
        );
    }
    if (command === "members") {
      if (positional[1] !== "owner") throw new Error("Usage: members owner");
      for (const flag of ["--agent", "--owner", "--revision", "--evidence"])
        if (flags[flag] === undefined) throw new Error(`Missing ${flag}`);
      method = "members.owner";
      input = {
        agentId: flags["--agent"],
        ownerId: flags["--owner"] === "Human" ? null : flags["--owner"],
        revision: Number(flags["--revision"]),
        evidence: resolve(flags["--evidence"]),
      };
    }
    if (command === "policy") {
      const agentId = flags["--agent"] ?? process.env.PASEO_AGENT_ID;
      if (!agentId) throw new Error("Missing --agent");
      if (positional[1] === "read") {
        method = "policy.read";
        input = { agentId };
      } else if (positional[1] === "ack" && flags["--digest"]) {
        method = "policy.ack";
        input = { agentId, digest: flags["--digest"] };
      } else throw new Error("Usage: policy read|ack --agent ID [--digest SHA256]");
    }
    if (command === "jobs" && positional[1] === "track") {
      for (const flag of ["--room", "--owner", "--pid", "--key", "--title"])
        if (!flags[flag]) throw new Error(`Missing ${flag}`);
      method = "jobs.track";
      input = {
        roomId: flags["--room"],
        ownerId: flags["--owner"],
        pid: Number(flags["--pid"]),
        key: flags["--key"],
        title: flags["--title"],
      };
    } else if (command === "jobs" && positional[1] === "owner") {
      for (const flag of ["--key", "--owner", "--revision"])
        if (!flags[flag]) throw new Error(`Missing ${flag}`);
      method = "jobs.owner";
      input = { key: flags["--key"], ownerId: flags["--owner"], revision: Number(flags["--revision"]) };
    } else if (command === "jobs" && positional[1] !== "list")
      throw new Error("Usage: jobs list|track|owner");
    if (command === "wakeups") {
      const action = positional[1];
      const ownerId = flags["--owner"] ?? process.env.PASEO_AGENT_ID;
      if (action === "list") method = "wakeups.list";
      else if (action === "add") {
        for (const flag of ["--room", "--key", "--reason"])
          if (!flags[flag]) throw new Error(`Missing ${flag}`);
        if (!ownerId) throw new Error("Missing --owner");
        if ([flags["--at"], flags["--job"], flags["--agent"]].filter(Boolean).length !== 1)
          throw new Error("Choose exactly one of --at, --job, or --agent with --turn");
        method = "wakeups.add";
        input = {
          key: flags["--key"],
          roomId: flags["--room"],
          ownerId,
          reason: flags["--reason"],
          ...(flags["--obligation"] ? { obligationKey: flags["--obligation"] } : {}),
          trigger: flags["--at"]
            ? { kind: "time", at: Date.parse(flags["--at"]) }
            : flags["--job"]
              ? { kind: "job", key: flags["--job"] }
              : { kind: "turn", agentId: flags["--agent"], turnId: flags["--turn"] },
          delivery: flags["--delivery"] ?? "pull",
          ...(flags["--every-ms"] ? { everyMs: Number(flags["--every-ms"]) } : {}),
          ...(flags["--max-runs"] ? { maxRuns: Number(flags["--max-runs"]) } : {}),
          ...(flags["--expires"] ? { expiresAt: Date.parse(flags["--expires"]) } : {}),
        };
      } else if (action === "take") {
        if (!ownerId) throw new Error("Missing --owner");
        method = "wakeups.take";
        input = { ownerId };
      } else if (["ack", "cancel", "owner"].includes(action)) {
        if (!ownerId || !flags["--key"] || !flags["--revision"])
          throw new Error("Requires --key, --owner and --revision");
        method = "wakeups.action";
        input = {
          key: flags["--key"],
          ownerId,
          revision: Number(flags["--revision"]),
          action,
          nextOwnerId: flags["--next-owner"],
        };
      } else throw new Error("Usage: wakeups list|add|take|ack|cancel|owner");
    }
    const client = new DaemonClient({
      url: `ws://${config.daemon.listen}/ws`,
      clientId: "alliance-operations",
      password: process.env.ALLIANCE_PASEO_PASSWORD,
      connectTimeoutMs: 10000,
    });
    try {
      await client.connect();
      const result = await client.invokePluginRpc("alliance-work", method, input);
      output(command === "jobs" && positional[1] === "list" ? result.jobs : result);
    } finally {
      await client.close();
    }
  } else if (command === "accept") {
    if (!flags["--agent"] || !flags["--report"])
      throw new Error("Usage: alliance-work accept --agent ID --report /absolute/report.json");
    const reportPath = resolve(flags["--report"]);
    const report = Evidence.parse(JSON.parse(await readFile(reportPath, "utf8")));
    const current = await installation(home);
    if (!current) throw new Error("No Alliance installation exists for this home");
    const config = JSON.parse(await readFile(join(current.paseoHome, "config.json"), "utf8"));
    const client = new DaemonClient({
      url: `ws://${config.daemon.listen}/ws`,
      clientId: "alliance-acceptance",
      password: process.env.ALLIANCE_PASEO_PASSWORD,
      connectTimeoutMs: 10000,
    });
    try {
      await client.connect();
      output(
        await client.invokePluginRpc("alliance-work", "members.disposition", {
          agentId: flags["--agent"],
          decision: "accepted",
          candidate: report.candidate.digest,
          evidence: reportPath,
          ...(flags["--product"]
            ? { product: JSON.parse(await readFile(resolve(flags["--product"]), "utf8")) }
            : {}),
        }),
      );
    } finally {
      await client.close();
    }
  } else if (command === "install" || (command === "setup" && flags["--refresh"])) {
    if (flags["--codex-auth-from"] && flags["--separate-auth"])
      throw new Error("Choose shared or separate auth, not both.");
    output(await withMaintenance(home, () => activate(installOptions)));
  } else if (command === "doctor" || command === "setup") {
    const result = await doctor(home);
    output(result);
    if (!result.ok) process.exitCode = 1;
  } else if (command === "auth") {
    if (positional[1] === "status") {
      const status = await authStatus(home);
      output(status);
      if (status.ready === false) process.exitCode = 1;
    } else if (positional[1] === "codex" && !!flags["--from"] !== !!flags["--separate"]) {
      await withMaintenance(home, async () => {
        await setAuthSource(home, flags["--from"] ?? null);
      });
      output(await authStatus(home));
      output(
        "Applies to newly opened Codex sessions in every role. Existing sessions keep their current auth mode.",
      );
    } else
      throw new Error(
        "Usage: alliance-work auth status | auth codex --from ~/.codex | auth codex --separate",
      );
  } else if (command === "login") {
    const [, harness, role] = positional;
    if (
      !["codex", "claude", "pi"].includes(harness) ||
      !["hq", "supervisor", "lead", "peer", "lens"].includes(role)
    )
      throw new Error("Usage: alliance-work login <codex|claude|pi> <hq|supervisor|lead|peer|lens>");
    run(
      process.execPath,
      [
        join(projectRoot, "scripts/launch.mjs"),
        home,
        `${harness}-${role}`,
        ...(harness === "codex" ? ["login"] : harness === "claude" ? ["auth", "login"] : []),
      ],
      { stdio: "inherit" },
    );
  } else if (command === "update") {
    const release = releaseInfo(flags["--version-tag"]);
    const current = await installation(home);
    if (!release) {
      output("No stable GitHub release is published in haohao3k/alliance-work. Installation unchanged.");
      if (!flags["--check"]) process.exitCode = 1;
    } else if (flags["--check"])
      output({
        current: current?.version ?? pkg.version,
        latest: release.tagName,
        url: release.url,
        updateAvailable: isNewerRelease(release.tagName, current?.version ?? pkg.version),
      });
    else if (!current) throw new Error("Run ./install.sh first; this home has no installation record.");
    else if (!isNewerRelease(release.tagName, current.version))
      output(
        `Installed v${current.version}; no newer release. Use setup --refresh to refresh managed profiles.`,
      );
    else
      output(
        await withMaintenance(home, async () => {
          const state = await instanceState(current.paseoHome);
          if (state?.localDaemon === "running") requireIdle(current.paseoHome);
          const root = await downloadRelease(home, release);
          // Execute the candidate's installer so migrations match the candidate version.
          run(
            process.execPath,
            [join(root, "scripts/cli.mjs"), "install", "--home", home, "--paseo-home", current.paseoHome],
            { stdio: "inherit", env: { ...process.env, ALLIANCE_PARENT_MAINTENANCE: String(process.pid) } },
          );
          return { updated: release.tagName, root };
        }),
      );
  } else if (command === "rollback") {
    const current = await installation(home);
    if (!current?.previous) throw new Error("No previous installation is recorded.");
    output(
      await withMaintenance(home, () =>
        activate({ ...installOptions, root: current.previous.root, paseoHome: current.paseoHome }),
      ),
    );
  } else throw new Error(`Unknown command ${command}. Run alliance-work --help.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
