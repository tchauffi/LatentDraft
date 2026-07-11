import type { PdfLayout } from "./pdftools.js";

/**
 * Turn the compile log + a PyMuPDF layout measurement into a compact TEXT
 * report the model can act on. This is how the agent "sees" the PDF: none of
 * the usual local models have vision, so visual problems must be described —
 * overfull lines (with source line numbers straight from the TeX log), page
 * overflows, margins, near-empty pages, font usage.
 */

export interface BoxWarning {
  kind: "Overfull" | "Underfull";
  box: "hbox" | "vbox";
  /** e.g. "15.2pt too wide" or "badness 10000". */
  detail: string;
  /** Source location if the log carried one, e.g. "main.tex:23". */
  where?: string;
}

/**
 * Parse Overfull/Underfull box warnings out of a (Tectonic) LaTeX log.
 * Tectonic prefixes them with `warning: file:line:`; plain TeX logs carry
 * `at lines A--B` instead — both are captured.
 */
export function parseBoxWarnings(log: string): BoxWarning[] {
  const warnings: BoxWarning[] = [];
  const re =
    /(?:warning:\s*([^\s:]+):(\d+):\s*)?(Overfull|Underfull) \\([hv])box \(([^)]+)\)[^\n]*?(?:at lines (\d+)--(\d+)|at line (\d+))?(?=\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const [, file, fileLine, kind, hv, detail, lineA, lineB, lineSingle] = m;
    let where: string | undefined;
    if (file && fileLine) where = `${file}:${fileLine}`;
    else if (lineA) where = `line ${lineA}${lineB && lineB !== lineA ? `–${lineB}` : ""}`;
    else if (lineSingle) where = `line ${lineSingle}`;
    warnings.push({
      kind: kind as BoxWarning["kind"],
      box: (hv + "box") as BoxWarning["box"],
      detail,
      where,
    });
  }
  return warnings;
}

const PAPER_SIZES: Record<string, string> = {
  "612x792": "US Letter",
  "595x842": "A4",
  "598x845": "A4", // some engines round differently
};

function paperName(size: [number, number] | null): string {
  if (!size) return "unknown";
  return PAPER_SIZES[`${size[0]}x${size[1]}`] ?? `${size[0]}x${size[1]}pt`;
}

const pt2cm = (pt: number) => (pt / 28.35).toFixed(1);

/** Render the layout facts + box warnings as a compact report for the model. */
export function formatLayoutReport(layout: PdfLayout, log: string): string {
  const lines: string[] = [];
  lines.push(
    `${layout.pageCount} page(s), paper: ${paperName(layout.pageSize)}.`,
  );

  for (const p of layout.pages) {
    const bits: string[] = [`text covers ${Math.round(p.coverage * 100)}%`];
    if (p.margins) {
      bits.push(
        `margins L/R/T/B ${pt2cm(p.margins.left)}/${pt2cm(p.margins.right)}/${pt2cm(p.margins.top)}/${pt2cm(p.margins.bottom)}cm`,
      );
    }
    if (p.imageCount > 0) bits.push(`${p.imageCount} image(s)`);
    if (p.overflowRight > 0) bits.push(`⚠ ${p.overflowRight} block(s) CLIPPED at the right edge`);
    if (p.overflowBottom > 0) bits.push(`⚠ ${p.overflowBottom} block(s) CLIPPED at the bottom edge`);
    if (p.chars < 200 && layout.pageCount > 1) {
      bits.push("⚠ nearly empty — consider tightening the previous page(s) to absorb it");
    }
    lines.push(`Page ${p.page}: ${bits.join("; ")}.`);
  }

  const warnings = parseBoxWarnings(log);
  const overfullH = warnings.filter((w) => w.kind === "Overfull" && w.box === "hbox");
  const overfullV = warnings.filter((w) => w.kind === "Overfull" && w.box === "vbox");
  const underfull = warnings.filter((w) => w.kind === "Underfull");
  if (overfullH.length > 0) {
    const shown = overfullH
      .slice(0, 6)
      .map((w) => `${w.where ?? "?"} (${w.detail})`)
      .join(", ");
    lines.push(
      `⚠ ${overfullH.length} Overfull \\hbox — text sticking out past the right margin at: ${shown}${
        overfullH.length > 6 ? ", …" : ""
      }. Fixes: reword the line; for long unbreakable tokens (package names, URLs, paths) ` +
        `wrap them in \\url{...} with \\usepackage{xurl} (breaks anywhere) or insert manual ` +
        `break points; as a last resort wrap the paragraph in \\begin{sloppypar}...\\end{sloppypar}.`,
    );
  }
  if (overfullV.length > 0) {
    lines.push(`⚠ ${overfullV.length} Overfull \\vbox — content taller than the page.`);
  }
  if (underfull.length > 0) {
    lines.push(
      `${underfull.length} Underfull box warning(s) (loose spacing; often caused by '\\\\' used as a paragraph break — prefer blank lines).`,
    );
  }
  if (overfullH.length === 0 && overfullV.length === 0 && layout.pages.every((p) => p.overflowRight === 0 && p.overflowBottom === 0)) {
    lines.push("No overflow problems detected.");
  }

  if (layout.fonts.length > 0) {
    const fonts = layout.fonts
      .slice(0, 5)
      .map(([name, share]) => `${name} (${Math.round(share * 100)}%)`)
      .join(", ");
    lines.push(`Fonts: ${fonts}.`);
  }

  return lines.join("\n");
}
