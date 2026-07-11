import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type PreviewStatus = "idle" | "compiling" | "ready" | "error";

interface Props {
  pdf: ArrayBuffer | null;
  status: PreviewStatus;
  log: string;
  onPages?: (n: number) => void;
  /** SyncTeX forward target (pt, top-left of `page`) — scroll there and flash. */
  syncTarget?: { page: number; x: number; y: number; stamp: number } | null;
  /** Double-click on a page: report PDF coords (pt) for SyncTeX inverse search. */
  onSyncClick?: (page: number, x: number, y: number) => void;
  /** Ask the agent to fix the current compile failure. */
  onFixWithAI?: () => void;
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.6;

export default function PreviewPane({
  pdf,
  status,
  log,
  onPages,
  syncTarget,
  onSyncClick,
  onFixWithAI,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);
  const [scale, setScale] = useState(1.2);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const renderToken = useRef(0);
  // PDF pt → CSS px, matching the render viewport below.
  const ptToPx = scale * 1.4;
  const [flash, setFlash] = useState<{ top: number; stamp: number } | null>(null);

  // SyncTeX forward: scroll the target line's position into view and flash it.
  useEffect(() => {
    if (!syncTarget) return;
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    const canvas = container.children[syncTarget.page - 1] as HTMLElement | undefined;
    if (!canvas) return;
    const top = canvas.offsetTop + syncTarget.y * ptToPx;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: "smooth" });
    setFlash({ top, stamp: syncTarget.stamp });
  }, [syncTarget, ptToPx]);

  // Double-click → PDF coords in pt for the inverse search.
  function onDblClick(e: React.MouseEvent) {
    if (!onSyncClick) return;
    const container = containerRef.current;
    if (!container) return;
    const canvases = [...container.children] as HTMLElement[];
    const idx = canvases.findIndex((c) => c === e.target);
    if (idx === -1) return;
    const rect = canvases[idx].getBoundingClientRect();
    onSyncClick(idx + 1, (e.clientX - rect.left) / ptToPx, (e.clientY - rect.top) / ptToPx);
  }

  useEffect(() => {
    if (!pdf) return;
    const container = containerRef.current;
    if (!container) return;

    const token = ++renderToken.current;
    let cancelled = false;

    (async () => {
      // Clone: pdf.js may transfer/detach the underlying buffer.
      const data = new Uint8Array(pdf.slice(0));
      const doc = await pdfjsLib.getDocument({ data }).promise;
      try {
        if (cancelled || token !== renderToken.current) return;

        container.innerHTML = "";
        setPages(doc.numPages);
        onPages?.(doc.numPages);
        const dpr = window.devicePixelRatio || 1;

        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled || token !== renderToken.current) return;
          const viewport = page.getViewport({ scale: scale * 1.4 });
          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page";
          canvas.width = Math.floor(viewport.width * dpr);
          canvas.height = Math.floor(viewport.height * dpr);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          ctx.scale(dpr, dpr);
          container.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      } finally {
        // The canvases keep their pixels; the parsed document would otherwise
        // leak worker memory on every recompile.
        void doc.destroy();
      }
    })().catch((err) => {
      if (!cancelled) console.error("PDF render failed", err);
    });

    return () => {
      cancelled = true;
    };
  }, [pdf, scale, onPages]);

  // Track which page is centered in the scroll viewport.
  function onScroll() {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    const mid = scroller.scrollTop + scroller.clientHeight / 2;
    const canvases = container.children;
    let current = 1;
    for (let i = 0; i < canvases.length; i++) {
      const el = canvases[i] as HTMLElement;
      if (el.offsetTop <= mid) current = i + 1;
    }
    setPage(current);
  }

  const showPdf = status !== "error" || !showLog;
  const zoomPct = Math.round(scale * 100);

  return (
    <div className="pane preview-pane">
      <div className="preview-header">
        <span className="preview-label">Preview</span>
        {status === "error" && (
          <button className="link-btn" onClick={() => setShowLog((s) => !s)}>
            {showLog ? "hide log" : "show error log"}
          </button>
        )}
        {status === "error" && onFixWithAI && (
          <button className="fix-ai-btn" onClick={onFixWithAI} title="Ask the agent to fix the compile error">
            ✦ Fix with AI
          </button>
        )}
        <div className="toolbar-spacer" />
        <div className="zoom">
          <button
            onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - 0.15).toFixed(2)))}
            title="Zoom out"
          >
            −
          </button>
          <span className="zoom-val">{zoomPct}%</span>
          <button
            onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + 0.15).toFixed(2)))}
            title="Zoom in"
          >
            +
          </button>
        </div>
        {pages > 0 && (
          <div className="pagecount">
            <span>Page</span>
            <span className="pagecount-cur">{page}</span>
            <span>/ {pages}</span>
          </div>
        )}
      </div>

      <div className="pane-body preview-body">
        {status === "error" && showLog ? (
          <pre className="compile-log">{log}</pre>
        ) : (
          <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
            {status === "compiling" && (
              <div className="compile-overlay">
                <div className="spinner" />
                <span className="mono">compiling main.tex…</span>
              </div>
            )}
            <div
              className="pdf-pages"
              ref={containerRef}
              onDoubleClick={onDblClick}
              title={onSyncClick ? "Double-click to jump to the source line" : undefined}
            />
            {flash && (
              <div
                key={flash.stamp}
                className="sync-flash"
                style={{ top: `${flash.top - 9}px` }}
                onAnimationEnd={() => setFlash(null)}
              />
            )}
            {!pdf && status !== "compiling" && showPdf && (
              <div className="empty-hint">The compiled PDF will appear here.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
