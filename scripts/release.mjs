import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { run } from "./distribution.mjs";
import { projectRoot } from "./profiles.mjs";

const pkg = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
if (run("git", ["status", "--porcelain"], { cwd: projectRoot }).trim())
  throw new Error("Commit the candidate before packaging; the archive must match the checked revision.");
const committed = JSON.parse(run("git", ["show", "HEAD:package.json"], { cwd: projectRoot }));
if (pkg.version !== committed.version) throw new Error("Working version differs from HEAD.");
const output = resolve(process.argv[2] ?? join(projectRoot, "dist"));
await mkdir(output, { recursive: true });
const name = `alliance-work-v${pkg.version}.tar.gz`;
run("git", ["archive", "--format=tar.gz", "--prefix=alliance-work/", "-o", join(output, name), "HEAD"], {
  cwd: projectRoot,
});
const hash = createHash("sha256")
  .update(await readFile(join(output, name)))
  .digest("hex");
await writeFile(join(output, "checksums.txt"), `${hash}  ${name}\n`);
await copyFile(join(projectRoot, "install.sh"), join(output, "install.sh"));
console.log(
  `Packaged v${pkg.version} from ${run("git", ["rev-parse", "HEAD"], { cwd: projectRoot }).trim()} in ${output}`,
);
