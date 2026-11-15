import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function patchPaseoIdleSwitch(target = root) {
  const patch = JSON.parse(await readFile(join(root, "scripts/paseo-0.15.4-idle-switch.json"), "utf8"));
  const pending = [];
  for (const file of patch.files) {
    const path = join(target, "node_modules", file.path);
    const source = await readFile(path, "utf8");
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    if (hash(source) === file.afterSha256) continue;
    if (hash(source) !== file.beforeSha256)
      throw new Error(`Unqualified Paseo source: ${file.path}; no patch applied`);
    let next = source;
    for (const [before, after] of file.changes) next = next.replace(before, after);
    if (hash(next) !== file.afterSha256) throw new Error("Native patch integrity mismatch");
    pending.push({ path, next });
  }
  // Verify every input before writing any file. Only this release's local dependencies are touched.
  for (const { path, next } of pending) await writeFile(path, next);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await patchPaseoIdleSwitch();
