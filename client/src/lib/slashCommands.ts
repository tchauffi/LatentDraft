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
    name: "find-refs",
    description: "Find real papers to cite (Crossref/arXiv) and insert their BibTeX",
    argLabel: "What to find a source for (topic, claim, or title fragment)",
    prompt:
      "I need real, citable references. Use the find_references tool — NEVER write a .bib " +
      "entry from memory.\n" +
      "1. Work out what needs a source: if I named a topic/claim below, use that; if I quoted " +
      "a sentence from my document, that sentence is the claim. If it is genuinely unclear, " +
      "ask me first.\n" +
      "2. Call find_references with a focused query (up to 3 queries with different wording " +
      "if the first finds nothing convincing).\n" +
      "3. Present the candidates briefly: title, authors, year, venue — and say which one(s) " +
      "you recommend and why.\n" +
      "4. Insert the best match's BibTeX block into the project's .bib file EXACTLY as the " +
      "tool returned it (create the .bib with create_file and reference it from the document " +
      "if the project has none), and add \\cite{key} where the claim is made — or, if I only " +
      "gave a topic, just add the entry and tell me the key to cite. Each insertion is an " +
      "accept/reject diff, so I can reject and pick a different candidate.\n" +
      "5. Run compile_check (and check_bibtex if you touched existing entries).\n" +
      "If no candidate truly matches, tell me so — do NOT insert a poor match and NEVER " +
      "fabricate or alter bibliographic data.",
  },
  {
    name: "review",
    description: "Proofread the document: findings + numbered fix plan first, edits after you approve",
    argLabel: "Focus or extra instructions",
    prompt:
      "Proofread and review the writing in this project. This turn is REVIEW AND PLANNING " +
      "ONLY — do NOT call edit_document or create_file yet.\n" +
      "1. Read everything relevant: list_files, then read_document on each .tex file (skip " +
      "generated/style files).\n" +
      "2. Review for: spelling and grammar; clarity and wordiness; inconsistent terminology, " +
      "notation, capitalization, and hyphenation; acronyms used before they are defined; " +
      "tense and voice shifts; awkward or ambiguous sentences; LaTeX-level issues (mixing " +
      "\\ref/\\eqref styles, inconsistent heading case, missing non-breaking spaces before " +
      "\\cite/\\ref).\n" +
      "3. Reply with: (a) a one-paragraph overall assessment; (b) a NUMBERED list of concrete " +
      "findings, each quoting the exact current text and the file it is in, with your " +
      "proposed rewording — most important first, and skip nitpicks that don't help; (c) " +
      "anything you deliberately left alone (e.g. correct but unusual phrasing).\n" +
      "4. Finish by asking me which numbers to apply (or 'all') — then WAIT.\n" +
      "In a LATER message, once I approve: apply the approved items with edit_document " +
      "(anchoring old_string on the quoted text), run compile_check, and summarize what " +
      "changed. Never change technical meaning, results, or claims while rewording.",
  },
  {
    name: "check-submission",
    description: "Check the document against a venue's submission rules (pages, margins, anonymity)",
    argLabel: "Venue and its rules (e.g. \"NeurIPS 2026, 9 pages excl. refs, anonymized\")",
    prompt:
      "Check whether this document meets its target venue's submission requirements. This " +
      "turn is CHECKING AND PLANNING ONLY — do NOT call edit_document or create_file yet.\n" +
      "1. Establish the requirements: use the venue/rules I gave below if any; if I only " +
      "named the venue, web_search its current author guidelines (page limit and what counts " +
      "toward it, anonymization policy, format/template, abstract limits). If you cannot " +
      "establish them, ask me instead of guessing.\n" +
      "2. Run view_pdf to get the REAL page count, paper size, margins, overfull lines, and " +
      "fonts. Judge the page limit against what the venue counts (e.g. references excluded).\n" +
      "3. If the venue requires anonymization, read the source files and hunt for leaks: " +
      "\\author/\\thanks/\\email content, acknowledgements, grant numbers, links to personal " +
      "or lab repos, and self-citations phrased as 'our previous work'.\n" +
      "4. Reply with: (a) a pass/fail CHECKLIST — one line per requirement with the evidence " +
      "(e.g. '⛔ 10 pages of content, limit is 9'); (b) a NUMBERED fix plan for every " +
      "failure, quoting the text or naming the layout change; (c) requirements you could not " +
      "verify, stated as such.\n" +
      "5. Finish by asking me to approve the plan — then WAIT.\n" +
      "In a LATER message, once I approve: apply the fixes with edit_document, then re-run " +
      "view_pdf (and compile_check) to confirm the document now complies, and summarize.",
  },
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
