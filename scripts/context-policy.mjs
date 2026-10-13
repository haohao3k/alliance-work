import { fileURLToPath } from "node:url";

export const contextTokenLimit = 300_000;
export const piContextExtension = fileURLToPath(new URL("./pi-context-limit.mjs", import.meta.url));

// The native harness owns summarization and continuation. Apply the policy after
// caller arguments/environment so a saved 1M profile cannot undo it.
export function contextPolicy(harness, args, environment) {
  const env = { ...environment };
  args = [...args];
  if (harness === "codex") {
    args.push("-c", `model_auto_compact_token_limit=${contextTokenLimit}`);
    args.push("-c", 'model_auto_compact_token_limit_scope="total"');
  } else if (harness === "claude") {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextTokenLimit);
    env.DISABLE_AUTO_COMPACT = "0";
    env.DISABLE_COMPACT = "0";
  } else if (harness === "pi") {
    if (!args.includes(piContextExtension)) args.push("-e", piContextExtension);
  } else {
    throw new Error(`No verified context policy for harness: ${harness}`);
  }
  return { args, env };
}
