import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { claudeAccountsState, importClaudeAccount, selectClaudeAccount } from "../server/claude-accounts.mjs";

async function readSecret() {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk;
      if (value.length > 8192) throw new Error("Credential input too large.");
    }
    return value.trim();
  }
  process.stderr.write("Claude setup-token (hidden): ");
  const silent = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const input = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    return (await input.question("")).trim();
  } finally {
    input.close();
    process.stderr.write("\n");
  }
}

export async function claudeAccountsCommand(home, args) {
  if (args[0] === "import" && args.length === 2) {
    await importClaudeAccount(home, args[1], await readSecret());
    return { stored: args[1], selectionChanged: false, runningProcessesChanged: false };
  }
  if (args[0] === "select" && args.length === 3) {
    const state = await claudeAccountsState(home);
    return selectClaudeAccount(home, args[1], args[2], state.revision);
  }
  if (args.length === 0 || (args[0] === "status" && args.length === 1)) return claudeAccountsState(home);
  throw new Error(
    "Usage: accounts status | accounts import 5x|20x (hidden prompt/stdin) | accounts select default|hq|supervisor|lead|peer|lens legacy|5x|20x|inherit. Never pass tokens as arguments.",
  );
}
