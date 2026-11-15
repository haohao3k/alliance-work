import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomStore } from "../server/store";
import { temporary } from "./temp";

export async function scratchFixture() {
  const root = await temporary("alliance-scratch-");
  const scratchRoot = join(root, "var-tmp");
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(scratchRoot);
  return { root, home, env: { ALLIANCE_SCRATCH_ROOT: scratchRoot } as NodeJS.ProcessEnv, scratchRoot };
}

export const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

export async function repository() {
  const f = await scratchFixture();
  const main = join(f.root, "project");
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "README.md"), "hello");
  git(main, "add", ".");
  git(main, "commit", "-q", "-m", "initial");
  const worktree = (name: string, commit = false) => {
    const path = join(f.root, "worktrees", name);
    git(main, "worktree", "add", "-q", "-b", `feature/${name}`, path);
    if (commit) {
      spawnSync("sh", ["-c", "echo more >> README.md"], { cwd: path });
      git(path, "commit", "-qam", "unmerged work");
    }
    return path;
  };
  const store = new RoomStore(f.home);
  const room = {
    id: "room-1",
    title: "Room",
    cwd: main,
    workspaceId: "w",
    mission: "",
    artifacts: join(f.root, "artifacts"),
    createdAt: new Date().toISOString(),
  };
  store.addRoom(room);
  const member = (id: string, cwd: string, archived: boolean, extra: Record<string, unknown> = {}) =>
    store.saveMember({
      id,
      roomId: room.id,
      role: "peer",
      provider: "alliance-codex-peer",
      parentId: null as string | null,
      assignment: "",
      cwd,
      lastOutcome: null,
      resultPath: null,
      decision: "open",
      decisionEvidence: null,
      launchKey: null,
      launchHash: null,
      ...(archived ? { archivedAt: new Date().toISOString() } : {}),
      ...extra,
    });
  return { ...f, main, store, room, worktree, member };
}
