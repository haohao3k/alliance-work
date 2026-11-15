import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assertNoLinks } from "./profile-integrity.mjs";

async function atomicWrite(path, value) {
  await assertNoLinks(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(staged, value, { mode: 0o600, flag: "wx" });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

export const HOLD_FILE = "maintenance-hold.json";
const Hold = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    phase: z.enum(["holding", "held", "updating", "resuming", "failed", "complete"]),
    reason: z.string().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    targets: z.array(z.object({ id: z.string(), phase: z.string() }).passthrough()),
    controls: z.record(z.string(), z.array(z.string())),
  })
  .passthrough();

export async function readMaintenanceHold(home) {
  const path = join(home, HOLD_FILE);
  await assertNoLinks(path);
  try {
    return Hold.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveMaintenanceHold(home, ledger) {
  const value = Hold.parse(ledger);
  const history = join(home, "maintenance-holds", value.id);
  await assertNoLinks(history);
  await mkdir(history, { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await atomicWrite(join(history, "ledger.json"), bytes);
  await atomicWrite(join(home, HOLD_FILE), bytes);
  return value;
}

export async function maintenanceHeld(home) {
  const hold = await readMaintenanceHold(home);
  return Boolean(hold && hold.phase !== "complete");
}

export async function heldTask(home, id) {
  const hold = await readMaintenanceHold(home);
  return Boolean(
    hold &&
      hold.phase !== "complete" &&
      hold.targets.some((task) => task.id === id && !["resuming", "resumed"].includes(task.phase)),
  );
}

export async function maintenanceMessageIds(home, id) {
  return (await readMaintenanceHold(home))?.controls[id] ?? [];
}
