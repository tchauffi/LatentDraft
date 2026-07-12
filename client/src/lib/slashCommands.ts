/**
 * Chat slash commands: `/name [extra context…]` typed in the composer expands
 * into a full instruction prompt for the agent. The expanded prompt is what
 * gets stored in the message content (the model re-reads history every turn),
 * while the raw command is kept separately for display. Unknown /commands are
 * sent literally. While the command name is being typed, `matchSlashCommands`
 * feeds the composer's autocomplete menu.
 */

export interface SlashCommand {
  /** Command name without the leading slash. */
  name: string;
  /** One-line description shown in the autocomplete menu. */
  description: string;
  /** The instruction actually sent to the agent. */
  prompt: string;
}

export interface SlashExpansion {
  /** What the user literally typed — shown in the chat bubble. */
  display: string;
  /** The instruction actually sent to the agent. */
  prompt: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "check-bibtex",
    description: "Verify references: \\cite keys resolve and sources are real (Crossref/arXiv)",
    prompt:
      "Check this project's bibliography for broken or hallucinated references. Run the " +
      "check_bibtex tool now. Then: (1) fix unresolved \\cite keys and wrong \\bibliography " +
      "targets with edit_document, anchoring old_string on the quoted source lines; (2) for " +
      "entries flagged MISMATCH or NOT FOUND, use web_search to locate the real publication — " +
      "if it exists, correct the .bib entry (title/authors/year/DOI); if you cannot find a real " +
      "source, clearly tell me which references appear fabricated and suggest removing them; " +
      "(3) mention entries that could not be checked without changing them. Do NOT invent or " +
      "guess bibliographic data. After making fixes, run check_bibtex again to confirm they " +
      "resolve. Finish with a short verified/fixed/flagged summary.",
  },
];

/** Expand a known `/command`; returns null for anything else (sent as-is). */
export function expandSlashCommand(input: string): SlashExpansion | null {
  const m = /^\/([a-z][a-z0-9-]*)\b\s*([\s\S]*)$/i.exec(input.trim());
  if (!m) return null;
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1].toLowerCase());
  if (!cmd) return null;
  const rest = m[2].trim();
  return {
    display: input.trim(),
    prompt: rest ? `${cmd.prompt}\n\nAdditional context from me: ${rest}` : cmd.prompt,
  };
}

/**
 * Commands matching a partially typed name — non-empty only while the input
 * is still just `/na…` (no whitespace yet), i.e. while completion makes sense.
 */
export function matchSlashCommands(input: string): SlashCommand[] {
  const m = /^\/([a-z0-9-]*)$/i.exec(input);
  if (!m) return [];
  const typed = m[1].toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(typed));
}
