import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function temporary(prefix: string) {
  return mkdtemp(join(await realpath(tmpdir()), prefix));
}
