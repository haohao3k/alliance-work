import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DIMENSIONS, parseWindow, renderText, usageReport } from "../server/usage-report.mjs";

export const usageHelp = `alliance-work usage — read-only token, cache-hit and estimated cost report for this host

  alliance-work usage [--days N | --since DATE [--until DATE]] [--by provider,role,model,day,gap]
                      [--include-other] [--tz HOURS] [--pricing FILE] [--json]

Reads local Claude Code, Codex, agy and Pi logs (usage counters, model, time and ids only; never
conversation text) and Paseo agent records to attribute roles. Writes nothing and uses no network.
Default window is the last 7 days; dates are UTC. Cost is an estimate at public API list prices,
not an invoice. Override prices per model in <alliance home>/usage-pricing.json or with --pricing FILE.
Claude main chains include cold_wakes, rebuild_tokens and rebuild_usd estimates; --by gap groups
request gaps. Weekly friction reads retained room records; snapshot limits are shown in the report.
Wake sources summarize exact recorded marker episodes without guessing request attribution.
Locations: --home (Alliance home), --user-home, --paseo-home (repeat).
`;

const values = new Set([
  "--days",
  "--since",
  "--until",
  "--by",
  "--tz",
  "--pricing",
  "--home",
  "--user-home",
  "--paseo-home",
]);
const switches = new Set(["--json", "--include-other", "--help", "-h"]);

export async function usageCommand(args, env = process.env) {
  const flags = {};
  const paseoHomes = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (values.has(arg)) {
      if (args[i + 1] === undefined || args[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--paseo-home") paseoHomes.push(resolve(args[++i]));
      else flags[arg] = args[++i];
    } else if (switches.has(arg)) flags[arg] = true;
    else throw new Error(`Unknown usage option ${arg}; see alliance-work usage --help`);
  }
  if (flags["--help"] || flags["-h"]) return usageHelp;
  const by = (flags["--by"] ?? "provider,role").split(",").filter(Boolean);
  if (!by.length || new Set(by).size !== by.length || by.some((d) => !DIMENSIONS.includes(d)))
    throw new Error(`--by takes distinct names from ${DIMENSIONS.join(", ")}, separated by commas`);
  const tz = flags["--tz"] === undefined ? 0 : Number(flags["--tz"]);
  if (!Number.isFinite(tz) || Math.abs(tz) > 14)
    throw new Error("--tz is a UTC offset in hours, for example 7");
  if (flags["--days"] !== undefined && flags["--since"] !== undefined)
    throw new Error("Use --days or --since, not both");
  const report = await usageReport({
    userHome: resolve(flags["--user-home"] ?? homedir()),
    home: resolve(flags["--home"] ?? env.ALLIANCE_WORK_HOME ?? join(homedir(), ".alliance-work")),
    paseoHomes,
    ...parseWindow({ days: flags["--days"], since: flags["--since"], until: flags["--until"] }),
    by,
    tz,
    includeOther: Boolean(flags["--include-other"]),
    pricingFile: flags["--pricing"] ? resolve(flags["--pricing"]) : undefined,
  });
  if (
    report.friction.coverage.store_unavailable_reason?.startsWith("USAGE_SQLITE_NODE_UNSUPPORTED") ||
    Object.keys(report.coverage.agy.snapshot_failures).some((reason) =>
      reason.startsWith("USAGE_SQLITE_NODE_UNSUPPORTED"),
    )
  )
    process.exitCode = 2;
  return flags["--json"] ? JSON.stringify(report, null, 2) : renderText(report);
}
