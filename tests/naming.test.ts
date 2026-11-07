import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTitle } from "../shared/naming";

test("task names retain project, role and multilingual task without host or implementation IDs", () => {
  assert.equal(
    agentTitle("ExampleApp", "peer", "Rà soát phân quyền"),
    "ExampleApp · Peer · Rà soát phân quyền",
  );
  assert.equal(agentTitle("Alliance Work", "hq"), "Alliance Work · HQ");
  assert.equal(
    agentTitle("Sleek Radar", "lead", "\n# Hoàn thiện dashboard\nDetails"),
    "Sleek Radar · Lead · Hoàn thiện dashboard",
  );
});

test("long or hostile display text stays bounded and cannot inject extra lines or bidi controls", () => {
  const title = agentTitle("p".repeat(100), "supervisor", "😀".repeat(100) + "\u202e\ttext");
  assert.ok(title.length <= 160);
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(title));
  assert.ok(!title.includes("\ufffd"));
});
