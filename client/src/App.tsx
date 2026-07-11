import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import EditorPane from "./panes/EditorPane";
import PreviewPane, { type PreviewStatus } from "./panes/PreviewPane";
import ChatPane from "./panes/ChatPane";
import TopToolbar from "./components/TopToolbar";
import StatusBar from "./components/StatusBar";
import {
  compile,
  fetchSessionFiles,
  sessionFileUrl,
  uploadSessionFile,
  type ProposedEdit,
} from "./lib/api";
import { applyEdit as applyEditToDoc, type ApplyResult } from "./lib/diff";

const MAIN = "main.tex";

const SAMPLE = `\\documentclass{article}
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
`;

const BIB = `@article{shannon1948,
  author  = {Shannon, C. E.},
  title   = {A Mathematical Theory of Communication},
  journal = {Bell System Technical Journal},
  year    = {1948},
}
`;

const INTRO = `% Draft the introduction here, then \\input{sections/intro} from main.tex.
\\section{Introduction}
Turbulence remains a central open problem in classical physics.
`;

const INITIAL_FILES: Record<string, string> = {
  [MAIN]: SAMPLE,
  "refs.bib": BIB,
  "sections/intro.tex": INTRO,
};

const FILE_ORDER = [MAIN, "refs.bib", "sections/intro.tex"];

const DEBOUNCE_MS = 800;

function makeSessionId(): string {
  return `s-${Math.random().toString(36).slice(2, 10)}`;
}

/** Rough word count: LaTeX control sequences and braces stripped out. */
function countWords(tex: string): number {
  const text = tex
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/[{}[\]\\$&#~^_%]/g, " ");
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}

export default function App() {
  const [files, setFiles] = useState<Record<string, string>>(INITIAL_FILES);
  const [active, setActive] = useState<string>(MAIN);
  // Tabs are OPEN buffers, not a mirror of the project: the tree opens them,
  // × closes them. main.tex is pinned open (it's the compiled document).
  const [openTabs, setOpenTabs] = useState<string[]>([MAIN]);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [log, setLog] = useState("");
  const [agentOpen, setAgentOpen] = useState(true);
  const [pages, setPages] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  // Agent edits awaiting a decision, mirrored inline in the editor.
  const [pendingEdits, setPendingEdits] = useState<ProposedEdit[]>([]);
  // Server-side files in the compile session (aux + agent-generated figures).
  const [sessionFiles, setSessionFiles] = useState<string[]>([]);
  const editResolverRef = useRef<((editId: string, action: "accept" | "reject") => void) | null>(
    null,
  );

  // The agent + compiler always operate on main.tex.
  const mainRef = useRef(files[MAIN]);
  mainRef.current = files[MAIN];
  const filesRef = useRef(files);
  filesRef.current = files;
  const sessionId = useRef(makeSessionId()).current;
  const compileSeq = useRef(0);
  // Last completed compile, handed to the agent so a failure log the user is
  // looking at reaches it with the chat request.
  const lastCompileRef = useRef<{ ok: boolean; log: string } | null>(null);

  const activeText = files[active] ?? "";
  const words = useMemo(() => countWords(activeText), [activeText]);

  const setActiveText = useCallback(
    (value: string) => setFiles((f) => ({ ...f, [active]: value })),
    [active],
  );

  /** Everything except main.tex — sent alongside so \input/\bibliography resolve. */
  const auxFiles = useCallback(() => {
    const { [MAIN]: _main, ...rest } = filesRef.current;
    return rest;
  }, []);

  const refreshSessionFiles = useCallback(async () => {
    setSessionFiles(await fetchSessionFiles(sessionId));
  }, [sessionId]);

  const runCompile = useCallback(
    async (tex: string) => {
      const seq = ++compileSeq.current;
      setStatus("compiling");
      const result = await compile(sessionId, tex, auxFiles());
      void refreshSessionFiles();
      if (seq !== compileSeq.current) return; // superseded by a newer compile
      if (result.ok) {
        lastCompileRef.current = { ok: true, log: "" };
        setPdf(result.pdf);
        setStatus("ready");
        setLog("");
      } else {
        lastCompileRef.current = { ok: false, log: result.log };
        setStatus("error");
        setLog(result.log);
      }
    },
    [sessionId, refreshSessionFiles],
  );

  // Files that exist only server-side (e.g. figures the agent generated).
  const generatedFiles = useMemo(
    () => sessionFiles.filter((f) => !(f in files)),
    [sessionFiles, files],
  );
  const fileUrl = useCallback((name: string) => sessionFileUrl(sessionId, name), [sessionId]);

  /** Upload a data file into the session; returns an error message or null. */
  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      const res = await uploadSessionFile(sessionId, file);
      if (!res.ok) return res.error;
      await refreshSessionFiles();
      return null;
    },
    [sessionId, refreshSessionFiles],
  );

  // Debounced compile whenever any file changes (aux files feed \input/\bibliography).
  useEffect(() => {
    const t = setTimeout(() => void runCompile(files[MAIN]), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [files, runCompile]);

  // Cmd/Ctrl+Enter forces an immediate recompile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void runCompile(mainRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCompile]);

  const getDocument = useCallback(() => mainRef.current, []);
  const getLastCompile = useCallback(() => lastCompileRef.current, []);

  const openFile = useCallback((f: string) => {
    setOpenTabs((tabs) => (tabs.includes(f) ? tabs : [...tabs, f]));
    setActive(f);
  }, []);

  const closeTab = useCallback((f: string) => {
    if (f === MAIN) return; // pinned
    setOpenTabs((tabs) => tabs.filter((t) => t !== f));
    setActive((a) => (a === f ? MAIN : a));
  }, []);

  const applyEdit = useCallback((edit: ProposedEdit): ApplyResult => {
    const result = applyEditToDoc(mainRef.current, edit);
    if (result.ok) {
      mainRef.current = result.doc;
      setFiles((f) => ({ ...f, [MAIN]: result.doc }));
      setActive(MAIN); // surface the change the agent just made
    }
    return result;
  }, []);

  // Inline suggestion buttons resolve through the chat pane, so the diff
  // card there flips to applied/rejected in the same motion.
  const acceptSuggestion = useCallback(
    (edit: ProposedEdit) => editResolverRef.current?.(edit.id, "accept"),
    [],
  );
  const rejectSuggestion = useCallback(
    (edit: ProposedEdit) => editResolverRef.current?.(edit.id, "reject"),
    [],
  );

  const downloadPdf = useCallback(() => {
    if (!pdf) return;
    const blob = new Blob([pdf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "main.pdf";
    a.click();
    URL.revokeObjectURL(url);
  }, [pdf]);

  return (
    <div className="app">
      <TopToolbar
        fileName={active}
        status={status}
        agentOpen={agentOpen}
        onRecompile={() => void runCompile(mainRef.current)}
        onToggleAgent={() => setAgentOpen((o) => !o)}
        onDownload={downloadPdf}
        canDownload={!!pdf}
      />

      <div className="body">
        <div className="workspace">
          <PanelGroup direction="horizontal">
            <Panel defaultSize={50} minSize={22}>
              <EditorPane
                value={activeText}
                onChange={setActiveText}
                onCursor={setCursor}
                files={openTabs}
                projectFiles={FILE_ORDER}
                active={active}
                onSelect={openFile}
                onCloseTab={closeTab}
                generatedFiles={generatedFiles}
                fileUrl={fileUrl}
                onUpload={uploadFile}
                suggestions={active === MAIN ? pendingEdits : undefined}
                onAcceptSuggestion={acceptSuggestion}
                onRejectSuggestion={rejectSuggestion}
              />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={50} minSize={22}>
              <PreviewPane pdf={pdf} status={status} log={log} onPages={setPages} />
            </Panel>
          </PanelGroup>
        </div>

        {/* Kept mounted so collapsing the agent never loses the conversation. */}
        <ChatPane
          sessionId={sessionId}
          getDocument={getDocument}
          getFiles={auxFiles}
          getLastCompile={getLastCompile}
          applyEdit={applyEdit}
          onClose={() => setAgentOpen(false)}
          collapsed={!agentOpen}
          onPendingEditsChange={setPendingEdits}
          resolverRef={editResolverRef}
          onTurnEnd={refreshSessionFiles}
          generatedFiles={generatedFiles}
        />

        {!agentOpen && (
          <button className="agent-rail" onClick={() => setAgentOpen(true)} title="Open agent">
            <span className="agent-rail-mark">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="#7c5cff">
                <path d="M8 0l1.6 4.9L14.5 6l-4.9 1.6L8 12.5 6.4 7.6 1.5 6l4.9-1.1z" />
              </svg>
            </span>
            <span className="agent-rail-label">Agent</span>
          </button>
        )}
      </div>

      <StatusBar status={status} pages={pages} words={words} cursor={cursor} log={log} fileName={active} />
    </div>
  );
}
