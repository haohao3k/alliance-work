import { readFile } from "node:fs/promises";

const SOURCES = new Set([
  "alliance.wakeup",
  "alliance.retry",
  "alliance.continue",
  "alliance.resume",
  "alliance.account-switch",
  "native.agent-message",
  "native.notification",
  "native.plain",
  "unknown",
]);
const PROVIDERS = new Set(["claude", "codex", "agy", "pi"]);
export async function collectWakeMarkers({ file, since, until }) {
  const report = {
    available: false,
    basis:
      "Exact recorded turn episodes, refined by later readback; not joined to token requests because transcript linkage is unverified. native.plain does not identify a Human. No time-only attribution.",
    turns: 0,
    by_source: /** @type {Array<{provider: string, source: string, turns: number}>} */ ([]),
    coverage: { bad_records: 0, unreadable_files: 0, duplicate_markers_folded: 0 },
  };
  let body;
  try {
    body = await readFile(file, "utf8");
    report.available = true;
  } catch (error) {
    if (error.code !== "ENOENT") report.coverage.unreadable_files++;
    return report;
  }
  const episodes = new Map();
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      report.coverage.bad_records++;
      continue;
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      report.coverage.bad_records++;
      continue;
    }
    const time = typeof m.time === "number" ? m.time : typeof m.time === "string" ? Date.parse(m.time) : NaN;
    const provider = /^alliance-(claude|codex|agy|pi)-/.exec(m.provider)?.[1] ?? m.provider;
    if (
      !PROVIDERS.has(provider) ||
      typeof m.agentId !== "string" ||
      !m.agentId ||
      typeof m.turnId !== "string" ||
      !m.turnId ||
      !Number.isFinite(time)
    ) {
      report.coverage.bad_records++;
      continue;
    }
    if (time < since || time >= until) continue;
    const source = SOURCES.has(m.source) ? m.source : "unknown";
    const key = JSON.stringify([m.agentId, m.turnId, time]);
    const previous = episodes.get(key);
    if (previous) report.coverage.duplicate_markers_folded++;
    if (!previous || source !== "unknown") episodes.set(key, { provider, source });
  }
  const groups = new Map();
  for (const { provider, source } of episodes.values()) {
    const key = `${provider}\0${source}`;
    const g = groups.get(key) ?? { provider, source, turns: 0 };
    g.turns++;
    groups.set(key, g);
  }
  report.turns = episodes.size;
  report.by_source = [...groups.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source),
  );
  return report;
}
