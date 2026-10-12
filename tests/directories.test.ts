import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { directorySuggestions } from "../server/directories";
import { temporary } from "./temp";

test("folder completion expands host home, filters files, follows directory links and completes partial paths", async () => {
  const home = await realpath(await temporary("alliance-folders-"));
  const project = join(home, "project");
  await mkdir(project);
  await mkdir(join(home, ".hidden"));
  await writeFile(join(home, "project.txt"), "not a directory");
  await symlink(project, join(home, "linked-project"));
  const initial = await directorySuggestions("", [project], home);
  assert.equal(initial.current, home);
  assert.deepEqual(initial.paths, [project, join(home, "linked-project")]);
  assert.deepEqual((await directorySuggestions("~/pro", [], home)).paths, [project]);
  assert.equal((await directorySuggestions("~/linked-project", [], home)).current, project);
  assert.deepEqual((await directorySuggestions("~/.h", [], home)).paths, [join(home, ".hidden")]);
  await assert.rejects(directorySuggestions("relative/path", [], home), /absolute/);
});
