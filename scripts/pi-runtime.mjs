import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Each release owns fresh npm-installed runtime bytes. Role homes own all mutable state.
export async function bundledPi(root) {
  const pkg = await readFile(join(root, "package.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!pkg?.devDependencies?.["@earendil-works/pi-coding-agent"]) return null;
  return {
    executable: join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    extensions: [
      "@iznogoudd/pi-devin/extensions/index.ts",
      "pi-antigravity/src/index.ts",
      "@iznogoudd/pi-cursor/dist/index.js",
    ].map((entry) => join(root, "node_modules", entry)),
  };
}
