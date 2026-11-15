import assert from "node:assert/strict";
import { test } from "node:test";
import {
  filterRoomBoard,
  indexRoomBoard,
  projectIsExpanded,
  type RoomSnapshot,
  roomJobPage,
} from "../shared/room-board";

function snapshot(): RoomSnapshot {
  // Only the board's read model fields are relevant here; RPC schema validation has separate coverage.
  return {
    rooms: [
      { id: "a", title: "Alpha", cwd: "/projects/alpha" },
      { id: "b", title: "Beta", cwd: "/projects/beta" },
      { id: "c", title: "Gamma", cwd: "/projects/gamma" },
    ],
    members: [
      {
        id: "idle",
        roomId: "a",
        title: "Write report",
        role: "peer",
        status: "idle",
        ownerLabel: "Human",
        archived: false,
      },
      {
        id: "running",
        roomId: "a",
        title: "Review changes",
        role: "lead",
        status: "running",
        ownerLabel: "Ada",
        archived: false,
      },
      {
        id: "permission",
        roomId: "b",
        title: "Read source",
        role: "peer",
        status: "awaiting_permission",
        ownerLabel: "Grace",
        archived: false,
      },
      {
        id: "archived",
        roomId: "a",
        title: "Old task",
        role: "peer",
        status: "closed",
        ownerLabel: "Human",
        archived: true,
      },
    ],
    jobs: [],
    obligations: [],
    wakeups: [],
  } as unknown as RoomSnapshot;
}

test("search and session filters reveal matching sessions inside initially collapsed projects", () => {
  const board = indexRoomBoard(snapshot(), false);
  for (const [filter, search, id] of [
    ["all", "Review changes", "running"],
    ["attention", "", "permission"],
    ["working", "", "running"],
    ["idle", "", "idle"],
  ] as const) {
    const groups = filterRoomBoard(board, { project: null, filter, search });
    assert.equal(groups.length, 1);
    assert.deepEqual(
      groups[0].members.map((member) => member.id),
      [id],
    );
    assert.equal(projectIsExpanded(false, { focused: false, filter, search }), true);
  }
  assert.equal(projectIsExpanded(false, { focused: false, filter: "all", search: "  " }), false);
  assert.equal(projectIsExpanded(true, { focused: false, filter: "all", search: "" }), true);
  assert.equal(projectIsExpanded(false, { focused: true, filter: "all", search: "" }), true);
});

test("session filters retain projects with unfinished responsibility and expose obligations outside a search", () => {
  const data = snapshot();
  data.jobs.push({ roomId: "a", state: "unknown" } as RoomSnapshot["jobs"][number]);
  data.obligations.push({ roomId: "c", state: "open" } as RoomSnapshot["obligations"][number]);
  data.obligations.push({ roomId: "b", state: "fulfilled" } as RoomSnapshot["obligations"][number]);
  data.wakeups.push({ roomId: "b", state: "acknowledged" } as RoomSnapshot["wakeups"][number]);
  const board = indexRoomBoard(data, false);
  const groups = filterRoomBoard(board, { project: null, filter: "working", search: "" });
  assert.deepEqual(
    groups.map(({ room }) => room.id),
    ["a", "c"],
  );
  assert.equal(groups[1].obligations.length, 1);
  assert.equal(board.byRoom.get("b")?.wakeups.length, 0);
  const searched = filterRoomBoard(board, { project: null, filter: "all", search: "Alpha" });
  const visible = new Set(searched.map(({ room }) => room.id));
  assert.equal(board.openObligations.filter((item) => !visible.has(item.roomId)).length, 1);
});

test("attention includes model drift and unowned sessions without hiding working state or archived choices", () => {
  const data = snapshot();
  Object.assign(data.members[0], { selectedModel: "selected", runtimeModel: "running" });
  Object.assign(data.members[1], { ownerStatus: "needs-owner" });
  const originalOrder = data.members.map((member) => member.id);
  const board = indexRoomBoard(data, false);
  assert.deepEqual(board.counts, { all: 3, working: 1, attention: 3, idle: 1 });
  assert.deepEqual(
    board.byRoom.get("a")?.members.map((member) => member.id),
    ["running", "idle"],
  );
  assert.deepEqual(
    data.members.map((member) => member.id),
    originalOrder,
  );
  assert.equal(indexRoomBoard(data, true).counts.all, 4);
});

test("owner search respects project focus and clearing the query restores the default overview", () => {
  const board = indexRoomBoard(snapshot(), false);
  assert.deepEqual(
    filterRoomBoard(board, { project: null, filter: "all", search: "  gRaCe " }).flatMap((group) =>
      group.members.map((member) => member.id),
    ),
    ["permission"],
  );
  assert.equal(filterRoomBoard(board, { project: "a", filter: "all", search: "Grace" }).length, 0);
  assert.equal(filterRoomBoard(board, { project: null, filter: "all", search: "" }).length, 3);
});

test("a large job history pages without concealing live or unknown jobs or dropping custody records", () => {
  const data = snapshot();
  for (let n = 0; n < 2400; n++)
    data.jobs.push({ key: `old-${n}`, roomId: "a", state: "exited" } as RoomSnapshot["jobs"][number]);
  data.jobs.push({ key: "live", roomId: "a", state: "running" } as RoomSnapshot["jobs"][number]);
  data.jobs.push({ key: "uncertain", roomId: "a", state: "unknown" } as RoomSnapshot["jobs"][number]);
  const jobs = indexRoomBoard(data, false).byRoom.get("a")?.jobs;
  assert(jobs);
  assert.equal(jobs.length, data.jobs.length);
  const first = roomJobPage(jobs, 10);
  assert.equal(first.visible.length, 10);
  assert.deepEqual(
    first.visible.slice(0, 2).map((job) => job.key),
    ["uncertain", "live"],
  );
  assert.equal(first.remaining, 2392);
  assert.deepEqual(roomJobPage(jobs, 30).visible.slice(0, 10), first.visible);
  assert.deepEqual(roomJobPage(jobs, jobs.length), { visible: jobs, remaining: 0 });
  assert.equal(data.jobs[0].key, "old-0", "indexing must not reorder the source snapshot");
});
