import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createClaudeUsageSource } from "../server/claude-usage-source";
import { temporary } from "./temp";

test("native Usage discovery registers both profiles without exposing credentials or email", async () => {
  const dir = await temporary("alliance-usage-source-");
  const registry = join(dir, "accounts.json");
  const accounts = ["5x", "20x"].map((id) => ({ id, label: `Claude ${id}`, configDir: join(dir, id) }));
  await writeFile(registry, JSON.stringify({ version: 1, accounts }), { mode: 0o600 });
  const source = createClaudeUsageSource(registry);
  const discovered = await source.discover({ kind: "global" });
  assert.deepEqual(
    discovered.map((a) => ({ label: a.label, input: a.input })),
    [
      { label: "Claude 5x", input: { id: "5x" } },
      { label: "Claude 20x", input: { id: "20x" } },
    ],
  );
  assert.notEqual(discovered[0].key, discovered[1].key);
  assert.deepEqual(await source.discover({ kind: "session", provider: "codex", env: {} }), []);
  assert.deepEqual(await source.fetch({ id: "unknown" }), {
    status: "error",
    error: "This Claude profile is no longer registered on the host.",
  });
  await assert.rejects(source.fetch({ id: "5x", configDir: "/another/profile" }));
  await writeFile(registry, JSON.stringify({ version: 1, accounts: accounts.slice(1) }), { mode: 0o600 });
  assert.equal((await source.discover({ kind: "global" })).length, 1);
});
