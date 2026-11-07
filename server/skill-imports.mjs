import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { SkillPath } from "../shared/skill-settings.mjs";
import { assertNoLinks } from "./profile-integrity.mjs";
import { projectSkills } from "./project-skills.mjs";
import { projectSkillSettings, withSkillLock, writeSkillSelection } from "./skill-settings.mjs";

const execute = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safePath = (value) =>
  value === "" ||
  value
    .split("/")
    .every(
      (p) => p && p !== "." && p !== ".." && !p.includes("\\") && ![...p].some((c) => c.charCodeAt(0) < 32),
    );

// Parse a source, never evaluate pasted command text. Project installs have no global/agent flags.
export function parseSkillSource(input) {
  let source = input.trim();
  let names = [];
  if (/^npx\s/.test(source)) {
    const match =
      /^npx\s+skills(?:@latest)?\s+add\s+(\S+)(?:\s+--skill\s+([a-z0-9-]+(?:\s+[a-z0-9-]+)*))?$/.exec(source);
    if (!match)
      throw new Error("Use npx skills add owner/repo [--skill name], without other shell commands or flags");
    source = match[1];
    names = match[2]?.split(/\s+/) ?? [];
  }
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source)) source = `https://github.com/${source}`;
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Enter a GitHub repository URL or owner/repo");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTPS github.com repository or tree URL");
  const parts = url.pathname.replace(/\/$/, "").slice(1).split("/").map(decodeURIComponent);
  const [owner, repoRaw, kind, ref, ...rest] = parts;
  const repo = repoRaw?.replace(/\.git$/, "");
  if (
    !owner ||
    !repo ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(owner) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(repo)
  )
    throw new Error("Invalid GitHub owner/repository");
  if (
    kind &&
    (!["tree", "blob"].includes(kind) ||
      !ref ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref) ||
      ref.includes(".."))
  )
    throw new Error("Use a repository URL or /tree/REF/path URL");
  if (kind === "blob") {
    if (rest.at(-1) !== "SKILL.md") throw new Error("A file URL must point to SKILL.md");
    rest.pop();
  }
  const path = rest.join("/");
  if (!safePath(path)) throw new Error("Invalid skill source path");
  return { repository: `https://github.com/${owner}/${repo}.git`, ref: ref ?? "HEAD", path, names };
}

async function git(cwd, args, binary = false) {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    timeout: 120000,
    maxBuffer: 17 * 1024 * 1024,
    encoding: binary ? "buffer" : "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  });
  return stdout;
}

// Fetch objects only: no checkout, submodules, hooks, npm packages or skill scripts execute.
async function withSource(input, commit, action) {
  const source = parseSkillSource(input);
  if (commit && !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source commit");
  const temp = await mkdtemp(join(await realpath(tmpdir()), "alliance-skill-import-"));
  try {
    const repo = join(temp, "repository.git");
    await git(temp, ["init", "--bare", "--template=", repo]);
    await git(repo, ["fetch", "--depth=1", "--no-tags", source.repository, commit ?? source.ref]);
    const sha = (await git(repo, ["rev-parse", "FETCH_HEAD^{commit}"])).trim();
    if (commit && sha !== commit) throw new Error("Source commit changed");
    const tree = (await git(repo, ["ls-tree", "-rz", "--full-tree", sha]))
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        if (!match || !safePath(match[4])) throw new Error("Unsupported repository path");
        return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
      });
    const candidates = tree.filter(
      (e) =>
        (e.path === "SKILL.md" || e.path.endsWith("/SKILL.md")) &&
        (!source.path || e.path === `${source.path}/SKILL.md` || e.path.startsWith(`${source.path}/`)),
    );
    if (candidates.length > 100)
      throw new Error("More than 100 skills found; paste a link to a narrower GitHub directory");
    return await action({ source, commit: sha, temp, repo, tree, candidates });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function loadRemoteSkill(context, entry) {
  const path = entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length);
  const files = context.tree.filter((e) => !path || e.path.startsWith(`${path}/`));
  if (files.length > 1000) throw new Error("Skill exceeds 1000 files");
  const contents = [];
  let bytes = 0;
  for (const file of files) {
    if (!["100644", "100755"].includes(file.mode) || file.type !== "blob")
      throw new Error("Skill contains a symlink, submodule or unsupported file");
    const size = Number((await git(context.repo, ["cat-file", "-s", file.oid])).trim());
    bytes += size;
    if (bytes > 16 * 1024 * 1024) throw new Error("Skill exceeds 16 MiB");
    const content = await git(context.repo, ["cat-file", "blob", file.oid], true);
    contents.push({
      path: path ? file.path.slice(path.length + 1) : file.path,
      content,
      mode: file.mode === "100755" ? 0o700 : 0o600,
    });
  }
  const body = contents.find((e) => e.path === "SKILL.md")?.content.toString();
  if (!body || Buffer.byteLength(body) > 256 * 1024)
    throw new Error("SKILL.md is missing or exceeds 256 KiB");
  const metadata = parse(body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "");
  const name = metadata?.name;
  SkillPath.parse(`.agents/skills/${name}`);
  if (name.startsWith("slp-") || name.startsWith("alliance-"))
    throw new Error("Reserved Alliance skill name");
  if (typeof metadata?.description !== "string" || !metadata.description.trim())
    throw new Error("Skill description is required");
  const digest = hash(
    JSON.stringify(contents.map((f) => ({ path: f.path, mode: f.mode, digest: hash(f.content) }))),
  );
  return { path, name, description: metadata.description, body, digest, bytes, files: contents };
}

export async function previewSkillImport(input) {
  return withSource(input, undefined, async (context) => {
    const skills = [],
      errors = [];
    let total = 0;
    for (const entry of context.candidates) {
      try {
        const { files, ...skill } = await loadRemoteSkill(context, entry);
        total += skill.bytes;
        if (total > 32 * 1024 * 1024) throw new Error("Preview exceeds 32 MiB; use a narrower directory");
        if (!context.source.names.length || context.source.names.includes(skill.name)) skills.push(skill);
      } catch (error) {
        errors.push({ path: entry.path, error: error.message });
      }
      if (total > 32 * 1024 * 1024) break;
    }
    for (const name of context.source.names)
      if (!skills.some((s) => s.name === name))
        errors.push({ path: name, error: "Requested skill was not found or is invalid" });
    return { source: input, repository: context.source.repository, commit: context.commit, skills, errors };
  });
}

export async function installProjectSkills(cwd, input, commit, requested, revision) {
  if (
    !requested.length ||
    requested.length > 100 ||
    new Set(requested.map((s) => s.path)).size !== requested.length
  )
    throw new Error("Choose unique skills to install");
  return withSource(input, commit, async (context) => {
    const skills = [];
    let bytes = 0;
    for (const request of requested) {
      const candidate = context.candidates.find(
        (e) => e.path === (request.path ? `${request.path}/SKILL.md` : "SKILL.md"),
      );
      if (!candidate) throw new Error("Selected skill is outside the source preview");
      const skill = await loadRemoteSkill(context, candidate);
      if (skill.digest !== request.digest) throw new Error("Skill content changed; preview again");
      bytes += skill.bytes;
      if (bytes > 16 * 1024 * 1024) throw new Error("Selected skills exceed 16 MiB");
      if (skills.some((s) => s.name === skill.name)) throw new Error("Selected skills have duplicate names");
      skills.push(skill);
    }
    return withSkillLock(cwd, async (root, lock) => {
      const current = await projectSkillSettings(root);
      if (current.revision !== revision) throw new Error("Project skills changed; reload before installing");
      const destinations = skills.map((s) => join(root, ".agents/skills", s.name));
      for (const destination of destinations) {
        await assertNoLinks(destination);
        const exists = await lstat(destination).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (exists)
          throw new Error(`Skill already exists: ${destination}. Existing files are never overwritten.`);
      }
      const staged = join(context.temp, "project");
      for (const skill of skills) {
        const directory = join(staged, ".agents/skills", skill.name);
        for (const file of skill.files) {
          const target = join(directory, file.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content, { mode: file.mode, flag: "wx" });
        }
        const provenance = {
          repository: context.source.repository,
          commit,
          path: skill.path,
          digest: skill.digest,
        };
        await writeFile(
          join(directory, ".alliance-source.json"),
          `${JSON.stringify(provenance, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
      }
      // Validate staged resources using exactly the runtime loader before touching project files.
      await projectSkills(staged, { version: 1, skills: skills.map((s) => `.agents/skills/${s.name}`) });
      const installed = [];
      try {
        for (const skill of skills) {
          const destination = join(root, ".agents/skills", skill.name);
          await mkdir(dirname(destination), { recursive: true });
          // Reserve the target atomically; do not replace a directory created by another process.
          await mkdir(destination);
          installed.push(destination);
          for (const file of skill.files) {
            const target = join(destination, file.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.content, { mode: file.mode, flag: "wx" });
          }
          await writeFile(
            join(destination, ".alliance-source.json"),
            `${JSON.stringify({ repository: context.source.repository, commit, path: skill.path, digest: skill.digest }, null, 2)}\n`,
            { mode: 0o600, flag: "wx" },
          );
        }
        await writeSkillSelection(root, lock, [
          ...current.selected,
          ...skills.map((s) => `.agents/skills/${s.name}`),
        ]);
      } catch (error) {
        for (const destination of installed) await rm(destination, { recursive: true, force: true });
        throw error;
      }
      return projectSkillSettings(root);
    });
  });
}
