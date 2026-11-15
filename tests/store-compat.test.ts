import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { projectRoot } from "../scripts/profiles.mjs";
import { dropHandbackRecords } from "../scripts/rollback-compat.mjs";
import { AllianceRuntime } from "../server/runtime";
import { RoomStore } from "../server/store";
import { setStoreMarker, storeAccessAt } from "../server/store-compat.mjs";
import { Wakeups } from "../server/wakeups";
import { temporary } from "./temp";

// What a newer release leaves in rooms.sqlite when it changes the store in a way this code
// cannot read or write safely: rows in table store_compat (see docs/operations.md, "Store level").
function mark(home: string, rows: Record<string, string>) {
  const db = new DatabaseSync(join(home, "rooms.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS store_compat(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const [key, value] of Object.entries(rows))
      db.prepare("INSERT OR REPLACE INTO store_compat(key,value) VALUES(?,?)").run(key, value);
  } finally {
    db.close();
  }
}
const room = (id: string, home: string) => ({
  id,
  cwd: join(home, id),
  artifacts: home,
  title: id,
  nativeTitle: id,
  mission: "",
  workspaceId: "w",
  createdAt: "now",
});
const future = { write_level: "2", marked_by: "0.9.0" };
const tableNames = (home: string) => {
  const db = new DatabaseSync(join(home, "rooms.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
};
const userVersion = (home: string) => {
  const db = new DatabaseSync(join(home, "rooms.sqlite"), { readOnly: true });
  try {
    return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
};

test("a store a newer release marked is read but never written, and the refusal names both versions", async () => {
  const home = await temporary("alliance-store-future-");
  const first = new RoomStore(home);
  first.addRoom(room("before", home));
  first.close();
  mark(home, future);
  const store = new RoomStore(home);
  try {
    assert.deepEqual(
      store.rooms().map((r) => r.id),
      ["before"],
    );
    const writes: [string, () => unknown][] = [
      ["room", () => store.addRoom(room("after", home))],
      ["title", () => store.updateRoomTitle("before", "before", "renamed")],
      ["transaction", () => store.atomic(() => store.addRoom(room("inside", home)))],
      ["migration", () => store.setMigration(2)],
    ];
    for (const [name, write] of writes)
      assert.throws(
        write,
        (error: Error) => /0\.9\.0/.test(error.message) && /level 1/.test(error.message),
        name,
      );
    assert.deepEqual(
      store.rooms().map((r) => [r.id, r.title]),
      [["before", "before"]],
    );
    assert.equal(store.migration(), 0, "reads of the store still answer");
  } finally {
    store.close();
  }
  assert.equal(userVersion(home), 0, "the refused migration left the store alone");
});

test("a marker raised while this code is running stops the next write", async () => {
  const home = await temporary("alliance-store-raised-");
  const store = new RoomStore(home);
  try {
    store.addRoom(room("one", home));
    mark(home, future);
    assert.throws(() => store.addRoom(room("two", home)), /0\.9\.0/);
    assert.deepEqual(
      store.rooms().map((r) => r.id),
      ["one"],
    );
  } finally {
    store.close();
  }
});

test("a store this code cannot even read is refused when opened, untouched", async () => {
  const home = await temporary("alliance-store-unreadable-");
  new RoomStore(home).close();
  mark(home, { write_level: "3", read_level: "3", marked_by: "0.9.0" });
  const before = tableNames(home);
  assert.throws(() => new RoomStore(home), /0\.9\.0/);
  assert.deepEqual(tableNames(home), before);
  mark(home, { write_level: "0", read_level: "not a number", marked_by: "0.9.0" });
  assert.throws(() => new RoomStore(home), /0\.9\.0/, "an unrecognized marker is not an unmarked store");
});

test("an unmarked store, or one marked for this code's level, behaves as before and gains no marker", async () => {
  const home = await temporary("alliance-store-plain-");
  const store = new RoomStore(home);
  store.addRoom(room("r", home));
  new Wakeups(store);
  store.close();
  assert.equal(userVersion(home), 1, "the one-time reminder migration still counts 1, as in 0.1.19-0.1.51");
  assert.ok(!tableNames(home).includes("store_compat"), "a release that needs nothing leaves no marker");
  mark(home, { write_level: "1", read_level: "1", marked_by: "0.1.52" });
  const marked = new RoomStore(home);
  try {
    assert.doesNotThrow(() => marked.addRoom(room("again", home)));
  } finally {
    marked.close();
  }
});

test("rolling back below 0.1.19 does not rewrite a store a newer release marked", async () => {
  const home = await temporary("alliance-store-rollback-");
  const store = new RoomStore(home);
  store.close();
  mark(home, future);
  assert.throws(() => dropHandbackRecords(home), /0\.9\.0/);
});

test("the runtime keeps a marked store readable, does not start scheduled writes, and says why", async () => {
  const home = await temporary("alliance-store-runtime-");
  await writeFile(join(home, "profiles.json"), JSON.stringify({ home, root: home, profiles: {} }));
  const seed = new RoomStore(home);
  seed.addRoom(room("kept", home));
  seed.close();
  mark(home, future);
  const runtime = await new AllianceRuntime(home).ready();
  try {
    await runtime.startWakeups();
    assert.deepEqual(
      runtime.store.rooms().map((r) => r.id),
      ["kept"],
    );
    assert.match(String(runtime.wakeupHealth.error), /0\.9\.0/);
    assert.equal(userVersion(home), 0);
  } finally {
    await runtime.close();
  }
  mark(home, { write_level: "3", read_level: "3", marked_by: "0.9.0" });
  await assert.rejects(new AllianceRuntime(home).ready(), /0\.9\.0/);
});

test("a 0.1.51 reader still opens and writes a store this code, or a future marker, has touched", async (t) => {
  // The compatibility promise: the marker is a table older releases never open, and nothing here
  // changes user_version. The 0.1.51 sources come from git; skip where that commit is unavailable.
  const old = await temporary("alliance-store-0151-");
  try {
    execFileSync("git", ["-C", projectRoot, "cat-file", "-e", "b51fc63^{commit}"], { stdio: "ignore" });
    execFileSync("sh", ["-c", `git -C "${projectRoot}" archive b51fc63 server shared | tar -x -C "${old}"`]);
  } catch {
    t.skip("commit b51fc63 (0.1.51) is not in this checkout");
    return;
  }
  await symlink(join(projectRoot, "node_modules"), join(old, "node_modules"));
  await writeFile(join(old, "package.json"), JSON.stringify({ type: "module" }));
  const home = await temporary("alliance-store-0151-home-");
  const current = new RoomStore(home);
  current.addRoom(room("a", home));
  new Wakeups(current);
  current.close();
  mark(home, { write_level: "2", read_level: "2", marked_by: "0.9.0" });
  const script = join(old, "check.mjs");
  await writeFile(
    script,
    `import { RoomStore } from "./server/store.ts";
     import { Wakeups } from "./server/wakeups.ts";
     const store = new RoomStore(process.argv[2]);
     new Wakeups(store);
     store.addRoom({ id: "b", cwd: "/b", artifacts: "/b", title: "b", mission: "", workspaceId: "w", createdAt: "now" });
     console.log(JSON.stringify(store.rooms().map((r) => r.id).sort()));
     store.close();`,
  );
  const out = execFileSync(process.execPath, ["--import", "tsx", script, home], {
    cwd: old,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home },
  });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop() as string), ["a", "b"]);
  assert.ok(existsSync(join(home, "rooms.sqlite")));
});

test("a newer release that converts the store and lowers the marker on rollback lets this code write again", async () => {
  const home = await temporary("alliance-store-lowered-");
  assert.equal(await storeAccessAt(home), null, "no store, nothing to report");
  new RoomStore(home).close();
  const db = new DatabaseSync(join(home, "rooms.sqlite"));
  try {
    setStoreMarker(db, { writeLevel: 2, by: "0.9.0" });
    assert.deepEqual(
      (await storeAccessAt(home))?.access,
      "read",
      "doctor reads the verdict without the plugin",
    );
    setStoreMarker(db, { writeLevel: 1, by: "0.9.0" });
  } finally {
    db.close();
  }
  assert.equal((await storeAccessAt(home))?.access, "write");
  assert.ok(
    !tableNames(home).includes("store_compat"),
    "lowered to the level of every older release: no marker",
  );
  const store = new RoomStore(home);
  try {
    assert.doesNotThrow(() => store.addRoom(room("back", home)));
  } finally {
    store.close();
  }
});
