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

export interface PageLayout {
  /** 1-based page number. */
  page: number;
  /** Fraction of the page area covered by text blocks (0..1). */
  coverage: number;
  /** Content margins in points: distance from page edge to outermost text. */
  margins: { left: number; top: number; right: number; bottom: number } | null;
  /** Text blocks that cross the right/bottom page edge (clipped content). */
  overflowRight: number;
  overflowBottom: number;
  /** Number of characters of text on the page. */
  chars: number;
  imageCount: number;
}

export interface PdfLayout {
  pageCount: number;
  /** [width, height] of page 1 in points. */
  pageSize: [number, number] | null;
  pages: PageLayout[];
  /** "FontName 10.0pt" -> share of all characters (0..1), largest first. */
  fonts: [string, number][];
}

const LAYOUT_SCRIPT = `
import sys, json, fitz
doc = fitz.open(sys.argv[1])
pages = []
fonts = {}
for i, page in enumerate(doc):
    r = page.rect
    blocks = [b for b in page.get_text("blocks") if b[6] == 0]
    area = sum(max(0.0, (b[2]-b[0])) * max(0.0, (b[3]-b[1])) for b in blocks)
    chars = sum(len(b[4]) for b in blocks)
    margins = None
    if blocks:
        margins = {
            "left": round(min(b[0] for b in blocks) - r.x0, 1),
            "top": round(min(b[1] for b in blocks) - r.y0, 1),
            "right": round(r.x1 - max(b[2] for b in blocks), 1),
            "bottom": round(r.y1 - max(b[3] for b in blocks), 1),
        }
    pages.append({
        "page": i + 1,
        "coverage": round(area / (r.width * r.height), 3) if r.width and r.height else 0,
        "margins": margins,
        "overflowRight": sum(1 for b in blocks if b[2] > r.x1 + 1),
        "overflowBottom": sum(1 for b in blocks if b[3] > r.y1 + 1),
        "chars": chars,
        "imageCount": len(page.get_images(full=True)),
    })
    d = page.get_text("dict")
    for blk in d.get("blocks", []):
        if blk.get("type") != 0:
            continue
        for line in blk.get("lines", []):
            for span in line.get("spans", []):
                key = f"{span['font']} {round(span['size'], 1)}pt"
                fonts[key] = fonts.get(key, 0) + len(span.get("text", ""))
total = sum(fonts.values()) or 1
top_fonts = sorted(fonts.items(), key=lambda kv: -kv[1])[:8]
print(json.dumps({
    "pageCount": len(doc),
    "pageSize": [round(doc[0].rect.width), round(doc[0].rect.height)] if len(doc) else None,
    "pages": pages,
    "fonts": [[k, round(v / total, 3)] for k, v in top_fonts],
}))
`;

/** Measure the PDF's layout (margins, coverage, overflows, fonts) via PyMuPDF. */
export async function analyzePdfLayout(pdfPath: string): Promise<PdfLayout> {
  const out = await runPy(LAYOUT_SCRIPT, [pdfPath]);
  return JSON.parse(out) as PdfLayout;
}
