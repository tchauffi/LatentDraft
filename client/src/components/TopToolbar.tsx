import type { PreviewStatus } from "../panes/PreviewPane";

interface Props {
  fileName: string;
  status: PreviewStatus;
  agentOpen: boolean;
  onRecompile: () => void;
  onToggleAgent: () => void;
  onDownload: () => void;
  canDownload: boolean;
}

export default function TopToolbar({
  fileName,
  status,
  agentOpen,
  onRecompile,
  onToggleAgent,
  onDownload,
  canDownload,
}: Props) {
  const savedColor =
    status === "compiling" ? "#c2870b" : status === "error" ? "#d05a4a" : "#c9c4bc";

  return (
    <div className="toolbar">
      <div className="brand">
        <div className="brand-tile">
          L<span>D</span>
        </div>
        <span className="brand-name">LatentDraft</span>
      </div>

      <div className="toolbar-sep" />

      <div className="breadcrumb">
        <span>LatentDraft</span>
        <span className="crumb-slash">/</span>
        <span className="crumb-file">{fileName}</span>
        <span
          className="crumb-dot"
          style={{ background: savedColor }}
          title={status === "error" ? "compile error" : "saved"}
        />
      </div>

      <div className="toolbar-spacer" />

      <button className="btn-primary" onClick={onRecompile} disabled={status === "compiling"}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor">
          <path d="M3 2l7 4-7 4z" />
        </svg>
        Recompile
        <span className="kbd">⌘↵</span>
      </button>

      <button
        className="btn-icon"
        title="Download PDF"
        onClick={onDownload}
        disabled={!canDownload}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2v8m0 0L5 7m3 3l3-3" />
          <path d="M3 12v1a1 1 0 001 1h8a1 1 0 001-1v-1" />
        </svg>
      </button>

      <div className="toolbar-sep" />

      <button
        className={`btn-icon${agentOpen ? " active" : ""}`}
        title="Toggle agent"
        onClick={onToggleAgent}
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M10 2.5v11" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  );
}
