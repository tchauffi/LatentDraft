import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { latexLight } from "../lib/editorTheme";
import type { Extension } from "@codemirror/state";
import { inlineSuggestions, type SuggestionCallbacks } from "../lib/inlineSuggest";
import type { ProposedEdit } from "../lib/api";

const latex = StreamLanguage.define(stex);

interface Props {
  value: string;
  onChange: (value: string) => void;
  onCursor?: (pos: { line: number; col: number }) => void;
  files: string[];
  active: string;
  onSelect: (file: string) => void;
  /** Pending agent edits to render inline (Cursor-style accept/reject). */
  suggestions?: ProposedEdit[];
  onAcceptSuggestion?: (edit: ProposedEdit) => void;
  onRejectSuggestion?: (edit: ProposedEdit) => void;
}

function FileIcon({ active }: { active?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={active ? "#a89a6b" : "#b0a99f"} strokeWidth="1.3">
      <path d="M3 1.5h5l3 3v8H3z" />
      {active && <path d="M8 1.5v3h3" />}
    </svg>
  );
}

export default function EditorPane({
  value,
  onChange,
  onCursor,
  files,
  active,
  onSelect,
  suggestions,
  onAcceptSuggestion,
  onRejectSuggestion,
}: Props) {
  // .tex files get LaTeX highlighting; other buffers (e.g. .bib) render plain.
  // The inline-suggestion extension is rebuilt whenever the pending set changes.
  const extensions = useMemo(() => {
    const exts: Extension[] = active.endsWith(".tex") ? [latex] : [];
    if (suggestions && suggestions.length > 0 && onAcceptSuggestion && onRejectSuggestion) {
      const cb: SuggestionCallbacks = {
        onAccept: onAcceptSuggestion,
        onReject: onRejectSuggestion,
      };
      exts.push(inlineSuggestions(suggestions, cb));
    }
    return exts;
  }, [active, suggestions, onAcceptSuggestion, onRejectSuggestion]);

  return (
    <div className="pane editor-pane">
      <div className="tabstrip">
        {files.map((f) => {
          const isActive = f === active;
          return (
            <div
              key={f}
              className={`tab${isActive ? " tab-active" : " tab-muted"}`}
              onClick={() => onSelect(f)}
            >
              <FileIcon active={isActive} />
              {f}
              {isActive && f === "main.tex" && <span className="tab-close">×</span>}
            </div>
          );
        })}
      </div>
      <div className="pane-body editor-body">
        <CodeMirror
          key={active}
          value={value}
          height="100%"
          theme={latexLight}
          extensions={extensions}
          onChange={onChange}
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
    </div>
  );
}
