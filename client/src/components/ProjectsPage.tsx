import { useEffect, useRef, useState } from "react";
import type { ProjectInfo } from "../lib/api";

interface Props {
  projects: ProjectInfo[];
  templates: string[];
  /** Display path of the projects folder on disk (e.g. ~/LatentDraft). */
  root: string;
  currentProject: string | null;
  /** False on first run, when there is nothing to go back to. */
  canClose: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  /** Handlers resolve to an error message, or null on success. */
  onCreate: (name: string, template?: string) => Promise<string | null>;
  onRename: (id: string, name: string) => Promise<string | null>;
  onDuplicate: (id: string) => Promise<string | null>;
  onDelete: (id: string) => Promise<string | null>;
}

/** "just now", "14 min ago", "3 h ago", then a plain date. */
function relativeTime(mtimeMs: number): string {
  const mins = Math.round((Date.now() - mtimeMs) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(mtimeMs).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function ProjectsPage({
  projects,
  templates,
  root,
  currentProject,
  canClose,
  onClose,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [template, setTemplate] = useState(templates[0] ?? "article");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) nameInputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    if (!canClose) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !creating && !renamingId) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canClose, creating, renamingId, onClose]);

  const create = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    const err = await onCreate(name, template);
    setBusy(false);
    setError(err);
    if (!err) {
      setCreating(false);
      setNewName("");
    }
  };

  const rename = async (id: string) => {
    const name = renameValue.trim();
    if (busy) return;
    if (!name || name === id) {
      setRenamingId(null);
      return;
    }
    setBusy(true);
    const err = await onRename(id, name);
    setBusy(false);
    setError(err);
    if (!err) setRenamingId(null);
  };

  const remove = async (p: ProjectInfo) => {
    const label = p.title ? `“${p.title}” (${p.id})` : `“${p.id}”`;
    if (
      !window.confirm(
        `Delete ${label}?\n\nThis removes the whole folder ${root}/${p.id} from disk — every file in it, permanently.`,
      )
    )
      return;
    setError(await onDelete(p.id));
  };

  return (
    <div className="projects-page">
      <div className="projects-inner">
        <header className="projects-header">
          <div className="brand">
            <div className="brand-tile">
              L<span>D</span>
            </div>
            <span className="brand-name">LatentDraft</span>
          </div>
          {canClose && (
            <button className="btn-icon" title="Back to the editor (Esc)" onClick={onClose}>
              ✕
            </button>
          )}
        </header>

        <h1 className="projects-title">Projects</h1>
        <p className="projects-sub">
          Plain folders in <code className="mono">{root}</code> — git them, sync them, open them
          with any editor.
        </p>

        {error && (
          <div className="projects-error" role="alert">
            {error}
            <button className="link-btn" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}

        <div className="projects-grid">
          {projects.map((p) => (
            <article
              key={p.id}
              className={`project-card${p.id === currentProject ? " project-card-current" : ""}`}
              onClick={() => renamingId !== p.id && onOpen(p.id)}
            >
              {renamingId === p.id ? (
                <input
                  className="project-rename-input"
                  value={renameValue}
                  autoFocus
                  disabled={busy}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(p.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onBlur={() => void rename(p.id)}
                />
              ) : (
                <h2 className="project-card-title">{p.title ?? p.id}</h2>
              )}
              <div className="project-card-id mono">{p.id}/</div>
              <footer className="project-card-foot">
                <span className="project-card-time">
                  {p.id === currentProject ? "open now" : `edited ${relativeTime(p.mtimeMs)}`}
                </span>
                <span className="project-card-actions">
                  <button
                    className="project-action"
                    title="Rename project"
                    onClick={(e) => {
                      e.stopPropagation();
                      setError(null);
                      setRenamingId(p.id);
                      setRenameValue(p.id);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.5 2.5l2 2L5 13l-2.7.7.7-2.7z" />
                    </svg>
                  </button>
                  <button
                    className="project-action"
                    title="Duplicate project"
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      setBusy(true);
                      void onDuplicate(p.id).then((err) => {
                        setBusy(false);
                        setError(err);
                      });
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
                      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
                      <path d="M10.5 3.5v-1a1 1 0 00-1-1h-6a1 1 0 00-1 1v6a1 1 0 001 1h1" />
                    </svg>
                  </button>
                  <button
                    className="project-action"
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(p);
                    }}
                  >
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.6 9a1 1 0 001 .9h4.8a1 1 0 001-.9L12 4M6.7 6.5v5M9.3 6.5v5" />
                    </svg>
                  </button>
                </span>
              </footer>
            </article>
          ))}

          {creating ? (
            <article className="project-card project-card-new-form" onClick={(e) => e.stopPropagation()}>
              <input
                ref={nameInputRef}
                className="project-rename-input"
                placeholder="Project name"
                value={newName}
                disabled={busy}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void create();
                  if (e.key === "Escape") setCreating(false);
                }}
              />
              {templates.length > 1 && (
                <div className="project-templates">
                  {templates.map((t) => (
                    <button
                      key={t}
                      className={`project-template${t === template ? " project-template-on" : ""}`}
                      onClick={() => setTemplate(t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <footer className="project-card-foot">
                <button className="btn-primary" disabled={!newName.trim() || busy} onClick={() => void create()}>
                  Create project
                </button>
                <button className="link-btn" onClick={() => setCreating(false)}>
                  cancel
                </button>
              </footer>
            </article>
          ) : (
            <button
              className="project-card project-card-new"
              onClick={() => {
                setError(null);
                setCreating(true);
              }}
            >
              <span className="project-new-plus">＋</span>
              <span>New project</span>
            </button>
          )}
        </div>

        {projects.length === 0 && (
          <p className="projects-empty">No projects yet — create your first draft above.</p>
        )}
      </div>
    </div>
  );
}
