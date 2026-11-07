import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoLinks, digest } from "./profile-integrity.mjs";

// Local, same-name adaptations. Missing manifest means an older release's exact raw skills.
export async function skillOverrides(root, provenance) {
  const manifestPath = join(root, "room/skill-overrides.json");
  await assertNoLinks(manifestPath);
  const text = await readFile(manifestPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (text === null) return new Map();
  const manifest = JSON.parse(text);
  if (
    manifest.version !== 1 ||
    !manifest.skills ||
    typeof manifest.skills !== "object" ||
    Array.isArray(manifest.skills)
  )
    throw new Error("Invalid skill override manifest");
  const result = new Map();
  for (const [name, entry] of Object.entries(manifest.skills)) {
    const source = provenance.files.find((file) => file.path === entry?.source);
    if (!/^slp-[a-z0-9-]+$/.test(name) || !source?.path.endsWith(`/${name}/SKILL.md`))
      throw new Error(`Invalid skill override source: ${name}`);
    // An override never conceals modified upstream bytes.
    const original = provenance.files.filter((file) => file.path.startsWith(source.path.slice(0, -8)));
    for (const file of original) {
      await assertNoLinks(join(root, file.path));
      if (digest(await readFile(join(root, file.path))) !== file.sha256)
        throw new Error(`Seatwork source bytes changed: ${file.path}`);
    }
    const directory = `room/skill-overrides/${name}`;
    const files = [];
    const collect = async (path) => {
      await assertNoLinks(join(root, path));
      for (const child of await readdir(join(root, path), { withFileTypes: true })) {
        const next = `${path}/${child.name}`;
        if (child.isDirectory()) await collect(next);
        else if (child.isFile()) files.push({ path: next, local: true, sha256: "" });
        else throw new Error(`Unsupported skill override resource: ${next}`);
      }
    };
    await collect(directory);
    const body = await readFile(join(root, directory, "SKILL.md"), "utf8");
    if (/^name: (.+)$/m.exec(body)?.[1] !== name) throw new Error(`Skill override name mismatch: ${name}`);
    const role = source.path.split("/")[3];
    result.set(name, {
      directory,
      files,
      roles: [role, ...(["slp-challenge-premise", "slp-evidence-report"].includes(name) ? ["lens"] : [])],
    });
  }
  for (const entry of await readdir(join(root, "room/skill-overrides"), { withFileTypes: true }))
    if (entry.isDirectory() && !result.has(entry.name))
      throw new Error(`Unregistered skill override: ${entry.name}`);
  return result;
}
