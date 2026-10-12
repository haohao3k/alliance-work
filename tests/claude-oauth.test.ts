import assert from "node:assert/strict";
import test from "node:test";
import { profileEnvironment } from "../scripts/launch.mjs";

test("explicit Claude OAuth token works for every Claude role without leaking to other harnesses", () => {
  for (const role of ["hq", "supervisor", "lead", "peer", "lens"]) {
    const profile = { harness: "claude", role, home: "/tmp/claude-role", osHome: "/tmp/private-home" };
    const token = "synthetic-oauth-test-value";
    const explicit = profileEnvironment(profile, "/tmp/alliance", {}, { CLAUDE_CODE_OAUTH_TOKEN: token });
    assert.equal(explicit.CLAUDE_CODE_OAUTH_TOKEN, token);
    const ambient = profileEnvironment(profile, "/tmp/alliance", { CLAUDE_CODE_OAUTH_TOKEN: token });
    assert.equal(ambient.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    for (const harness of ["codex", "pi"]) {
      assert.throws(
        () =>
          profileEnvironment(
            { ...profile, harness },
            "/tmp/alliance",
            {},
            { CLAUDE_CODE_OAUTH_TOKEN: token },
          ),
        /Unsupported Alliance credential variable/,
      );
    }
  }
});
