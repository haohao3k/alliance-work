import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

/** Host-local completion for the plugin's folder picker; no shell expansion or filesystem writes. */
export async function directorySuggestions(query: string, recent: string[] = [], home = homedir()) {
  const text = query.trim();
  const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (expanded && !isAbsolute(expanded)) throw new Error("Use an absolute path or ~/.");
  const path = expanded || home;
  const isDirectory = await stat(path)
    .then((value) => value.isDirectory())
    .catch(() => false);
  const current = isDirectory ? await realpath(path) : null;
  const parent = isDirectory ? path : dirname(path);
  const prefix = isDirectory ? "" : basename(path).toLowerCase();
  const entries = await readdir(parent, { withFileTypes: true });
  const directories = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.name.toLowerCase().startsWith(prefix) &&
          (!entry.name.startsWith(".") || prefix.startsWith(".")),
      )
      .map(async (entry) => {
        const candidate = join(parent, entry.name);
        const directory =
          entry.isDirectory() ||
          (entry.isSymbolicLink() &&
            (await stat(candidate)
              .then((value) => value.isDirectory())
              .catch(() => false)));
        return directory ? candidate : null;
      }),
  );
  const paths = [
    ...new Set([
      ...(!text ? recent : []),
      ...directories.filter((value): value is string => value !== null).sort((a, b) => a.localeCompare(b)),
    ]),
  ].slice(0, 30);
  return { current, parent: dirname(parent), paths };
}
