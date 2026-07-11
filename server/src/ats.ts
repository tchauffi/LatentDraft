/**
 * Heuristic ATS (Applicant Tracking System) analysis of a resume's extracted
 * text. ATS software parses the PDF's *text layer*, so the checks here mirror
 * what a parser sees: is there real text, are the standard sections and contact
 * fields present, and — if a job description is supplied — how well do the
 * resume's terms cover it. Returns a compact model-readable report.
 */

const SECTION_PATTERNS: Record<string, RegExp> = {
  experience: /\b(work experience|professional experience|experience|employment)\b/i,
  education: /\b(education|academic)\b/i,
  skills: /\b(skills|technical skills|competencies)\b/i,
  summary: /\b(summary|profile|objective|about)\b/i,
  projects: /\b(projects|portfolio)\b/i,
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const LINKEDIN_RE = /linkedin\.com\/[A-Za-z0-9/-]+/i;
const GITHUB_RE = /github\.com\/[A-Za-z0-9/-]+/i;

const STOPWORDS = new Set(
  ("a an the and or but for nor of to in on at by with from as is are was were be been being this that " +
    "these those you your we our they their it its will can should would could may might must have has had do does " +
    "did not no yes if then than so such about into over under between within across per via etc using used use " +
    "including include includes years year experience work working ability strong excellent good team teams role")
    .split(/\s+/),
);

function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) ?? []) {
    const w = raw.replace(/[.\-]+$/, "");
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export interface AtsInput {
  /** Text extracted from the compiled resume PDF. */
  resumeText: string;
  /** Optional target job description to score keyword coverage against. */
  jobDescription?: string;
}

export function analyzeAts({ resumeText, jobDescription }: AtsInput): string {
  const text = resumeText.replace(/\f/g, "\n");
  const words = (text.match(/\S+/g) ?? []).length;
  const lines: string[] = [];

  lines.push("ATS analysis of the compiled PDF:");
  lines.push("");

  // 1. Parseability — the single most important ATS factor.
  if (words < 40) {
    lines.push(
      `⛔ PARSEABILITY: only ${words} words of selectable text were extracted. An ATS may see almost nothing — ` +
        `this usually means the content is rendered as images/glyphs rather than real text. Avoid icon fonts ` +
        `and image-based text; use a normal text-based layout.`,
    );
  } else {
    lines.push(`✅ Parseable: ${words} words of selectable text extracted.`);
  }

  // 2. Contact fields.
  const contact: string[] = [];
  if (EMAIL_RE.test(text)) contact.push("email"); else contact.push("MISSING email");
  if (PHONE_RE.test(text)) contact.push("phone"); else contact.push("MISSING phone");
  if (LINKEDIN_RE.test(text)) contact.push("LinkedIn");
  if (GITHUB_RE.test(text)) contact.push("GitHub");
  const missingContact = contact.filter((c) => c.startsWith("MISSING"));
  lines.push(`${missingContact.length ? "⚠️" : "✅"} Contact: ${contact.join(", ")}.`);

  // 3. Standard sections.
  const found = Object.keys(SECTION_PATTERNS).filter((k) => SECTION_PATTERNS[k].test(text));
  const missingSections = Object.keys(SECTION_PATTERNS).filter((k) => !found.includes(k));
  lines.push(
    `${missingSections.length > 2 ? "⚠️" : "✅"} Sections found: ${found.join(", ") || "none"}.` +
      (missingSections.length ? ` Consider adding clear headings for: ${missingSections.join(", ")}.` : ""),
  );

  // 4. Icon/glyph artifacts that hint at unparseable content.
  if (/[\uE000-\uF8FF]/.test(text)) {
    lines.push(
      "⚠️ Private-use Unicode glyphs detected (typically FontAwesome icons). ATS parsers drop these — " +
        "keep contact labels as plain text (e.g. \"Email:\", \"GitHub:\").",
    );
  }

  // 5. Keyword coverage vs a job description.
  if (jobDescription && jobDescription.trim()) {
    const jd = keywords(jobDescription);
    const resume = keywords(text);
    const present: string[] = [];
    const missing: string[] = [];
    for (const w of jd) (resume.has(w) ? present : missing).push(w);
    const total = jd.size || 1;
    const pct = Math.round((present.length / total) * 100);
    // Rank missing terms by length as a rough proxy for specificity/importance.
    const topMissing = missing.sort((a, b) => b.length - a.length).slice(0, 25);
    lines.push("");
    lines.push(`Keyword coverage vs job description: ${pct}% (${present.length}/${total} distinct terms matched).`);
    if (topMissing.length) {
      lines.push(
        `Notable terms from the job description NOT found in the resume: ${topMissing.join(", ")}.`,
      );
      lines.push(
        "Weave the genuinely relevant ones into the resume verbatim (skills/experience). Do not fabricate experience.",
      );
    }
  } else {
    lines.push("");
    lines.push("(Pass a job_description to also score keyword coverage against a specific posting.)");
  }

  return lines.join("\n");
}
