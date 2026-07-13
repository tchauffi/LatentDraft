import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { mkdir, readFile, writeFile, rm, cp, readdir } from "node:fs/promises";
import {
  compileTex,
  compileProject,
  projectBuildDir,
  sessionDir,
  listSessionFiles,
} from "./compile.js";
import type { CompileResult } from "./compile.js";
import { safeProjectFilePath, isTextPath, listFilesInDir } from "./projects.js";
import { webSearch } from "./research.js";
import { fetchPageText } from "./webpage.js";
import { runPython, runPythonIn } from "./python.js";
import { renderMermaid, renderMermaidIn } from "./mermaid.js";
import { renderPdf, extractPdfText, analyzePdfLayout } from "./pdftools.js";
import { formatLayoutReport } from "./layout.js";
import { analyzeAts } from "./ats.js";
import { checkBibtex, extractBibEntries, extractBibitems, type BibEntry } from "./bibcheck.js";
import { verifyEntries, formatVerifyReport, type VerifyResult } from "./bibverify.js";
import { findReferences, type ExistingRef } from "./refsearch.js";
import path from "node:path";

const MAIN = "main.tex";

export interface EditEvent {
  id: string;
  explanation: string;
  old_string: string;
  new_string: string;
  /** Project file the edit targets ("main.tex" unless the agent says otherwise). */
  file: string;
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
  if (s.length <= max) return s;
  // Keep both ends: crash hints are PREPENDED to the log, while LaTeX puts the
  // fatal error and the main.log details at the END. Cut the middle.
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n… (log truncated, ${s.length - max} chars omitted) …\n${s.slice(s.length - tail)}`;
}

export interface AgentToolsOptions {
  initialDoc: string;
  compileSessionId: string;
  /** When set, the agent works on this PROJECT directory: any text file can be
   * read/edited (via the `file` param), new files can be created, and
   * compile_check runs on a scratch mirror so rejecting an edit never leaves
   * the real files changed. Without it: legacy single-document session mode. */
  projectDir?: string;
  emitEdit: (e: EditEvent) => void;
  emitCheck: (c: CheckEvent) => void;
  /** Optional: surface non-edit tool activity (search, python, pdf, ats) to the UI. */
  emitTool?: (e: ToolEvent) => void;
  /** Injectable fetch for fetch_url — tests stay offline. */
  fetchFn?: typeof fetch;
}

/**
 * Build the agent's server-executed Mastra tools over a mutable working copy
 * of the document. `edit_document` applies to the working copy (and streams
 * the edit to the browser as an accept/reject diff); `compile_check` runs
 * Tectonic on the working copy so the agent can verify its own changes before
 * finishing. The returned `tools` map plugs into a Mastra Agent.
 */
export function createAgentTools(opts: AgentToolsOptions) {
  const state = {
    /** Working copies, path → content. main.tex is always present. */
    docs: new Map<string, string>([[MAIN, opts.initialDoc]]),
    edits: 0,
    /** true when a doc changed since the last compile_check. */
    dirty: false,
    lastCheck: undefined as { ok: boolean; log: string } | undefined,
    /** Last check_bibtex result this turn, for the end-of-turn recheck. */
    lastBib: undefined as { ok: boolean; summary: string; report: string } | undefined,
    /** true when a .tex/.bib doc changed since the last check_bibtex. */
    bibDirty: false,
    /** Whether the last check_bibtex verified online — the recheck matches it. */
    bibOnline: true,
    /** Per-turn cache of online verdicts, so the end-of-turn recheck only
     * re-fetches entries whose fields actually changed. Keyed by field
     * signature; transient failures (unverified) are not cached. */
    verifyCache: new Map<string, VerifyResult>(),
    /** Pages rendered by the most recent view_pdf, for the recovery loop to
     * attach as image parts. Tool results themselves are serialized text, so
     * inlining base64 there would flood the model's context. */
    renderedImages: [] as string[],
  };
  let editSeq = 0;
  /** Signatures of edits already applied this turn — weak models love to repeat themselves. */
  const appliedSigs = new Set<string>();

  const projectDir = opts.projectDir;
  /** Where run_python / render_mermaid write figures. */
  const workDir = projectDir ?? sessionDir(opts.compileSessionId);

  /** Resolve a tool's `file` argument to a normalized project path, or an error string. */
  function resolveTarget(file: string | undefined): { path: string } | { error: string } {
    const target = (file ?? "").trim() || MAIN;
    if (target === MAIN) return { path: MAIN };
    if (!projectDir) {
      return { error: `Only ${MAIN} can be edited in this session — put everything there.` };
    }
    const norm = safeProjectFilePath(target);
    if (!norm || !isTextPath(norm)) {
      return {
        error: `'${target}' is not an editable text file. Use a project-relative path like sections/intro.tex (see list_files).`,
      };
    }
    return { path: norm };
  }

  /** Working copy of a file, lazily loaded from the project dir on first use. */
  async function loadDoc(file: string): Promise<string | undefined> {
    const cached = state.docs.get(file);
    if (cached !== undefined) return cached;
    if (!projectDir) return undefined;
    try {
      const content = await readFile(path.join(projectDir, file), "utf8");
      state.docs.set(file, content);
      return content;
    } catch {
      return undefined;
    }
  }

  /** All .tex/.bib contents visible this turn: disk files overlaid with working copies. */
  async function gatherBibFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const wanted = (p: string) => /\.(tex|bib)$/i.test(p);
    if (projectDir) {
      for (const f of (await listFilesInDir(projectDir)) ?? []) {
        if (f.binary || !wanted(f.path)) continue;
        const doc = await loadDoc(f.path);
        if (doc !== undefined) out[f.path] = doc;
      }
    } else {
      for (const name of await listSessionFiles(opts.compileSessionId)) {
        if (!wanted(name) || state.docs.has(name)) continue;
        try {
          out[name] = await readFile(path.join(sessionDir(opts.compileSessionId), name), "utf8");
        } catch {
          /* unreadable session file — skip */
        }
      }
    }
    // Working copies win: pending edits and files created this turn.
    for (const [file, content] of state.docs) if (wanted(file)) out[file] = content;
    return out;
  }

  /**
   * Compile the working state. Project mode compiles a scratch MIRROR
   * (`.latentdraft/agent`): a copy of the project overlaid with the working
   * docs — so unaccepted edits are verifiable without ever touching the real
   * files. Legacy mode compiles main.tex in the session dir as before.
   */
  async function compileWorking(): Promise<CompileResult> {
    if (!projectDir) return compileTex(opts.compileSessionId, state.docs.get(MAIN) ?? "");
    const mirror = path.join(projectDir, ".latentdraft", "agent");
    await rm(mirror, { recursive: true, force: true });
    await mkdir(mirror, { recursive: true });
    // Copy top-level entries one by one — fs.cp refuses a destination inside
    // the source, and the mirror lives in the project's own .latentdraft/.
    for (const entry of await readdir(projectDir)) {
      if (entry === ".latentdraft" || entry === ".git") continue;
      await cp(path.join(projectDir, entry), path.join(mirror, entry), {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== ".latentdraft" && base !== ".git";
        },
      });
    }
    for (const [file, content] of state.docs) {
      const target = path.join(mirror, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    return compileProject(mirror);
  }

  /** Where the working compile leaves its PDF. */
  function workingPdfPath(): string {
    return projectDir
      ? path.join(projectBuildDir(path.join(projectDir, ".latentdraft", "agent")), "main.pdf")
      : path.join(sessionDir(opts.compileSessionId), "main.pdf");
  }

  const edit_document = createTool({
    id: "edit_document",
    description:
      "Apply a single targeted edit to the working copy of a document and show it " +
      "to the user as an accept/reject diff. Edits main.tex unless `file` names " +
      "another project file. `old_string` must appear EXACTLY ONCE in the CURRENT " +
      "working file (copy it verbatim, including whitespace). To insert content, " +
      "anchor on a short unique nearby string and repeat it at the start of " +
      "`new_string`. To rewrite the whole file from scratch, OMIT old_string and put " +
      "the entire new content in `new_string`. Make one edit per call; call again " +
      "for further changes.",
    inputSchema: z.object({
      explanation: z.string().describe("One short sentence: what this edit does."),
      file: z
        .string()
        .optional()
        .describe('Project file to edit, e.g. "sections/intro.tex". Default: main.tex.'),
      old_string: z
        .string()
        .optional()
        .describe(
          "Exact text to replace (must match uniquely). Omit or leave empty to replace the ENTIRE file with new_string.",
        ),
      new_string: z.string().describe("Replacement text."),
    }),
    execute: async ({ context }) => {
      let { old_string, new_string } = context;
      const { explanation, file } = context;
      const target = resolveTarget(file);
      if ("error" in target) return `NOT APPLIED: ${target.error}`;
      const doc = await loadDoc(target.path);
      if (doc === undefined) {
        return (
          `NOT APPLIED: ${target.path} does not exist. Check list_files for the real path, ` +
          `or create it with create_file.`
        );
      }
      // Guard (main.tex only): models routinely omit old_string meaning
      // "insert", which the contract treats as a FULL-DOCUMENT replacement —
      // silently nuking the preamble. When new_string is only a fragment,
      // insert it into the body (before \end{document}) instead.
      let insertedBeforeEnd = false;
      if (
        target.path === MAIN &&
        (old_string ?? "").length === 0 &&
        doc.trim().length > 0 &&
        !/\\documentclass|\\begin\{document\}/.test(new_string)
      ) {
        if (!doc.includes("\\end{document}")) {
          return (
            "NOT APPLIED: omitting old_string REPLACES THE ENTIRE DOCUMENT, but new_string " +
            "is not a complete LaTeX document (it has no \\documentclass or \\begin{document}). " +
            "To insert or change part of the document, call read_document, copy a short unique " +
            "anchor as old_string, and include it at the start of new_string. Only omit " +
            "old_string when you really mean to rewrite the whole document."
          );
        }
        if (new_string.trim().length >= 20 && doc.includes(new_string.trim())) {
          return (
            "NOT APPLIED: that content is already in the document — the earlier edit worked. " +
            "Do not repeat it. Call read_document to confirm, or compile_check to verify."
          );
        }
        old_string = "\\end{document}";
        new_string = `${new_string.replace(/\s+$/, "")}\n\n\\end{document}`;
        insertedBeforeEnd = true;
      }
      const sig = JSON.stringify([target.path, old_string ?? "", new_string]);
      if (appliedSigs.has(sig)) {
        return (
          "NOT APPLIED: this exact edit was already applied. The change is in the working " +
          "document — do not repeat it. Call read_document to confirm, or compile_check to verify."
        );
      }
      const res = applyServerEdit(doc, old_string ?? "", new_string);
      if (!res.ok) {
        return res.reason === "ambiguous"
          ? "NOT APPLIED: old_string matches multiple locations. Include more surrounding text so it is unique, then try again."
          : `NOT APPLIED: old_string was not found in ${target.path}. Call read_document` +
              `${target.path === MAIN ? "" : `({file: "${target.path}"})`} to see the current ` +
              "content, copy the anchor text verbatim (mind whitespace/newlines), then try again.";
      }
      state.docs.set(target.path, res.doc);
      state.edits += 1;
      state.dirty = true;
      if (/\.(tex|bib)$/i.test(target.path)) state.bibDirty = true;
      appliedSigs.add(sig);
      const id = `edit-${++editSeq}`;
      opts.emitEdit({
        id,
        explanation,
        old_string: old_string ?? "",
        new_string,
        file: target.path,
      });
      return insertedBeforeEnd
        ? "Edit applied: old_string was omitted, so the content was INSERTED at the end of the " +
            "body, just before \\end{document}. If it belongs elsewhere, make a follow-up " +
            "edit_document with a unique old_string anchor. Call compile_check to verify."
        : `Edit applied to the working copy of ${target.path}. Call compile_check to confirm the document still compiles.`;
    },
  });

  const read_document = createTool({
    id: "read_document",
    description:
      "Read the CURRENT working copy of a document (main.tex unless `file` names " +
      "another project file), including all edits applied so far this turn. Use it " +
      "to re-anchor before an edit_document call — especially after a NOT APPLIED " +
      "result, or whenever you are unsure what the file now contains.",
    inputSchema: z.object({
      file: z
        .string()
        .optional()
        .describe('Project file to read, e.g. "refs.bib". Default: main.tex.'),
    }),
    execute: async ({ context: { file } }) => {
      const target = resolveTarget(file);
      if ("error" in target) return target.error;
      const doc = await loadDoc(target.path);
      if (doc === undefined) {
        return `${target.path} does not exist. Check list_files for the real path.`;
      }
      return doc.length > 0
        ? `Current ${target.path} (${doc.length} chars):\n<document>\n${doc}\n</document>`
        : `(${target.path} is currently empty)`;
    },
  });

  const list_files = createTool({
    id: "list_files",
    description:
      "List the project's files with sizes. Text files can be read with " +
      "read_document({file}) and edited with edit_document({file, …}); images and " +
      "data files can be referenced from the document (\\includegraphics, pd.read_csv).",
    inputSchema: z.object({}),
    execute: async () => {
      if (!projectDir) {
        const files = await listSessionFiles(opts.compileSessionId);
        return [`${MAIN} (the document)`, ...files].join("\n");
      }
      const onDisk = (await listFilesInDir(projectDir)) ?? [];
      const lines = new Map<string, string>();
      for (const f of onDisk) {
        lines.set(f.path, `${f.path} (${f.size} bytes${f.binary ? ", binary" : ""})`);
      }
      for (const [file] of state.docs) {
        if (!lines.has(file)) lines.set(file, `${file} (new this turn, pending user accept)`);
      }
      return [...lines.values()].sort().join("\n") || "(the project is empty)";
    },
  });

  const create_file = createTool({
    id: "create_file",
    description:
      "Create a NEW text file in the project (e.g. sections/method.tex, refs.bib), " +
      "shown to the user as an accept/reject diff like any edit. Then reference it " +
      "from main.tex (\\input{sections/method}, \\bibliography{refs}, …) and " +
      "compile_check. To change an existing file use edit_document instead.",
    inputSchema: z.object({
      path: z.string().describe('Project-relative path, e.g. "sections/method.tex".'),
      content: z.string().describe("The full initial content of the file."),
      explanation: z.string().optional().describe("One short sentence: why this file."),
    }),
    execute: async ({ context: { path: rel, content, explanation } }) => {
      if (!projectDir) {
        return `NOT CREATED: this session has no project — put everything in ${MAIN}.`;
      }
      const norm = safeProjectFilePath(rel.trim());
      if (!norm || !isTextPath(norm)) {
        return "NOT CREATED: use a simple project-relative text-file path like sections/method.tex.";
      }
      if ((await loadDoc(norm)) !== undefined) {
        return `NOT CREATED: ${norm} already exists — edit it with edit_document({file: "${norm}", …}).`;
      }
      state.docs.set(norm, content);
      state.edits += 1;
      state.dirty = true;
      if (/\.(tex|bib)$/i.test(norm)) state.bibDirty = true;
      const id = `edit-${++editSeq}`;
      opts.emitEdit({
        id,
        explanation: explanation ?? `Create ${norm}`,
        old_string: "",
        new_string: content,
        file: norm,
      });
      return (
        `Created ${norm} in the working copy (pending user accept). Reference it from ` +
        `${MAIN} if needed, then compile_check.`
      );
    },
  });

  const compile_check = createTool({
    id: "compile_check",
    description:
      "Compile the current working document with LaTeX (Tectonic) and report whether " +
      "it succeeds. On failure, returns the error log so you can fix it. Call this " +
      "after making edits, and iterate until it compiles.",
    inputSchema: z.object({}),
    execute: async () => {
      const result = await compileWorking();
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
  async function compileToPdf(): Promise<
    { ok: true; pdf: string; log: string } | { ok: false; log: string }
  > {
    const result = await compileWorking();
    state.dirty = false;
    state.lastCheck = { ok: result.ok, log: truncate(result.log ?? "", 1200) };
    opts.emitCheck(state.lastCheck);
    if (!result.ok) return { ok: false, log: truncate(result.log ?? "") };
    return { ok: true, pdf: workingPdfPath(), log: result.log ?? "" };
  }

  const web_search = createTool({
    id: "web_search",
    description:
      "Search the web for up-to-date information — job posting details, company facts, " +
      "wording of skills/technologies, salary data, etc. Use it to research before " +
      "writing, then cite specifics in the document. Returns a ranked list of results " +
      "with titles, URLs and snippets.",
    inputSchema: z.object({
      query: z.string().describe("The search query."),
      max_results: z.number().int().min(1).max(10).optional().describe("How many results (default 5)."),
    }),
    execute: async ({ context: { query, max_results } }) => {
      const res = await webSearch(query, max_results ?? 5);
      emitTool({ name: "web_search", summary: `Searched: “${query}”`, ok: true });
      return res;
    },
  });

  const fetch_url = createTool({
    id: "fetch_url",
    description:
      "Fetch a specific web page by URL and return its readable text — job postings, " +
      "articles, documentation. web_search FINDS pages; fetch_url READS one you already " +
      "have the URL for (e.g. a job posting the user wants the resume tailored to). Some " +
      "sites (LinkedIn, login-walled pages) return little or no text — when that happens, " +
      "ask the user to paste the content instead of guessing.",
    inputSchema: z.object({
      url: z.string().describe("Full http(s) URL of the page to fetch."),
    }),
    execute: async ({ context: { url } }) => {
      const res = await fetchPageText(url, opts.fetchFn ?? fetch);
      emitTool({
        name: "fetch_url",
        summary: res.ok ? `Fetched ${url}` : `Fetch failed: ${url}`,
        ok: res.ok,
      });
      return res.text;
    },
  });

  const run_python = createTool({
    id: "run_python",
    description:
      "Run a Python 3 snippet (matplotlib, seaborn, pandas, numpy, openpyxl available) in " +
      "the document's build directory. Use it mainly to GENERATE FIGURES: save a plot as a " +
      "PNG, e.g. `plt.savefig('figure.png', dpi=200, bbox_inches='tight')`, then add " +
      "`\\includegraphics{figure.png}` to the document with edit_document. Data files the " +
      "user uploaded (CSV/Excel) sit in the same directory — load them with " +
      "`pd.read_csv('data.csv')` / `pd.read_excel('data.xlsx')` and plot with seaborn. " +
      "Files you write here sit next to the .tex, so reference them by bare filename. " +
      "matplotlib uses a headless backend; do not call plt.show(). 30s time limit. " +
      "Returns stdout/stderr and the list of files created.",
    inputSchema: z.object({
      code: z.string().describe("The Python source to execute."),
    }),
    execute: async ({ context: { code } }) => {
      const res = projectDir
        ? await runPythonIn(projectDir, code)
        : await runPython(opts.compileSessionId, code);
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

  const render_mermaid = createTool({
    id: "render_mermaid",
    description:
      "Render a Mermaid diagram (flowchart, sequence, class, state, ER, gantt, pie, " +
      "mindmap, …) to a PNG in the document's build directory. Pass the raw Mermaid " +
      "source (no ``` fences). On success, add the diagram to the document with " +
      "edit_document: \\includegraphics[width=…]{<filename>}. On a syntax error the " +
      "Mermaid parser message is returned — fix the source and retry.",
    inputSchema: z.object({
      code: z
        .string()
        .describe('Mermaid source, e.g. "flowchart LR\\n  A[Idea] --> B[Draft]".'),
      filename: z
        .string()
        .optional()
        .describe('Output PNG name, e.g. "pipeline.png" (default "diagram.png").'),
    }),
    execute: async ({ context: { code, filename } }) => {
      const res = projectDir
        ? await renderMermaidIn(projectDir, code, filename)
        : await renderMermaid(opts.compileSessionId, code, filename);
      emitTool({
        name: "render_mermaid",
        summary: res.ok ? `Rendered diagram → ${res.file}` : "Mermaid render failed",
        ok: res.ok,
      });
      return res.ok
        ? `Diagram rendered to ${res.file}. Now add it to the document with edit_document, ` +
            `e.g. \\includegraphics[width=0.9\\textwidth]{${res.file}} (inside a figure ` +
            `environment if it needs a caption), then compile_check.`
        : `Mermaid rendering FAILED. Fix the diagram source and call render_mermaid again.\n\n${res.output}`;
    },
  });

  const view_pdf = createTool({
    id: "view_pdf",
    description:
      "Compile the current document and INSPECT the resulting PDF's layout. Returns a " +
      "text report of what the pages actually look like: page count and paper size, " +
      "text coverage and margins per page, content clipped at the page edges, Overfull " +
      "\\hbox lines (text sticking past the right margin, with main.tex line numbers), " +
      "near-empty trailing pages, and font usage. Call it after formatting changes or " +
      "when the user asks about layout/appearance, then FIX the issues it reports.",
    inputSchema: z.object({
      max_pages: z.number().int().min(1).max(5).optional().describe("Pages to render (default 3)."),
    }),
    execute: async ({ context: { max_pages } }) => {
      state.renderedImages = [];
      const compiled = await compileToPdf();
      if (!compiled.ok) {
        emitTool({ name: "view_pdf", summary: "Could not render — compile failed", ok: false });
        return `Cannot view the PDF — it does not compile:\n\n${compiled.log}`;
      }
      let report = "";
      try {
        const layout = await analyzePdfLayout(compiled.pdf);
        report = formatLayoutReport(layout, compiled.log);
      } catch (err) {
        report = `(layout analysis failed: ${String(err)})`;
      }
      try {
        const prefix = projectDir
          ? path.join(projectDir, ".latentdraft", "preview")
          : path.join(sessionDir(opts.compileSessionId), "preview");
        const pages = await renderPdf(compiled.pdf, prefix, max_pages ?? 3);
        state.renderedImages = pages.map((p) => p.base64);
        emitTool({ name: "view_pdf", summary: `Inspected layout (${pages.length} page(s) rendered)`, ok: true });
      } catch {
        emitTool({ name: "view_pdf", summary: "Inspected layout (render failed)", ok: true });
      }
      return `Compiled successfully. Layout report:\n${report}`;
    },
  });

  const ats_check = createTool({
    id: "ats_check",
    description:
      "Compile the document and run an ATS (Applicant Tracking System) analysis on the " +
      "extracted PDF text: whether the text is machine-parseable, presence of contact " +
      "fields and standard sections, icon/glyph artifacts, and — if a job_description is " +
      "given — keyword coverage against it. Use it on resumes/CVs and act on the findings.",
    inputSchema: z.object({
      job_description: z
        .string()
        .optional()
        .describe("Optional target job posting text to score keyword coverage against."),
    }),
    execute: async ({ context: { job_description } }) => {
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
   * The full bib check: local cross-check + (optionally) online verification
   * of cited entries. Shared by the check_bibtex tool and the end-of-turn
   * recheck in finalizeBib. Online verdicts are cached per entry signature,
   * so a recheck only re-fetches entries whose fields the agent changed.
   */
  async function runBibCheck(
    verifyOnline: boolean,
  ): Promise<{ ok: boolean; summary: string; report: string }> {
    const files = await gatherBibFiles();
    const local = checkBibtex(files);
    let ok = local.ok;
    let summary = local.summary;
    let report = local.report;
    if (verifyOnline && local.citedEntries.length > 0) {
      const sig = (e: BibEntry) =>
        JSON.stringify([e.key, e.title, e.author, e.year, e.doi, e.eprint, e.url]);
      const fresh = local.citedEntries.filter((e) => !state.verifyCache.has(sig(e)));
      const freshResults = await verifyEntries(fresh);
      const freshByKey = new Map(freshResults.map((r) => [r.key, r]));
      for (const e of fresh) {
        const r = freshByKey.get(e.key);
        // Transient failures stay uncached so a recheck retries them.
        if (r && r.verdict !== "unverified") state.verifyCache.set(sig(e), r);
      }
      const results: VerifyResult[] = [];
      for (const e of local.citedEntries) {
        const r = state.verifyCache.get(sig(e)) ?? freshByKey.get(e.key);
        if (r) results.push(r);
      }
      const overflow = freshResults.find((r) => r.key === "…");
      if (overflow) results.push(overflow);
      const verify = formatVerifyReport(
        results,
        new Map(local.citedEntries.map((e) => [e.key, e])),
      );
      ok = ok && verify.ok;
      summary = local.ok ? verify.summary : `${local.summary}; ${verify.summary}`;
      report =
        `${report}\n\n${verify.section}` +
        (verify.ok
          ? ""
          : "\n\nFor MISMATCH/NOT FOUND entries: find the real publication with web_search and " +
            "fix the .bib fields; if no real source exists, tell the user which references " +
            "appear fabricated and suggest removing them. NEVER invent bibliographic data.");
    }
    const result = { ok, summary, report };
    state.lastBib = result;
    state.bibDirty = false;
    state.bibOnline = verifyOnline;
    emitTool({ name: "check_bibtex", summary, ok });
    return result;
  }

  const check_bibtex = createTool({
    id: "check_bibtex",
    description:
      "Verify the bibliography: cross-check every \\cite-style key against the .bib entries / " +
      "\\bibitem definitions AND verify each cited entry against real-world sources (Crossref " +
      "DOI lookup, arXiv, title search) to catch hallucinated references — invented papers, " +
      "fake or mismatched DOIs. Static check on the working copy, no compile needed. Use it " +
      "whenever the user asks about citations/references or after writing bibliography entries.",
    inputSchema: z.object({
      verify_online: z
        .boolean()
        .optional()
        .describe(
          "Also verify cited entries against Crossref/arXiv (default true). " +
            "Set false for a fast local-only key check.",
        ),
    }),
    execute: async ({ context: { verify_online } }) => {
      const result = await runBibCheck(verify_online !== false);
      return result.report;
    },
  });

  const find_references = createTool({
    id: "find_references",
    description:
      "Search real scholarly databases (Crossref + arXiv) for papers matching a topic, a " +
      "claim that needs a citation, or a half-remembered title. Returns candidates with " +
      "ready-to-insert BibTeX built verbatim from the real records. ALWAYS use this instead " +
      "of writing a .bib entry from memory — memory invents papers. Present the candidates " +
      "to the user, insert the chosen block into the .bib unchanged, and \\cite its key.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("What to find a source for: a topic, the claim itself, a distinctive title phrase, or author + topic."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Candidates to return (default 5)."),
    }),
    execute: async ({ context: { query, max_results } }) => {
      // Existing entries: flag candidates already in the bibliography and
      // keep generated keys from colliding with keys already in use.
      const files = await gatherBibFiles();
      const existing: ExistingRef[] = [];
      for (const [file, content] of Object.entries(files)) {
        if (/\.bib$/i.test(file)) {
          for (const e of extractBibEntries(file, content)) {
            existing.push({ key: e.key, title: e.title, doi: e.doi });
          }
        } else {
          for (const b of extractBibitems(file, content)) existing.push({ key: b.key });
        }
      }
      const res = await findReferences(query, max_results ?? 5, existing, opts.fetchFn ?? fetch);
      emitTool({ name: "find_references", summary: res.summary, ok: res.ok });
      return res.report;
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
    const result = await compileWorking();
    state.dirty = false;
    state.lastCheck = { ok: result.ok, log: truncate(result.log ?? "", 1200) };
    opts.emitCheck(state.lastCheck);
    return state.lastCheck;
  }

  /**
   * End-of-turn bibliography recheck, mirroring finalize(): when the agent
   * used check_bibtex this turn AND edited files, the turn must not end on an
   * unverified bibliography. Re-runs the check (same online setting, cached
   * verdicts) if anything changed since the last one; returns undefined when
   * the bib workflow was never active or nothing was edited.
   */
  async function finalizeBib(): Promise<
    { ok: boolean; summary: string; report: string } | undefined
  > {
    if (!state.lastBib || state.edits === 0) return undefined;
    if (!state.bibDirty) return state.lastBib;
    return runBibCheck(state.bibOnline);
  }

  return {
    tools: {
      edit_document,
      read_document,
      list_files,
      create_file,
      compile_check,
      web_search,
      fetch_url,
      run_python,
      render_mermaid,
      view_pdf,
      ats_check,
      check_bibtex,
      find_references,
    },
    getDoc: () => state.docs.get(MAIN) ?? "",
    /** True once the agent has compiled at least once this turn — after that,
     * the editor's pre-turn compile log is stale and should stop being shown. */
    hasChecked: () => state.lastCheck !== undefined,
    /** Base64 PNG pages from the most recent view_pdf; clears on read. */
    takeRenderedImages: (): string[] => {
      const imgs = state.renderedImages;
      state.renderedImages = [];
      return imgs;
    },
    finalize,
    finalizeBib,
  };
}

export function buildSystemPrompt(
  documentText: string,
  auxFiles: string[] = [],
  /** Error log from the user's last in-editor compile, when it FAILED. */
  editorCompileLog?: string,
  /** True when the agent works on a project: file param + create_file available. */
  multiFile = false,
): string {
  const auxNote = auxFiles.length
    ? multiFile
      ? `\n\nProject files besides main.tex: ${auxFiles.join(", ")}. Read any text file with read_document({file: "…"}) and edit it with edit_document({file: "…", …}); create new ones with create_file. Files resolve relative to the project root (\\input{sections/intro}, \\bibliography{refs}, \\includegraphics{figure.png}).`
      : `\n\nThe compile directory also contains these project files (usable via \\input, \\bibliography, \\includegraphics): ${auxFiles.join(", ")}. You can only edit main.tex.`
    : "";
  const compileNote = editorCompileLog
    ? `\n\nWhen the user sent this message, the editor's last compile of this document had FAILED with the log below. Base your fix on it: fix the reported cause with edit_document, then compile_check until it succeeds.\n<compile_log>\n${truncate(editorCompileLog, 2000)}\n</compile_log>`
    : "";
  return `You are an autonomous LaTeX assistant embedded in an editor, like Cursor but for LaTeX.

You have tools:
- edit_document(explanation, old_string, new_string, file?): make one targeted change to the working copy (main.tex unless 'file' names another project file). Each change is shown to the user as an accept/reject diff.
- read_document(file?): read the CURRENT working copy (with your edits applied). Use it to re-anchor after a NOT APPLIED edit or whenever you are unsure what the document now contains.
- list_files(): list the project's files (sizes, binary markers).
- create_file(path, content, explanation?): create a NEW text file in the project (a section, a .bib), shown as an accept/reject diff.
- compile_check(): compile the current working document and get back success or the error log.
- web_search(query, max_results?): research anything on the web (job postings, companies, technologies, wording). Use it before writing when you need facts you don't have.
- fetch_url(url): fetch one specific web page and get its readable text. Use it when you HAVE a URL (a job posting, an article) — web_search finds pages, fetch_url reads one. If it returns little or no text (login wall, scripted page), ask the user to paste the content instead of guessing.
- run_python(code): run Python (matplotlib, seaborn, pandas, numpy, openpyxl) in the build directory, mainly to GENERATE FIGURES. Save as PNG, e.g. plt.savefig("figure.png", dpi=200, bbox_inches="tight"), then edit_document to add \\includegraphics{figure.png}. Uploaded data files (CSV/Excel) are in the same directory: pd.read_csv("data.csv") / pd.read_excel("data.xlsx"), then plot with seaborn. Reference files by bare filename; do not call plt.show().
- render_mermaid(code, filename?): render a Mermaid DIAGRAM (flowchart, sequence, class, state, ER, gantt, pie, mindmap) to a PNG in the build directory. Prefer it over Python for conceptual/structural diagrams. Pass raw Mermaid source (no fences), then edit_document to add \\includegraphics{<filename>}.
- view_pdf(max_pages?): compile and INSPECT the PDF's actual layout — page count, per-page text coverage and margins, content clipped at page edges, Overfull \\hbox lines (text sticking past the right margin, with main.tex line numbers), near-empty trailing pages, fonts. This is how you SEE the result. When the user mentions layout, formatting, spacing, or "how it looks", call view_pdf first, then fix what it reports and call it again to confirm.
- ats_check(job_description?): compile, extract the PDF text, and get an ATS (Applicant Tracking System) report — parseability, contact fields, sections, icon artifacts, and keyword coverage vs a job posting. Use on resumes/CVs.
- check_bibtex(verify_online?): verify the bibliography — every \\cite key vs the .bib entries / \\bibitem definitions, AND each cited entry vs real-world sources (Crossref DOI, arXiv, title search) to catch hallucinated references (invented papers, fake or mismatched DOIs). Use it whenever the user asks about citations/references/bibliography or after writing bibliography entries.
- find_references(query, max_results?): search Crossref + arXiv for REAL papers on a topic/claim/title and get candidates with ready-to-insert BibTeX. Whenever a new bibliography entry is needed (the user wants a citation, or you want to cite something), get it from find_references — NEVER write a .bib entry from memory.

Tool guidance:
- Invoke tools ONLY through the native tool/function-calling mechanism. NEVER print tool-call JSON (like {"name": "edit_document", ...}) or <tool_call> tags as part of your reply text — that is not a tool call and does nothing.
- These tools only READ or produce build artifacts; only edit_document changes the user's document, and every edit is theirs to accept or reject.
- ALWAYS write the actual document with edit_document. NEVER paste the finished LaTeX into your chat reply as a substitute for editing — the user's editor only changes through edit_document. If you produced a document but did not call edit_document, you have NOT done the task.
- Research is for gathering facts, not the goal. Do a FEW focused web_search calls (typically 2–4), then STOP and start writing. Do not keep searching once you have enough to write a solid first draft.
- For a resume/CV, a good loop is: research briefly → write the document with edit_document → compile_check → view_pdf to sanity-check the layout → ats_check (with the job description if provided) → apply the improvements it suggests. Never fabricate experience to match keywords.
- When the user asks to TAILOR a resume to a job posting (e.g. via /apply): get the posting text (fetch_url for a URL), run ats_check with it, then present a review and a NUMBERED improvement plan and STOP — do not edit until the user approves. After approval, apply the plan with edit_document, compile_check, and re-run ats_check with the same job description.
- When the user needs a CITATION for a claim or topic (e.g. via /find-refs): call find_references (1–3 focused queries), present the candidates (title, authors, year, venue), then insert the best match's BibTeX block into the .bib EXACTLY as returned and add \\cite{key} where the claim is made — each insertion is an accept/reject diff, so the user can reject and pick another candidate. If no candidate genuinely matches, say so; NEVER fabricate an entry or alter a returned block's bibliographic fields.
- When the user asks to PROOFREAD/review the writing (e.g. via /review): read every relevant file first, then present the findings and a NUMBERED fix plan quoting the exact text at each location, and STOP — do not edit until the user approves.
- When the user asks whether the document meets SUBMISSION requirements (e.g. via /check-submission): establish the venue's requirements (from what they gave you, or web_search the venue's author guidelines), run view_pdf for the real page count/margins/fonts, read the source for anonymization leaks if required (\\author, emails, \\thanks, acknowledgements, "our previous work"), then report a pass/fail checklist and a NUMBERED fix plan and STOP — do not edit until the user approves.
- You do NOT have any other tools (no shell, no file system, no "google"). If you need external info, use web_search.

Workflow when the user reports a BROKEN document ("it doesn't compile", "fix the errors", red log in the editor):
1. Call compile_check FIRST and read the error log. NEVER guess at the cause from the source alone.
2. Fix exactly what the log reports with edit_document, then compile_check again. Repeat until it compiles.
3. The failure log quotes the main.tex source at the reported line numbers ("> 5: \\badmacro"). Anchor old_string on that EXACT quoted text — do NOT locate the line by counting lines in the document yourself, and never include the "N:" line-number prefixes in old_string; they are annotations, not file content.

Workflow when the user wants a change:
1. Make the change with one or more edit_document calls.
2. Call compile_check to verify the document still compiles.
3. If it FAILED, read the log, make corrective edit_document calls, and compile_check again. Repeat until it compiles (give up after a few honest attempts and explain what's wrong).
4. When it compiles, write a SHORT summary of what you changed. Do not paste the whole document.

CRITICAL: If you changed the document, you MUST end the turn with a compile_check that SUCCEEDED. Never stop right after an edit_document call — always compile_check afterwards. Never end the turn while the document fails to compile unless you have genuinely tried and cannot fix it.

Rules:
- old_string must appear EXACTLY ONCE in the current working document — copy it verbatim, including indentation and newlines. After an edit, the document has changed; base later edits on the updated text. If an edit comes back NOT APPLIED, call read_document and re-anchor on the actual current text instead of guessing again.
- Keep edits small and local; prefer several edits over one huge one.
- When creating a document from scratch or replacing essentially all of it (e.g. "make a resume for X", "turn this into a cover letter", "write a report about Y"), call edit_document ONCE with old_string OMITTED and the complete new document in new_string. Do not try to anchor onto the placeholder/sample text.
- For FontAwesome icons (\\faPhone, \\faEnvelope, \\faGithub, \\faLinkedin, \\faMapMarker, …) use \\usepackage{fontawesome} — the classic v4 package, which compiles fine here. NEVER use \\usepackage{fontawesome5}: its load-time glyph-name introspection (\\XeTeXglyphname) CRASHES this system's Tectonic/XeTeX engine. The \\faXxx command names for common CV icons are the same in both packages, so just swap the package name.
- If compile_check reports that the engine CRASHED (e.g. "invalid pointer", "core dumped", "engine CRASHED", or a fontawesome/OTF failure), do NOT retry the same source. If it was fontawesome5, replace \\usepackage{fontawesome5} with \\usepackage{fontawesome} (v4); otherwise remove the offending OTF font package, then compile_check again.
- Missing packages are a common failure — if the log says a command is undefined (e.g. \\href needs hyperref), add the \\usepackage.
- When check_bibtex reports problems: fix wrong keys by anchoring edit_document on the quoted "> N:" source lines; for entries flagged MISMATCH or NOT FOUND, find the real publication with web_search and correct the .bib fields, or tell the user which references appear fabricated. Entries it could NOT check (❓) are not necessarily wrong — leave them and mention them. After your fixes, run check_bibtex AGAIN to confirm they resolve — never end the turn on unverified bibliography fixes. NEVER invent bibliographic data (authors, titles, years, DOIs).
- For pure questions ("what does amsmath give me?"), just answer — don't edit or compile.

Current document:
<document>
${documentText}
</document>${auxNote}${compileNote}`;
}
