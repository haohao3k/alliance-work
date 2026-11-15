import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ContextPolicy } from "../shared/context-settings.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";

const record = z.object({
  version: z.literal(1),
  roomId: z.string().min(1),
  revision: z.number().int().positive(),
  policy: ContextPolicy,
});
const hash = (value) => createHash("sha256").update(value).digest("hex");
const settingsPath = (home, roomId) => join(home, "context-settings", `${hash(roomId)}.json`);

async function readSettings(home, roomId) {
  const path = settingsPath(home, z.string().min(1).parse(roomId));
  await assertNoLinks(path);
  const text = await readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const saved = text === null ? null : record.parse(JSON.parse(text));
  if (saved && saved.roomId !== roomId) throw new Error("Context settings belong to another room");
  return { path, text, saved };
}

export async function contextSettings(home, roomId) {
  const { text, saved } = await readSettings(home, roomId);
  return {
    roomId,
    policy: saved?.policy ?? ContextPolicy.parse({}),
    revision: hash(text ?? ""),
    saved: saved !== null,
  };
}

export async function saveContextSettings(home, roomId, policy, revision, actorId) {
  if (actorId !== null) throw new Error("Only the Human can change Claude context settings");
  const parsed = ContextPolicy.parse(policy);
  const parent = join(home, "context-settings");
  await assertNoLinks(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lock = `${settingsPath(home, z.string().min(1).parse(roomId))}.lock`;
  await assertNoLinks(lock);
  await mkdir(lock, { mode: 0o700 }).catch((error) => {
    if (error.code === "EEXIST") throw new Error("Context settings are being edited; reload and retry");
    throw error;
  });
  try {
    const current = await readSettings(home, roomId);
    if (hash(current.text ?? "") !== revision)
      throw new Error("Context settings changed elsewhere; reload before saving");
    const staged = join(lock, "settings.json");
    await writeFile(
      staged,
      JSON.stringify(
        { version: 1, roomId, revision: (current.saved?.revision ?? 0) + 1, policy: parsed },
        null,
        2,
      ) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(staged, current.path);
    return await contextSettings(home, roomId);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
