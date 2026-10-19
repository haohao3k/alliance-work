import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("vendor/seatwork/provenance.json", root), "utf8"));
for (const file of manifest.files) {
  const digest = createHash("sha256")
    .update(readFileSync(new URL(file.path, root)))
    .digest("hex");
  if (digest !== file.sha256) throw new Error(`Vendored bytes changed: ${file.path}`);
}
console.log(
  `${manifest.skills.length} Seatwork skills / ${manifest.files.length} files verified against ${manifest.revision}`,
);

const agy = JSON.parse(readFileSync(new URL("server/agy-native/provenance.json", root), "utf8"));
for (const file of agy.files) {
  const actual = createHash("sha256")
    .update(readFileSync(new URL(file.path, root)))
    .digest("hex");
  if (actual !== file.sha256) throw new Error(`Vendored AGY driver changed: ${file.path}`);
}
console.log(`AGY native driver verified against ${agy.package}@${agy.version}`);
