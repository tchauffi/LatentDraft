import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchProviders,
  streamChat,
  type CheckResult,
  type ProviderInfo,
  type ProposedEdit,
  type ToolActivity,
} from "../lib/api";
import {
  parseLatexEditBlocks,
  stripLatexEditBlocks,
  extractFullDocLatex,
  stripLatexDocBlock,
  type ApplyResult,
} from "../lib/diff";

interface EditCard extends ProposedEdit {
  status: "pending" | "applied" | "rejected" | "failed";
  failReason?: string;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  edits: EditCard[];
  /** Non-edit tool activity this turn (search, python, pdf, ats), in order. */
  activity: ToolActivity[];
  /** Result of the agent's most recent compile_check this turn. */
  check?: CheckResult;
  error?: string;
}

interface Props {
  getDocument: () => string;
  /** Auxiliary project files (refs.bib, sections/…) for the agent's compile sandbox. */
  getFiles?: () => Record<string, string>;
  applyEdit: (edit: ProposedEdit) => ApplyResult;
  onClose: () => void;
  collapsed?: boolean;
}

let idSeq = 0;
const nextId = () => `m${++idSeq}`;

function Sparkle({ size = 12, fill = "#fff" }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill}>
      <path d="M8 0l1.6 4.9L14.5 6l-4.9 1.6L8 12.5 6.4 7.6 1.5 6l4.9-1.1z" />
    </svg>
  );
}

export default function ChatPane({ getDocument, getFiles, applyEdit, onClose, collapsed }: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchProviders()
      .then((list) => {
        setProviders(list);
        const firstAvailable = list.find((p) => p.available && p.models.length > 0) ?? list[0];
        if (firstAvailable) {
          setProvider(firstAvailable.id);
          setModel(firstAvailable.models[0] ?? "");
        }
      })
      .catch(() => setProviders([]));
  }, []);

  const currentProvider = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  useEffect(() => {
    if (currentProvider && !currentProvider.models.includes(model)) {
      setModel(currentProvider.models[0] ?? "");
    }
  }, [currentProvider, model]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function updateMessage(id: string, fn: (m: UIMessage) => UIMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming || !provider || !model) return;
    setInput("");

    const userMsg: UIMessage = { id: nextId(), role: "user", content: text, edits: [], activity: [] };
    const assistantId = nextId();
    const assistantMsg: UIMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      edits: [],
      activity: [],
    };

    const history = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    await streamChat(
      { provider, model, documentText: getDocument(), files: getFiles?.(), messages: history },
      {
        onText: (t) =>
          updateMessage(assistantId, (m) => ({ ...m, content: m.content + t })),
        onEdit: (edit) =>
          updateMessage(assistantId, (m) => ({
            ...m,
            edits: [...m.edits, { ...edit, status: "pending" }],
          })),
        onCheck: (check) => updateMessage(assistantId, (m) => ({ ...m, check })),
        onTool: (tool) =>
          updateMessage(assistantId, (m) => ({ ...m, activity: [...m.activity, tool] })),
        onError: (msg) => updateMessage(assistantId, (m) => ({ ...m, error: msg })),
        onDone: () => {
          // Fallback: parse fenced latex-edit blocks from the text for models
          // that couldn't call the tool.
          updateMessage(assistantId, (m) => {
            const parsed = parseLatexEditBlocks(m.content);
            const extra: EditCard[] = parsed
              .filter((p) => !m.edits.some((e) => e.old_string === p.old_string))
              .map((p) => ({ ...p, status: "pending" as const }));

            let content = stripLatexEditBlocks(m.content);
            const edits = [...m.edits, ...extra];

            // Last-resort recovery: the model wrote a whole document into its
            // reply instead of calling edit_document. Offer it as a full-doc edit.
            if (edits.length === 0) {
              const doc = extractFullDocLatex(content);
              if (doc) {
                edits.push({
                  id: `fallback-${assistantId}`,
                  explanation: "Replace the document with the LaTeX from this reply",
                  old_string: "",
                  new_string: doc,
                  status: "pending",
                });
                content = stripLatexDocBlock(content, doc);
              }
            }

            return { ...m, content, edits };
          });
          setStreaming(false);
        },
      },
      abort.signal,
    ).catch((err) => {
      if (abort.signal.aborted) {
        updateMessage(assistantId, (m) => ({
          ...m,
          content: m.content + (m.content ? "\n\n" : "") + "_Stopped._",
        }));
      } else {
        updateMessage(assistantId, (m) => ({ ...m, error: String(err) }));
      }
      setStreaming(false);
    });
    abortRef.current = null;
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onAccept(msgId: string, edit: EditCard) {
    const result = applyEdit(edit);
    updateMessage(msgId, (m) => ({
      ...m,
      edits: m.edits.map((e) =>
        e.id === edit.id
          ? result.ok
            ? { ...e, status: "applied" }
            : { ...e, status: "failed", failReason: result.reason }
          : e,
      ),
    }));
  }

  function onReject(msgId: string, editId: string) {
    updateMessage(msgId, (m) => ({
      ...m,
      edits: m.edits.map((e) => (e.id === editId ? { ...e, status: "rejected" } : e)),
    }));
  }

  function onAcceptAll(msg: UIMessage) {
    // Apply pending edits in order; applyEdit mutates the doc synchronously so
    // later edits see the results of earlier ones.
    for (const edit of msg.edits) {
      if (edit.status === "pending") onAccept(msg.id, edit);
    }
  }

  return (
    <div className={`agent${collapsed ? " agent-collapsed" : ""}`}>
      <div className="agent-header">
        <span className="agent-mark">
          <Sparkle size={16} fill="#7c5cff" />
        </span>
        <span className="agent-title">Agent</span>
        <div className="agent-badge">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            title="Provider"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {p.available ? "" : " (unconfigured)"}
              </option>
            ))}
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)} title="Model">
            {(currentProvider?.models ?? []).map((mdl) => (
              <option key={mdl} value={mdl}>
                {mdl}
              </option>
            ))}
            {(currentProvider?.models ?? []).length === 0 && <option value="">no models</option>}
          </select>
        </div>
        <div className="toolbar-spacer" />
        <button
          className="agent-icon-btn"
          title="New chat"
          onClick={() => setMessages([])}
          disabled={streaming}
        >
          ＋
        </button>
        <button className="agent-icon-btn" title="Collapse" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="agent-body" ref={scrollRef}>
        {currentProvider && !currentProvider.available && currentProvider.note && (
          <div className="notice">{currentProvider.note}</div>
        )}
        {messages.length === 0 && (
          <div className="agent-empty">
            <Sparkle size={20} fill="#c9b8ff" />
            <p>Ask the agent to edit, explain, or fix your LaTeX. Proposed changes appear as accept/reject diffs.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.role === "user" ? (
              <div className="msg-user-bubble">{m.content}</div>
            ) : (
              <div className="msg-assistant-row">
                <div className="msg-avatar">
                  <Sparkle size={12} />
                </div>
                <div className="msg-assistant-content">
                  {m.activity.length > 0 && <ActivityList activity={m.activity} />}
                  {m.content && <div className="msg-text">{m.content}</div>}
                  {m.check && <VerifyBanner check={m.check} />}
                  {m.edits.filter((e) => e.status === "pending").length >= 2 && (
                    <button className="accept-all" onClick={() => onAcceptAll(m)}>
                      Accept all {m.edits.filter((e) => e.status === "pending").length} edits
                    </button>
                  )}
                  {m.edits.map((edit) => (
                    <EditCardView
                      key={edit.id}
                      edit={edit}
                      onAccept={() => onAccept(m.id, edit)}
                      onReject={() => onReject(m.id, edit.id)}
                    />
                  ))}
                  {m.error && <div className="msg-error">⚠ {m.error}</div>}
                  {!m.content && !m.error && m.edits.length === 0 && streaming && (
                    <div className="msg-text dim">
                      <span className="typing">
                        <i />
                        <i />
                        <i />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="composer-box">
          <div className="composer-chips">
            <span className="chip">@main.tex</span>
          </div>
          <textarea
            value={input}
            placeholder={streaming ? "Streaming…" : "Ask the agent to edit, explain, or fix your LaTeX…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            disabled={streaming}
          />
          <div className="composer-actions">
            <span className="composer-hint mono">Agent · edits files</span>
            <div className="toolbar-spacer" />
            {streaming ? (
              <button className="composer-send" onClick={stop} title="Stop">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="4" y="4" width="8" height="8" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                className="composer-send"
                onClick={send}
                disabled={!input.trim() || !model}
                title="Send"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 13V3M8 3L4 7M8 3l4 4" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const TOOL_ICON: Record<string, string> = {
  web_search: "🔎",
  run_python: "🐍",
  view_pdf: "👁️",
  ats_check: "📋",
};

function ActivityList({ activity }: { activity: ToolActivity[] }) {
  return (
    <div className="activity">
      {activity.map((a, i) => (
        <div key={i} className={`activity-item ${a.ok ? "" : "activity-fail"}`}>
          <span className="activity-icon">{TOOL_ICON[a.name] ?? "🛠️"}</span>
          <span>{a.summary}</span>
        </div>
      ))}
    </div>
  );
}

function VerifyBanner({ check }: { check: CheckResult }) {
  const [showLog, setShowLog] = useState(false);
  return (
    <div className={`verify ${check.ok ? "verify-ok" : "verify-fail"}`}>
      <div className="verify-head">
        {check.ok
          ? "✓ Verified — the document compiles with these changes."
          : "✗ The agent could not get it to compile."}
        {!check.ok && check.log && (
          <button className="link-btn" onClick={() => setShowLog((s) => !s)}>
            {showLog ? "hide log" : "show log"}
          </button>
        )}
      </div>
      {!check.ok && showLog && <pre className="verify-log">{check.log}</pre>}
    </div>
  );
}

function EditCardView({
  edit,
  onAccept,
  onReject,
}: {
  edit: EditCard;
  onAccept: () => void;
  onReject: () => void;
}) {
  const oldLines = edit.old_string ? edit.old_string.split("\n") : [];
  const newLines = edit.new_string.split("\n");
  return (
    <div className={`edit-card edit-${edit.status}`}>
      <div className="edit-head">
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="#a89a6b" strokeWidth="1.3">
          <path d="M3 1.5h5l3 3v8H3z" />
          <path d="M8 1.5v3h3" />
        </svg>
        <span className="mono">main.tex</span>
        <div className="toolbar-spacer" />
        {oldLines.length > 0 && <span className="diff-plus mono">+{newLines.length}</span>}
        {oldLines.length > 0 && <span className="diff-minus mono">−{oldLines.length}</span>}
        {oldLines.length === 0 && <span className="diff-plus mono">full doc</span>}
      </div>
      {edit.explanation && <div className="edit-expl">{edit.explanation}</div>}
      {!edit.old_string && <div className="edit-fulldoc">Replaces the entire document</div>}
      <div className="edit-diff">
        {oldLines.map((l, i) => (
          <div key={`o${i}`} className="diff-row diff-old">
            <span className="diff-sign">−</span>
            <span className="diff-code">{l || " "}</span>
          </div>
        ))}
        {newLines.map((l, i) => (
          <div key={`n${i}`} className="diff-row diff-new">
            <span className="diff-sign">+</span>
            <span className="diff-code">{l || " "}</span>
          </div>
        ))}
      </div>
      {edit.status === "pending" ? (
        <div className="edit-actions">
          <button className="accept" onClick={onAccept}>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2.5 7.5l3 3 6-7" />
            </svg>
            Apply
          </button>
          <button className="reject" onClick={onReject}>
            Reject
          </button>
        </div>
      ) : (
        <div className={`edit-status status-${edit.status}`}>
          {edit.status === "applied" && (
            <>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 7.5l3 3 6-7" />
              </svg>
              Applied to main.tex
            </>
          )}
          {edit.status === "rejected" && "Suggestion dismissed"}
          {edit.status === "failed" &&
            `⚠ could not apply (${edit.failReason === "ambiguous" ? "text matches multiple places" : "text not found"})`}
        </div>
      )}
    </div>
  );
}
