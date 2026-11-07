import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function pushTips(input) {
  const tips = new Set();
  for (const line of input.split(/\r?\n/u).filter((value) => value.trim())) {
    const fields = line.trim().split(/\s+/u);
    if (
      fields.length !== 4 ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(fields[1]) ||
      !/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(fields[3])
    ) {
      throw new Error("Invalid pre-push ref input; push blocked.");
    }
    if (!/^0+$/u.test(fields[1])) tips.add(fields[1]);
  }
  return [...tips];
}

export function allowedFinding(finding, allowlist) {
  const git = finding?.SourceMetadata?.Data?.Git;
  if (!git || typeof finding.Raw !== "string") return false;
  const hash = createHash("sha256").update(finding.Raw).digest("hex");
  return allowlist.some(
    (entry) =>
      entry.detector === finding.DetectorName &&
      entry.file === git.file &&
      entry.commit === git.commit &&
      entry.sha256 === hash,
  );
}

function git(args) {
  const result = spawnSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status !== 0) throw new Error("Git revision lookup failed; push blocked.");
  return result.stdout.trim();
}

export function scan(tips) {
  process.umask(0o077);
  const temp = mkdtempSync(join(tmpdir(), "alliance-secret-scan-"));
  const summaries = [];
  let passed = true;
  const scannerEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    const allowlist = JSON.parse(readFileSync(join(source, "scripts/secret-scan-allowlist.json"), "utf8"));
    const commits = [...new Set(tips.map((tip) => git(["rev-parse", "--verify", `${tip}^{commit}`])))];
    for (const commit of commits) {
      const commands = [
        [
          "gitleaks",
          [
            "git",
            source,
            `--log-opts=${commit}`,
            "--redact=100",
            "--no-banner",
            "--ignore-gitleaks-allow",
            "--config",
            join(source, ".gitleaks.toml"),
            "--gitleaks-ignore-path",
            temp,
            "--report-format=json",
            "--report-path",
            join(temp, "gitleaks.json"),
          ],
        ],
        [
          "trufflehog",
          [
            "git",
            pathToFileURL(source).href,
            `--branch=${commit}`,
            "--no-verification",
            "--no-update",
            "--no-ignore-tag",
            "--results=verified,unknown,unverified",
            "--fail",
            "--fail-on-scan-errors",
            "--json",
          ],
        ],
      ];
      for (const [tool, args] of commands) {
        if (tool === "gitleaks") rmSync(join(temp, "gitleaks.json"), { force: true });
        const stdoutPath = join(temp, `${tool}.stdout`);
        const stderrPath = join(temp, `${tool}.stderr`);
        const stdout = openSync(stdoutPath, "w", 0o600);
        const stderr = openSync(stderrPath, "w", 0o600);
        let result;
        try {
          result = spawnSync(tool, args, {
            cwd: source,
            env: scannerEnv,
            stdio: ["ignore", stdout, stderr],
            timeout: 600000,
          });
        } finally {
          closeSync(stdout);
          closeSync(stderr);
        }
        let findings = [],
          allowed = 0,
          ok = false;
        try {
          if (tool === "gitleaks") {
            findings = JSON.parse(readFileSync(join(temp, "gitleaks.json"), "utf8"));
            if (!Array.isArray(findings)) throw new Error("Invalid report");
            ok = !result.error && result.status === 0 && findings.length === 0;
          } else {
            findings = readFileSync(stdoutPath, "utf8")
              .split(/\r?\n/u)
              .filter(Boolean)
              .map((line) => JSON.parse(line));
            allowed = findings.filter((finding) => allowedFinding(finding, allowlist)).length;
            const scanError = readFileSync(stderrPath, "utf8")
              .split(/\r?\n/u)
              .filter(Boolean)
              .some((line) => {
                try {
                  const log = JSON.parse(line);
                  return Boolean(log.error) || /error|fatal/iu.test(String(log.level ?? ""));
                } catch {
                  return true; // Unexpected diagnostics are not a clean scan.
                }
              });
            ok =
              !result.error &&
              !scanError &&
              [0, 183].includes(result.status) &&
              findings.length === allowed &&
              (result.status === 0 || findings.length > 0);
          }
        } catch {
          ok = false;
        }
        if (!Array.isArray(findings)) findings = [];
        passed &&= ok;
        summaries.push({
          tool,
          commit,
          passed: ok,
          findings: findings.length,
          reviewedFixtures: allowed,
          exitCode: result.status,
          executionError: Boolean(result.error),
          locations: findings
            .filter((finding) => tool !== "trufflehog" || !allowedFinding(finding, allowlist))
            .map((finding) => ({
              rule: tool === "gitleaks" ? finding?.RuleID : finding?.DetectorName,
              file: tool === "gitleaks" ? finding?.File : finding?.SourceMetadata?.Data?.Git?.file,
              line: tool === "gitleaks" ? finding?.StartLine : finding?.SourceMetadata?.Data?.Git?.line,
              commit: tool === "gitleaks" ? finding?.Commit : finding?.SourceMetadata?.Data?.Git?.commit,
            })),
        });
        console.error(
          `[secret-scan] ${tool}: ${ok ? "PASS" : "BLOCKED"} (${commit.slice(0, 12)}; ${findings.length - allowed} unapproved findings, ${allowed} reviewed fixtures)`,
        );
      }
    }
    // Only counts and source locations, never credential values or scanner stderr.
    const report = git(["rev-parse", "--git-path", "alliance-secret-scan.json"]);
    writeFileSync(
      resolve(source, report),
      `${JSON.stringify({ at: new Date().toISOString(), passed, scans: summaries }, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (!passed)
      throw new Error(
        "Secret scan failed or a scanner is missing/unavailable. Push blocked; inspect locally without printing raw scanner output.",
      );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const tips = process.argv[2] === "--pre-push" ? pushTips(readFileSync(0, "utf8")) : ["HEAD"];
    if (tips.length) scan(tips);
  } catch {
    console.error(
      "[secret-scan] Push blocked: scanner, ref/configuration error, or unapproved findings. Check tool installation and .git/alliance-secret-scan.json; never print raw scanner output.",
    );
    process.exitCode = 1;
  }
}
