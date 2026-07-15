import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Agent Skills: user-authored instruction packs in the Claude Code SKILL.md
 * format — `<root>/<name>/SKILL.md` with YAML frontmatter (`description:`
 * required, `name:` optional) followed by a markdown instruction body. Skills
 * written for Claude Code load unchanged: unknown frontmatter keys
 * (allowed-tools, metadata, …) are simply ignored.
 *
 * Two roots: a global one for all projects, and `.latentdraft/skills/` inside
 * the current project (which wins on a name clash). Invalid skills are skipped
 * with a warning — a broken SKILL.md must never break the chat.
 */
export const SKILLS_ROOT =
  process.env.SKILLS_ROOT ?? path.join(os.homedir(), ".latentdraft", "skills");

/** Per-project skills live next to the other .latentdraft artifacts. */
export function projectSkillsDir(projectDir: string): string {
  return path.join(projectDir, ".latentdraft", "skills");
}

export interface Skill {
  /** Slash-command-safe name: lowercase [a-z0-9-]. */
  name: string;
  /** One-liner used for autocomplete AND for the model to decide relevance. */
  description: string;
  /** The instruction body (SKILL.md minus frontmatter). */
  body: string;
  source: "global" | "project";
}

// A skill body is a prompt — anything beyond this is misuse, not instructions.
const MAX_BODY_BYTES = 64 * 1024;

/** Normalize a folder name into a usable skill name, or undefined. */
function normalizeName(raw: string): string | undefined {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
}

/**
 * Pull `name:` and `description:` out of a `---`-delimited frontmatter block.
 * Deliberately minimal: single-line string values (optionally quoted) are all
 * the spec needs here; every other key/shape is ignored, not rejected.
 */
export function parseSkillMd(
  raw: string,
): { name?: string; description?: string; body: string } | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return undefined; // no frontmatter — not a skill file
  const fields: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) continue; // nested/multiline values belong to keys we don't read
    let value = kv[2].trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    fields[kv[1].toLowerCase()] = value;
  }
  return { name: fields.name, description: fields.description, body: m[2].trim() };
}

/** Load the valid skills under one root; invalid entries warn and are skipped. */
async function listSkillsIn(root: string, source: Skill["source"]): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // root not created yet
  }
  const skills: Skill[] = [];
  for (const entry of entries.sort()) {
    const file = path.join(root, entry, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue; // not a skill folder (plain file, or no SKILL.md)
    }
    const warn = (why: string) => console.warn(`[skills] skipping ${file}: ${why}`);
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      warn(`larger than ${MAX_BODY_BYTES / 1024}KB`);
      continue;
    }
    const parsed = parseSkillMd(raw);
    if (!parsed) {
      warn("missing --- frontmatter block");
      continue;
    }
    const name = normalizeName(parsed.name || entry);
    if (!name) {
      warn("no usable name (frontmatter or folder)");
      continue;
    }
    if (!parsed.description) {
      warn("frontmatter has no description");
      continue;
    }
    if (!parsed.body) {
      warn("empty instruction body");
      continue;
    }
    skills.push({ name, description: parsed.description, body: parsed.body, source });
  }
  return skills;
}

/**
 * All skills visible to a chat turn: global ones plus, in project mode, the
 * project's own — which shadow a global skill of the same name.
 */
export async function listSkills(projectDir?: string): Promise<Skill[]> {
  const [global, project] = await Promise.all([
    listSkillsIn(SKILLS_ROOT, "global"),
    projectDir ? listSkillsIn(projectSkillsDir(projectDir), "project") : Promise.resolve([]),
  ]);
  const byName = new Map<string, Skill>();
  for (const s of [...global, ...project]) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
