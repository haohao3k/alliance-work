import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { assertNoLinks, atomicWrite } from "./profiles.mjs";

export async function authSource(home) {
  const config = await readFile(join(home, "auth-source.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
  return config.codex?.path;
}

// Read only. The original Codex installation remains the owner of its OAuth lifecycle.
export async function readCodexAuth(path, now = Date.now()) {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077)
    throw new Error("Codex auth source must be a regular file readable only by its owner (chmod 600).");
  let data;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Cannot read Codex auth source. Run codex login in the original profile.");
  }
  if (data.auth_mode === "apikey" && typeof data.OPENAI_API_KEY === "string" && data.OPENAI_API_KEY)
    return { type: "apiKey", apiKey: data.OPENAI_API_KEY };
  const token = data.tokens?.access_token;
  const account = data.tokens?.account_id;
  if (typeof token !== "string" || typeof account !== "string" || !account)
    throw new Error("No usable ChatGPT auth in the source. Run codex login in the original profile.");
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    throw new Error("Codex source access token is malformed. Sign in again in the original profile.");
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 30000)
    throw new Error(
      "Codex source access token expired. Use the original Codex to refresh it, or run codex login there.",
    );
  return { type: "chatgptAuthTokens", accessToken: token, chatgptAccountId: account };
}

export async function setAuthSource(home, source) {
  if (!source) {
    await unlink(join(home, "auth-source.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return;
  }
  const path = resolve(source.endsWith(".json") ? source : join(source, "auth.json"));
  await readCodexAuth(path);
  await atomicWrite(join(home, "auth-source.json"), JSON.stringify({ codex: { path } }, null, 2) + "\n");
}

export async function authStatus(home) {
  const source = await authSource(home);
  if (!source) return { mode: "separate", ready: null };
  try {
    const credentials = await readCodexAuth(source);
    return { mode: "inherited", source, ready: true, type: credentials.type };
  } catch (error) {
    return { mode: "inherited", source, ready: false, error: error.message };
  }
}

// Only auth messages are handled here. Paseo owns every thread, turn, tool and permission.
// Tokens stay on the child's private stdin; neither the parent protocol nor logs receive them.
export function bridgeCodexAuth({
  child,
  source,
  input = /** @type {import("node:stream").Readable} */ (process.stdin),
  output = /** @type {import("node:stream").Writable} */ (process.stdout),
}) {
  const internalId = `alliance-auth-${randomUUID()}`;
  let closed = false;
  const toChild = (message) => {
    if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + "\n");
  };
  const toParent = (message) => {
    if (!closed && !output.destroyed) output.write(JSON.stringify(message) + "\n");
  };
  const client = createInterface({ input });
  const server = createInterface({ input: child.stdout });
  let initializeId,
    initializeResponse,
    lastCredentials,
    ready = false,
    timer;
  const queued = [];
  const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    client.close();
    server.close();
    child.stdin.end();
  };
  const fail = () => {
    if (initializeId !== undefined)
      toParent({
        id: initializeId,
        error: {
          code: -32001,
          message:
            "Alliance shared auth unavailable. Run alliance-work auth status; refresh the original Codex login.",
        },
      });
    stop();
    child.kill("SIGTERM");
  };
  client.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fail();
    }
    if (message.method === "initialize") {
      initializeId = message.id;
      message.params ??= {};
      message.params.capabilities = { ...message.params.capabilities, experimentalApi: true };
      timer = setTimeout(fail, 20000);
      toChild(message);
    } else if (message.method === "initialized") {
      // Sent to the native server immediately before the private auth handshake.
    } else if (["account/logout", "account/login/start", "account/login/cancel"].includes(message.method)) {
      toParent({
        id: message.id,
        error: {
          code: -32001,
          message:
            "Authentication is inherited. Manage login in the original Codex profile, or use alliance-work auth codex --separate.",
        },
      });
    } else if (ready) toChild(message);
    else queued.push(message);
  });
  server.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fail();
    }
    if (message.id === internalId) {
      if (message.error) return fail();
      clearTimeout(timer);
      ready = true;
      toParent(initializeResponse);
      for (const request of queued.splice(0)) toChild(request);
    } else if (initializeId !== undefined && message.id === initializeId && !ready && !message.method) {
      if (message.error) {
        toParent(message);
        return stop();
      }
      initializeResponse = message;
      toChild({ method: "initialized" });
      readCodexAuth(source)
        .then((credentials) => {
          lastCredentials = credentials;
          toChild({ id: internalId, method: "account/login/start", params: credentials });
        })
        .catch(fail);
    } else if (message.method === "account/chatgptAuthTokens/refresh") {
      readCodexAuth(source)
        .then((credentials) => {
          if (
            credentials.type !== "chatgptAuthTokens" ||
            credentials.chatgptAccountId !== lastCredentials?.chatgptAccountId ||
            fingerprint(credentials) === fingerprint(lastCredentials)
          )
            throw new Error("Source has not refreshed, or changed account.");
          lastCredentials = credentials;
          const { type: _type, ...result } = credentials;
          toChild({ id: message.id, result });
        })
        .catch(() =>
          toChild({
            id: message.id,
            error: {
              code: -32001,
              message:
                "Refresh the original Codex login, then resume this agent. Alliance does not rotate shared refresh tokens.",
            },
          }),
        );
    } else toParent(message);
  });
  child.stdin.on("error", stop);
  input.on("end", stop);
  child.on("exit", stop);
  child.on("error", stop);
  return stop;
}
