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
export function managedDigest(profile, path, bytes) {
  if (nativeTrustFile(profile, path))
    return digest(bytes.toString().replace(codexTrust, "\n").trimEnd() + "\n");
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
