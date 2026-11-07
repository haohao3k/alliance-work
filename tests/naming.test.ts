import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTitle } from "../shared/naming";

test("task names retain project, role and multilingual task without host or implementation IDs", () => {
  assert.equal(
    agentTitle("ExampleApp", "peer", "Rà soát phân quyền"),
    "[peer] [ExampleApp] Rà soát phân quyền",
  );
  assert.equal(agentTitle("Alliance Work", "hq"), "[hq] [Alliance Work]");
  assert.equal(
    agentTitle("Sleek Radar", "lead", "\n# Hoàn thiện dashboard\nDetails"),
    "[lead] [Sleek Radar] Hoàn thiện dashboard",
  );
});

test("long or hostile display text stays bounded and cannot inject extra lines or bidi controls", () => {
  const title = agentTitle("p".repeat(100), "supervisor", "😀".repeat(100) + "\u202e\ttext");
  assert.ok(title.length <= 160);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(title));
  assert.ok(!title.includes("\ufffd"));
});

test("supplied child titles cannot omit or spoof the profile role and retain the actual project in shared workspaces", () => {
  assert.equal(
    agentTitle("Shared workspace", "peer", "ExampleApp C20 docs lane", ["ExampleApp"]),
    "[peer] [ExampleApp] C20 docs lane",
  );
  assert.equal(agentTitle("Shared workspace", "peer", "[hq] [ExampleApp] Docs"), "[peer] [ExampleApp] Docs");
  assert.equal(
    agentTitle("ExampleApp", "supervisor", "ExampleApp · Supervisor · Plan"),
    "[sup] [ExampleApp] Plan",
  );
  const title = agentTitle("ExampleApp", "lead", "Review");
  assert.equal(agentTitle("Shared workspace", "lead", title), title);
  assert.equal(
    agentTitle("[team] [ExampleApp] Shared workspace", "lens", "Review"),
    "[lens] [ExampleApp] Review",
  );
  assert.equal(agentTitle("App", "peer", "Apple diagnostics", ["App"]), "[peer] [App] Apple diagnostics");
});
