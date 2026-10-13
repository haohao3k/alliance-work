// Maps actual behavioral test execution to the shipped feature contract.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const { check } = await import(process.env.ALLIANCE_ASSERTION_HELPER);
const cases = JSON.parse(await readFile(new URL("./verification-cases.json", import.meta.url), "utf8"));
const id = process.argv[2];
const spec = cases[id];
if (!spec) throw new Error(`Unknown contract: ${id}`);
await check(id, async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=tap", `--test-name-pattern=${spec.pattern}`, spec.file],
    { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
  );
  process.stdout.write(result.stdout);
  // A renamed/missing test must not become a false green zero-test run.
  assert.match(result.stdout, /# pass [1-9][0-9]*/);
  assert.match(result.stdout, /# fail 0\b/);
});
