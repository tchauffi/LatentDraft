import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

/**
 * LaTeX autocomplete: citation keys from the project's .bib buffers, \ref
 * targets from \label{}s across .tex buffers, plus a static command and
 * environment table. Pure extractors are exported for unit tests.
 */

/** Citation keys from every .bib buffer: `@article{key,` → "key". */
export function bibKeys(files: Record<string, string>): string[] {
  const keys = new Set<string>();
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith(".bib")) continue;
    for (const m of content.matchAll(/@\w+\s*\{\s*([^,\s{}]+)\s*,/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

/** \label{...} targets from every .tex buffer. */
export function labels(files: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith(".tex")) continue;
    for (const m of content.matchAll(/\\label\{([^}]+)\}/g)) out.add(m[1]);
  }
  return [...out].sort();
}

const ENVIRONMENTS = [
  "document", "equation", "equation*", "align", "align*", "itemize", "enumerate",
  "description", "figure", "table", "tabular", "center", "abstract", "quote",
  "verbatim", "frame", "block", "columns", "column", "theorem", "proof",
  "matrix", "pmatrix", "bmatrix", "cases", "minipage",
];

const PACKAGES = [
  "amsmath", "amssymb", "amsfonts", "graphicx", "hyperref", "geometry", "xcolor",
  "booktabs", "siunitx", "listings", "enumitem", "fancyhdr", "natbib", "biblatex",
  "tikz", "subcaption", "float", "caption", "microtype", "fontawesome", "titlesec",
];

/** Commands offered after a backslash. `{}`-terminated ones move the cursor inside. */
const COMMAND_NAMES = [
  "section{}", "subsection{}", "subsubsection{}", "paragraph{}", "textbf{}", "textit{}",
  "emph{}", "underline{}", "texttt{}", "cite{}", "ref{}", "eqref{}", "label{}",
  "footnote{}", "caption{}", "includegraphics{}", "input{}", "usepackage{}",
  "begin{}", "end{}", "frac{}{}", "sqrt{}", "sum", "int", "infty", "alpha", "beta",
  "gamma", "delta", "epsilon", "lambda", "mu", "pi", "sigma", "omega", "zeta",
  "partial", "nabla", "cdot", "times", "pm", "leq", "geq", "neq", "approx",
  "rightarrow", "Rightarrow", "maketitle", "tableofcontents", "item", "centering",
  "vspace{}", "hspace{}", "newpage", "clearpage", "linewidth", "textwidth",
  "bibliography{}", "bibliographystyle{}", "href{}{}", "url{}", "verb", "emptyset",
  "mathbb{}", "mathcal{}", "hat{}", "bar{}", "vec{}", "dot{}", "ddot{}",
];

const COMMAND_COMPLETIONS: Completion[] = COMMAND_NAMES.map((name) => {
  const bare = name.replace(/\{\}/g, "");
  return {
    label: `\\${bare}`,
    apply: name.includes("{}") ? `\\${name.replace("{}", "{").replace(/\{\}/g, "{}")}` : `\\${bare}`,
    type: "keyword",
  };
});

/**
 * Completion targets for an argument command — pure, unit-testable.
 * `texts` are the editable buffers; `allFiles` every project file (for
 * \includegraphics / \input path completion).
 */
export function targetsFor(
  cmd: string,
  texts: Record<string, string>,
  allFiles: string[],
): string[] {
  switch (cmd) {
    case "cite":
    case "citep":
    case "citet":
      return bibKeys(texts);
    case "ref":
    case "eqref":
    case "autoref":
      return labels(texts);
    case "begin":
    case "end":
      return ENVIRONMENTS;
    case "usepackage":
      return PACKAGES;
    case "input":
      return allFiles
        .filter((f) => f.endsWith(".tex") && f !== "main.tex")
        .map((f) => f.replace(/\.tex$/, ""));
    case "includegraphics":
      return allFiles.filter((f) => /\.(png|jpe?g|pdf|svg)$/i.test(f));
    case "bibliography":
      return allFiles.filter((f) => f.endsWith(".bib")).map((f) => f.replace(/\.bib$/, ""));
    default:
      return [];
  }
}

const ARG_CMD =
  /\\(cite[pt]?|ref|eqref|autoref|begin|end|usepackage|input|includegraphics|bibliography)(?:\[[^\]]*\])?\{([a-zA-Z0-9:_./-]*)$/;

/** The CodeMirror completion source, reading the live buffers via getters. */
export function latexCompletionSource(
  getTexts: () => Record<string, string>,
  getAllFiles: () => string[],
) {
  return (ctx: CompletionContext): CompletionResult | null => {
    // Inside a known command's argument: \cite{sha…, \begin{equ…, \input{sec…
    const arg = ctx.matchBefore(ARG_CMD);
    if (arg) {
      const m = ARG_CMD.exec(arg.text)!;
      const options = targetsFor(m[1], getTexts(), getAllFiles());
      if (options.length === 0) return null;
      return {
        from: ctx.pos - m[2].length,
        options: options.map((label) => ({ label, type: "constant" as const })),
        validFor: /^[a-zA-Z0-9:_./-]*$/,
      };
    }
    // A command being typed: \sec…
    const cmd = ctx.matchBefore(/\\[a-zA-Z]*$/);
    if (cmd && (cmd.text.length > 1 || ctx.explicit)) {
      return { from: cmd.from, options: COMMAND_COMPLETIONS, validFor: /^\\[a-zA-Z]*$/ };
    }
    return null;
  };
}

/** Ready-to-use CodeMirror extension. */
export function latexAutocomplete(
  getTexts: () => Record<string, string>,
  getAllFiles: () => string[],
) {
  return autocompletion({
    override: [latexCompletionSource(getTexts, getAllFiles)],
    icons: false,
  });
}
