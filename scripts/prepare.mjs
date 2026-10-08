import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareProfiles } from "./profiles.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};
async function executable(name) {
  const explicit = option(`--${name}`);
  if (explicit) {
    await access(explicit, constants.X_OK);
    return resolve(explicit);
  }
  for (const directory of (process.env.PATH ?? "").split(":")) {
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {}
  }
  throw new Error(`${name} not found. Pass --${name} /absolute/path/to/${name}`);
}
try {
  const manifest = await prepareProfiles({
    home: option("--home") ?? join(homedir(), ".alliance-work"),
    isolatedRoot: option("--isolated-root"),
    executables: Object.fromEntries(
      await Promise.all(["codex", "claude", "pi"].map(async (name) => [name, await executable(name)])),
    ),
  });
  console.log(
    `Prepared ${Object.keys(manifest.profiles).length} independent role homes.\nManifest: ${join(manifest.home, "profiles.json")}\nProvider configuration: ${join(manifest.home, "providers.json")}`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
