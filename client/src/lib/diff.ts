import type { ProposedEdit } from "./api";

let counter = 0;
function localId(): string {
  counter += 1;
  return `edit-${Date.now()}-${counter}`;
}

/**
 * Parse fallback edit blocks emitted by models that can't call tools:
 *
 * ```latex-edit
 * @@ explanation: <reason>
 * <<<<<<< OLD
 * old text
 * =======
 * new text
 * >>>>>>> NEW
 * ```
 */
export function parseLatexEditBlocks(text: string): ProposedEdit[] {
  const edits: ProposedEdit[] = [];
  const fence = /```latex-edit\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1];
    const explMatch = body.match(/@@ *explanation: *(.*)/);
    const explanation = explMatch ? explMatch[1].trim() : "";
    const blockMatch = body.match(
      /<<<<<<< OLD\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> NEW/,
    );
    if (!blockMatch) continue;
    edits.push({
      id: localId(),
      explanation,
      old_string: blockMatch[1],
      new_string: blockMatch[2],
    });
  }
  return edits;
}

/** Remove fenced latex-edit blocks from chat text (they render as cards instead). */
export function stripLatexEditBlocks(text: string): string {
  return text.replace(/```latex-edit\s*\n[\s\S]*?```/g, "").trim();
}

/**
 * Safety net for models that write a whole document into their chat reply
 * inside a ```latex / ```tex fence instead of calling the edit tool. Returns
 * the fenced block if it looks like a complete standalone document, so the UI
 * can offer it as a full-document replacement the user can apply.
 */
export function extractFullDocLatex(text: string): string | null {
  const fence = /```(?:latex|tex)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let best: string | null = null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    if (/\\documentclass/.test(body) && /\\begin\{document\}/.test(body)) {
      // Prefer the largest matching block.
      if (!best || body.length > best.length) best = body;
    }
  }
  return best;
}

/** Remove fenced code blocks whose body exactly matches the given LaTeX. */
export function stripLatexDocBlock(text: string, body: string): string {
  return text
    .replace(/```(?:latex|tex)?\s*\n([\s\S]*?)```/g, (whole, inner: string) =>
      inner.trim() === body.trim() ? "" : whole,
    )
    .trim();
}

export type ApplyResult =
  | { ok: true; doc: string }
  | { ok: false; reason: "not-found" | "ambiguous" };

/** Apply a proposed edit by replacing the single occurrence of old_string. */
export function applyEdit(doc: string, edit: ProposedEdit): ApplyResult {
  if (edit.old_string.length === 0) {
    // Empty anchor: replace the entire document (matches the server tool).
    return { ok: true, doc: edit.new_string };
  }
  const first = doc.indexOf(edit.old_string);
  if (first === -1) return { ok: false, reason: "not-found" };
  const second = doc.indexOf(edit.old_string, first + edit.old_string.length);
  if (second !== -1) return { ok: false, reason: "ambiguous" };
  return {
    ok: true,
    doc: doc.slice(0, first) + edit.new_string + doc.slice(first + edit.old_string.length),
  };
}
