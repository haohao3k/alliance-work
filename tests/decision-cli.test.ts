import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

test("Human attribution refuses older plugins before recording a decision and confirms upgraded plugins", async () => {
  const home = await temporary("alliance-decision-cli-");
  const paseoHome = join(home, "paseo");
  await mkdir(paseoHome);
  await writeFile(join(home, "installation.json"), JSON.stringify({ version: "0.0.0", paseoHome }));
  await writeFile(join(paseoHome, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:9" } }));
  // Replace the client boundary only: the actual CLI parses options, opens the installation and invokes RPCs.
  const loader = join(home, "loader.mjs");
  await writeFile(
    loader,
    `export async function resolve(specifier, context, next) {
    if (specifier === './command-client.mjs') return { url: new URL('./client.mjs', import.meta.url).href, shortCircuit: true };
    return next(specifier, context);
  }`,
  );
  await writeFile(
    join(home, "client.mjs"),
    `import { appendFileSync } from 'node:fs';
    export function commandClient() { return {
      connect: async () => {}, close: async () => {},
      invokePluginRpc: async (plugin, method, input) => {
        appendFileSync(process.env.DECISION_CLI_CALLS, JSON.stringify({ plugin, method, input }) + '\\n');
        if (method === 'maintenance.status' && process.env.DECISION_CLI_CAPABILITY === 'unavailable') throw new Error('Unknown plugin RPC');
        if (method === 'maintenance.status') return { durablePause: true, hold: null,
          ...(process.env.DECISION_CLI_CAPABILITY === 'missing' ? {} : { humanDecisionAttribution: process.env.DECISION_CLI_CAPABILITY === 'true' }) };
        return process.env.DECISION_CLI_POSTFLIGHT === 'old' ? { saved: true } : { saved: true, authorizedBy: 'Human', source: input.source };
      }
    }; }`,
  );
  const timestamp = "2026-11-14T08:00:00.000Z";
  for (const [capability, postflight] of [
    ["unavailable", "new"],
    ["missing", "new"],
    ["false", "new"],
    ["true", "new"],
    ["true", "old"],
  ]) {
    const callsPath = join(home, `calls-${capability}-${postflight}.jsonl`);
    await writeFile(callsPath, "");
    const result = spawnSync(
      process.execPath,
      [
        "--loader",
        loader,
        join(projectRoot, "scripts/cli.mjs"),
        "reject",
        "--agent",
        "peer",
        "--reason",
        "Revise",
        "--for-human",
        "--source",
        "native-id",
        "--at",
        timestamp,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ALLIANCE_WORK_HOME: home,
          PASEO_AGENT_ID: "hq",
          DECISION_CLI_CALLS: callsPath,
          DECISION_CLI_CAPABILITY: capability,
          DECISION_CLI_POSTFLIGHT: postflight,
        },
      },
    );
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(calls[0]?.method, "maintenance.status");
    const decisions = calls.filter((call) => call.method === "members.disposition");
    if (capability !== "true") {
      assert.notEqual(result.status, 0);
      assert.equal(decisions.length, 0, "an older plugin must never receive the mutating request");
      assert.match(result.stderr, /plugin.*Human attribution/i);
    } else {
      if (postflight === "old") {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /decision was recorded.*did not confirm Human attribution/);
      } else assert.equal(result.status, 0, result.stderr);
      assert.equal(decisions.length, 1);
      assert.deepEqual(decisions[0].input, {
        agentId: "peer",
        decision: "rejected",
        candidate: "handback",
        evidence: "Revise",
        actorId: "hq",
        forHuman: true,
        source: { messageId: "native-id", timestamp },
      });
    }
  }
});
