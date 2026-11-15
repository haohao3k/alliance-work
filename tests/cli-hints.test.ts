import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { cliHints, closest, parseHelp } from "../scripts/cli-hints.mjs";
import { projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

const cli = join(projectRoot, "scripts/cli.mjs");
function alliance(args: string[], env: Record<string, string> = {}) {
  const clean = { ...process.env };
  for (const name of ["PASEO_AGENT_ID", "ALLIANCE_ROLE", "ALLIANCE_BOUND_ROOM", "ALLIANCE_WORK_HOME"])
    delete clean[name];
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
const help = alliance(["--help"]).stdout;
const hints = cliHints({
  help,
  flags: [...new Set(help.match(/--[a-z][a-z-]*/g))],
  valueFlags: [...new Set(help.match(/--[a-z][a-z-]*/g))].filter(
    (flag) => !["--check", "--hold"].includes(flag),
  ),
});
const syntaxLines = (stderr: string, command: string) =>
  stderr.split("\n").filter((line) => line.startsWith(`  alliance-work ${command}`));

test("non-Git acceptance failures explain member scope and put input flags on verification", () => {
  const error = "For non-Git work, name the candidate files with --input FILE";
  const explained = hints.explain(error, ["accept", "--agent", "member", "--report", "/report.json"]);
  assert.match(explained, /member.*checkout/i);
  assert.match(explained, /verify[^\n]*--input FILE/);
  assert.doesNotMatch(explained, /accept\s+--input/);
  const verify = hints.explain(error, ["verify", "--scenario", "analysis"]);
  assert.match(verify, /verify[^\n]*--input FILE/);
});

test("changed acceptance artifacts request fresh verification rather than a job settlement envelope", () => {
  const explained = hints.explain("Evidence artifact changed: /proof/command.log", [
    "accept",
    "--agent",
    "member",
    "--report",
    "/report.json",
  ]);
  assert.match(explained, /rerun.*verify/i);
  assert.doesNotMatch(explained, /--evidence|processIdentity|jobs list/);
});

// Synthetic invalid calls exercise command hints and common argument mistakes.
test("jobs track with --command names --title and shows the track syntax", () => {
  const { code, stderr } = alliance(["jobs", "track", "--pid", "5", "--key", "k", "--command", "sleep 1"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Unknown option --command/);
  assert.match(stderr, /--title/);
  assert.ok(syntaxLines(stderr, "jobs track").some((line) => line.includes("--title TITLE")));
});

test("autonomy checkpoint with --note names --reason and shows the checkpoint syntax", () => {
  const { code, stderr } = alliance(["autonomy", "checkpoint", "--phase", "review", "--note", "x"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Did you mean --reason/);
  assert.ok(syntaxLines(stderr, "autonomy checkpoint").length > 0);
});

test("an unknown command gets its nearest real command, and `help` points at --help", () => {
  const near = alliance(["job", "list"]);
  assert.notEqual(near.code, 0);
  assert.match(near.stderr, /Did you mean `jobs`/);
  assert.ok(syntaxLines(near.stderr, "jobs").length > 1);
  const bare = alliance(["help"]);
  assert.notEqual(bare.code, 0);
  assert.match(bare.stderr, /--help/);
});

test("a misspelled flag gets the nearest flag of that command", () => {
  const { code, stderr } = alliance(["jobs", "settle", "--key", "k", "--revison", "3"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Did you mean --revision/);
});

test("--flag=value is refused with the spelling that works", () => {
  const { code, stderr } = alliance(["wakeups", "list", "--owner=agent-1"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /--owner VALUE/);
});

test("a mistyped subcommand names the nearest subcommand", async () => {
  const home = await installed();
  const { code, stderr } = alliance(["wakeups", "ad"], { ALLIANCE_WORK_HOME: home });
  assert.notEqual(code, 0);
  assert.match(stderr, /did you mean `wakeups add`/);
  assert.ok(syntaxLines(stderr, "wakeups add").length > 0);
});

async function installed() {
  const home = await temporary("alliance-hints-home-");
  const paseoHome = join(home, "paseo");
  await mkdir(paseoHome);
  await writeFile(join(home, "installation.json"), JSON.stringify({ version: "0.0.0", paseoHome }));
  await writeFile(join(paseoHome, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:9" } }));
  return home;
}

test("a missing required flag shows the syntax that lists it", async () => {
  const home = await installed();
  const { code, stderr } = alliance(["jobs", "track", "--pid", "5", "--key", "k"], {
    ALLIANCE_WORK_HOME: home,
    ALLIANCE_BOUND_ROOM: "room",
    PASEO_AGENT_ID: "agent",
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /^Missing --title/);
  assert.ok(syntaxLines(stderr, "jobs track").some((line) => line.includes("--title TITLE")));
});

test("a Human-authorized decision requires both source identity and timestamp before connecting", () => {
  for (const command of ["accept", "reject"]) {
    const args = command === "accept" ? ["--report", "/unused/report.json"] : ["--reason", "Revise"];
    const missing = alliance([command, "--agent", "peer", ...args, "--for-human", "--source", "native-id"], {
      PASEO_AGENT_ID: "hq",
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /--source NATIVE_MESSAGE_ID --at ISO_TIMESTAMP/);
    const unpaired = alliance([command, "--agent", "peer", ...args, "--source", "native-id"]);
    assert.notEqual(unpaired.code, 0);
    assert.match(unpaired.stderr, /--source requires --for-human/);
  }
});

test("Human attribution flags cannot be silently ignored by other commands", () => {
  for (const args of [
    ["status", "--for-human"],
    ["models", "reset", "--all", "--source", "native-id"],
  ]) {
    const result = alliance(args);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /only to member accept\/reject/);
    assert.doesNotMatch(result.stderr, /No Alliance installation/);
  }
});

test("a missing option value says the value must follow the option", () => {
  const { code, stderr } = alliance(["wait", "--pid"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /Missing value for --pid/);
  assert.ok(syntaxLines(stderr, "wait").length > 0);
});

// Rejections the plugin sent for well-formed but wrong calls; the text is what the daemon logged.
test("plugin rejections of real calls come with the fix and the command's syntax", () => {
  const settle = ["jobs", "settle", "--key", "k", "--revision", "1"];
  const bind = hints.explain("Evidence must bind job key, PID, process identity, outcome and reason", settle);
  assert.match(bind, /processIdentity/);
  assert.ok(syntaxLines(bind, "jobs settle").length > 0);
  const notJson = hints.explain(`Unexpected token '#', "# Job Sett"... is not valid JSON`, settle);
  assert.match(notJson, /--evidence must name a JSON file/);
  const stale = hints.explain("Wakeup changed; refresh owner and revision", ["wakeups", "ack", "--key", "k"]);
  assert.match(stale, /wakeups list/);
  assert.match(
    hints.explain("Process is no longer running; no job recorded", ["jobs", "track"]),
    /still running/,
  );
  assert.match(hints.explain("Job and wakeup must share room and owner", ["wakeups", "add"]), /jobs list/);
  assert.match(
    hints.explain("For non-Git work, name the candidate files with --input FILE", [
      "verify",
      "--scenario",
      "s",
    ]),
    /--input FILE/,
  );
});

test("settle recovery guidance survives taking only the final output line", () => {
  const argv = ["jobs", "settle"];
  for (const message of [
    "Evidence must bind job key, PID, process identity, outcome and reason",
    "Evidence must bind job key, PID, process identity, outcome and reason; mismatched fields: pid",
    "Verified outcomes require artifact hashes",
    "Evidence requires an absolute path",
    "Unexpected token '#', is not valid JSON",
  ]) {
    const last = hints.explain(message, argv).trim().split("\n").at(-1) as string;
    assert.match(last, /--evidence/);
    assert.match(last, /JSON/);
    assert.doesNotMatch(last, /^\s*alliance-work jobs settle/);
  }
});

test("failures that are not wrong calls keep their message exactly", () => {
  for (const message of [
    "No Alliance installation exists for this home",
    "Plugin RPC timed out: alliance-work.invoke",
    "ENOENT: no such file or directory, lstat '/x'",
  ])
    assert.equal(hints.explain(message, ["jobs", "list"]), message);
});

test("correct calls are untouched: version and help still succeed", () => {
  const version = alliance(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  assert.equal(alliance(["--help"]).code, 0);
  assert.equal(alliance(["models", "bogus"], { ALLIANCE_WORK_HOME: "/nonexistent" }).code, 1);
});

// Every command in --help gets hints without a second table: a command added there is covered.
test("every command in --help yields its own syntax for an unknown option", () => {
  const entries = parseHelp(help);
  assert.ok(entries.length > 30);
  for (const command of new Set(entries.map((entry: { command: string }) => entry.command))) {
    const text = hints.explain("Unknown option --zzzzqq", [command as string]);
    assert.ok(syntaxLines(text, command as string).length > 0, `${command} shows its syntax`);
  }
});

test("every alias the hints offer is a real option of the command it is offered for", () => {
  const offered: Array<[string[], string]> = [
    [["jobs", "track"], "--command"],
    [["autonomy", "checkpoint"], "--note"],
    [["wakeups", "defer"], "--delay"],
    [["jobs", "settle"], "--id"],
  ];
  for (const [argv, wrong] of offered) {
    const text = hints.explain(`Unknown option ${wrong}`, argv);
    const target = /Did you mean (--[a-z-]+)\?/.exec(text)?.[1];
    assert.ok(target, `${wrong} on ${argv.join(" ")} gets a suggestion`);
    assert.ok(
      parseHelp(help).some(
        (entry: { command: string; subs: string[]; flags: Set<string> }) =>
          entry.command === argv[0] && entry.subs.includes(argv[1]) && entry.flags.has(target),
      ),
      `${target} is an option of ${argv.join(" ")}`,
    );
  }
});

test("closest ignores far-off words and finds transpositions", () => {
  assert.equal(closest("--revsion", ["--revision", "--reason"]), "--revision");
  assert.equal(closest("--zebra", ["--revision", "--reason"]), null);
});

test("a real command with a wrong subcommand names the subcommand, not the command it already is", () => {
  const { code, stderr } = alliance(["fleet", "stat"]);
  assert.notEqual(code, 0);
  assert.doesNotMatch(stderr, /Did you mean `fleet`\?/);
  assert.match(stderr, /did you mean `fleet status`/);
  assert.ok(syntaxLines(stderr, "fleet status").length > 0);
});
