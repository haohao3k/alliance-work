import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allowedFinding, pushTips } from "../scripts/scan-secrets.mjs";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zero = "0".repeat(40),
  sha = "a".repeat(40);

test("push tips include non-HEAD branches and tags, deduplicate tips and skip deletions", () => {
  assert.deepEqual(
    pushTips(
      `refs/heads/other ${sha} refs/heads/other ${zero}\nrefs/tags/v1 ${sha} refs/tags/v1 ${zero}\n(delete) ${zero} refs/heads/old ${sha}\n`,
    ),
    [sha],
  );
  assert.throws(() => pushTips("refs/heads/main --all refs/heads/main invalid"));
});

test("reviewed TruffleHog fixtures require exact detector, path, historical commit and value", () => {
  const raw = "synthetic fixture";
  const entry = {
    detector: "URI",
    file: "test.ts",
    commit: sha,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
  const finding = {
    DetectorName: "URI",
    Raw: raw,
    SourceMetadata: { Data: { Git: { file: "test.ts", commit: sha } } },
  };
  assert.equal(allowedFinding(finding, [entry]), true);
  for (const key of ["detector", "file", "commit", "sha256"] as const)
    assert.equal(allowedFinding(finding, [{ ...entry, [key]: "different" }]), false);
  assert.equal(allowedFinding({ ...finding, Raw: "new value" }, [entry]), false);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }, real = false) {
  const root = await mkdtemp(join(tmpdir(), "push-secret-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"),
    remote = join(root, "remote.git"),
    bin = join(root, "bin");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, ".githooks"));
  await mkdir(bin);
  for (const path of [
    "scripts/scan-secrets.mjs",
    "scripts/secret-scan-allowlist.json",
    ".gitleaks.toml",
    ".githooks/pre-push",
  ])
    await copyFile(join(source, path), join(repo, path));
  await chmod(join(repo, ".githooks/pre-push"), 0o755);
  await symlink(process.execPath, join(bin, "node"));
  const env = {
    ...process.env,
    PATH: real ? `${bin}:${process.env.PATH}` : `${bin}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
  };
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  assert.equal(git("init", "-q", "-b", "main").status, 0);
  assert.equal(git("init", "--bare", "-q", remote).status, 0);
  assert.equal(git("config", "core.hooksPath", ".githooks").status, 0);
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("commit", "-qm", "clean root").status, 0);
  const scanner = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  return { root, repo, remote, bin, git, scanner, env };
}

test("hook installation configures only its own checkout and preserves existing custom hooks", async (t) => {
  const f = await fixture(t);
  const installer = join(f.repo, "scripts/install-git-hooks.mjs");
  await copyFile(join(source, "scripts/install-git-hooks.mjs"), installer);
  f.git("config", "--unset", "core.hooksPath");
  const install = (path: string) => spawnSync(process.execPath, [path], { env: f.env, encoding: "utf8" });
  assert.equal(install(installer).status, 0);
  assert.equal(f.git("config", "--get", "core.hooksPath").stdout.trim(), ".githooks");
  f.git("config", "core.hooksPath", "existing-hooks");
  assert.notEqual(install(installer).status, 0);
  const archive = join(f.repo, "release-archive/scripts/install-git-hooks.mjs");
  await mkdir(dirname(archive), { recursive: true });
  await copyFile(installer, archive);
  assert.equal(install(archive).status, 0);
  assert.equal(f.git("config", "--get", "core.hooksPath").stdout.trim(), "existing-hooks");
});

const cleanGitleaks =
  'while [ "$#" -gt 0 ]; do if [ "$1" = "--report-path" ]; then shift; printf "[]" > "$1"; fi; shift; done';

test("real git pre-push blocks missing scanners, scanner errors and findings without leaking raw output", async (t) => {
  const f = await fixture(t);
  await f.scanner("gitleaks", cleanGitleaks);
  let result = f.git("push", f.remote, "main");
  assert.notEqual(result.status, 0, "missing TruffleHog must fail closed");
  assert.equal(f.git("ls-remote", f.remote).stdout, "");
  await f.scanner("trufflehog", "exit 2");
  assert.notEqual(f.git("push", f.remote, "main").status, 0, "scanner failure must block");
  const canary = "TEST_CANARY_DO_NOT_PRINT";
  await f.scanner(
    "trufflehog",
    `printf '%s\\n' '${JSON.stringify({ DetectorName: "Test", Raw: canary })}'\nexit 183`,
  );
  result = f.git("push", f.remote, "main");
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr).includes(canary));
  assert.ok(!(await readFile(join(f.repo, ".git/alliance-secret-scan.json"), "utf8")).includes(canary));
  await f.scanner(
    "trufflehog",
    'printf \'%s\\n\' \'{"level":"error","error":"synthetic scan failure"}\' >&2\nexit 0',
  );
  assert.notEqual(f.git("push", f.remote, "main").status, 0, "error diagnostics cannot pass with exit zero");
  await f.scanner("trufflehog", "exit 0");
  await rm(join(f.bin, "gitleaks"));
  assert.notEqual(f.git("push", f.remote, "main").status, 0, "missing Gitleaks must fail closed");
  await f.scanner("gitleaks", `${cleanGitleaks}\nexit 1`);
  result = f.git("push", f.remote, "main");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trufflehog: PASS/u, "both tools run even if Gitleaks fails");
  await f.scanner("gitleaks", cleanGitleaks);
  assert.equal(f.git("push", f.remote, "main").status, 0);
  assert.match(f.git("ls-remote", f.remote).stdout, /refs\/heads\/main/u);
});

test("installed scanners block a deleted synthetic credential in a non-checked-out branch's history", {
  skip: process.env.ALLIANCE_SECRET_SCAN_TESTS !== "1",
}, async (t) => {
  const f = await fixture(t, true);
  assert.equal(f.git("push", f.remote, "main").status, 0);
  assert.equal(f.git("checkout", "-qb", "leaky-history").status, 0);
  // Construct a non-live canary at runtime; no real credential is used or verified.
  const canary = ["ghp", randomBytes(18).toString("hex")].join("_");
  await writeFile(join(f.repo, "canary.txt"), `token=${canary}\n`);
  f.git("add", "canary.txt");
  f.git("commit", "-qm", "synthetic detection fixture");
  f.git("rm", "-q", "canary.txt");
  f.git("commit", "-qm", "remove fixture");
  f.git("checkout", "-q", "main");
  assert.equal(f.git("tag", "-a", "synthetic-tag", "leaky-history", "-m", "history scan fixture").status, 0);
  const result = f.git("push", f.remote, "leaky-history", "refs/tags/synthetic-tag");
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr).includes(canary));
  assert.ok(!(await readFile(join(f.repo, ".git/alliance-secret-scan.json"), "utf8")).includes(canary));
  assert.ok(!f.git("ls-remote", f.remote).stdout.includes("leaky-history"));
  assert.ok(!f.git("ls-remote", f.remote).stdout.includes("synthetic-tag"));
  const report = JSON.parse(await readFile(join(f.repo, ".git/alliance-secret-scan.json"), "utf8"));
  assert.equal(report.scans.length, 2);
  assert.ok(
    report.scans.every((scan: { passed: boolean; findings: number }) => !scan.passed && scan.findings > 0),
  );
});
