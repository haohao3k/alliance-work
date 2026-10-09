import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { authStatus, bridgeCodexAuth, readCodexAuth, setAuthSource } from "../scripts/auth.mjs";
import { temporary } from "./temp";

function cache(marker: string, expires = Date.now() + 3600000, account = "fixture-account") {
  const token = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(expires / 1000), marker })).toString("base64url")}.fixture`;
  return {
    auth_mode: "chatgpt",
    tokens: { access_token: token, refresh_token: "never-copy-this-fixture", account_id: account },
  };
}
type RpcMessage = {
  id?: string | number;
  method?: string;
  params: Record<string, unknown> & { capabilities?: { experimentalApi?: boolean } };
  result: { accessToken?: string };
  error: { code?: number };
};
function messages(stream: PassThrough) {
  const lines = createInterface({ input: stream });
  const queue: RpcMessage[] = [];
  let receiver: ((message: RpcMessage) => void) | undefined;
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (receiver) {
      const deliver = receiver;
      receiver = undefined;
      deliver(message);
    } else queue.push(message);
  });
  return {
    next: () =>
      new Promise<RpcMessage>((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error("protocol timeout")), 3000);
        receiver = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      }),
    close: () => lines.close(),
  };
}

test("inherited auth stays private while native protocol and source token rotation keep working", async () => {
  const dir = await temporary("alliance-auth-");
  const source = join(dir, "auth.json");
  const first = cache("first");
  await writeFile(source, JSON.stringify(first), { mode: 0o600 });
  await setAuthSource(join(dir, "alliance"), source);
  assert.equal((await authStatus(join(dir, "alliance"))).ready, true);
  assert(
    !(await readFile(join(dir, "alliance/auth-source.json"), "utf8")).includes(first.tokens.access_token),
  );
  const input = new PassThrough(),
    output = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => true,
  });
  const native = messages(child.stdin),
    parent = messages(output);
  const stop = bridgeCodexAuth({ child, source, input, output });
  const send = (stream: PassThrough, value: unknown) => stream.write(JSON.stringify(value) + "\n");
  try {
    send(input, { id: 10, method: "initialize", params: { clientInfo: { name: "paseo" } } });
    assert.equal((await native.next()).params.capabilities?.experimentalApi, true);
    send(child.stdout, { id: 10, result: { userAgent: "native" } });
    assert.equal((await native.next()).method, "initialized");
    const login = await native.next();
    assert.equal(login.method, "account/login/start");
    assert.equal(login.params.accessToken, first.tokens.access_token);
    assert(!("refresh_token" in login.params));
    send(child.stdout, { id: login.id, result: { type: "chatgptAuthTokens" } });
    assert.deepEqual(await parent.next(), { id: 10, result: { userAgent: "native" } });
    const request = {
      id: 11,
      method: "thread/start",
      params: { cwd: "/project", sandbox: "workspace-write" },
    };
    send(input, { method: "initialized" });
    send(input, request);
    assert.deepEqual(await native.next(), request);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), first);
    const next = cache("rotated-by-original-codex");
    await writeFile(source, JSON.stringify(next));
    send(child.stdout, {
      id: "refresh",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized" },
    });
    const refresh = await native.next();
    assert.equal(refresh.result.accessToken, next.tokens.access_token);
    assert(!("refresh_token" in refresh.result));
    send(child.stdout, {
      id: "stale",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "unauthorized" },
    });
    assert.equal((await native.next()).error.code, -32001);
    send(input, { id: 12, method: "account/logout" });
    assert.equal((await parent.next()).error.code, -32001);
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), next);
  } finally {
    stop();
    native.close();
    parent.close();
    input.destroy();
    output.destroy();
  }
});

test("expired inherited credentials fail explicitly instead of using a stale refresh token", async () => {
  const dir = await temporary("alliance-expired-");
  const path = join(dir, "auth.json");
  await writeFile(path, JSON.stringify(cache("expired", Date.now() - 1000)), { mode: 0o600 });
  await assert.rejects(readCodexAuth(path), /expired/);
});
