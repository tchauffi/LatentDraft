import { gunzipSync } from "node:zlib";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { projectBuildDir } from "./compile.js";

/**
 * Minimal SyncTeX parser — just the subset needed for forward (source line →
 * PDF position) and inverse (PDF click → source line) search. The format
 * (from `tectonic --synctex`, gzipped):
 *
 *   Input:1:/abs/path/main.tex        tag table (tag 7 = sections/intro.tex)
 *   Unit:1 / X Offset:0 / Y Offset:0  preamble
 *   {1 … }                            page blocks
 *   (7,3:8799519,8868410:…            box/glue records: KIND tag,line:x,y:…
 *
 * Coordinates are in sp (65536 sp = 1 pt), origin top-left of the page.
 */

const SP_PER_PT = 65536;

export interface SyncRecord {
  page: number;
  tag: number;
  line: number;
  /** pt from the page's left edge. */
  x: number;
  /** pt from the page's top edge. */
  y: number;
}

export interface SyncTexData {
  /** tag → project-relative source path. */
  inputs: Map<number, string>;
  records: SyncRecord[];
}

/** Record lines start with a box/glue kind: [ ( h v x k g $ */
const RECORD = /^[[(hvxkg$](\d+),(\d+):(-?\d+),(-?\d+)/;

export function parseSyncTex(content: string, baseDir: string): SyncTexData {
  const inputs = new Map<number, string>();
  const records: SyncRecord[] = [];
  let page = 0;
  for (const line of content.split("\n")) {
    if (line.startsWith("Input:")) {
      const m = /^Input:(\d+):(.+)$/.exec(line);
      if (m) {
        const raw = m[2].trim();
        const rel = path.isAbsolute(raw)
          ? path.relative(baseDir, raw).split(path.sep).join("/")
          : raw.replace(/^\.\//, "");
        // Files outside the project (class/style internals) are not jump targets.
        if (rel && !rel.startsWith("..")) inputs.set(Number(m[1]), rel);
      }
      continue;
    }
    if (line.startsWith("{")) {
      page = Number(line.slice(1)) || page;
      continue;
    }
    if (page === 0) continue;
    const m = RECORD.exec(line);
    if (m) {
      records.push({
        page,
        tag: Number(m[1]),
        line: Number(m[2]),
        x: Number(m[3]) / SP_PER_PT,
        y: Number(m[4]) / SP_PER_PT,
      });
    }
  }
  return { inputs, records };
}

/** Source line → PDF position. Picks the record closest to the requested
 * line, preferring the first one at or after it. */
export function forwardSearch(
  data: SyncTexData,
  file: string,
  line: number,
): { page: number; x: number; y: number } | undefined {
  let tag: number | undefined;
  for (const [t, p] of data.inputs) {
    if (p === file) {
      tag = t;
      break;
    }
  }
  if (tag === undefined) return undefined;
  // Lower score = better: lines at/after the target win over lines before it.
  const score = (l: number) => (l >= line ? l - line : 1_000_000 + (line - l));
  let best: SyncRecord | undefined;
  for (const r of data.records) {
    if (r.tag !== tag) continue;
    if (!best || score(r.line) < score(best.line)) best = r;
  }
  return best ? { page: best.page, x: best.x, y: best.y } : undefined;
}

/** PDF position (pt, top-left origin) → source file + line. */
export function reverseSearch(
  data: SyncTexData,
  page: number,
  x: number,
  y: number,
): { file: string; line: number } | undefined {
  let best: SyncRecord | undefined;
  let bestDist = Infinity;
  for (const r of data.records) {
    if (r.page !== page || !data.inputs.has(r.tag)) continue;
    // Vertical distance dominates: a click targets a LINE, not a column.
    const d = Math.abs(r.y - y) * 4 + Math.abs(r.x - x);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best ? { file: data.inputs.get(best.tag)!, line: best.line } : undefined;
}

const cache = new Map<string, { mtimeMs: number; data: SyncTexData }>();

/** Parsed synctex for a project's last build, cached by file mtime. */
export async function loadProjectSyncTex(projectDir: string): Promise<SyncTexData | undefined> {
  const file = path.join(projectBuildDir(projectDir), "main.synctex.gz");
  try {
    const st = await stat(file);
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
    const data = parseSyncTex(gunzipSync(await readFile(file)).toString("utf8"), projectDir);
    cache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return undefined; // never compiled with synctex yet
  }
}
