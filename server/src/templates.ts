/**
 * Starter projects: template id → { relative path → content }. Every template
 * must include a main.tex (the compile target). The article template mirrors
 * the sample document the client used to hardcode.
 */
export const TEMPLATES: Record<string, Record<string, string>> = {
  article: {
    "main.tex": `\\documentclass{article}
\\usepackage{amsmath}
\\title{Untitled}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Welcome to LatentDraft. Edit this LaTeX on the left; the PDF compiles in the
middle; ask the assistant on the right to propose changes.

The quadratic formula is
\\begin{equation}
  x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}.
\\end{equation}

\\end{document}
`,
    "refs.bib": `@article{shannon1948,
  author  = {Shannon, C. E.},
  title   = {A Mathematical Theory of Communication},
  journal = {Bell System Technical Journal},
  year    = {1948},
}
`,
    "sections/intro.tex": `% Draft the introduction here, then \\input{sections/intro} from main.tex.
\\section{Introduction}
Turbulence remains a central open problem in classical physics.
`,
  },
  beamer: {
    "main.tex": `\\documentclass[aspectratio=169]{beamer}
\\usetheme{Madrid}
\\usepackage{amsmath}
\\usepackage{graphicx}

\\title{Presentation Title}
\\subtitle{Subtitle}
\\author{Your Name}
\\date{\\today}

\\begin{document}

\\frame{\\titlepage}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}

\\begin{frame}{First Slide}
  \\begin{itemize}
    \\item Every frame needs a matching \\texttt{\\textbackslash end\\{frame\\}}.
    \\item Ask the agent to draft slides, figures, or diagrams.
  \\end{itemize}
\\end{frame}

\\end{document}
`,
  },
  cv: {
    "main.tex": `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1.8cm]{geometry}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage{hyperref}
% NOTE: fontawesome (v4) works here; fontawesome5 crashes this engine.
\\usepackage{fontawesome}

\\titleformat{\\section}{\\large\\bfseries}{}{0em}{}[\\titlerule]
\\pagestyle{empty}

\\begin{document}

{\\LARGE\\bfseries Your Name}\\\\[2pt]
\\faEnvelope\\ you@example.com \\quad \\faPhone\\ +00 000 000 \\quad \\faGithub\\ github.com/you

\\section{Experience}
\\textbf{Job Title} — Company \\hfill 2022--present
\\begin{itemize}[leftmargin=1.2em, nosep]
  \\item Achievement with a measurable result.
\\end{itemize}

\\section{Education}
\\textbf{Degree} — University \\hfill 2018--2022

\\section{Skills}
LaTeX, \\ldots

\\end{document}
`,
  },
};

export const DEFAULT_TEMPLATE = "article";
