import { cp, mkdir, readdir, readFile, writeFile, stat, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { safeRelPath } from "./compile.js";
import { TEMPLATES, DEFAULT_TEMPLATE } from "./templates.js";

/**
 * A project is a PLAIN DIRECTORY under PROJECTS_ROOT — no manifest, no
 * database. The folder is the source of truth: users can git-init it, edit it
 * with other tools, or drop an existing paper in. Build artifacts live in
 * `.latentdraft/` inside the project (gitignored at creation).
 */
export const PROJECTS_ROOT =
  process.env.PROJECTS_ROOT ?? path.join(os.homedir(), "LatentDraft");

/** Directories never listed or writable through the file API. */
const HIDDEN_DIRS = new Set([".latentdraft", ".git"]);

/** Files served/edited as text; everything else is binary (preview-only).
 * Dotfiles (.gitignore) are text. */
const TEXT_EXT = /(\.(tex|bib|sty|cls|txt|md|csv|tsv|json|dat|mmd|py|sh|yml|yaml)|(^|\/)\.[a-z]+)$/i;

export function isTextPath(rel: string): boolean {
  return TEXT_EXT.test(rel);
}

export interface ProjectInfo {
  id: string;
  /** Directory mtime — a cheap "last touched" for sorting the switcher. */
  mtimeMs: number;
  /** Document title from main.tex's \title{…}, when one is set. */
  title?: string;
}

export interface ProjectFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  /** True when the file should be previewed, not opened in the editor. */
  binary: boolean;
}

/** Project ids are directory names: simple, no slashes, no dot-prefix. */
export function safeProjectId(id: string): string | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,63}$/.test(id)) return undefined;
  return id;
}

/** Turn a display name into a usable project id. */
export function slugifyProjectName(name: string): string | undefined {
  const slug = name
    .trim()
    .replace(/[^a-zA-Z0-9._ -]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 64);
  return safeProjectId(slug);
}

export function projectDir(id: string): string | undefined {
  if (!safeProjectId(id)) return undefined;
  return path.join(PROJECTS_ROOT, id);
}

/**
 * Validate a path within a project for the file API: structurally safe AND
 * not inside a hidden dir (build artifacts, .git internals).
 */
export function safeProjectFilePath(rel: string): string | undefined {
  const norm = safeRelPath(rel);
  if (!norm) return undefined;
  const top = norm.split("/")[0];
  if (HIDDEN_DIRS.has(top)) return undefined;
  return norm;
}

/**
 * Pull the document title out of a main.tex preamble. One level of nested
 * braces is enough for real titles; formatting commands are stripped for
 * display. Returns undefined when there's no usable title.
 */
export function extractTexTitle(tex: string): string | undefined {
  const m = tex.match(/\\title\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
  if (!m) return undefined;
  const title = m[1]
    .replace(/\\\\/g, " ")
    .replace(/\\[a-zA-Z@]+\*?\s*/g, "")
    .replace(/[{}~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return title || undefined;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  let names: string[];
  try {
    names = await readdir(PROJECTS_ROOT);
  } catch {
    return []; // root not created yet
  }
  const projects: ProjectInfo[] = [];
  for (const name of names) {
    if (!safeProjectId(name)) continue;
    try {
      const st = await stat(path.join(PROJECTS_ROOT, name));
      if (!st.isDirectory()) continue;
      let title: string | undefined;
      try {
        const main = await readFile(path.join(PROJECTS_ROOT, name, "main.tex"), "utf8");
        title = extractTexTitle(main);
      } catch {
        /* no main.tex — the id is the only name */
      }
      projects.push({ id: name, mtimeMs: st.mtimeMs, title });
    } catch {
      /* raced */
    }
  }
  return projects.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Rename a project DIRECTORY. The new name goes through the same slugify as
 * creation; renaming onto an existing project is refused.
 */
export async function renameProject(
  id: string,
  newName: string,
): Promise<{ id: string } | { error: string }> {
  const from = projectDir(id);
  if (!from) return { error: "Invalid project." };
  const newId = slugifyProjectName(newName);
  if (!newId) return { error: "Project names need at least one letter or digit." };
  if (newId === id) return { id };
  const to = path.join(PROJECTS_ROOT, newId);
  try {
    await stat(to);
    return { error: `A project named '${newId}' already exists.` };
  } catch {
    /* target free */
  }
  try {
    await rename(from, to);
    return { id: newId };
  } catch (err) {
    return { error: String(err) };
  }
}

/**
 * Copy a project into "<id> copy" (then "<id> copy 2", …). Build artifacts
 * and git history stay behind — the copy is a fresh draft of the sources.
 */
export async function duplicateProject(
  id: string,
): Promise<{ id: string } | { error: string }> {
  const src = projectDir(id);
  if (!src) return { error: "Invalid project." };
  try {
    if (!(await stat(src)).isDirectory()) return { error: "Project not found." };
  } catch {
    return { error: "Project not found." };
  }
  for (let n = 1; n <= 99; n++) {
    const newId = slugifyProjectName(n === 1 ? `${id} copy` : `${id} copy ${n}`);
    if (!newId || newId === id) return { error: "Could not derive a name for the copy." };
    const dest = path.join(PROJECTS_ROOT, newId);
    try {
      await mkdir(dest, { recursive: false }); // claims the name atomically
    } catch {
      continue; // taken — try the next suffix
    }
    await cp(src, dest, {
      recursive: true,
      filter: (p) => p === src || !HIDDEN_DIRS.has(path.basename(p)),
    });
    return { id: newId };
  }
  return { error: "Too many copies of this project already exist." };
}

/* ---- Per-project chat history: .latentdraft/chat.json. Lives in the hidden
   build dir, so it never shows in the file tree and travels with the folder
   (rename) or dies with it (delete). ---- */

export async function readProjectChat(id: string): Promise<unknown[] | undefined> {
  const dir = projectDir(id);
  if (!dir) return undefined;
  try {
    const raw = await readFile(path.join(dir, ".latentdraft", "chat.json"), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // no history yet (or unreadable) — an empty conversation
  }
}

export async function writeProjectChat(
  id: string,
  messages: unknown[],
): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  if (!dir) return { ok: false, error: "Invalid project." };
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, error: "Project not found." };
  } catch {
    return { ok: false, error: "Project not found." };
  }
  try {
    const target = path.join(dir, ".latentdraft", "chat.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(messages), "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Delete a whole project directory — build artifacts, .git and all. */
export async function deleteProject(id: string): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  if (!dir) return { ok: false, error: "Invalid project." };
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return { ok: false, error: "Project not found." };
  } catch {
    return { ok: false, error: "Project not found." };
  }
  try {
    await rm(dir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Escape LaTeX-special characters so a project name is safe in \title{…}. */
function texEscape(s: string): string {
  return s.replace(/([&%$#_{}])/g, "\\$1").replace(/~/g, "\\textasciitilde{}");
}

/**
 * Create a project directory seeded from a template, plus a .gitignore that
 * hides the build dir. Fails if the directory already exists.
 */
export async function createProject(
  name: string,
  template = DEFAULT_TEMPLATE,
): Promise<{ id: string } | { error: string }> {
  const id = slugifyProjectName(name);
  if (!id) return { error: "Project names need at least one letter or digit." };
  const files = TEMPLATES[template];
  if (!files) return { error: `Unknown template '${template}'.` };
  const dir = path.join(PROJECTS_ROOT, id);
  try {
    await mkdir(dir, { recursive: false });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return { error: `A project named '${id}' already exists.` };
    // Root may not exist yet — create it and retry once.
    if (code === "ENOENT") {
      await mkdir(dir, { recursive: true });
    } else {
      throw err;
    }
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    // Seed the document title with the project's name instead of a placeholder.
    const seeded =
      rel === "main.tex"
        ? content.replace("\\title{Untitled}", `\\title{${texEscape(name.trim())}}`)
        : content;
    await writeFile(target, seeded, "utf8");
  }
  await writeFile(path.join(dir, ".gitignore"), ".latentdraft/\n", { flag: "wx" }).catch(() => {});
  return { id };
}

export async function listProjectFiles(id: string): Promise<ProjectFileInfo[] | undefined> {
  const dir = projectDir(id);
  if (!dir) return undefined;
  return listFilesInDir(dir);
}

/** Walk an absolute project directory (also used by the agent's list_files). */
export async function listFilesInDir(dir: string): Promise<ProjectFileInfo[] | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return undefined; // project doesn't exist
  }
  const files: ProjectFileInfo[] = [];
  for (const name of names) {
    const rel = name.split(path.sep).join("/");
    if (HIDDEN_DIRS.has(rel.split("/")[0])) continue;
    if (path.basename(rel).startsWith("_")) continue; // agent scratch files
    try {
      const st = await stat(path.join(dir, name));
      if (st.isFile()) {
        files.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs, binary: !TEXT_EXT.test(rel) });
      }
    } catch {
      /* raced */
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * All directories in a project (project-relative, sorted), so the file tree
 * can show EMPTY folders too — `listFilesInDir` alone can't represent them.
 */
export async function listDirsInDir(dir: string): Promise<string[] | undefined> {
  let names: string[];
  try {
    names = (await readdir(dir, { recursive: true })) as string[];
  } catch {
    return undefined; // project doesn't exist
  }
  const dirs: string[] = [];
  for (const name of names) {
    const rel = name.split(path.sep).join("/");
    if (HIDDEN_DIRS.has(rel.split("/")[0])) continue;
    try {
      if ((await stat(path.join(dir, name))).isDirectory()) dirs.push(rel);
    } catch {
      /* raced */
    }
  }
  return dirs.sort();
}

/** Create a directory in a project (parents included; already-exists is fine). */
export async function createProjectDir(
  id: string,
  rel: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  const norm = rel && safeProjectFilePath(rel);
  if (!dir || !norm) return { ok: false, error: "Invalid project or path." };
  try {
    if (!(await stat(dir)).isDirectory()) return { ok: false, error: "Project not found." };
  } catch {
    return { ok: false, error: "Project not found." };
  }
  try {
    await mkdir(path.join(dir, norm), { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Delete a project directory AND its contents. */
export async function deleteProjectDir(
  id: string,
  rel: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  const norm = rel && safeProjectFilePath(rel);
  if (!dir || !norm) return { ok: false, error: "Invalid project or path." };
  const target = path.join(dir, norm);
  try {
    if (!(await stat(target)).isDirectory()) return { ok: false, error: "Not a directory." };
  } catch {
    return { ok: false, error: "Directory not found." };
  }
  try {
    await rm(target, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function readProjectFile(
  id: string,
  rel: string,
): Promise<{ data: Buffer; mtimeMs: number } | undefined> {
  const dir = projectDir(id);
  const norm = rel && safeProjectFilePath(rel);
  if (!dir || !norm) return undefined;
  const target = path.join(dir, norm);
  try {
    const [data, st] = await Promise.all([readFile(target), stat(target)]);
    return { data, mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

export type WriteResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: { mtimeMs: number; content: string } }
  | { ok: false; error: string };

/**
 * Write a file, guarding against clobbering an EXTERNAL edit: when the caller
 * supplies the mtime its buffer was based on and the file on disk has moved
 * past it (git pull, another editor), the write is refused and the disk
 * content returned so the client can offer "reload from disk".
 */
export async function writeProjectFile(
  id: string,
  rel: string,
  data: Buffer,
  baseMtimeMs?: number,
): Promise<WriteResult> {
  const dir = projectDir(id);
  const norm = rel && safeProjectFilePath(rel);
  if (!dir || !norm) return { ok: false, error: "Invalid project or path." };
  const target = path.join(dir, norm);

  if (baseMtimeMs !== undefined) {
    try {
      const st = await stat(target);
      // mtime equality = no conflict (some filesystems have 1s granularity).
      if (st.mtimeMs > baseMtimeMs) {
        const content = (await readFile(target)).toString("utf8");
        return { ok: false, conflict: { mtimeMs: st.mtimeMs, content } };
      }
    } catch {
      /* file doesn't exist yet — nothing to conflict with */
    }
  }

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  const st = await stat(target);
  return { ok: true, mtimeMs: st.mtimeMs };
}

export async function renameProjectFile(
  id: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  const fromNorm = from && safeProjectFilePath(from);
  const toNorm = to && safeProjectFilePath(to);
  if (!dir || !fromNorm || !toNorm) return { ok: false, error: "Invalid project or path." };
  try {
    const targetTo = path.join(dir, toNorm);
    await mkdir(path.dirname(targetTo), { recursive: true });
    await rename(path.join(dir, fromNorm), targetTo);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function deleteProjectFile(
  id: string,
  rel: string,
): Promise<{ ok: boolean; error?: string }> {
  const dir = projectDir(id);
  const norm = rel && safeProjectFilePath(rel);
  if (!dir || !norm) return { ok: false, error: "Invalid project or path." };
  if (norm === "main.tex") return { ok: false, error: "main.tex is the compile target — it cannot be deleted." };
  try {
    await rm(path.join(dir, norm));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
