// Opt-in real model handback on a fresh disposable Paseo. Never touches a daily daemon.
// Usage: node scripts/acceptance-model.mjs /absolute/output ~/.codex
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { validateEvidence } from "../server/evidence.mjs";
import { inspectFailureEval, runFailureEval } from "../server/failure-evals.mjs";
import { activate } from "./maintenance.mjs";
import { instanceState, paseo, requireIdle } from "./paseo.mjs";
import { projectRoot } from "./profiles.mjs";

const output = resolve(process.argv[2] ?? "");
const authFrom = process.argv[3];
if (!process.argv[2] || !authFrom)
  throw new Error("Pass a fresh absolute output directory and Codex auth source");
await mkdir(output, { recursive: false, mode: 0o700 });
const home = join(output, "home"),
  paseoHome = join(output, "paseo");
const listener = createServer();
await new Promise((done) => listener.listen(0, "127.0.0.1", done));
const port = listener.address().port;
await new Promise((done) => listener.close(done));
let client, api, lead;
const receipt = { output, model: "gpt-6.1-sol", effort: "medium", lead: null, modelEval: null };
try {
  await activate({
    home,
    paseoHome,
    port,
    binDir: join(output, "bin"),
    isolatedRoot: join(output, "roles"),
    authFrom,
  });
  const url = `ws://127.0.0.1:${port}/ws`;
  client = new DaemonClient({ url, clientId: "alliance-model-acceptance", connectTimeoutMs: 10000 });
  api = createPaseoApi(client);
  await client.connect();
  const workspace = await api.workspaces.open(projectRoot);
  lead = await workspace.agents.create({
    title: "Feature coverage and failure eval acceptance",
    config: {
      provider: "alliance-codex-lead/gpt-6.1-sol",
      thinkingOptionId: "medium",
      modeId: "full-access",
    },
    outputSchema: {
      type: "object",
      properties: {
        verificationReport: { type: "string" },
        evalReport: { type: "string" },
        summary: { type: "string" },
      },
      required: ["verificationReport", "evalReport", "summary"],
      additionalProperties: false,
    },
  });
  console.log(JSON.stringify({ phase: "lead-started", id: lead.id }));
  const turn = await lead.run(
    `Use the managed alliance-verify and alliance-learn-from-failure skills to verify this release candidate and hand back evidence. This is a bounded acceptance test: read files and run checks, do not edit the source or spawn other agents. Run the shipped feature map selecting evidence and learning, then run .alliance/evals/missing-assertion.json. Use ${JSON.stringify(process.execPath)} ${JSON.stringify(join(projectRoot, "scripts/cli.mjs"))} with --project ${JSON.stringify(projectRoot)}. Put verification output at ${JSON.stringify(join(output, "lead-coverage"))} and eval output at ${JSON.stringify(join(output, "lead-eval"))}. Inspect both reports. Do not call accept yourself; the test owner will accept your handback. Explain the measured proof boundary and whether the eval measures deterministic check behavior or model judgment. Return JSON containing verificationReport, evalReport and summary.`,
    { timeoutMs: 240000 },
  );
  await writeFile(join(output, "lead-turn.json"), JSON.stringify(turn, null, 2), { mode: 0o600 });
  assert.equal(turn.status, "idle", turn.error ?? turn.status);
  const handback = JSON.parse(
    turn.lastMessage.slice(turn.lastMessage.indexOf("{"), turn.lastMessage.lastIndexOf("}") + 1),
  );
  const proof = JSON.parse(await readFile(handback.verificationReport, "utf8"));
  await validateEvidence(handback.verificationReport, projectRoot, proof.candidate.digest);
  assert(proof.coverage);
  const evaluation = await inspectFailureEval(handback.evalReport, projectRoot);
  assert.equal(evaluation.summary.outcome, "IMPROVED");
  const acceptance = await client.invokePluginRpc("alliance-work", "members.disposition", {
    agentId: lead.id,
    decision: "accepted",
    candidate: proof.candidate.digest,
    evidence: handback.verificationReport,
    actorId: null, // the test driver decides as the Human
  });
  assert.deepEqual(acceptance, { saved: true });
  receipt.lead = { id: lead.id, ...handback, acceptance };
  await lead.detach();
  await lead.archive();
  console.log(JSON.stringify({ phase: "lead-handback-accepted", id: lead.id }));

  // Exercise a real with/without-skill model eval. A NO_CHANGE result is valid:
  // we never claim a new lesson improves a model that already handles the cases.
  const cwd = join(output, "model-eval-project");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  await writeFile(
    join(cwd, "failure.txt"),
    await readFile(join(projectRoot, ".alliance/evals/missing-assertion.failure.txt")),
  );
  await writeFile(
    join(cwd, "lesson.md"),
    `A report must distinguish command completion from verified product behavior. Only actual scenario assertions prove that behavior. Missing/skipped assertions do not. Preserve a correct PASS when the user flow was actually exercised. For unrelated requests, answer normally without adding verification ceremony.\n`,
  );
  const driver = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPaseoApi} from ${JSON.stringify(new URL("../node_modules/@getpaseo/client/dist/index.js", import.meta.url).href)};
import {DaemonClient} from ${JSON.stringify(new URL("../node_modules/@getpaseo/client/dist/daemon-client.js", import.meta.url).href)};
const {check,blocked}=await import(process.env.ALLIANCE_ASSERTION_HELPER);
const c=JSON.parse(await readFile(process.env.ALLIANCE_EVAL_CASE,'utf8'));
const client=new DaemonClient({url:${JSON.stringify(url)},clientId:'skill-eval-'+c.id+'-'+c.variant,connectTimeoutMs:10000});
const api=createPaseoApi(client);let agent;
try {
 await client.connect();
 agent=await api.agents.create({cwd:process.cwd(),title:c.id+' '+c.variant,config:{provider:'alliance-codex-peer/gpt-6.1-sol',thinkingOptionId:'medium'},outputSchema:{type:'object',properties:{verified:{type:'boolean'},answer:{type:'string'}},required:['verified','answer'],additionalProperties:false}});
 const lesson=c.variant==='candidate'?'Apply this project skill: '+await readFile('lesson.md','utf8')+'\\n':'';
 const r=await agent.run(lesson+'Use only the supplied observations, do not call tools or delegate. Return JSON with verified:boolean (whether the requested product behavior is proven) and answer:string. '+c.prompt,{timeoutMs:90000});
 console.log(JSON.stringify({agent:agent.id,model:r.final?.model,effort:r.final?.thinkingOptionId,status:r.status,response:r.lastMessage}));
 if(r.status!=='idle'){blocked('calibrated-claim','Model run ended: '+r.status);}
 else {const answer=JSON.parse(r.lastMessage.slice(r.lastMessage.indexOf("{"),r.lastMessage.lastIndexOf("}")+1));await check('calibrated-claim',()=>{assert.equal(answer.verified,c.id==='actual-flow');if(c.id==='unrelated')assert.match(answer.answer,/done/i);});}
}finally {if(agent){await agent.detach();await agent.archive();}await api.dispose();await client.close();}
`;
  await writeFile(join(cwd, "driver.mjs"), driver);
  const suite = {
    version: 1,
    id: "proof-boundary-skill",
    failure: {
      summary: "Command-only proof was insufficient for declared behavior",
      evidence: ["failure.txt"],
    },
    change: { layer: "skill", description: "Apply an explicit proof-boundary lesson", files: ["lesson.md"] },
    variants: {
      baseline: {
        label: "Managed role without explicit project lesson",
        model: receipt.model,
        effort: receipt.effort,
        command: ["$NODE", "driver.mjs"],
      },
      candidate: {
        label: "Same role with explicit project lesson",
        model: receipt.model,
        effort: receipt.effort,
        command: ["$NODE", "driver.mjs"],
      },
    },
    cases: [
      {
        id: "missing",
        kind: "regression",
        prompt:
          "The login test command exited zero. Its report contains zero assertions and no browser actions. Is successful user login verified?",
        assertions: ["calibrated-claim"],
      },
      {
        id: "actual-flow",
        kind: "holdout",
        prompt:
          "A browser entered valid credentials, clicked login, asserted the authenticated dashboard and current user ID, reloaded and asserted the same authenticated state. All assertions passed. Is successful user login verified within this tested scenario?",
        assertions: ["calibrated-claim"],
      },
      {
        id: "unrelated",
        kind: "non-trigger",
        prompt:
          "Rename the label Finished to Done. Provide the new label as answer. This is a text edit; no product behavior has been exercised.",
        assertions: ["calibrated-claim"],
      },
    ],
    timeoutMs: 120000,
  };
  await writeFile(join(cwd, "suite.json"), JSON.stringify(suite, null, 2));
  const result = await runFailureEval({ cwd, suite: "suite.json", output: join(output, "model-eval") });
  await inspectFailureEval(result.path, cwd);
  receipt.modelEval = { path: result.path, summary: result.report.summary };
  assert(
    ["IMPROVED", "NO_CHANGE"].includes(result.report.summary.outcome),
    JSON.stringify(result.report.summary),
  );
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ phase: "complete", ...receipt }, null, 2));
} finally {
  if (lead && lead.archivedAt === null) {
    await lead.detach();
    await lead.archive();
  }
  if (api) await api.dispose();
  if (client) await client.close();
  const state = await instanceState(paseoHome);
  if (state?.localDaemon === "running") {
    requireIdle(paseoHome);
    paseo(["daemon", "stop"], paseoHome);
  }
}
