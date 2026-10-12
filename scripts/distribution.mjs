import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

export const repository = "haohao3k/alliance-work";
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 300000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr?.trim().slice(0, 1500) ?? `exit ${result.status}`}`,
    );
  return result.stdout;
}
export function isNewerRelease(tag, current) {
  const parse = (version) => {
    const match =
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        version,
      );
    if (!match) throw new Error("Cannot compare release versions.");
    const parts = match.slice(1, 4).map(Number);
    if (parts.some((part) => !Number.isSafeInteger(part)))
      throw new Error("Cannot compare release versions.");
    return { parts, prerelease: match[4] };
  };
  const next = parse(tag),
    previous = parse(current);
  if (next.prerelease) throw new Error("Update target must be a stable release");
  const left = next.parts,
    right = previous.parts;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return Boolean(previous.prerelease);
}
export function releaseInfo(tag) {
  const args = ["release", "view", ...(tag ? [tag] : []), "--repo", repository, "--json", "tagName,url"];
  try {
    const release = JSON.parse(run("gh", args));
    if (!/^v\d+\.\d+\.\d+$/.test(release.tagName))
      throw new Error("Expected a stable vMAJOR.MINOR.PATCH release.");
    return release;
  } catch (error) {
    if (/release not found/i.test(error.message)) return null;
    throw error;
  }
}
export function verifyChecksum(bytes, checksums, name) {
  const matches = checksums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1]?.replace(/^\*/, "") === name);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (matches.length !== 1 || matches[0][0] !== actual)
    throw new Error(`Checksum mismatch for ${name}; installation unchanged.`);
  return actual;
}
export async function downloadRelease(home, release) {
  const releases = join(home, "releases");
  const stage = join(releases, `.download-${randomUUID()}`);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const name = `alliance-work-${release.tagName}.tar.gz`;
  try {
    run("gh", [
      "release",
      "download",
      release.tagName,
      "--repo",
      repository,
      "--dir",
      stage,
      "--pattern",
      name,
      "--pattern",
      "checksums.txt",
    ]);
    const hash = verifyChecksum(
      await readFile(join(stage, name)),
      await readFile(join(stage, "checksums.txt"), "utf8"),
      name,
    );
    const entries = run("tar", ["-tzf", join(stage, name)])
      .trim()
      .split("\n");
    if (entries.some((path) => !path.startsWith("alliance-work/") || path.split("/").includes("..")))
      throw new Error("Release archive has an unexpected path.");
    if (
      run("tar", ["-tvzf", join(stage, name)])
        .trim()
        .split("\n")
        .some((line) => !["d", "-"].includes(line[0]))
    )
      throw new Error("Release archives must contain ordinary files and directories only.");
    run("tar", ["-xzf", join(stage, name), "-C", stage]);
    const root = join(stage, "alliance-work");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (`v${pkg.version}` !== release.tagName || pkg.name !== "alliance-work")
      throw new Error("Release version/package mismatch.");
    // Candidate checks happen before active profiles, source or Paseo configuration change.
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
    run("npm", ["run", "check"], { cwd: root, stdio: "inherit" });
    const target = join(releases, `${release.tagName}-${hash.slice(0, 12)}-${Date.now()}`);
    await rename(root, target);
    return target;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
