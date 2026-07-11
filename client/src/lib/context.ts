/**
 * Client-side estimate of how many tokens an agent request will occupy in the
 * model's context window. Chars/4 is a deliberately rough heuristic (LaTeX and
 * prose both land near it) — the point is the ratio against the window, not
 * exact counts, so the UI can warn before Ollama silently truncates the prompt.
 */

const CHARS_PER_TOKEN = 4;

/** Tokens the request spends before any user content: system-prompt
 * boilerplate (tool instructions, workflows) plus the native tool schemas. */
export const PROMPT_OVERHEAD_TOKENS = 1800;

/** The server truncates the editor's failure log to this before prompting. */
const COMPILE_LOG_CAP_CHARS = 2000;

export function estimateRequestTokens(parts: {
  documentText: string;
  history: { content: string }[];
  /** Text currently in the composer, not yet sent. */
  draft?: string;
  /** Editor's last FAILED compile log (travels with the request). */
  compileLog?: string;
}): number {
  const chars =
    parts.documentText.length +
    parts.history.reduce((n, m) => n + m.content.length, 0) +
    (parts.draft?.length ?? 0) +
    Math.min(parts.compileLog?.length ?? 0, COMPILE_LOG_CAP_CHARS);
  return PROMPT_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
}

/** "850", "12.3k", "200k" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const s = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${s}k`;
}

/** Visual severity of the estimate vs the model's window. */
export function contextSeverity(
  estimate: number,
  window?: number,
): "ok" | "warn" | "over" | "unknown" {
  if (!window) return "unknown";
  if (estimate >= window) return "over";
  if (estimate >= window * 0.75) return "warn";
  return "ok";
}
