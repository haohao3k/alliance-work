import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Native metadata only: this never creates a thread or starts a model turn.
export async function discoverCodex(executable, env, cwd, configArgs = []) {
  const child = spawn(executable, ["--no-daemon", ...configArgs, "app-server"], {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let serial = 0;
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      message.error
        ? entry.reject(new Error(`Codex metadata ${message.error.code}`))
        : entry.resolve(message.result);
    }
  });
  const fail = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("Codex metadata process exited")));
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 15000);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(JSON.stringify({ id, jsonrpc: "2.0", method, params }) + "\n");
    });
  try {
    await request("initialize", {
      clientInfo: { name: "alliance-home-check", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"jsonrpc":"2.0","method":"initialized","params":{}}\n');
    const config = await request("config/read", { cwd, includeLayers: false });
    const result = await request("skills/list", { cwds: [cwd], forceReload: true });
    return { config: config.config, skills: result.data.flatMap((entry) => entry.skills) };
  } finally {
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}
