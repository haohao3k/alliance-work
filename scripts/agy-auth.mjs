import { lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertNoLinks, atomicWrite } from "./profiles.mjs";

// A dedicated Alliance login is shared only by linking the native credential file.
// No token bytes are copied or parsed; AGY remains responsible for OAuth refresh.
export async function setAgyAuthSource(home, path) {
  if (!isAbsolute(path)) throw new Error("AGY auth source must be an absolute native token path");
  await assertNoLinks(path);
  const info = await lstat(path);
  if (!info.isFile() || info.mode & 0o077) throw new Error("AGY auth source must be an owner-only file");
  await atomicWrite(join(home, "agy-auth-source.json"), `${JSON.stringify({ path }, null, 2)}\n`);
}

export async function linkAgyAuth(home, profile, { allowSourceLogin = false } = {}) {
  const config = join(home, "agy-auth-source.json");
  await assertNoLinks(config);
  const source = await readFile(config, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!source) return false;
  if (typeof source.path !== "string" || !isAbsolute(source.path)) throw new Error("Invalid AGY auth source");
  await assertNoLinks(source.path);
  const destination = join(profile.osHome, ".gemini/antigravity-cli/antigravity-oauth-token");
  const info = await lstat(source.path).catch((error) => {
    if (error.code === "ENOENT" && allowSourceLogin && resolve(source.path) === resolve(destination))
      return null;
    throw error;
  });
  if (!info) return true; // Native interactive login recreates its own credential after logout.
  if (!info.isFile() || info.mode & 0o077) throw new Error("AGY auth source must be an owner-only file");
  if (resolve(source.path) === resolve(destination)) return true;
  await assertNoLinks(dirname(destination));
  const existing = await lstat(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (existing.isSymbolicLink() && (await readlink(destination)) === source.path) return true;
    throw new Error("AGY role has separate credentials; refusing to replace them with shared Alliance login");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await symlink(source.path, destination).catch(async (error) => {
    if (error.code === "EEXIST" && (await readlink(destination).catch(() => null)) === source.path) return;
    throw error;
  });
  return true;
}
