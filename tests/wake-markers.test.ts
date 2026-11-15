import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { RoomStore } from "../server/store";
import { temporary } from "./temp";

test("wake measurement preserves lifecycle and attributes only exact prompt identities", async () => {
  const home = await temporary("wake-markers");
  const store = new RoomStore(home);
  try {
    store.saveMember({
      id: "a",
      roomId: "r",
      role: "peer",
      provider: "alliance-claude-peer",
      parentId: null,
      assignment: "",
      lastOutcome: "completed",
      resultPath: "/retained",
      decision: "accepted",
      decisionEvidence: "proof",
      launchKey: null,
      launchHash: null,
    });
    store.noteWakeMessage("a", "sent", "alliance.resume", 100);
    store.noteTurnWake("a", "turn", 200);
    assert.equal(store.member("a")?.turnWake?.source, "unknown");
    store.noteTurnWake("a", "turn", 200, "unrelated");
    assert.equal(store.member("a")?.turnWake?.source, "native.plain");
    store.noteTurnWake("a", "turn", 200, "sent");
    assert.equal(store.member("a")?.turnWake?.source, "alliance.resume");
    assert.equal(store.member("a")?.decision, "accepted");
    assert.equal(store.member("a")?.resultPath, "/retained");
    assert.equal(store.member("a")?.pluginMessages, undefined);
    const rows = (await readFile(join(home, "wake-markers.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    assert.equal(rows.length, 3);
    assert.equal(rows[2].promptId, "sent");
    store.noteTurnWake("a", "turn", 200, "sent");
    assert.equal((await readFile(join(home, "wake-markers.jsonl"), "utf8")).trim().split("\n").length, 3);
  } finally {
    store.close();
  }
});
