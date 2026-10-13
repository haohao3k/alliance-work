// Internal subprocess of verify --map; every scenario gets a fresh assertion sink.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { loadFeatureMap } from "../server/coverage.mjs";
import { artifact, runVerification } from "../server/evidence.mjs";

const [map, selected, destination, inputJson, kind, target] = process.argv.slice(2);
const cwd = process.cwd();
const loaded = await loadFeatureMap(cwd, map, JSON.parse(selected));
const runs = [];
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
for (const scenario of loaded.scenarios) {
  if (controller.signal.aborted) break;
  const result = await runVerification({
    signal: controller.signal,
    cwd,
    output: join(dirname(destination), "scenarios", scenario.id),
    command: scenario.command.map((arg) => (arg === "$NODE" ? process.execPath : arg)),
    scenario: scenario.id,
    kind,
    target,
    inputs: [...new Set([...JSON.parse(inputJson), relative(cwd, loaded.path)])],
    assertionIds: scenario.assertions.map((a) => a.id),
    timeoutMs: scenario.timeoutMs ?? 600000,
  });
  runs.push({ scenario: scenario.id, report: await artifact(result.path) });
}
await mkdir(dirname(destination), { recursive: true });
await writeFile(
  destination,
  `${JSON.stringify({ map: await artifact(map), features: loaded.features, runs }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
