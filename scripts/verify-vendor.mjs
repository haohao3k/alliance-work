import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { skillOverrides } from "../server/skill-overrides.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rawManifest = "vendor/seatwork/upstream-ab41c12/provenance.json";

// Derived playbooks remain editable local assets. Their source bytes stay pinned, and every
// installed resource has a recorded source, including attribution and licenses.
export function verifyAdaptedPlaybooks(root = defaultRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, rawManifest), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Older releases predate both the raw pack and the role catalog.
    try {
      lstatSync(join(root, "room/skills.json"));
    } catch (catalogError) {
      if (catalogError.code === "ENOENT") return null;
      throw catalogError;
    }
    throw error;
  }
  const sourcePaths = new Set();
  const checkedPath = (path) => {
    if (
      typeof path !== "string" ||
      !path ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === ".." || !part)
    )
      throw new Error(`Invalid playbook provenance path: ${path}`);
    const full = join(root, path);
    if (!lstatSync(full).isFile()) throw new Error(`Not a regular playbook file: ${path}`);
    return full;
  };
  for (const file of manifest.files) {
    if (digest(readFileSync(checkedPath(file.path))) !== file.sha256)
      throw new Error(`Vendored bytes changed: ${file.path}`);
    if (sourcePaths.has(file.path)) throw new Error(`Duplicate playbook source: ${file.path}`);
    sourcePaths.add(file.path);
  }
  for (const adaptation of manifest.adaptations) {
    if (adaptation.directory !== `room/skills/${adaptation.name}` || !/^[a-z0-9-]+$/.test(adaptation.name))
      throw new Error(`Invalid playbook adaptation: ${adaptation.name}`);
    const mapped = new Set();
    for (const file of adaptation.files) {
      if (
        !file.path.startsWith(`${adaptation.directory}/`) ||
        mapped.has(file.path) ||
        !file.sources?.length ||
        file.sources.some((source) => !sourcePaths.has(source))
      )
        throw new Error(`Invalid derivative source mapping: ${file.path}`);
      checkedPath(file.path);
      mapped.add(file.path);
    }
    const collect = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (!entry.isFile() || !mapped.delete(relative(root, path)))
          throw new Error(`Unmapped playbook resource: ${path}`);
      }
    };
    collect(join(root, adaptation.directory));
    if (mapped.size) throw new Error(`Missing playbook resources: ${[...mapped].join(", ")}`);
    const skill = readFileSync(join(root, adaptation.directory, "SKILL.md"), "utf8");
    if (/^name: (.+)$/m.exec(skill)?.[1] !== adaptation.name)
      throw new Error(`Playbook name does not match its directory: ${adaptation.name}`);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync(join(defaultRoot, "vendor/seatwork/provenance.json"), "utf8"));
  for (const file of manifest.files) {
    if (digest(readFileSync(join(defaultRoot, file.path))) !== file.sha256)
      throw new Error(`Vendored bytes changed: ${file.path}`);
  }
  console.log(
    `${manifest.skills.length} Seatwork skills / ${manifest.files.length} files verified against ${manifest.revision}`,
  );
  const overrides = await skillOverrides(defaultRoot, manifest);
  console.log(`${overrides.size} same-name Alliance adaptations mapped to unchanged Seatwork sources`);
  const adapted = verifyAdaptedPlaybooks();
  if (adapted)
    console.log(
      `${adapted.adaptations.length} adapted playbooks / ${adapted.files.length} raw files verified against ${adapted.revision}`,
    );
  const agy = JSON.parse(readFileSync(join(defaultRoot, "server/agy-native/provenance.json"), "utf8"));
  for (const file of agy.files) {
    if (digest(readFileSync(join(defaultRoot, file.path))) !== file.sha256)
      throw new Error(`Vendored AGY driver changed: ${file.path}`);
  }
  console.log(`AGY native driver verified against ${agy.package}@${agy.version}`);
}
