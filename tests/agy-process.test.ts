import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

for (const scenario of ["stop", "startup", "probe"]) {
  test(`AGY ${scenario} cleanup reports denied signals without crashing its host`, () => {
    const script = `
      import assert from 'node:assert/strict';
      import { startDriver, probe } from './server/agy-native/internal/process.ts';
      const scenario = ${JSON.stringify(scenario)};
      const kill = process.kill;
      process.kill = (pid, signal) => {
        if (pid < 0) throw Object.assign(new Error('synthetic signal denial'), {code: 'EPERM'});
        return kill(pid, signal);
      };
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 10000 ? 30 : ms, ...args);
      const child = scenario === 'stop'
        ? "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{});console.log(JSON.stringify({event:'init',conversation_id:'fixture',init:{model:null}}));setTimeout(()=>process.exit(0),1300)"
        : "console.log('{}');setTimeout(()=>process.exit(0),250)";
      const launch = {command:process.execPath,args:['-e',child,'--'],env:process.env};
      if (scenario === 'probe') {
        await assert.rejects(probe({launch,args:[]}), {code:'EPERM'});
      } else {
        const driver = startDriver({launch,config:{cwd:process.cwd(),env:{}},conversationId:null,onFrame(){},onExit(){}});
        if (scenario === 'startup') await assert.rejects(driver.ready, /Invalid Antigravity output/);
        else await driver.ready;
        await assert.rejects(driver.stop('close'), {code:'EPERM'});
      }
      await new Promise(resolve=>timer(resolve,350));
      console.log('host survived; cleanup was not reported successful');
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.match(output, /host survived; cleanup was not reported successful/);
  });
}
