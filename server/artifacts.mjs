import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { measure } from "./scratch.mjs";

/**
 * Rebuildable build and dependency directories, found by name next to the file that says what builds
 * them. The list is deliberately short and holds only what a lockfile or manifest regenerates;
 * `dist`, `build` without a Gradle manifest, `venv`, `.env` and anything a repository may track are
 * not on it. A directory is only a candidate when it is a real directory (never a symlink).
 */
export const RULES = [
  {
    type: "node",
    markers: ["package.json"],
    dirs: ["node_modules", ".angular", ".turbo", ".next", ".nuxt", ".svelte-kit", ".parcel-cache"],
  },
  {
    type: "python",
    markers: [
      "pyproject.toml",
      "requirements.txt",
      "setup.py",
      "setup.cfg",
      "Pipfile",
      "uv.lock",
      "poetry.lock",
      "tox.ini",
    ],
    dirs: [".venv", ".tox", ".nox"],
  },
  { type: "python-cache", markers: [], dirs: ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"] },
  { type: "cargo", markers: ["Cargo.toml"], dirs: ["target"] },
  { type: "maven", markers: ["pom.xml"], dirs: ["target"] },
  {
    type: "gradle",
    markers: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    dirs: ["build", ".gradle"],
  },
  { type: "swift", markers: ["Package.swift"], dirs: [".build"] },
  { type: "zig", markers: ["build.zig"], dirs: [".zig-cache", "zig-out"] },
];

const MAX_DEPTH = 8;
const MAX_ENTRIES = 200_000;
const UNITS = { m: 60, h: 3600, d: 86_400, w: 604_800 };

/** "30m", "12h", "7d", "2w" to seconds. */
export function parseAge(text) {
  const match = /^(\d+)([mhdw])$/.exec(String(text ?? ""));
  if (!match) throw new Error(`Invalid --older ${JSON.stringify(text)}; use a number and m, h, d or w (7d)`);
  return Number(match[1]) * UNITS[match[2]];
}

/**
 * Artifact directories under `root`, never following a symlink or leaving the filesystem of `root`,
 * and never descending into a candidate, `.git`, or any other hidden directory.
 * @returns {Promise<{path: string, parent: string, type: string, name: string}[]>}
 */
export async function findArtifacts(root) {
  const found = new Map();
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return [];
  let seen = 0;
  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    seen += entries.length;
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    const dirs = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const taken = new Set();
    for (const rule of RULES) {
      if (rule.markers.length && !rule.markers.some((marker) => files.has(marker))) continue;
      for (const name of rule.dirs) {
        if (!dirs.has(name)) continue;
        taken.add(name);
        const path = join(directory, name);
        if (!found.has(path)) found.set(path, { path, parent: directory, type: rule.type, name });
      }
    }
    if (depth >= MAX_DEPTH || seen > MAX_ENTRIES) return;
    for (const name of dirs) {
      if (taken.has(name) || name.startsWith(".")) continue;
      const child = join(directory, name);
      try {
        const info = await lstat(child);
        if (info.dev !== rootInfo.dev) continue;
      } catch {
        continue;
      }
      await walk(child, depth + 1);
    }
  }
  await walk(root, 0);
  return [...found.values()];
}

/** Size and age of one candidate: the newest write anywhere inside it, so a directory in use is young. */
export async function describe(candidate) {
  const size = await measure(candidate.path);
  return {
    ...candidate,
    bytes: size.bytes,
    files: size.files,
    newest: size.newest,
    ageSeconds: size.newest ? Math.max(0, Math.floor((Date.now() - size.newest) / 1000)) : null,
    exists: size.exists,
  };
}
