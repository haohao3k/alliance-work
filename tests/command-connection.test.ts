import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { prepareProfiles, projectRoot } from "../scripts/profiles.mjs";
import { temporary } from "./temp";

const execute = promisify(execFile);

test("an offline scheduler finishes its first round and can shut down", async () => {
  const home = await temporary("alliance-scheduler-connection-");
  const paseoHome = join(home, "paseo");
  await mkdir(paseoHome);
  await prepareProfiles({
    home,
    isolatedRoot: join(home, "roles"),
    executables: { codex: "/usr/bin/false", claude: "/usr/bin/false", pi: "/usr/bin/false" },
  });
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await writeFile(join(home, "installation.json"), JSON.stringify({ home, paseoHome }));
  await writeFile(
    join(paseoHome, "config.json"),
    JSON.stringify({ daemon: { listen: `127.0.0.1:${address.port}` } }),
  );
  const source = `
    import {AllianceRuntime} from ${JSON.stringify(new URL("../server/runtime.ts", import.meta.url).href)};
    const runtime = await new AllianceRuntime(process.argv[1]).ready();
    try {
      await runtime.startWakeups();
      console.log(JSON.stringify(runtime.wakeupHealth));
    } finally { await runtime.close(); }
  `;
  const { stdout } = await execute(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source, home],
    { cwd: projectRoot, timeout: 3000, env: { PATH: process.env.PATH, HOME: home } },
  );
  assert.match(JSON.parse(stdout).error, /native connection failed/);
});

for (const command of [["status"], ["models", "show"]]) {
  test(`CLI ${command.join(" ")} exits when the daemon refuses a connection`, async () => {
    const home = await temporary("alliance-connection-");
    const paseoHome = join(home, "paseo");
    await mkdir(paseoHome);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await writeFile(join(home, "installation.json"), JSON.stringify({ home, paseoHome }));
    await writeFile(
      join(paseoHome, "config.json"),
      JSON.stringify({ daemon: { listen: `127.0.0.1:${address.port}` } }),
    );
    await assert.rejects(
      execute(process.execPath, [join(projectRoot, "scripts/cli.mjs"), ...command, "--home", home], {
        timeout: 3000,
        env: { PATH: process.env.PATH, HOME: home },
      }),
      (error: Error & { code?: number; killed?: boolean; signal?: string }) => {
        assert.equal(error.killed, false, "a failed command must exit without a watchdog killing it");
        assert.equal(error.code, 1);
        return true;
      },
    );
  });
}
