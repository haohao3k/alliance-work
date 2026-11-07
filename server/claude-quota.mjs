import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { credentialCommand } from "./claude-accounts.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

const Registry = z
  .object({
    version: z.literal(1),
    accounts: z
      .array(
        z
          .object({
            id: z.string().regex(/^[\w-]{1,40}$/),
            label: z.string().max(80),
            configDir: z.string().refine(isAbsolute),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

async function privateJson(path) {
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077) throw new Error("Private profile file required");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function quotaCredential(configDir, platform = process.platform, run = credentialCommand) {
  if (platform === "darwin") {
    const service = `Claude Code-credentials-${createHash("sha256").update(configDir).digest("hex").slice(0, 8)}`;
    const user = process.env.USER || userInfo().username;
    const account = /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
    try {
      const raw = await run("/usr/bin/security", [
        "find-generic-password",
        "-a",
        account,
        "-s",
        service,
        "-w",
      ]);
      const token = JSON.parse(raw).claudeAiOauth?.accessToken;
      if (typeof token === "string" && token) return token;
    } catch {
      /* Claude's documented file fallback stays within this exact profile. */
    }
  }
  try {
    const token = (await privateJson(join(configDir, ".credentials.json"))).claudeAiOauth?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

const Window = z.object({ utilization: z.number().finite(), resets_at: z.string().nullable().optional() });
const Usage = z.object({
  five_hour: Window.nullish(),
  seven_day: Window.nullish(),
  seven_day_opus: Window.nullish(),
  seven_day_omelette: Window.nullish(),
  limits: z.array(z.unknown()).nullish(),
});

const ScopedLimit = z.object({
  kind: z.string(),
  percent: z.number().finite().nullish(),
  resets_at: z.string().nullish(),
  scope: z
    .object({
      model: z.object({ display_name: z.string().nullish() }).nullish(),
      surface: z.object({ display_name: z.string().nullish() }).nullish(),
    })
    .nullish(),
});

export async function readQuotaRegistry(registry = join(homedir(), ".config/paseo/claude-accounts.json")) {
  let config;
  try {
    config = Registry.parse(await privateJson(registry));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, accounts: [] };
    throw new Error("Invalid Claude quota registry on this host; credential contents were not logged.");
  }
  if (
    new Set(config.accounts.map((a) => a.id)).size !== config.accounts.length ||
    new Set(config.accounts.map((a) => a.configDir)).size !== config.accounts.length
  )
    throw new Error("Claude quota registry contains duplicate accounts.");
  return config;
}

export async function claudeQuota({
  registry = join(homedir(), ".config/paseo/claude-accounts.json"),
  credential = quotaCredential,
  fetchApi = fetch,
  accountId = "",
} = {}) {
  const config = await readQuotaRegistry(registry);
  const accounts = await Promise.all(
    config.accounts
      .filter((account) => !accountId || account.id === accountId)
      .map(async ({ id, label, configDir }) => {
        const base = { id, label, windows: [] };
        try {
          const token = await credential(configDir);
          if (!token) return { ...base, error: "Login required in this profile." };
          const response = await fetchApi("https://api.anthropic.com/api/oauth/usage", {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "anthropic-beta": "oauth-2025-04-20",
            },
            signal: AbortSignal.timeout(10000),
          });
          if ([401, 403].includes(response.status))
            return { ...base, error: "Refresh this profile login to read quota." };
          if (!response.ok)
            return { ...base, error: `Quota request failed (${response.status}). Retry later.` };
          const usage = Usage.parse(await response.json());
          const windows = [];
          for (const [field, label] of [
            ["five_hour", "Session (5h)"],
            ["seven_day", "Weekly"],
            ["seven_day_opus", "Weekly · Opus"],
            ["seven_day_omelette", "Weekly · Omelette"],
          ]) {
            const window = usage[field];
            if (window)
              windows.push({ label, usedPct: window.utilization, resetsAt: window.resets_at ?? null });
          }
          for (const entry of usage.limits ?? []) {
            const parsed = ScopedLimit.safeParse(entry);
            if (!parsed.success) continue;
            const limit = parsed.data;
            const name = limit.scope?.model?.display_name ?? limit.scope?.surface?.display_name;
            if (limit.kind === "weekly_scoped" && name && typeof limit.percent === "number") {
              const label = `Weekly · ${limit.scope?.model?.display_name ? name : `Surface: ${name}`}`;
              const existing = windows.findIndex((w) => w.label === label);
              const window = { label, usedPct: limit.percent, resetsAt: limit.resets_at ?? null };
              if (existing >= 0) windows[existing] = window;
              else windows.push(window);
            }
          }
          return { ...base, windows, error: windows.length ? null : "No quota windows returned." };
        } catch {
          return { ...base, error: "Quota unavailable. Check this profile login and connectivity." };
        }
      }),
  );
  return { fetchedAt: new Date().toISOString(), accounts };
}
