import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

/** Markdown lines outside fenced code blocks. */
function prose(markdown: string) {
  let fenced = false;
  return markdown.split("\n").filter((line) => {
    if (line.startsWith("```")) fenced = !fenced;
    return !fenced;
  });
}

/** Heading anchors as GitHub renders them: lower case, punctuation dropped, repeats numbered. */
function anchors(markdown: string) {
  const seen = new Map<string, number>();
  for (const line of prose(markdown)) {
    const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const repeat = (seen.get(slug) ?? -1) + 1;
    seen.set(slug, repeat);
    if (repeat) seen.set(`${slug}-${repeat}`, 0);
  }
  return new Set(seen.keys());
}

test("links in the user docs and role texts reach an existing file and heading", async () => {
  const room = (await readdir(join(projectRoot, "room"), { recursive: true }))
    .filter((path) => path.endsWith(".md"))
    .map((path) => join("room", path));
  const docs = (await readdir(join(projectRoot, "docs")))
    .filter((path) => path.endsWith(".md"))
    .map((path) => join("docs", path));
  const broken: string[] = [];
  for (const file of ["README.md", ...docs, ...room]) {
    const source = join(projectRoot, file);
    for (const line of prose(await readFile(source, "utf8")))
      for (const [, link] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(link)) continue;
        const [path, anchor] = link.split("#");
        const target = path ? resolve(dirname(source), path) : source;
        if (!(await stat(target).catch(() => null))) broken.push(`${file}: ${link} (no such file)`);
        else if (anchor && target.endsWith(".md") && !anchors(await readFile(target, "utf8")).has(anchor))
          broken.push(`${file}: ${link} (no such heading)`);
      }
  }
  assert.deepEqual(broken, []);
});
