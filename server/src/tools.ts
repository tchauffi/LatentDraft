import { tool } from "ai";
import { z } from "zod";
import { compileTex } from "./compile.js";
import { sessionDir } from "./compile.js";
import { webSearch } from "./research.js";
import { runPython } from "./python.js";
import { renderPdf, extractPdfText } from "./pdftools.js";
import { analyzeAts } from "./ats.js";
import path from "node:path";

export interface EditEvent {
  id: string;
  explanation: string;
  old_string: string;
  new_string: string;
}

export interface CheckEvent {
  ok: boolean;
  log: string;
}

export interface ToolEvent {
  /** Which tool ran, e.g. "web_search" or "run_python". */
  name: string;
  /** Short human-readable summary for the chat activity line. */
  summary: string;
  ok: boolean;
}

type ApplyResult =
  | { ok: true; doc: string }
  | { ok: false; reason: "not-found" | "ambiguous" };

/** Apply a single unique-match replacement to a working copy of the document. */
function applyServerEdit(doc: string, oldStr: string, newStr: string): ApplyResult {
  // Empty/omitted old_string => replace the ENTIRE document.
  if (oldStr.length === 0) return { ok: true, doc: newStr };
  const first = doc.indexOf(oldStr);
  if (first === -1) return { ok: false, reason: "not-found" };
  const second = doc.indexOf(oldStr, first + oldStr.length);
  if (second !== -1) return { ok: false, reason: "ambiguous" };
  return { ok: true, doc: doc.slice(0, first) + newStr + doc.slice(first + oldStr.length) };
}

function truncate(s: string, max = 2500): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (log truncated, ${s.length - max} more chars)`;
}

export interface AgentToolsOptions {
  initialDoc: string;
  compileSessionId: string;
  emitEdit: (e: EditEvent) => void;
  emitCheck: (c: CheckEvent) => void;
  /** Optional: surface non-edit tool activity (search, python, pdf, ats) to the UI. */
  emitTool?: (e: ToolEvent) => void;
}

/**
 * Build the agent's server-executed tools over a mutable working copy of the
 * document. `edit_document` applies to the working copy (and streams the edit
 * to the browser as an accept/reject diff); `compile_check` runs Tectonic on
 * the working copy so the agent can verify its own changes before finishing.
 */
export function createAgentTools(opts: AgentToolsOptions) {
  const state = {
    doc: opts.initialDoc,
    edits: 0,
    /** true when the doc changed since the last compile_check. */
    dirty: false,
    lastCheck: undefined as { ok: boolean; log: string } | undefined,
  };
  let editSeq = 0;

  const edit_document = tool({
    description:
      "Apply a single targeted edit to the working copy of the document and show it " +
      "to the user as an accept/reject diff. `old_string` must appear EXACTLY ONCE " +
      "in the CURRENT working document (copy it verbatim, including whitespace). To " +
      "insert content, anchor on a short unique nearby string and repeat it at the " +
      "start of `new_string`. To rewrite the whole document from scratch, OMIT " +
      "old_string and put the entire new document in `new_string`. Make one edit per " +
      "call; call again for further changes.",
    parameters: z.object({
      explanation: z.string().describe("One short sentence: what this edit does."),
      old_string: z
        .string()
        .optional()
        .describe(
          "Exact text to replace (must match uniquely). Omit or leave empty to replace the ENTIRE document with new_string.",
        ),
      new_string: z.string().describe("Replacement text."),
    }),
    execute: async ({ explanation, old_string, new_string }) => {
      const res = applyServerEdit(state.doc, old_string ?? "", new_string);
      if (!res.ok) {
        return res.reason === "ambiguous"
          ? "NOT APPLIED: old_string matches multiple locations. Include more surrounding text so it is unique, then try again."
          : "NOT APPLIED: old_string was not found. Copy it verbatim from the current document (mind whitespace/newlines), then try again.";
      }
      state.doc = res.doc;
      state.edits += 1;
      state.dirty = true;
      const id = `edit-${++editSeq}`;
      opts.emitEdit({ id, explanation, old_string: old_string ?? "", new_string });
      return "Edit applied to the working copy. Call compile_check to confirm the document still compiles.";
    },
  });

  const compile_check = tool({
    description:
      "Compile the current working document with LaTeX (Tectonic) and report whether " +
      "it succeeds. On failure, returns the error log so you can fix it. Call this " +
      "after making edits, and iterate until it compiles.",
    parameters: z.object({}),
    execute: async () => {
      const result = await compileTex(opts.compileSessionId, state.doc);
      const log = truncate(result.log ?? "");
      state.dirty = false;
      state.lastCheck = { ok: result.ok, log: truncate(result.log ?? "", 1200) };
      opts.emitCheck(state.lastCheck);
      return result.ok
        ? "Compilation SUCCEEDED. The current changes are valid."
        : `Compilation FAILED. Fix the cause and call compile_check again.\n\nLog:\n${log}`;
    },
  });

  const emitTool = opts.emitTool ?? (() => {});

  /** Compile the working copy and return the produced PDF path, or an error string. */
  async function compileToPdf(): Promise<{ ok: true; pdf: string } | { ok: false; log: string }> {
    const result = await compileTex(opts.compileSessionId, state.doc);
    state.dirty = false;
    state.lastCheck = { ok: result.ok, log: truncate(result.log ?? "", 1200) };
    opts.emitCheck(state.lastCheck);
    if (!result.ok) return { ok: false, log: truncate(result.log ?? "") };
    return { ok: true, pdf: path.join(sessionDir(opts.compileSessionId), "main.pdf") };
  }

  const web_search = tool({
    description:
      "Search the web for up-to-date information — job posting details, company facts, " +
      "wording of skills/technologies, salary data, etc. Use it to research before " +
      "writing, then cite specifics in the document. Returns a ranked list of results " +
      "with titles, URLs and snippets.",
    parameters: z.object({
      query: z.string().describe("The search query."),
      max_results: z.number().int().min(1).max(10).optional().describe("How many results (default 5)."),
    }),
    execute: async ({ query, max_results }) => {
      const res = await webSearch(query, max_results ?? 5);
      emitTool({ name: "web_search", summary: `Searched: “${query}”`, ok: true });
      return res;
    },
  });

  const run_python = tool({
    description:
      "Run a Python 3 snippet (matplotlib, numpy available) in the document's build " +
      "directory. Use it mainly to GENERATE FIGURES: save a plot as a PNG, e.g. " +
      "`plt.savefig('figure.png', dpi=200, bbox_inches='tight')`, then add " +
      "`\\includegraphics{figure.png}` to the document with edit_document. Files you write " +
      "here sit next to the .tex, so reference them by bare filename. matplotlib uses a " +
      "headless backend; do not call plt.show(). 30s time limit. Returns stdout/stderr and " +
      "the list of files created.",
    parameters: z.object({
      code: z.string().describe("The Python source to execute."),
    }),
    execute: async ({ code }) => {
      const res = await runPython(opts.compileSessionId, code);
      const filesLine = res.createdFiles.length
        ? `\n\nFiles created (reference by bare filename in \\includegraphics): ${res.createdFiles.join(", ")}`
        : "\n\n(No new files were created.)";
      emitTool({
        name: "run_python",
        summary: res.createdFiles.length
          ? `Ran Python → ${res.createdFiles.join(", ")}`
          : "Ran Python",
        ok: res.ok,
      });
      return `${res.ok ? "Python ran successfully." : "Python exited with an error."}\n\nOutput:\n${
        res.output || "(no output)"
      }${filesLine}`;
    },
  });

  const view_pdf = tool({
    description:
      "Compile the current document and LOOK at the resulting PDF as images, so you can " +
      "judge layout, spacing, overflow, alignment and overall visual quality — things the " +
      "compile log cannot tell you. Call this after big formatting changes or when the user " +
      "asks how it looks. Returns page images (first few pages).",
    parameters: z.object({
      max_pages: z.number().int().min(1).max(5).optional().describe("Pages to render (default 3)."),
    }),
    execute: async ({ max_pages }) => {
      const compiled = await compileToPdf();
      if (!compiled.ok) {
        emitTool({ name: "view_pdf", summary: "Could not render — compile failed", ok: false });
        return { text: `Cannot view the PDF — it does not compile:\n\n${compiled.log}`, images: [] };
      }
      try {
        const prefix = path.join(sessionDir(opts.compileSessionId), "preview");
        const pages = await renderPdf(compiled.pdf, prefix, max_pages ?? 3);
        emitTool({ name: "view_pdf", summary: `Rendered ${pages.length} page(s)`, ok: true });
        return {
          text: `Compiled successfully. Showing ${pages.length} page(s) of the PDF.`,
          images: pages.map((p) => p.base64),
        };
      } catch (err) {
        emitTool({ name: "view_pdf", summary: "Render failed", ok: false });
        return { text: `Failed to render the PDF: ${String(err)}`, images: [] };
      }
    },
    // Feed the rendered pages back to the model as image content blocks.
    experimental_toToolResultContent: (result: { text: string; images: string[] }) => [
      { type: "text" as const, text: result.text },
      ...result.images.map((data) => ({
        type: "image" as const,
        data,
        mimeType: "image/png",
      })),
    ],
  });

  const ats_check = tool({
    description:
      "Compile the document and run an ATS (Applicant Tracking System) analysis on the " +
      "extracted PDF text: whether the text is machine-parseable, presence of contact " +
      "fields and standard sections, icon/glyph artifacts, and — if a job_description is " +
      "given — keyword coverage against it. Use it on resumes/CVs and act on the findings.",
    parameters: z.object({
      job_description: z
        .string()
        .optional()
        .describe("Optional target job posting text to score keyword coverage against."),
    }),
    execute: async ({ job_description }) => {
      const compiled = await compileToPdf();
      if (!compiled.ok) {
        emitTool({ name: "ats_check", summary: "Could not analyze — compile failed", ok: false });
        return `Cannot run the ATS check — the document does not compile:\n\n${compiled.log}`;
      }
      try {
        const resumeText = await extractPdfText(compiled.pdf);
        const report = analyzeAts({ resumeText, jobDescription: job_description });
        emitTool({ name: "ats_check", summary: "Ran ATS analysis", ok: true });
        return report;
      } catch (err) {
        emitTool({ name: "ats_check", summary: "ATS analysis failed", ok: false });
        return `Failed to analyze the PDF text: ${String(err)}`;
      }
    },
  });

  /**
   * Authoritative end-of-turn verification. Runs a compile if the document
   * changed since the last check (or was never checked), emits the result, and
   * returns the true final compile status — so the turn never ends on an
   * unverified document. Returns undefined when nothing was edited.
   */
  async function finalize(): Promise<{ ok: boolean; log: string } | undefined> {
    if (state.edits === 0) return undefined;
    if (!state.dirty && state.lastCheck) return state.lastCheck;
    const result = await compileTex(opts.compileSessionId, state.doc);
    state.dirty = false;
    state.lastCheck = { ok: result.ok, log: truncate(result.log ?? "", 1200) };
    opts.emitCheck(state.lastCheck);
    return state.lastCheck;
  }

  return {
    tools: { edit_document, compile_check, web_search, run_python, view_pdf, ats_check },
    getDoc: () => state.doc,
    finalize,
  };
}

export function buildSystemPrompt(documentText: string, auxFiles: string[] = []): string {
  const auxNote = auxFiles.length
    ? `\n\nThe compile directory also contains these project files (usable via \\input, \\bibliography, \\includegraphics): ${auxFiles.join(", ")}. You can only edit main.tex.`
    : "";
  return `You are an autonomous LaTeX assistant embedded in an editor, like Cursor but for LaTeX.

You have tools:
- edit_document(explanation, old_string, new_string): make one targeted change to the working copy. Each change is shown to the user as an accept/reject diff.
- compile_check(): compile the current working document and get back success or the error log.
- web_search(query, max_results?): research anything on the web (job postings, companies, technologies, wording). Use it before writing when you need facts you don't have.
- run_python(code): run Python (matplotlib/numpy) in the build directory, mainly to GENERATE FIGURES. Save as PNG, e.g. plt.savefig("figure.png", dpi=200, bbox_inches="tight"), then edit_document to add \\includegraphics{figure.png}. Reference files by bare filename; do not call plt.show().
- view_pdf(max_pages?): compile and actually LOOK at the rendered PDF pages as images to judge layout/spacing/overflow. Use after formatting changes or when asked how it looks — the compile log alone can't show visual problems.
- ats_check(job_description?): compile, extract the PDF text, and get an ATS (Applicant Tracking System) report — parseability, contact fields, sections, icon artifacts, and keyword coverage vs a job posting. Use on resumes/CVs.

Tool guidance:
- These tools only READ or produce build artifacts; only edit_document changes the user's document, and every edit is theirs to accept or reject.
- ALWAYS write the actual document with edit_document. NEVER paste the finished LaTeX into your chat reply as a substitute for editing — the user's editor only changes through edit_document. If you produced a document but did not call edit_document, you have NOT done the task.
- Research is for gathering facts, not the goal. Do a FEW focused web_search calls (typically 2–4), then STOP and start writing. Do not keep searching once you have enough to write a solid first draft.
- For a resume/CV, a good loop is: research briefly → write the document with edit_document → compile_check → view_pdf to sanity-check the layout → ats_check (with the job description if provided) → apply the improvements it suggests. Never fabricate experience to match keywords.
- You do NOT have any other tools (no shell, no file system, no "google"). If you need external info, use web_search.

Workflow when the user wants a change:
1. Make the change with one or more edit_document calls.
2. Call compile_check to verify the document still compiles.
3. If it FAILED, read the log, make corrective edit_document calls, and compile_check again. Repeat until it compiles (give up after a few honest attempts and explain what's wrong).
4. When it compiles, write a SHORT summary of what you changed. Do not paste the whole document.

CRITICAL: If you changed the document, you MUST end the turn with a compile_check that SUCCEEDED. Never stop right after an edit_document call — always compile_check afterwards. Never end the turn while the document fails to compile unless you have genuinely tried and cannot fix it.

Rules:
- old_string must appear EXACTLY ONCE in the current working document — copy it verbatim, including indentation and newlines. After an edit, the document has changed; base later edits on the updated text.
- Keep edits small and local; prefer several edits over one huge one.
- When creating a document from scratch or replacing essentially all of it (e.g. "make a resume for X", "turn this into a cover letter", "write a report about Y"), call edit_document ONCE with old_string OMITTED and the complete new document in new_string. Do not try to anchor onto the placeholder/sample text.
- For FontAwesome icons (\\faPhone, \\faEnvelope, \\faGithub, \\faLinkedin, \\faMapMarker, …) use \\usepackage{fontawesome} — the classic v4 package, which compiles fine here. NEVER use \\usepackage{fontawesome5}: its load-time glyph-name introspection (\\XeTeXglyphname) CRASHES this system's Tectonic/XeTeX engine. The \\faXxx command names for common CV icons are the same in both packages, so just swap the package name.
- If compile_check reports that the engine CRASHED (e.g. "invalid pointer", "core dumped", "engine CRASHED", or a fontawesome/OTF failure), do NOT retry the same source. If it was fontawesome5, replace \\usepackage{fontawesome5} with \\usepackage{fontawesome} (v4); otherwise remove the offending OTF font package, then compile_check again.
- Missing packages are a common failure — if the log says a command is undefined (e.g. \\href needs hyperref), add the \\usepackage.
- For pure questions ("what does amsmath give me?"), just answer — don't edit or compile.

Current document:
<document>
${documentText}
</document>${auxNote}`;
}
