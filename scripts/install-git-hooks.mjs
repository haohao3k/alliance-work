import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const top = git("rev-parse", "--show-toplevel");
// Release archives are not checkouts; never configure an enclosing repository.
if (top.status === 0 && resolve(top.stdout.trim()) === root) {
  const configured = git("config", "--get", "core.hooksPath");
  if (![0, 1].includes(configured.status)) throw new Error("Cannot read Git hook configuration.");
  if (configured.stdout.trim() && configured.stdout.trim() !== ".githooks") {
    throw new Error(
      "An existing core.hooksPath is configured. Reconcile it with .githooks before setup; it was not overwritten.",
    );
  }
  chmodSync(join(root, ".githooks/pre-push"), 0o755);
  if (git("config", "--local", "core.hooksPath", ".githooks").status !== 0)
    throw new Error("Cannot install Git hooks.");
  console.log("Installed pre-push hook: Gitleaks and TruffleHog must both pass.");
}
