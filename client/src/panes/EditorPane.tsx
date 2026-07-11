import CodeMirror from "@uiw/react-codemirror";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { latexLight } from "../lib/editorTheme";

const latex = StreamLanguage.define(stex);

interface Props {
  value: string;
  onChange: (value: string) => void;
  onCursor?: (pos: { line: number; col: number }) => void;
  files: string[];
  active: string;
  onSelect: (file: string) => void;
}

function FileIcon({ active }: { active?: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke={active ? "#a89a6b" : "#b0a99f"} strokeWidth="1.3">
      <path d="M3 1.5h5l3 3v8H3z" />
      {active && <path d="M8 1.5v3h3" />}
    </svg>
  );
}

export default function EditorPane({ value, onChange, onCursor, files, active, onSelect }: Props) {
  // .tex files get LaTeX highlighting; other buffers (e.g. .bib) render plain.
  const extensions = active.endsWith(".tex") ? [latex] : [];

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
