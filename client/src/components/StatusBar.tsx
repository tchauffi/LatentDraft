import type { PreviewStatus } from "../panes/PreviewPane";

interface Props {
  status: PreviewStatus;
  pages: number;
  words: number;
  cursor: { line: number; col: number };
  log: string;
}

/** First meaningful error line from a Tectonic log, for the status bar. */
function firstError(log: string): string {
  const line = log
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("!") || /error/i.test(l));
  if (!line) return "compile failed";
  return line.replace(/^!\s*/, "").slice(0, 80);
}

export default function StatusBar({ status, pages, words, cursor, log }: Props) {
  return (
    <div className="statusbar">
      {status === "ready" && (
        <>
          <span className="stat ok">
            <span className="stat-dot" />
            Compiled successfully
          </span>
          {pages > 0 && (
            <>
              <span className="stat-sep">·</span>
              <span>
                {pages} page{pages === 1 ? "" : "s"}
              </span>
            </>
          )}
        </>
      )}
      {status === "compiling" && (
        <span className="stat warn">
          <span className="stat-dot pulse" />
          Compiling…
        </span>
      )}
      {status === "error" && (
        <>
          <span className="stat err">
            <span className="stat-dot" />
            Compile error
          </span>
          <span className="stat-sep">·</span>
          <span className="mono err-detail">{firstError(log)}</span>
        </>
      )}
      {status === "idle" && <span className="stat idle">Ready</span>}

      <div className="toolbar-spacer" />

      <span className="mono">LaTeX</span>
      <span className="stat-sep">·</span>
      <span className="mono">UTF-8</span>
      <span className="stat-sep">·</span>
      <span className="mono">
        Ln {cursor.line}, Col {cursor.col}
      </span>
      <span className="stat-sep">·</span>
      <span>{words.toLocaleString()} words</span>
    </div>
  );
}
