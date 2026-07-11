import { spawn } from "node:child_process";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDir } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const MMDC_BIN = process.env.MMDC_BIN ?? path.join(REPO_ROOT, "node_modules", ".bin", "mmdc");
const TIMEOUT_MS = 60_000;

export interface MermaidResult {
  ok: boolean;
  /** mmdc's combined output — mermaid syntax errors land here. */
  output: string;
  /** Created PNG filename (relative to the session dir) when ok. */
  file?: string;
}

/** Force a safe, simple PNG basename; undefined if it can't be salvaged. */
function safePngName(name: string | undefined): string | undefined {
  const base = (name ?? "diagram.png").trim().replace(/\.png$/i, "");
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(base) || base.startsWith(".")) return undefined;
  return `${base}.png`;
}

/**
 * Render a Mermaid diagram to a PNG inside the session's compile directory
 * (next to main.tex), so `\includegraphics{<file>}` resolves. Uses the
 * vendored mermaid-cli; Chromium runs with --no-sandbox because Ubuntu's
 * AppArmor blocks unprivileged user namespaces — acceptable for a
 * localhost-only server rendering the agent's own diagram source.
 */
export async function renderMermaid(
  sessionId: string,
  code: string,
  filename?: string,
): Promise<MermaidResult> {
  return renderMermaidIn(sessionDir(sessionId), code, filename);
}

/** Same, but in an explicit working directory (a project dir). */
export async function renderMermaidIn(
  dir: string,
  code: string,
  filename?: string,
): Promise<MermaidResult> {
  const file = safePngName(filename);
  if (!file) {
    return { ok: false, output: `Bad filename — use a simple name like "diagram.png".` };
  }
  await mkdir(dir, { recursive: true });
  // The model often wraps the source in ```mermaid fences — strip them.
  const source = code.replace(/^\s*```(?:mermaid)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  const srcPath = path.join(dir, "_diagram.mmd");
  const cfgPath = path.join(dir, "_puppeteer.json");
  await writeFile(srcPath, source, "utf8");
  await writeFile(cfgPath, JSON.stringify({ args: ["--no-sandbox", "--disable-setuid-sandbox"] }));

  const args = [
    "-i", srcPath,
    "-o", path.join(dir, file),
    "-b", "white", // transparent PNGs look broken on the printed page
    "-s", "3", // ~3x scale for print-quality raster
    "-p", cfgPath,
  ];

  return new Promise<MermaidResult>((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(MMDC_BIN, args, { cwd: dir });
    } catch (err) {
      resolve({ ok: false, output: `Failed to launch mermaid-cli (${MMDC_BIN}): ${String(err)}` });
      return;
    }
    const timer = setTimeout(() => {
      out += `\n[killed: rendering exceeded ${TIMEOUT_MS / 1000}s]`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${out}\nmermaid-cli process error: ${String(err)}` });
    });
    child.on("close", async (code_) => {
      clearTimeout(timer);
      if (code_ !== 0) {
        resolve({ ok: false, output: out.trim() || `mmdc exited with code ${code_}` });
        return;
      }
      try {
        await access(path.join(dir, file));
        resolve({ ok: true, output: out.trim(), file });
      } catch {
        resolve({ ok: false, output: `${out}\nmmdc succeeded but ${file} was not created.` });
      }
    });
  });
}
