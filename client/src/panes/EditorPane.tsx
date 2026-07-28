import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { python } from "@codemirror/legacy-modes/mode/python";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { json as jsonMode } from "@codemirror/legacy-modes/mode/javascript";
import { markdown } from "@codemirror/lang-markdown";
import { linter, lintGutter } from "@codemirror/lint";
import { latexLight } from "../lib/editorTheme";
import type { Extension } from "@codemirror/state";
import { inlineSuggestions, type SuggestionCallbacks } from "../lib/inlineSuggest";
import { latexAutocomplete } from "../lib/latexComplete";
import { buildFileTree, isImageFile, moveTarget, parentOf, type FileNode } from "../lib/fileTree";
import type { CompileDiagnostic, ProposedEdit } from "../lib/api";

const latex = StreamLanguage.define(stex);

/** Non-LaTeX syntax highlighting by extension; undefined renders plain. */
function languageFor(file: string): Extension | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  switch (ext) {
    case "py":
      return StreamLanguage.define(python);
    case "md":
      return markdown();
    case "yml":
    case "yaml":
      return StreamLanguage.define(yaml);
    case "json":
      return StreamLanguage.define(jsonMode);
    case "sh":
      return StreamLanguage.define(shell);
    default:
      return undefined;
  }
}

/** A file to upload, with the project-relative path it should land under.
 * `path` differs from `file.name` only for files inside a dropped folder. */
export interface UploadFile {
  file: File;
  path?: string;
}

/** Identifies an internal tree drag, so drops from other apps are ignored. */
const DRAG_MIME = "application/x-latentdraft-path";

/**
 * Collect the dropped items as uploadable files. A dropped folder is walked
 * recursively (webkitGetAsEntry), so its structure is preserved rather than
 * flattened; browsers without the API fall back to the flat file list.
 */
async function filesFromDrop(dt: DataTransfer): Promise<UploadFile[]> {
  const entries = [...dt.items]
    .filter((i) => i.kind === "file")
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.length === 0 || entries.every((e) => !e)) {
    return [...dt.files].map((file) => ({ file }));
  }
  const out: UploadFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) out.push({ file, path: prefix + file.name });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most ~100 per call — keep reading until it's dry.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    }
  };
  for (const entry of entries) if (entry) await walk(entry, "");
  return out;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onCursor?: (pos: { line: number; col: number }) => void;
  /** OPEN buffers, shown as tabs. */
  files: string[];
  /** All editable project files, shown in the tree (superset of `files`). */
  projectFiles?: string[];
  /** All project directories (incl. empty ones), from the server listing. */
  projectDirs?: string[];
  active: string;
  onSelect: (file: string) => void;
  /** Close an open tab (never called for main.tex — it is pinned). */
  onCloseTab?: (file: string) => void;
  /** Server-side session files not in `files` — e.g. figures from run_python. */
  generatedFiles?: string[];
  /** URL serving a session file's content, for previews of generated files. */
  fileUrl?: (name: string) => string;
  /** Upload data files into `destDir` ("" = root); resolves to an error or null. */
  onUpload?: (files: UploadFile[], destDir?: string) => Promise<string | null>;
  /** Move a file or folder into another folder ("" = root), by drag-and-drop. */
  onMoveEntry?: (from: string, toDir: string) => void;
  /** Create a file or folder (inline input row); resolves to an error or null. */
  onCreateEntry?: (path: string, kind: "file" | "dir") => Promise<string | null>;
  /** Project file operations (shown as actions above the tree). */
  onRenameFile?: (path: string) => void;
  onDeleteFile?: (path: string) => void;
  /** Folder operations (hover actions on directory rows). */
  onRenameDir?: (path: string) => void;
  onDeleteDir?: (path: string) => void;
  /** Pending agent edits to render inline (Cursor-style accept/reject). */
  suggestions?: ProposedEdit[];
  onAcceptSuggestion?: (edit: ProposedEdit) => void;
  onRejectSuggestion?: (edit: ProposedEdit) => void;
  /** All text buffers (for \cite/\ref autocomplete extraction). */
  fileContents?: Record<string, string>;
  /** Every project file incl. binaries (for \includegraphics completion). */
  allFiles?: string[];
  /** Structured compile errors — squiggles in the active buffer, badges in the tree. */
  diagnostics?: CompileDiagnostic[];
  /** Ctrl/Cmd+click in the source: jump the PDF preview here (SyncTeX forward). */
  onSyncToPdf?: (file: string, line: number) => void;
  /** Set (with a fresh stamp) to move the cursor to a line — SyncTeX inverse. */
  jumpTo?: { file: string; line: number; stamp: number };
}

function FileIcon({ active }: { active?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={active ? "#a89a6b" : "#b0a99f"} strokeWidth="1.3">
      <path d="M3 1.5h5l3 3v8H3z" />
      {active && <path d="M8 1.5v3h3" />}
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="#b0a99f" strokeWidth="1.3">
      <path d="M1.5 3h4l1.5 2h5.5v6.5h-11z" />
    </svg>
  );
}

function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="8"
      height="8"
      viewBox="0 0 8 8"
      fill="none"
      stroke="#b0a99f"
      strokeWidth="1.4"
      className={`filetree-chevron${collapsed ? " filetree-chevron-collapsed" : ""}`}
    >
      <path d="M2 1l4 3-4 3" />
    </svg>
  );
}

/** Drag-and-drop wiring shared by every row and by the tree background. */
interface DragOps {
  /** The entry being dragged, for styling only — `beginDrag` records the
   * authoritative copy synchronously, since dragover can fire before React
   * has re-rendered and a stale value would accept an illegal drop. */
  dragging: string | null;
  beginDrag: (path: string) => void;
  endDrag: () => void;
  /** Folder highlighted as the drop target ("" = the tree root). */
  dropDir: string | null;
  setDropDir: (dir: string | null) => void;
  /** Whether a drop onto this folder is currently allowed. */
  canDrop: (toDir: string, internal: boolean) => boolean;
  /** Perform the drop: an internal move, or an upload of dropped OS files. */
  onDrop: (e: React.DragEvent, toDir: string) => void;
}

/** Whether a drag carries one of our tree rows. `types` is the only part of
 * the DataTransfer readable during dragover — getData is blocked until drop. */
function isInternalDrag(dt: DataTransfer): boolean {
  return [...dt.types].includes(DRAG_MIME);
}

/** Handlers for anything that accepts a drop into `dir` ("" = root). */
function dropProps(ops: DragOps, dir: string) {
  return {
    onDragOver: (e: React.DragEvent) => {
      const internal = isInternalDrag(e.dataTransfer);
      if (!ops.canDrop(dir, internal)) return;
      e.preventDefault(); // required, or the browser refuses the drop
      e.stopPropagation();
      e.dataTransfer.dropEffect = internal ? "move" : "copy";
      ops.setDropDir(dir);
    },
    onDragLeave: (e: React.DragEvent) => {
      // Ignore the leave events fired while crossing this row's own children.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (ops.dropDir === dir) ops.setDropDir(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!ops.canDrop(dir, isInternalDrag(e.dataTransfer))) return;
      e.preventDefault();
      e.stopPropagation();
      ops.onDrop(e, dir);
    },
  };
}

function TreeLevel({
  nodes,
  active,
  preview,
  onPick,
  errorCounts,
  collapsed,
  onToggleDir,
  onRenameDir,
  onDeleteDir,
  drag,
}: {
  nodes: FileNode[];
  active: string;
  preview: string | null;
  onPick: (node: FileNode) => void;
  errorCounts?: Record<string, number>;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  onRenameDir?: (path: string) => void;
  onDeleteDir?: (path: string) => void;
  drag?: DragOps;
}) {
  /** Rows are draggable only for real project files — generated (server-side)
   * files and main.tex have nowhere to move to. */
  const dragProps = (node: FileNode) =>
    !drag || node.generated || node.path === "main.tex"
      ? {}
      : {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.stopPropagation();
            e.dataTransfer.setData(DRAG_MIME, node.path);
            e.dataTransfer.effectAllowed = "move";
            drag.beginDrag(node.path);
          },
          onDragEnd: () => drag.endDrag(),
        };

  return (
    <ul className="filetree-level">
      {nodes.map((node) =>
        node.children ? (
          <li key={node.path}>
            <div
              className={`filetree-row filetree-dir${
                drag?.dropDir === node.path ? " filetree-droptarget" : ""
              }${drag?.dragging === node.path ? " filetree-dragging" : ""}`}
              onClick={() => onToggleDir(node.path)}
              {...dragProps(node)}
              {...(drag ? dropProps(drag, node.path) : {})}
            >
              <Chevron collapsed={collapsed.has(node.path)} />
              <FolderIcon />
              <span className="filetree-name">{node.name}</span>
              <span className="filetree-dir-actions">
                {onRenameDir && (
                  <button
                    className="filetree-action"
                    title={`Rename ${node.path}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameDir(node.path);
                    }}
                  >
                    ✎
                  </button>
                )}
                {onDeleteDir && (
                  <button
                    className="filetree-action"
                    title={`Delete ${node.path}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteDir(node.path);
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            </div>
            {!collapsed.has(node.path) && (
              <TreeLevel
                nodes={node.children}
                active={active}
                preview={preview}
                onPick={onPick}
                errorCounts={errorCounts}
                collapsed={collapsed}
                onToggleDir={onToggleDir}
                onRenameDir={onRenameDir}
                onDeleteDir={onDeleteDir}
                drag={drag}
              />
            )}
          </li>
        ) : (
          <li key={node.path}>
            <div
              className={`filetree-row${
                node.path === (preview ?? active) ? " filetree-active" : ""
              }${drag?.dragging === node.path ? " filetree-dragging" : ""}`}
              onClick={() => onPick(node)}
              {...dragProps(node)}
              {...(drag ? dropProps(drag, parentOf(node.path)) : {})}
            >
              <FileIcon active={node.path === (preview ?? active)} />
              <span className="filetree-name">{node.name}</span>
              {(errorCounts?.[node.path] ?? 0) > 0 && (
                <span className="filetree-errbadge" title="Compile errors in this file">
                  {errorCounts![node.path]}
                </span>
              )}
              {node.generated && <span className="filetree-gen" title="Generated by the agent" />}
            </div>
          </li>
        ),
      )}
    </ul>
  );
}

export default function EditorPane({
  value,
  onChange,
  onCursor,
  files,
  projectFiles,
  projectDirs,
  active,
  onSelect,
  onCloseTab,
  generatedFiles,
  fileUrl,
  onUpload,
  onMoveEntry,
  onCreateEntry,
  onRenameFile,
  onDeleteFile,
  onRenameDir,
  onDeleteDir,
  suggestions,
  onAcceptSuggestion,
  onRejectSuggestion,
  fileContents,
  allFiles,
  diagnostics,
  onSyncToPdf,
  jumpTo,
}: Props) {
  const viewRef = useRef<EditorView | null>(null);

  // SyncTeX inverse: place the cursor on the requested line once its buffer is active.
  useEffect(() => {
    const view = viewRef.current;
    if (!jumpTo || !view || jumpTo.file !== active) return;
    const line = view.state.doc.line(Math.min(Math.max(1, jumpTo.line), view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [jumpTo, active]);

  // SyncTeX forward: Ctrl/Cmd+click a source line to jump the PDF there.
  const syncClickExt = useMemo(() => {
    if (!onSyncToPdf) return [] as Extension[];
    return [
      EditorView.domEventHandlers({
        mousedown: (e, view) => {
          if (!(e.ctrlKey || e.metaKey)) return false;
          const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          onSyncToPdf(active, view.state.doc.lineAt(pos).number);
          return true;
        },
      }),
    ];
  }, [onSyncToPdf, active]);

  // Getter refs keep the (stateful) autocomplete extension stable across renders.
  const textsRef = useRef<Record<string, string>>({});
  textsRef.current = fileContents ?? {};
  const allFilesRef = useRef<string[]>([]);
  allFilesRef.current = allFiles ?? [];
  const autocompleteExt = useMemo(
    () => latexAutocomplete(() => textsRef.current, () => allFilesRef.current),
    [],
  );
  const [showTree, setShowTree] = useState(true);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  // A generated (server-side) file being previewed instead of the editor.
  // `stamp` busts the browser cache so a regenerated figure re-renders.
  const [preview, setPreview] = useState<{ path: string; stamp: number } | null>(null);

  const tree = useMemo(
    () => buildFileTree(projectFiles ?? files, generatedFiles ?? [], projectDirs ?? []),
    [projectFiles, files, generatedFiles, projectDirs],
  );
  // Folded folders (VS Code style) — session-local, keyed by dir path.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  // Inline creation row: which kind is being named, plus a server-side error.
  const [creating, setCreating] = useState<"file" | "dir" | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const createInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);
  const createBusyRef = useRef(false); // Enter then blur must not create twice
  const submitCreate = async (name: string) => {
    if (createBusyRef.current) return;
    const path = name.trim().replace(/^\/+|\/+$/g, "");
    if (!path || !onCreateEntry) {
      setCreating(null);
      setCreateError(null);
      return;
    }
    createBusyRef.current = true;
    try {
      const err = await onCreateEntry(path, creating ?? "file");
      if (err) {
        setCreateError(err); // keep the row open so the name can be fixed
      } else {
        setCreating(null);
        setCreateError(null);
      }
    } finally {
      createBusyRef.current = false;
    }
  };
  // ---- Drag and drop: reorganise the tree, or drop files in from the desktop.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // dragover can fire in the same tick as dragstart, before React re-renders,
  // so the drag source lives in a ref and `dragging` is only for the styling.
  const draggingRef = useRef<string | null>(null);

  const drag = useMemo<DragOps>(() => {
    const canDrop = (toDir: string, internal: boolean) => {
      if (internal) {
        const from = draggingRef.current;
        return from !== null && onMoveEntry !== undefined && moveTarget(from, toDir).ok;
      }
      return onUpload !== undefined; // an external drag — anything can be uploaded
    };
    const endDrag = () => {
      draggingRef.current = null;
      setDragging(null);
      setDropDir(null);
    };
    return {
      dragging,
      beginDrag: (path) => {
        draggingRef.current = path;
        setDragging(path);
      },
      endDrag,
      dropDir,
      setDropDir,
      canDrop,
      onDrop: (e, toDir) => {
        setDropDir(null);
        const moved = e.dataTransfer.getData(DRAG_MIME);
        if (moved) {
          endDrag();
          onMoveEntry?.(moved, toDir);
          return;
        }
        if (!onUpload) return;
        void (async () => {
          const dropped = await filesFromDrop(e.dataTransfer);
          if (dropped.length === 0) return;
          setUploading(true);
          try {
            setUploadError(await onUpload(dropped, toDir));
          } finally {
            setUploading(false);
          }
        })();
      },
    };
  }, [dragging, dropDir, onMoveEntry, onUpload]);

  // A previewed file can disappear (e.g. new browser session dir) — fall back.
  const previewGone = preview && !(generatedFiles ?? []).includes(preview.path);
  const activePreview = preview && !previewGone ? preview : null;

  const pick = (node: FileNode) => {
    if (node.generated) {
      setPreview({ path: node.path, stamp: Date.now() });
    } else {
      setPreview(null);
      onSelect(node.path);
    }
  };
  // Compile errors for the ACTIVE buffer become lint squiggles; the linter
  // clamps line numbers so a stale diagnostic never crashes on a shorter doc.
  const lintExt = useMemo((): Extension[] => {
    const mine = (diagnostics ?? []).filter((d) => d.file === active);
    if (mine.length === 0) return [];
    return [
      lintGutter(),
      linter(
        (view) =>
          mine.map((d) => {
            const line = view.state.doc.line(
              Math.min(Math.max(1, d.line), view.state.doc.lines),
            );
            return { from: line.from, to: line.to, severity: d.severity, message: d.message };
          }),
        { delay: 0 },
      ),
    ];
  }, [diagnostics, active]);

  // Per-file error counts for the tree badges.
  const errorCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of diagnostics ?? []) counts[d.file] = (counts[d.file] ?? 0) + 1;
    return counts;
  }, [diagnostics]);

  // .tex files get LaTeX highlighting (plus autocomplete and SyncTeX); other
  // known types (.py, .md, .yml, .json, .sh) get plain syntax highlighting.
  // The inline-suggestion extension is rebuilt whenever the pending set changes.
  const extensions = useMemo(() => {
    const lang = languageFor(active);
    const exts: Extension[] = active.endsWith(".tex")
      ? [latex, autocompleteExt, ...lintExt, ...syncClickExt]
      : [...(lang ? [lang] : []), ...lintExt];
    if (suggestions && suggestions.length > 0 && onAcceptSuggestion && onRejectSuggestion) {
      const cb: SuggestionCallbacks = {
        onAccept: onAcceptSuggestion,
        onReject: onRejectSuggestion,
      };
      exts.push(inlineSuggestions(suggestions, cb));
    }
    return exts;
  }, [active, suggestions, onAcceptSuggestion, onRejectSuggestion, autocompleteExt, lintExt, syncClickExt]);

  return (
    <div className="pane editor-pane">
      <div className="tabstrip">
        <button
          className={`tree-toggle${showTree ? " tree-toggle-on" : ""}`}
          onClick={() => setShowTree((s) => !s)}
          title={showTree ? "Hide files" : "Show files"}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1.5 3h4l1.5 2h5.5v6.5h-11z" />
          </svg>
        </button>
        {files.map((f) => {
          const isActive = f === active && !activePreview;
          return (
            <div
              key={f}
              className={`tab${isActive ? " tab-active" : " tab-muted"}`}
              onClick={() => {
                setPreview(null);
                onSelect(f);
              }}
            >
              <FileIcon active={isActive} />
              {f}
              {f !== "main.tex" && onCloseTab && (
                <span
                  className="tab-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(f);
                  }}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
        {activePreview && (
          <div className="tab tab-active tab-preview">
            <FileIcon active />
            {activePreview.path}
            <span className="tab-close" title="Close preview" onClick={() => setPreview(null)}>
              ×
            </span>
          </div>
        )}
      </div>
      <div className="editor-main">
        {showTree && (
          // The tree itself is the root drop target: files dropped on the
          // background land at the project root, folder rows take precedence.
          <div
            className={`filetree${dropDir === "" ? " filetree-droproot" : ""}`}
            {...dropProps(drag, "")}
          >
            {onCreateEntry && (
              <div className="filetree-actions">
                <span className="filetree-actions-label">FILES</span>
                <div className="toolbar-spacer" />
                <button
                  className="filetree-action"
                  title="New file (any text type: .tex, .py, .md, …; use / to nest)"
                  onClick={() => {
                    setCreating("file");
                    setCreateError(null);
                  }}
                >
                  ＋
                </button>
                <button
                  className="filetree-action"
                  title="New folder (use / to nest)"
                  onClick={() => {
                    setCreating("dir");
                    setCreateError(null);
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                    <path d="M1.5 3h4l1.5 2h5.5v6.5h-11z" />
                    <path d="M7 7.5v3M5.5 9h3" />
                  </svg>
                </button>
                <button
                  className="filetree-action"
                  title={`Rename ${active}`}
                  onClick={() => onRenameFile?.(active)}
                  disabled={active === "main.tex"}
                >
                  ✎
                </button>
                <button
                  className="filetree-action"
                  title={`Delete ${active}`}
                  onClick={() => onDeleteFile?.(active)}
                  disabled={active === "main.tex"}
                >
                  ×
                </button>
              </div>
            )}
            {creating && (
              <div className="filetree-create">
                <div className="filetree-create-row">
                  {creating === "dir" ? <FolderIcon /> : <FileIcon />}
                  <input
                    ref={createInputRef}
                    className="filetree-create-input"
                    placeholder={creating === "dir" ? "folder/name" : "sections/notes.md"}
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitCreate(e.currentTarget.value);
                      if (e.key === "Escape") {
                        setCreating(null);
                        setCreateError(null);
                      }
                    }}
                    onBlur={(e) => {
                      // Blur with a name = create (like VS Code); empty = cancel.
                      void submitCreate(e.currentTarget.value);
                    }}
                  />
                </div>
                {createError && <div className="filetree-create-err">{createError}</div>}
              </div>
            )}
            <TreeLevel
              nodes={tree}
              active={active}
              preview={activePreview?.path ?? null}
              onPick={pick}
              errorCounts={errorCounts}
              collapsed={collapsed}
              onToggleDir={toggleDir}
              onRenameDir={onRenameDir}
              onDeleteDir={onDeleteDir}
              drag={drag}
            />
            {onUpload && (
              <div className="filetree-upload">
                <button
                  className="filetree-upload-btn"
                  title="Add data files (CSV, Excel, image, …) — or drag them in from your desktop"
                  onClick={() => uploadInputRef.current?.click()}
                  disabled={uploading}
                >
                  {uploading ? "Uploading…" : "+ Add data files"}
                </button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  multiple
                  accept=".csv,.tsv,.xlsx,.xls,.json,.txt,.dat,.png,.jpg,.jpeg,.svg,.pdf,.bib,.py,.md,.yml,.yaml"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const picked = [...(e.target.files ?? [])].map((file) => ({ file }));
                    e.target.value = ""; // allow re-uploading the same name
                    if (picked.length === 0) return;
                    setUploading(true);
                    try {
                      setUploadError(await onUpload(picked));
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
                {uploadError && <div className="filetree-upload-err">{uploadError}</div>}
              </div>
            )}
          </div>
        )}
        {activePreview && fileUrl ? (
          <div className="pane-body file-preview">
            {isImageFile(activePreview.path) ? (
              <img
                src={`${fileUrl(activePreview.path)}&v=${activePreview.stamp}`}
                alt={activePreview.path}
              />
            ) : (
              <iframe
                title={activePreview.path}
                src={`${fileUrl(activePreview.path)}&v=${activePreview.stamp}`}
              />
            )}
          </div>
        ) : (
          <div className="pane-body editor-body">
            <CodeMirror
              key={active}
              value={value}
              height="100%"
              theme={latexLight}
              extensions={extensions}
              onChange={onChange}
              onCreateEditor={(view) => {
                viewRef.current = view;
              }}
              onUpdate={(vu) => {
                if (!onCursor) return;
                if (vu.selectionSet || vu.docChanged) {
                  const head = vu.state.selection.main.head;
                  const line = vu.state.doc.lineAt(head);
                  onCursor({ line: line.number, col: head - line.from + 1 });
                }
              }}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                bracketMatching: true,
                closeBrackets: true,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
