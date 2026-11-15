import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const nativeRoot = dirname(require.resolve("@getpaseo/server"));
const manifest = await import(
  pathToFileURL(join(nativeRoot, "agent/providers/claude/model-manifest.js")).href
);

test("qualified native catalog exposes Fable 5.2 only on supported Claude Code without changing the default", () => {
  const before = manifest.getClaudeManifestModels("2.1.320");
  assert.equal(
    before.some((model: { id: string }) => model.id === "claude-fable-5-2"),
    false,
  );
  const models = manifest.getClaudeManifestModels("2.1.321", new Set());
  assert.equal(
    models.some((model: { id: string }) => model.id.startsWith("claude-mythos-")),
    false,
  );
  const fable = models.find((model: { id: string }) => model.id === "claude-fable-5-2");
  assert.ok(fable);
  assert.equal(fable.label, "Fable 5.2");
  assert.equal(fable.contextWindowMaxTokens, 1_000_000);
  assert.equal(fable.defaultThinkingOptionId, "medium");
  assert.equal(
    fable.thinkingOptions.some((option: { id: string }) => option.id === "off"),
    false,
  );
  assert.equal(manifest.claudeManifestModelSupportsFastMode(fable.id), true);
  assert.equal(models.find((model: { isDefault?: boolean }) => model.isDefault)?.id, "claude-opus-5-5");
});
