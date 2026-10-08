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
