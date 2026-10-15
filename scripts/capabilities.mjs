import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const required = {
  "context-300k": ["scripts/context-policy.mjs", "scripts/pi-context-limit.mjs"],
  "feature-coverage": [
    "server/feature-verification.mjs",
    "server/assertions.mjs",
    "server/coverage.mjs",
    ".alliance/features.json",
  ],
  "failure-learning": ["server/failure-evals.mjs", "room/skills/alliance-learn-from-failure/SKILL.md"],
  operations: ["server/jobs.mjs", "shared/operations.ts"],
};
const roots = [
  "package.json",
  "package-lock.json",
  "paseo-plugin.json",
  "index.server.ts",
  "index.client.tsx",
  "scripts",
  "server",
  "shared",
  "client",
  "room",
  "vendor/seatwork",
  ".alliance",
];

// Source identity excludes mutable dependencies, evidence and operator data.
export async function sourceIdentity(root) {
  const files = [];
  async function walk(relative) {
    const stat = await lstat(join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Source identity refuses symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(join(root, relative))).sort()) await walk(`${relative}/${entry}`);
    } else if (stat.isFile()) files.push(relative);
    else throw new Error(`Unsupported source entry: ${relative}`);
  }
  for (const path of roots) await walk(path);
  const digest = createHash("sha256");
  for (const path of files.sort()) {
    const bytes = await readFile(join(root, path));
    digest.update(`${path}\0${bytes.length}\0`).update(bytes);
  }
  return digest.digest("hex");
}

export async function inspectCapabilities(root, expected) {
  /** @type {Record<string, boolean>} */
  const capabilities = {};
  for (const [name, files] of Object.entries(required)) {
    capabilities[name] = (
      await Promise.all(
        files.map(async (path) => {
          try {
            return (await lstat(join(root, path))).isFile();
          } catch {
            return false;
          }
        }),
      )
    ).every(Boolean);
  }
  const digest = await sourceIdentity(root);
  return {
    ok: Object.values(capabilities).every(Boolean) && (!expected || digest === expected),
    capabilities,
    sourceDigest: digest,
    pinned: Boolean(expected),
    matches: expected ? digest === expected : null,
  };
}
