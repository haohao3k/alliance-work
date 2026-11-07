// Opt-in real-agent contextual naming during two small coding tasks, never on a daily daemon.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { commandClient } from "./command-client.mjs";
import { activate } from "./maintenance.mjs";
import { instanceState, paseo, requireIdle } from "./paseo.mjs";

process.umask(0o077);
if (!process.argv[2] || !process.argv[3])
  throw Error("Usage: node scripts/acceptance-naming.mjs NEW_OUTPUT CODEX_AUTH_SOURCE");
const output = resolve(process.argv[2]),
  home = join(output, "home"),
  paseoHome = join(output, "paseo"),
  cwd = join(output, "checkout");
await mkdir(output, { recursive: false });
await mkdir(cwd);
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
const receipt = { model: "gpt-6-astra", effort: "medium", turns: [], passed: false, cleanup: false };
let client, api, agent;
try {
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom: process.argv[3],
  });
  client = commandClient({ url: `ws://127.0.0.1:${port}/ws`, clientId: "contextual-naming-acceptance" });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(cwd);
  agent = await workspace.agents.create({
    config: {
      provider: "alliance-codex-lead/gpt-6-astra",
      thinkingOptionId: "medium",
      modeId: "full-access",
    },
  });
  // Deliberately no rename command in the task: the standing policy must guide the agent.
  const prompts = [
    "You are the sole accountable owner of this disposable workspace. The product is BrightCart. Implement price.mjs exporting formatPrice(cents): accept only nonnegative integer cents; return USD text such as $0.00 and $12.34; throw RangeError on invalid input. Add and execute tests. Work only in this project, use no network, do not delegate, and finish with a concise result. This is a small coding acceptance fixture; no production deployment or acceptance paperwork is needed.",
    "The price helper is finished; retain it unchanged. Our current BrightCart objective is now refund accounting. Implement refund.mjs exporting refundTotal(entries): sum nonnegative integer cents from an array, returning 0 for an empty array, and throw RangeError on negative, fractional or nonnumeric entries. Add and execute tests. Keep this bounded to the fixture; do not delegate or use the network. Finish with a concise result.",
  ];
  for (let index = 0; index < prompts.length; index++) {
    const turn = await agent.run(prompts[index], { timeoutMs: 240000 });
    await writeFile(join(output, `turn-${index + 1}.json`), JSON.stringify(turn, null, 2));
    assert.equal(turn.status, "idle");
    const snapshot = (await agent.refresh()).agent,
      nativeWorkspace = await workspace.refresh();
    assert.equal(snapshot.model, "gpt-6-astra");
    assert.equal(snapshot.thinkingOptionId, "medium");
    assert.match(snapshot.title, /^\[lead\] \[BrightCart\] .+/u);
    assert.match(nativeWorkspace.title, /^\[(?:lead|team)\] \[BrightCart\] .+/u);
    const feature = index ? /refund|account|ledger/iu : /price|pricing|currency/iu;
    assert.match(snapshot.title, feature);
    assert.match(nativeWorkspace.title, feature);
    const check = index
      ? 'import assert from "node:assert/strict";import {refundTotal} from "./refund.mjs";assert.equal(refundTotal([]),0);assert.equal(refundTotal([125,75]),200);for(const x of [-1,1.1,"2"])assert.throws(()=>refundTotal([x]),RangeError);'
      : 'import assert from "node:assert/strict";import {formatPrice} from "./price.mjs";assert.equal(formatPrice(0),"$0.00");assert.equal(formatPrice(1234),"$12.34");for(const x of [-1,1.1,"2"])assert.throws(()=>formatPrice(x),RangeError);';
    execFileSync(process.execPath, ["--input-type=module", "-e", check], { cwd, stdio: "pipe" });
    receipt.turns.push({
      sessionTitle: snapshot.title,
      workspaceTitle: nativeWorkspace.title,
      codingAssertions: "PASS",
    });
    console.log(JSON.stringify({ phase: `turn-${index + 1}`, ...receipt.turns.at(-1) }));
    await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  }
  assert.notEqual(receipt.turns[0].sessionTitle, receipt.turns[1].sessionTitle);
  assert.notEqual(receipt.turns[0].workspaceTitle, receipt.turns[1].workspaceTitle);
  receipt.passed = true;
} finally {
  if (agent) {
    const snapshot = (await agent.refresh())?.agent;
    if (snapshot && !["idle", "closed", "error"].includes(snapshot.status))
      await client.cancelAgent(agent.id);
    await agent.detach();
    await agent.archive();
  }
  if (api) await api.dispose();
  if (client) await client.close();
  if ((await instanceState(paseoHome))?.localDaemon === "running") {
    requireIdle(paseoHome);
    paseo(["daemon", "stop"], paseoHome);
  }
  receipt.cleanup = true;
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
}
