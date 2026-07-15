import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import EditorPane from "./panes/EditorPane";
import PreviewPane, { type PreviewStatus } from "./panes/PreviewPane";
import ChatPane from "./panes/ChatPane";
import TopToolbar from "./components/TopToolbar";
import StatusBar from "./components/StatusBar";
import ProjectsPage from "./components/ProjectsPage";
import {
  fetchProjects,
  createProjectApi,
  renameProjectApi,
  duplicateProjectApi,
  deleteProjectApi,
  fetchProjectFiles,
  fetchProjectFileText,
  saveProjectFile,
  renameProjectFileApi,
  deleteProjectFileApi,
  createProjectDirApi,
  deleteProjectDirApi,
  compileProjectApi,
  projectFileUrl,
  synctexForward,
  synctexReverse,
  type CompileDiagnostic,
  type ProjectInfo,
  type ProposedEdit,
} from "./lib/api";
import { applyEdit as applyEditToDoc, type ApplyResult } from "./lib/diff";

const MAIN = "main.tex";
const DEBOUNCE_MS = 800;
const PROJECT_KEY = "latentdraft:project";

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
  // ---- Project state: the server's project DIRECTORY is the source of truth;
  // `files` holds the text buffers, saved back via debounced autosave. ----
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [templates, setTemplates] = useState<string[]>([]);
  const [projectsRoot, setProjectsRoot] = useState("");
  // The projects page is an overlay: the editor (and the agent conversation)
  // stays mounted underneath while projects are managed.
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [binaryFiles, setBinaryFiles] = useState<string[]>([]);
  // Directories reported by the server — includes EMPTY folders, which can't
  // be derived from file paths.
  const [projectDirs, setProjectDirs] = useState<string[]>([]);

  const [active, setActive] = useState<string>(MAIN);
  // Tabs are OPEN buffers, not a mirror of the project: the tree opens them,
  // × closes them. main.tex is pinned open (it's the compiled document).
  const [openTabs, setOpenTabs] = useState<string[]>([MAIN]);
  const [pdf, setPdf] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [log, setLog] = useState("");
  const [diagnostics, setDiagnostics] = useState<CompileDiagnostic[]>([]);
  // SyncTeX: editor→PDF target and PDF→editor jump.
  const [syncTarget, setSyncTarget] = useState<{ page: number; x: number; y: number; stamp: number } | null>(null);
  const [jumpTo, setJumpTo] = useState<{ file: string; line: number; stamp: number } | undefined>();
  const [agentOpen, setAgentOpen] = useState(true);
  const [pages, setPages] = useState(0);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  // Agent edits awaiting a decision, mirrored inline in the editor.
  const [pendingEdits, setPendingEdits] = useState<ProposedEdit[]>([]);
  const editResolverRef = useRef<((editId: string, action: "accept" | "reject") => void) | null>(
    null,
  );

  const mainRef = useRef("");
  mainRef.current = files[MAIN] ?? "";
  const filesRef = useRef(files);
  filesRef.current = files;
  const binaryRef = useRef(binaryFiles);
  binaryRef.current = binaryFiles;
  const projectRef = useRef<string | null>(null);
  /** Disk mtime each buffer was loaded from — the autosave conflict guard. */
  const mtimes = useRef<Record<string, number>>({});
  /** Buffers edited since their last successful save. */
  const dirty = useRef<Set<string>>(new Set());

  // The agent's compile sandbox session (replaced by the project itself in M3).
  const sessionId = useRef(makeSessionId()).current;
  const compileSeq = useRef(0);
  // Last completed compile, handed to the agent so a failure log the user is
  // looking at reaches it with the chat request.
  const lastCompileRef = useRef<{ ok: boolean; log: string } | null>(null);

  const activeText = files[active] ?? "";
  const words = useMemo(() => countWords(activeText), [activeText]);

  const setActiveText = useCallback(
    (value: string) => {
      dirty.current.add(active);
      setFiles((f) => ({ ...f, [active]: value }));
    },
    [active],
  );

  /**
   * Push every dirty buffer to disk. A 409 means the file changed on disk
   * (git, another editor) since we loaded it — ask which side wins.
   */
  const saveDirty = useCallback(async (): Promise<void> => {
    const id = projectRef.current;
    if (!id) return;
    for (const path of [...dirty.current]) {
      const content = filesRef.current[path];
      if (content === undefined) {
        dirty.current.delete(path);
        continue;
      }
      const result = await saveProjectFile(id, path, content, mtimes.current[path]);
      if (result.ok) {
        mtimes.current[path] = result.mtimeMs;
        dirty.current.delete(path);
      } else if ("conflict" in result) {
        const useDisk = window.confirm(
          `${path} changed on disk since you loaded it (git? another editor?).\n\n` +
            `OK — reload the disk version (discards your unsaved change to this file)\n` +
            `Cancel — keep your version and overwrite the disk`,
        );
        if (useDisk) {
          mtimes.current[path] = result.conflict.mtimeMs;
          dirty.current.delete(path);
          setFiles((f) => ({ ...f, [path]: result.conflict.content }));
        } else {
          const forced = await saveProjectFile(id, path, content);
          if (forced.ok) {
            mtimes.current[path] = forced.mtimeMs;
            dirty.current.delete(path);
          }
        }
      } else {
        console.warn(`[latentdraft] save failed for ${path}: ${result.error}`);
      }
    }
  }, []);

  /** Save dirty buffers, then compile the project from disk. */
  const runCompile = useCallback(async () => {
    const id = projectRef.current;
    if (!id) return;
    const seq = ++compileSeq.current;
    setStatus("compiling");
    await saveDirty();
    const result = await compileProjectApi(id);
    if (seq !== compileSeq.current) return; // superseded by a newer compile
    if (result.ok) {
      lastCompileRef.current = { ok: true, log: "" };
      setPdf(result.pdf);
      setStatus("ready");
      setLog("");
      setDiagnostics([]);
    } else {
      lastCompileRef.current = { ok: false, log: result.log };
      setStatus("error");
      setLog(result.log);
      setDiagnostics(result.diagnostics ?? []);
    }
  }, [saveDirty]);

  /**
   * Re-sync with the project directory: pick up files created/changed outside
   * the editor (git checkout, agent-generated figures). Dirty buffers win.
   */
  const refreshProjectFiles = useCallback(async () => {
    const id = projectRef.current;
    if (!id) return;
    let list;
    try {
      list = await fetchProjectFiles(id);
    } catch {
      return;
    }
    setBinaryFiles(list.files.filter((f) => f.binary).map((f) => f.path));
    setProjectDirs(list.dirs);
    const texts = list.files.filter((f) => !f.binary);
    const updates: Record<string, string> = {};
    await Promise.all(
      texts.map(async (f) => {
        const known = mtimes.current[f.path];
        if (known !== undefined && f.mtimeMs <= known) return; // unchanged
        if (dirty.current.has(f.path)) return; // never clobber local edits
        const r = await fetchProjectFileText(id, f.path);
        if (r) {
          updates[f.path] = r.content;
          mtimes.current[f.path] = r.mtimeMs;
        }
      }),
    );
    if (Object.keys(updates).length > 0) setFiles((f) => ({ ...f, ...updates }));
  }, []);

  /** Load a project's files into fresh buffers and make it current. */
  const loadProject = useCallback(async (id: string) => {
    const list = await fetchProjectFiles(id);
    const texts: Record<string, string> = {};
    const mt: Record<string, number> = {};
    await Promise.all(
      list.files
        .filter((f) => !f.binary)
        .map(async (f) => {
          const r = await fetchProjectFileText(id, f.path);
          if (r) {
            texts[f.path] = r.content;
            mt[f.path] = r.mtimeMs;
          }
        }),
    );
    mtimes.current = mt;
    dirty.current = new Set();
    projectRef.current = id;
    lastCompileRef.current = null;
    setProjectId(id);
    setBinaryFiles(list.files.filter((f) => f.binary).map((f) => f.path));
    setProjectDirs(list.dirs);
    setFiles(texts); // triggers the debounced initial compile
    setOpenTabs([MAIN]);
    setActive(MAIN);
    setPdf(null);
    setPendingEdits([]);
    localStorage.setItem(PROJECT_KEY, id);
  }, []);

  const switchProject = useCallback(
    async (id: string) => {
      if (id === projectRef.current) return;
      await saveDirty(); // never lose edits on switch
      await loadProject(id);
    },
    [saveDirty, loadProject],
  );

  /** Refetch the project list (titles and mtimes move under our feet). */
  const refreshProjects = useCallback(async () => {
    setProjects((await fetchProjects()).projects);
  }, []);

  const openProjectsPage = useCallback(() => {
    setProjectsOpen(true);
    void refreshProjects().catch(() => {});
  }, [refreshProjects]);

  // ---- Projects page handlers: each resolves to an error message or null. ----
  const createNewProject = useCallback(
    async (name: string, template?: string): Promise<string | null> => {
      const r = await createProjectApi(name, template);
      if ("error" in r) return r.error;
      await refreshProjects();
      await switchProject(r.id);
      setProjectsOpen(false);
      return null;
    },
    [refreshProjects, switchProject],
  );

  const openProject = useCallback(
    async (id: string) => {
      await switchProject(id);
      setProjectsOpen(false);
    },
    [switchProject],
  );

  const renameProject = useCallback(
    async (id: string, name: string): Promise<string | null> => {
      const wasCurrent = projectRef.current === id;
      if (wasCurrent) await saveDirty(); // the directory moves — flush first
      const r = await renameProjectApi(id, name);
      if ("error" in r) return r.error;
      await refreshProjects();
      if (wasCurrent) await loadProject(r.id);
      return null;
    },
    [saveDirty, refreshProjects, loadProject],
  );

  const duplicateProject = useCallback(
    async (id: string): Promise<string | null> => {
      if (projectRef.current === id) await saveDirty(); // copy what's on screen, not stale disk
      const r = await duplicateProjectApi(id);
      if ("error" in r) return r.error;
      await refreshProjects(); // stay on the page — the copy appears in the grid
      return null;
    },
    [saveDirty, refreshProjects],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<string | null> => {
      const r = await deleteProjectApi(id);
      if (!r.ok) return r.error ?? "Delete failed.";
      await refreshProjects();
      if (projectRef.current === id) {
        // The open project is gone — reset the editor to a blank slate.
        projectRef.current = null;
        mtimes.current = {};
        dirty.current = new Set();
        lastCompileRef.current = null;
        setProjectId(null);
        setFiles({});
        setBinaryFiles([]);
        setOpenTabs([MAIN]);
        setActive(MAIN);
        setPdf(null);
        setStatus("idle");
        setLog("");
        setDiagnostics([]);
        setPendingEdits([]);
        localStorage.removeItem(PROJECT_KEY);
      }
      return null;
    },
    [refreshProjects],
  );

  // Bootstrap: list projects and open the last-used (or most recent) one; with
  // nothing to open, land on the projects page instead.
  useEffect(() => {
    void (async () => {
      try {
        const initial = await fetchProjects();
        setTemplates(initial.templates);
        setProjectsRoot(initial.root);
        setProjects(initial.projects);
        const stored = localStorage.getItem(PROJECT_KEY);
        const pick =
          initial.projects.find((p) => p.id === stored)?.id ?? initial.projects[0]?.id;
        if (pick) await loadProject(pick);
        else setProjectsOpen(true);
      } catch (err) {
        setStatus("error");
        setLog(`Could not reach the LatentDraft server: ${String(err)}`);
      }
    })();
  }, [loadProject]);

  // Debounced save+compile whenever any buffer changes (also fires once after
  // a project loads, producing the initial preview).
  useEffect(() => {
    if (!projectId) return;
    const t = setTimeout(() => void runCompile(), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [files, projectId, runCompile]);

  // Cmd/Ctrl+Enter forces an immediate save+recompile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void runCompile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runCompile]);

  // Catch external edits (git pull, another editor) when the window regains focus.
  useEffect(() => {
    const onFocus = () => void refreshProjectFiles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshProjectFiles]);

  const getDocument = useCallback(() => mainRef.current, []);
  const getLastCompile = useCallback(() => lastCompileRef.current, []);

  /** Everything except main.tex — sent alongside so \input/\bibliography resolve. */
  const auxFiles = useCallback(() => {
    const { [MAIN]: _main, ...rest } = filesRef.current;
    return rest;
  }, []);

  // The agent works on the project directly (figures land in the project dir);
  // after a turn, re-sync the tree to pick them up.
  const chatControlRef = useRef<{
    send: (text: string) => void;
    autoFix: boolean;
    streaming: boolean;
  } | null>(null);
  const lastAutoFixedLog = useRef("");

  const fixWithAI = useCallback(() => {
    setAgentOpen(true);
    chatControlRef.current?.send(
      "The document fails to compile. Find the cause and fix it.",
    );
  }, []);

  // Auto-fix: when enabled in the chat pane, a failing compile triggers one
  // agent fix attempt per distinct error log (no retry loops on the same log).
  useEffect(() => {
    if (status !== "error" || !log) return;
    const ctl = chatControlRef.current;
    if (!ctl?.autoFix || ctl.streaming || lastAutoFixedLog.current === log) return;
    lastAutoFixedLog.current = log;
    fixWithAI();
  }, [status, log, fixWithAI]);

  const fileUrl = useCallback(
    (name: string) => (projectRef.current ? projectFileUrl(projectRef.current, name) : ""),
    [],
  );

  /** Upload a file (data, image, bib) straight into the project. */
  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      const id = projectRef.current;
      if (!id) return "No project open.";
      const res = await saveProjectFile(id, file.name, file);
      if (!res.ok) return "error" in res ? res.error : "Upload failed.";
      await refreshProjectFiles();
      return null;
    },
    [refreshProjectFiles],
  );

  const openFile = useCallback((f: string) => {
    setOpenTabs((tabs) => (tabs.includes(f) ? tabs : [...tabs, f]));
    setActive(f);
  }, []);

  const closeTab = useCallback((f: string) => {
    if (f === MAIN) return; // pinned
    setOpenTabs((tabs) => tabs.filter((t) => t !== f));
    setActive((a) => (a === f ? MAIN : a));
  }, []);

  /** Create a file or an (empty) folder from the tree's inline input row.
   * Returns an error message for the row to show, or null on success. */
  const createEntry = useCallback(
    async (path: string, kind: "file" | "dir"): Promise<string | null> => {
      const id = projectRef.current;
      if (!id) return "No project open.";
      if (kind === "dir") {
        const r = await createProjectDirApi(id, path);
        if (!r.ok) return r.error ?? "Could not create the folder.";
        await refreshProjectFiles();
        setProjectDirs((d) => (d.includes(path) ? d : [...d, path].sort()));
        return null;
      }
      if (filesRef.current[path] !== undefined) {
        openFile(path); // already exists — just open it, like VS Code
        return null;
      }
      const r = await saveProjectFile(id, path, "");
      if (!r.ok) return "error" in r ? r.error : "Could not create the file.";
      mtimes.current[path] = r.mtimeMs;
      setFiles((f) => ({ ...f, [path]: "" }));
      openFile(path);
      return null;
    },
    [openFile, refreshProjectFiles],
  );

  const renameFile = useCallback(
    async (path: string) => {
      const id = projectRef.current;
      if (!id) return;
      if (path === MAIN) {
        window.alert("main.tex is the compile target — it cannot be renamed.");
        return;
      }
      const to = window.prompt("Rename to:", path)?.trim();
      if (!to || to === path) return;
      await saveDirty(); // rename what's on disk, not a stale copy
      const r = await renameProjectFileApi(id, path, to);
      if (!r.ok) {
        window.alert(r.error ?? "Rename failed.");
        return;
      }
      setFiles((f) => {
        const { [path]: content, ...rest } = f;
        return content !== undefined ? { ...rest, [to]: content } : rest;
      });
      mtimes.current[to] = Date.now();
      delete mtimes.current[path];
      dirty.current.delete(path);
      setOpenTabs((tabs) => tabs.map((t) => (t === path ? to : t)));
      setActive((a) => (a === path ? to : a));
      void refreshProjectFiles();
    },
    [saveDirty, refreshProjectFiles],
  );

  const deleteFile = useCallback(
    async (path: string) => {
      const id = projectRef.current;
      if (!id) return;
      if (!window.confirm(`Delete ${path} from the project?`)) return;
      const r = await deleteProjectFileApi(id, path);
      if (!r.ok) {
        window.alert(r.error ?? "Delete failed.");
        return;
      }
      setFiles((f) => {
        const { [path]: _gone, ...rest } = f;
        return rest;
      });
      delete mtimes.current[path];
      dirty.current.delete(path);
      closeTab(path);
      void refreshProjectFiles();
    },
    [closeTab],
  );

  /** Rename a folder: one fs.rename server-side, then remap every piece of
   * state keyed by the old path prefix (buffers, mtimes, dirty, tabs). */
  const renameDir = useCallback(
    async (path: string) => {
      const id = projectRef.current;
      if (!id) return;
      const to = window.prompt("Rename folder to:", path)?.trim().replace(/\/+$/, "");
      if (!to || to === path) return;
      await saveDirty(); // rename what's on disk, not a stale copy
      const r = await renameProjectFileApi(id, path, to);
      if (!r.ok) {
        window.alert(r.error ?? "Rename failed.");
        return;
      }
      const prefix = `${path}/`;
      const move = (p: string) => (p.startsWith(prefix) ? `${to}/${p.slice(prefix.length)}` : p);
      setFiles((f) =>
        Object.fromEntries(Object.entries(f).map(([p, content]) => [move(p), content])),
      );
      mtimes.current = Object.fromEntries(
        Object.entries(mtimes.current).map(([p, mt]) => [move(p), mt]),
      );
      dirty.current = new Set([...dirty.current].map(move));
      setOpenTabs((tabs) => tabs.map(move));
      setActive(move);
      setProjectDirs((dirs) => dirs.map((d) => (d === path ? to : move(d))).sort());
      void refreshProjectFiles();
    },
    [saveDirty, refreshProjectFiles],
  );

  /** Delete a folder and everything in it. */
  const deleteDir = useCallback(
    async (path: string) => {
      const id = projectRef.current;
      if (!id) return;
      if (!window.confirm(`Delete the folder ${path} and everything in it?`)) return;
      const r = await deleteProjectDirApi(id, path);
      if (!r.ok) {
        window.alert(r.error ?? "Delete failed.");
        return;
      }
      const prefix = `${path}/`;
      const gone = (p: string) => p.startsWith(prefix);
      setFiles((f) => Object.fromEntries(Object.entries(f).filter(([p]) => !gone(p))));
      for (const p of Object.keys(mtimes.current)) if (gone(p)) delete mtimes.current[p];
      dirty.current = new Set([...dirty.current].filter((p) => !gone(p)));
      setOpenTabs((tabs) => tabs.filter((t) => !gone(t)));
      setActive((a) => (gone(a) ? MAIN : a));
      setProjectDirs((dirs) => dirs.filter((d) => d !== path && !gone(d)));
      void refreshProjectFiles();
    },
    [refreshProjectFiles],
  );

  const applyEdit = useCallback(
    (edit: ProposedEdit): ApplyResult => {
      const target = edit.file ?? MAIN;
      const current = filesRef.current[target] ?? ""; // "" = the agent created a new file
      const result = applyEditToDoc(current, edit);
      if (result.ok) {
        dirty.current.add(target);
        setFiles((f) => ({ ...f, [target]: result.doc }));
        openFile(target); // surface the change the agent just made
      }
      return result;
    },
    [openFile],
  );

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

  /** Ctrl/Cmd+click in the editor → scroll the PDF to that line. */
  const syncToPdf = useCallback(async (file: string, line: number) => {
    const id = projectRef.current;
    if (!id) return;
    const hit = await synctexForward(id, file, line);
    if (hit) setSyncTarget({ ...hit, stamp: Date.now() });
  }, []);

  /** Double-click in the PDF → open the source file at that line. */
  const syncToSource = useCallback(
    async (page: number, x: number, y: number) => {
      const id = projectRef.current;
      if (!id) return;
      const hit = await synctexReverse(id, page, x, y);
      if (!hit || filesRef.current[hit.file] === undefined) return;
      openFile(hit.file);
      setJumpTo({ ...hit, stamp: Date.now() });
    },
    [openFile],
  );

  const downloadPdf = useCallback(() => {
    if (!pdf) return;
    const blob = new Blob([pdf], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${projectRef.current ?? "main"}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }, [pdf]);

  const projectFiles = useMemo(() => Object.keys(files).sort(), [files]);

  return (
    <div className="app">
      <TopToolbar
        fileName={active}
        status={status}
        agentOpen={agentOpen}
        currentProject={projectId}
        onOpenProjects={openProjectsPage}
        onRecompile={() => void runCompile()}
        onToggleAgent={() => setAgentOpen((o) => !o)}
        onDownload={downloadPdf}
        canDownload={!!pdf}
      />

      {projectsOpen && (
        <ProjectsPage
          projects={projects}
          templates={templates}
          root={projectsRoot}
          currentProject={projectId}
          canClose={projectId !== null}
          onClose={() => setProjectsOpen(false)}
          onOpen={(id) => void openProject(id)}
          onCreate={createNewProject}
          onRename={renameProject}
          onDuplicate={duplicateProject}
          onDelete={deleteProject}
        />
      )}

      <div className="body">
        <div className="workspace">
          <PanelGroup direction="horizontal">
            <Panel defaultSize={50} minSize={22}>
              <EditorPane
                value={activeText}
                onChange={setActiveText}
                onCursor={setCursor}
                files={openTabs}
                projectFiles={projectFiles}
                projectDirs={projectDirs}
                active={active}
                onSelect={openFile}
                onCloseTab={closeTab}
                generatedFiles={binaryFiles}
                fileUrl={fileUrl}
                onUpload={uploadFile}
                onCreateEntry={createEntry}
                onRenameFile={(f) => void renameFile(f)}
                onDeleteFile={(f) => void deleteFile(f)}
                onRenameDir={(d) => void renameDir(d)}
                onDeleteDir={(d) => void deleteDir(d)}
                suggestions={pendingEdits.filter((e) => (e.file ?? MAIN) === active)}
                onAcceptSuggestion={acceptSuggestion}
                onRejectSuggestion={rejectSuggestion}
                fileContents={files}
                allFiles={[...projectFiles, ...binaryFiles]}
                diagnostics={diagnostics}
                onSyncToPdf={(f, l) => void syncToPdf(f, l)}
                jumpTo={jumpTo}
              />
            </Panel>
            <PanelResizeHandle className="resize-handle" />
            <Panel defaultSize={50} minSize={22}>
              <PreviewPane
                pdf={pdf}
                status={status}
                log={log}
                onPages={setPages}
                syncTarget={syncTarget}
                onSyncClick={(p, x, y) => void syncToSource(p, x, y)}
                onFixWithAI={fixWithAI}
              />
            </Panel>
          </PanelGroup>
        </div>

        {/* Collapsing only hides it (CSS) — the conversation survives. The
            project KEY remounts it on switch: each project hydrates its own
            history from .latentdraft/chat.json. */}
        <ChatPane
          key={projectId ?? "no-project"}
          projectId={projectId}
          onBeforeSend={saveDirty}
          sessionId={sessionId}
          getDocument={getDocument}
          getFiles={auxFiles}
          getLastCompile={getLastCompile}
          applyEdit={applyEdit}
          onClose={() => setAgentOpen(false)}
          collapsed={!agentOpen}
          onPendingEditsChange={setPendingEdits}
          resolverRef={editResolverRef}
          controlRef={chatControlRef}
          onTurnEnd={() => void refreshProjectFiles()}
          generatedFiles={binaryFiles}
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
