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
  /** Label for trailing text appended to the prompt (default "Additional context from me"). */
  argLabel?: string;
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
  {
    name: "apply",
    description: "Tailor the resume to a job posting: review + plan first, edits after you approve",
    argLabel: "Job posting (URL or pasted job description)",
    prompt:
      "I want to tailor the resume/CV in this project to a specific job posting. This turn is " +
      "REVIEW AND PLANNING ONLY — do NOT call edit_document or create_file yet, no matter how " +
      "obvious the fixes seem.\n" +
      "1. Get the job description: if I gave a URL below, call fetch_url with it; if I pasted " +
      "text, use that directly. If the fetch fails or returns almost no text (login wall, " +
      "scripted page), STOP and ask me to paste the job description — do not guess or search " +
      "for it.\n" +
      "2. Read my current resume with read_document (list_files first if the project has " +
      "multiple files).\n" +
      "3. Run ats_check, passing the job description text, to measure parseability and keyword " +
      "coverage.\n" +
      "4. Then reply with exactly three parts: (a) the role's KEY REQUIREMENTS AND KEYWORDS, " +
      "quoted concisely from the posting — include them verbatim so they stay in our chat for " +
      "the next turn; (b) a short review of how my resume matches: genuine strengths and gaps; " +
      "(c) a NUMBERED improvement plan (reorder or reword bullets, surface matching skills and " +
      "keywords I actually have, cut content irrelevant to this role). NEVER propose inventing " +
      "experience, skills, or qualifications I don't have.\n" +
      "5. Finish by asking me to approve the plan or tell you what to change — then WAIT.\n" +
      "In a LATER message, once I approve: apply the approved numbered items with " +
      "edit_document, run compile_check, then run ats_check again with the same job " +
      "description to confirm coverage improved, and summarize what changed.",
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
    prompt: rest
      ? `${cmd.prompt}\n\n${cmd.argLabel ?? "Additional context from me"}: ${rest}`
      : cmd.prompt,
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
