/**
 * Turns a failed alliance-work call into an error that says what is wrong and shows the correct
 * syntax. The syntax is read from the CLI's own `--help` text, so a command added there is covered
 * without a second table. A hint is appended to the original message; it never replaces it, and the
 * exit code stays the caller's.
 */

/** Words agents reach for, mapped to the option the CLI really has (seen on real failed calls). */
const SYNONYMS = {
  "--title": ["--command", "--cmd", "--name", "--label", "--description"],
  "--reason": ["--note", "--message", "--comment", "--why", "--description", "--summary"],
  "--phase": ["--status", "--state"],
  "--agent": ["--id", "--agent-id", "--session", "--member"],
  "--key": ["--id", "--job-id", "--run-id", "--job", "--name"],
  "--revision": ["--rev", "--version"],
  "--file": ["--path", "--json", "--input-file"],
  "--minutes": ["--min", "--delay", "--after"],
  "--at": ["--time", "--when", "--until"],
};
const COMMAND_SYNONYMS = {
  job: "jobs",
  wakeup: "wakeups",
  wake: "wakeups",
  obligation: "obligations",
  member: "members",
  model: "models",
  skill: "skills",
  account: "accounts",
  policies: "policy",
  waits: "wait",
  accepts: "accept",
  rejects: "reject",
};

/** Messages that are a wrong call; anything else is a runtime failure that needs no syntax. */
const CALL_ERROR =
  /^(Unknown command|Unknown option|Missing\b|Usage:|Choose\b|Provide\b|Read \S+ \S+ and provide|.*\brequires --|.*\btakes --)/;

/** Rejections the plugin sends for calls that were well-formed but wrong, with the fix to apply. */
const REJECTIONS = [
  {
    when: /Evidence must bind job key|Verified outcomes require artifact hashes|Evidence artifact changed|Evidence requires an absolute path/,
    hint: (ctx) =>
      ctx.command === "accept"
        ? "An artifact no longer matches the verification report. Review the change and rerun verify on the candidate before accepting its new report."
        : '--evidence is the absolute path of a JSON file: {"key": KEY, "pid": PID, "processIdentity": ID, "outcome": OUTCOME, "reason": REASON}. Copy key, pid and processIdentity from `alliance-work jobs list`; outcome and reason must equal the --outcome and --reason you pass. succeeded|failed|superseded also need "artifacts": [{"path": ABSOLUTE_PATH, "sha256": HEX}]; unverified needs none.',
  },
  {
    when: /is not valid JSON|Unexpected non-whitespace character after JSON|^\[\s*$/,
    hint: (ctx) => {
      const flag = JSON_FLAGS[ctx.path] ?? JSON_FLAGS[ctx.command];
      return flag
        ? `${flag} must name a JSON file, not notes, markdown or command output.`
        : "A flag of this command names a file that must hold JSON; notes, markdown and command output are not accepted.";
    },
  },
  {
    when: /(Wakeup|Job|Obligation|Owner|Autonomy|Account selection) changed; refresh/,
    hint: (ctx) =>
      `--revision must be the current revision of that record. Read it again (${READ_BACK[ctx.command] ?? "alliance-work status"}) and retry with the number it shows; a stale or guessed revision is refused.`,
  },
  {
    when: /Process is no longer running; no job recorded/,
    hint: "--pid must be a process that is still running when you call jobs track: start it first, then track its own pid. A process that already ended needs no job.",
  },
  {
    when: /Job key already belongs to another run or owner/,
    hint: "--key names one run: use a new RUN_ID for this run (`alliance-work jobs list` shows the keys in use).",
  },
  {
    when: /Job and wakeup must share room and owner/,
    hint: "Pass the --room and --owner the job was tracked with (`alliance-work jobs list` shows roomId and ownerId).",
  },
  {
    when: /Take or receive the wakeup before acknowledging it/,
    hint: "Run `alliance-work wakeups take --owner AGENT` first, then ack it with its revision.",
  },
  {
    when: /For non-Git work, name the candidate files with --input FILE/,
    hint: (ctx) =>
      ctx.command === "accept"
        ? "accept checks the member's registered checkout against the report's candidate and input list. Check that scope first; input flags belong to verification: verify --project MEMBER_CHECKOUT --scenario NAME --input FILE [--input FILE2] -- COMMAND. A separate non-Git analysis bundle inside this room's artifacts requires an analysis report and accept --analysis-root; it cannot establish product acceptance."
        : "Outside a Git repository, pass every file that is the candidate: verify --scenario NAME --input FILE [--input FILE2] -- COMMAND.",
  },
];
const JSON_FLAGS = {
  "jobs settle": "--evidence",
  "obligations add": "--file",
  "obligations action": "--file",
  "mcp save": "--file",
  "skills save": "--file",
  accept: "--report, --product or --integration",
};
const READ_BACK = {
  wakeups: "`alliance-work wakeups list`",
  jobs: "`alliance-work jobs list`",
  obligations: "`alliance-work obligations list`",
  members: "`alliance-work status`",
  autonomy: "`alliance-work autonomy list`",
  accounts: "`alliance-work accounts status`",
};

/** Edit distance (a swap of neighbours counts once); Infinity once it exceeds `limit`. */
export function distance(a, b, limit = 3) {
  if (Math.abs(a.length - b.length) > limit) return Number.POSITIVE_INFINITY;
  const grid = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) grid[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      grid[i][j] = Math.min(
        grid[i - 1][j] + 1,
        grid[i][j - 1] + 1,
        grid[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        grid[i][j] = Math.min(grid[i][j], grid[i - 2][j - 2] + 1);
    }
  return grid[a.length][b.length] <= limit ? grid[a.length][b.length] : Number.POSITIVE_INFINITY;
}

/** The nearest candidate to `word`: a unique prefix, or within a small edit distance. */
export function closest(word, candidates) {
  const wanted = word.replace(/^-+/, "");
  const names = [...new Set(candidates)];
  const strip = (name) => name.replace(/^-+/, "");
  const prefixed = names.filter((name) => wanted.length >= 3 && strip(name).startsWith(wanted));
  if (prefixed.length === 1) return prefixed[0];
  const limit = wanted.length <= 4 ? 1 : wanted.length <= 7 ? 2 : 3;
  let best = null;
  let bestDistance = limit + 1;
  for (const name of names) {
    const d = distance(wanted, strip(name), limit);
    if (d < bestDistance) [best, bestDistance] = [name, d];
  }
  return best;
}

/** Entries of the `--help` text: one per `  alliance-work COMMAND [SUB] ...` line. */
export function parseHelp(help) {
  const entries = [];
  let current = null;
  for (const line of help.split("\n")) {
    const start = /^ {2}alliance-work (\S.*)$/.exec(line);
    if (start) {
      const words = start[1].trim().split(/\s+/);
      const second = words[1];
      current = {
        command: words[0],
        subs: second && /^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/.test(second) ? second.split("|") : [],
        line: line.trimEnd(),
        flags: new Set(start[1].match(/--[a-z][a-z-]*/g) ?? []),
      };
      entries.push(current);
    } else if (current && /^ {4,}\S/.test(line))
      for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) current.flags.add(flag);
    else current = null;
  }
  return entries;
}

/**
 * @param {{ help: string, flags: Iterable<string>, valueFlags: Iterable<string> }} source the CLI's help
 *   text, every option it parses, and those that take a value
 */
export function cliHints({ help, flags, valueFlags }) {
  const entries = parseHelp(help);
  const commands = [...new Set(entries.map((entry) => entry.command))];
  const known = new Set(flags);
  const valued = new Set(valueFlags);

  /** The command and subcommand the caller meant, by position in argv (option values skipped). */
  function resolve(argv) {
    const words = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") break;
      if (valued.has(arg)) i++;
      else if (!arg.startsWith("-")) words.push(arg);
    }
    const command = commands.includes(words[0]) ? words[0] : null;
    const mine = entries.filter((entry) => entry.command === command);
    const sub = mine.some((entry) => entry.subs.includes(words[1])) ? words[1] : null;
    return { command, sub, given: words[1] ?? null, mine, path: sub ? `${command} ${sub}` : command };
  }

  const syntaxFor = ({ sub, mine }) => {
    const chosen = sub ? mine.filter((entry) => entry.subs.includes(sub)) : mine;
    return chosen.slice(0, 8).map((entry) => entry.line);
  };

  function explain(message, argv) {
    const text = String(message ?? "");
    try {
      return hint(text, resolve(argv));
    } catch {
      return text;
    }
  }

  function hint(text, ctx) {
    const extra = [];
    const lines = [];

    const unknownCommand = /^Unknown command (\S+?)\.?(\s|$)/.exec(text);
    const unknownOption = /^Unknown option (\S+)/.exec(text);
    if (unknownCommand) {
      const word = unknownCommand[1];
      if (word === "help") extra.push("Use `alliance-work --help` for every command's syntax.");
      else if (word === ctx.command && ctx.given && !ctx.sub) {
        // A real command whose dispatch matched no subcommand: the subcommand is what is wrong.
        const near = closest(
          ctx.given,
          ctx.mine.flatMap((entry) => entry.subs),
        );
        extra.push(
          `\`${word} ${ctx.given}\` is not a subcommand${near ? `; did you mean \`${word} ${near}\`?` : ""}`,
        );
        lines.push(...syntaxFor({ ...ctx, sub: near }));
      } else {
        const near = COMMAND_SYNONYMS[word] ?? closest(word, commands);
        if (near) {
          extra.push(`Did you mean \`${near}\`?`);
          lines.push(
            ...entries
              .filter((entry) => entry.command === near)
              .slice(0, 8)
              .map((e) => e.line),
          );
        } else extra.push(`Commands: ${commands.join(", ")}. \`alliance-work --help\` shows the syntax.`);
      }
    } else if (unknownOption) {
      const raw = unknownOption[1];
      const name = raw.split("=")[0];
      const mine = ctx.mine.filter((entry) => !ctx.sub || entry.subs.includes(ctx.sub));
      const own = new Set(mine.flatMap((entry) => [...entry.flags]));
      if (raw.includes("=") && known.has(name))
        extra.push(`Write \`${name} VALUE\` with a space; \`${name}=VALUE\` is not accepted.`);
      else {
        const pool = own.size ? own : known;
        const alias = Object.entries(SYNONYMS).find(
          ([target, words]) => words.includes(name) && pool.has(target),
        )?.[0];
        const near = alias ?? closest(name, [...pool]) ?? (own.size ? closest(name, [...known]) : null);
        if (near) extra.push(`Did you mean ${near}?`);
        else if (own.size) extra.push(`${ctx.path ?? ctx.command} takes: ${[...own].sort().join(" ")}`);
      }
      if (ctx.command) lines.push(...syntaxFor(ctx));
    } else if (CALL_ERROR.test(text) && ctx.command) {
      const typo = ctx.given && !ctx.sub && ctx.mine.some((entry) => entry.subs.length);
      if (typo && /^Usage:/.test(text)) {
        const all = ctx.mine.flatMap((entry) => entry.subs);
        const near = closest(ctx.given, all);
        extra.push(
          `\`${ctx.command} ${ctx.given}\` is not a subcommand${near ? `; did you mean \`${ctx.command} ${near}\`?` : ""}`,
        );
      }
      if (/^Missing value for (--\S+)/.test(text))
        extra.push(
          "An option that takes a value needs one right after it, and the value cannot start with --.",
        );
      // A message that already carries this command's full syntax needs no second copy.
      if (!text.includes(`alliance-work ${ctx.command} `)) lines.push(...syntaxFor(ctx));
    } else if (ctx.command) {
      for (const rule of REJECTIONS)
        if (rule.when.test(text)) {
          extra.push(typeof rule.hint === "function" ? rule.hint(ctx) : rule.hint);
          if (!/not valid JSON|Unexpected/.test(text)) lines.push(...syntaxFor(ctx));
          break;
        }
    }
    if (!extra.length && !lines.length) return text;
    return [text, ...(lines.length ? ["Syntax:", ...lines] : []), ...extra].join("\n");
  }

  return { explain, resolve, commands, entries };
}
