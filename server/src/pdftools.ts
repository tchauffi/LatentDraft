import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");
const VENV_PYTHON = path.join(SERVER_ROOT, ".venv", "bin", "python");
const PYTHON_BIN = process.env.PYTHON_BIN ?? VENV_PYTHON;

/** Run the venv python with an inline script; resolve stdout, reject on failure. */
function runPy(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const child = spawn(PYTHON_BIN, ["-c", script, ...args], {
      env: { ...process.env, MPLBACKEND: "Agg" },
    });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`Failed to launch Python (${PYTHON_BIN}): ${String(e)}`)));
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `python exited with code ${code}`));
    });
  });
}

export interface RenderedPage {
  /** PNG bytes, base64-encoded (for a multimodal tool result). */
  base64: string;
}

const RENDER_SCRIPT = `
import sys, fitz
pdf, out_prefix, max_pages, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
doc = fitz.open(pdf)
paths = []
for i in range(min(len(doc), max_pages)):
    pix = doc[i].get_pixmap(dpi=dpi)
    p = f"{out_prefix}-{i+1}.png"
    pix.save(p)
    paths.append(p)
print("\\n".join(paths))
`;

/** Render up to maxPages of a PDF to PNGs and return their bytes as base64. */
export async function renderPdf(
  pdfPath: string,
  outPrefix: string,
  maxPages = 3,
  dpi = 110,
): Promise<RenderedPage[]> {
  const out = await runPy(RENDER_SCRIPT, [pdfPath, outPrefix, String(maxPages), String(dpi)]);
  const paths = out.split("\n").map((s) => s.trim()).filter(Boolean);
  const pages: RenderedPage[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    pages.push({ base64: buf.toString("base64") });
  }
  return pages;
}

const EXTRACT_SCRIPT = `
import sys, fitz
doc = fitz.open(sys.argv[1])
parts = []
for page in doc:
    parts.append(page.get_text("text"))
sys.stdout.write("\\f".join(parts))
`;

/** Extract the selectable text layer of a PDF, one page per form-feed. */
export async function extractPdfText(pdfPath: string): Promise<string> {
  return runPy(EXTRACT_SCRIPT, [pdfPath]);
}
