import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { claudeQuota, quotaCredential } from "../server/claude-quota.mjs";
import { temporary } from "./temp";

test("two profile quotas stay distinct, expire independently and never refresh credentials", async () => {
  const dir = await temporary("alliance-quota-");
  const registry = join(dir, "accounts.json");
  const accounts = ["5x", "20x"].map((id) => ({ id, label: `Claude ${id}`, configDir: join(dir, id) }));
  for (const account of accounts) {
    await mkdir(account.configDir);
    await writeFile(
      join(account.configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: `synthetic-${account.id}`, refreshToken: "never-redeem" },
      }),
      { mode: 0o600 },
    );
  }
  await writeFile(registry, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
  const before = await readFile(join(accounts[0].configDir, ".credentials.json"), "utf8");
  const calls: string[] = [];
  const result = await claudeQuota({
    registry,
    credential: (path: string) => quotaCredential(path, "linux"),
    fetchApi: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const token = new Headers(init?.headers).get("Authorization");
      if (token === "Bearer synthetic-20x") return new Response(null, { status: 401 });
      assert.equal(token, "Bearer synthetic-5x");
      return Response.json({
        five_hour: { utilization: 30, resets_at: null },
        seven_day: { utilization: 50 },
      });
    },
  });
  assert.equal(result.accounts[0].windows[0].usedPct, 30);
  assert.equal(result.accounts[0].error, null);
  assert.match(result.accounts[1].error!, /Refresh/);
  assert.equal(result.accounts[1].windows.length, 0);
  assert(calls.every((url) => url === "https://api.anthropic.com/api/oauth/usage"));
  assert.equal(await readFile(join(accounts[0].configDir, ".credentials.json"), "utf8"), before);
  assert(!JSON.stringify(result).includes("synthetic-"));
});

test("missing custom keychain credential cannot fall back to daily Keychain login", async () => {
  const path = await temporary("alliance-quota-empty-");
  const calls: string[][] = [];
  const result = await quotaCredential(path, "darwin", async (_command: string, args: string[]) => {
    calls.push(args);
    throw new Error("No selected item");
  });
  assert.equal(result, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0][calls[0].indexOf("-s") + 1], /^Claude Code-credentials-[a-f0-9]{8}$/);
});
