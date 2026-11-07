import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Native Codex records per-project trust after an approved interaction. Preserve only these
// native trust tables; every other managed config change still requires reconciliation.
export const codexTrust =
  /(?:^|\n)[ \t]*\[projects\.(?:"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')\][ \t]*\r?\n[ \t]*trust_level[ \t]*=[ \t]*"(?:trusted|untrusted)"[ \t]*(?:\r?\n|$)/g;
export function nativeTrustFile(profile, path) {
  return profile.harness === "codex" && path === join(profile.home, "config.toml");
}
// Pi writes these preferences during normal use, including its first startup. Loading and
// isolation settings remain managed: packages, extensions, MCP and compaction cannot drift.
const piPreferences = [
  "lastChangelogVersion",
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "theme",
];
export function nativePiSettingsFile(profile, path) {
  return profile.harness === "pi" && path === join(profile.home, "settings.json");
}
export function preservePiPreferences(managed, current) {
  const settings = JSON.parse(managed.toString());
  const previous = JSON.parse(current.toString());
  for (const key of piPreferences) if (key in previous) settings[key] = previous[key];
  return JSON.stringify(settings, null, 2) + "\n";
}
export function managedDigest(profile, path, bytes) {
  if (nativeTrustFile(profile, path))
    return digest(bytes.toString().replace(codexTrust, "\n").trimEnd() + "\n");
  if (nativePiSettingsFile(profile, path)) {
    const settings = JSON.parse(bytes.toString());
    for (const key of piPreferences) delete settings[key];
    return digest(JSON.stringify(settings, null, 2) + "\n");
  }
  return digest(bytes);
}
export async function assertNoLinks(path) {
  const full = resolve(path);
  for (let current = full; current !== dirname(current); current = dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink is not an Alliance home: ${current}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
export async function verifyProfile(profile) {
  await assertNoLinks(profile.home);
  await assertNoLinks(profile.osHome);
  for (const [path, expected] of Object.entries(profile.files)) {
    await assertNoLinks(path);
    if (managedDigest(profile, path, await readFile(path)) !== expected)
      throw new Error(`Managed profile file changed: ${path}. Reconcile before launch.`);
  }
  // A new untracked skill must not silently become part of an existing role.
  const known = new Set(profile.skillDirectories);
  for (const item of await readdir(join(profile.home, "skills"), { withFileTypes: true })) {
    if (item.name === ".system" && profile.harness === "codex") continue;
    const path = join(profile.home, "skills", item.name);
    if (item.isSymbolicLink() || !known.has(path)) throw new Error(`Unmanaged skill in role home: ${path}`);
  }
}
