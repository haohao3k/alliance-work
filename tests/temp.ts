import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const directories: string[] = [];
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

export async function temporary(prefix: string) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), prefix));
  directories.push(directory);
  return directory;
}
