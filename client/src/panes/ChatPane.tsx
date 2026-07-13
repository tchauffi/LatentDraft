import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  fetchProviders,
  fetchProjectChat,
  saveProjectChat,
  streamChat,
  type CheckResult,
  type ProviderInfo,
  type ProposedEdit,
  type ToolActivity,
} from "../lib/api";
import { contextSeverity, estimateRequestTokens, formatTokens } from "../lib/context";
import {
  parseLatexEditBlocks,
  stripLatexEditBlocks,
  extractFullDocLatex,
  stripLatexDocBlock,
  type ApplyResult,
} from "../lib/diff";
import { expandSlashCommand, matchSlashCommands } from "../lib/slashCommands";

interface EditCard extends ProposedEdit {
  status: "pending" | "applied" | "rejected" | "failed";
  failReason?: string;
}

interface UIMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** What the user literally typed, when a slash command expanded `content`. */
  display?: string;
  edits: EditCard[];
  /** Non-edit tool activity this turn (search, python, pdf, ats), in order. */
  activity: ToolActivity[];
  /** Result of the agent's most recent compile_check this turn. */
  check?: CheckResult;
  error?: string;
}

interface Props {
  /** The project the agent works on (multi-file mode). */
  projectId?: string | null;
  /** Flush dirty buffers to disk before a turn — the agent reads from disk. */
  onBeforeSend?: () => Promise<void>;
  /** The editor's compile session — legacy fallback when no project is open. */
  sessionId?: string;
  getDocument: () => string;
  /** Auxiliary project files (refs.bib, sections/…) for the agent's compile sandbox. */
  getFiles?: () => Record<string, string>;
  /** Editor's most recent compile result, so its failure log reaches the agent. */
  getLastCompile?: () => { ok: boolean; log: string } | null;
  applyEdit: (edit: ProposedEdit) => ApplyResult;
  onClose: () => void;
  collapsed?: boolean;
  /** Notified whenever the set of pending (undecided) edits changes — drives the inline editor suggestions. */
  onPendingEditsChange?: (edits: ProposedEdit[]) => void;
  /** Receives a resolver so other panes (inline suggestions) can accept/reject an edit by id. */
  resolverRef?: React.MutableRefObject<((editId: string, action: "accept" | "reject") => void) | null>;
  /** Exposes send/autoFix/streaming so the app can trigger agent turns (auto-fix). */
  controlRef?: React.MutableRefObject<{
    send: (text: string) => void;
    autoFix: boolean;
    streaming: boolean;
  } | null>;
  /** Called when an agent turn finishes (files may have been generated server-side). */
  onTurnEnd?: () => void;
  /** Server-side generated files — part of the agent's context, shown in the composer chips. */
  generatedFiles?: string[];
}

let idSeq = 0;
const nextId = () => `m${++idSeq}`;

/* ---- Per-project chat history, persisted server-side in the project's
   .latentdraft/chat.json (it travels with the folder on rename and dies with
   it on delete). The pane is remounted with a project-keyed `key`, so each
   mount hydrates one project's conversation and saves back on change. ---- */
const CHAT_LIMIT = 40; // messages kept per project — bounds chat.json growth

/** Make hydrated messages safe to resume: fresh ids won't collide, and stale
 * pending edits don't resurrect as live inline suggestions. */
function reviveChat(msgs: UIMessage[]): UIMessage[] {
  for (const m of msgs) {
    const n = Number(m.id.slice(1));
    if (Number.isFinite(n) && n > idSeq) idSeq = n;
    m.edits = (m.edits ?? []).map((e) =>
      e.status === "pending" ? { ...e, status: "rejected" as const } : e,
    );
    m.activity = m.activity ?? [];
  }
  return msgs;
}

function Sparkle({ size = 12, fill = "#fff" }: { size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={fill}>
      <path d="M8 0l1.6 4.9L14.5 6l-4.9 1.6L8 12.5 6.4 7.6 1.5 6l4.9-1.1z" />
    </svg>
  );
}

export default function ChatPane({
  projectId,
  onBeforeSend,
  sessionId,
  getDocument,
  getFiles,
  getLastCompile,
  applyEdit,
  onClose,
  collapsed,
  onPendingEditsChange,
  resolverRef,
  controlRef,
  onTurnEnd,
  generatedFiles,
}: Props) {
  // UI preferences survive the per-project remount (and reloads) — they are
  // browser-level settings, unlike the conversation, which is per-project.
  const [autoFix, setAutoFix] = useState(() => localStorage.getItem("latentdraft:auto-fix") === "1");
  // Auto-edit: apply the agent's edits the moment they stream in, instead of
  // waiting for Accept/Reject. A ref so mid-stream toggles take effect.
  const [autoEdit, setAutoEdit] = useState(() => localStorage.getItem("latentdraft:auto-edit") === "1");
  const autoEditRef = useRef(autoEdit);
  autoEditRef.current = autoEdit;
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState<string>(() => localStorage.getItem("latentdraft:provider") ?? "");
  const [model, setModel] = useState<string>(() => localStorage.getItem("latentdraft:model") ?? "");

  useEffect(() => {
    localStorage.setItem("latentdraft:auto-fix", autoFix ? "1" : "0");
    localStorage.setItem("latentdraft:auto-edit", autoEdit ? "1" : "0");
    if (provider) localStorage.setItem("latentdraft:provider", provider);
    if (model) localStorage.setItem("latentdraft:model", model);
  }, [autoFix, autoEdit, provider, model]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Slash-command autocomplete: open while the input is a partial /name.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashMatches = streaming || slashDismissed ? [] : matchSlashCommands(input);
  const slashSel = Math.min(slashIndex, Math.max(0, slashMatches.length - 1));
  function pickSlashCommand(name: string) {
    setInput(`/${name} `);
    setSlashIndex(0);
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Set once this project's history has loaded — saves are held until then. */
  const hydratedRef = useRef(false);
  const messagesRef = useRef<UIMessage[]>([]);

  // Hydrate this project's conversation; the pane is keyed by project, so a
  // switch remounts it (aborting any in-flight stream via the cleanup below).
  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      hydratedRef.current = true;
      return;
    }
    void fetchProjectChat<UIMessage>(projectId).then((msgs) => {
      if (cancelled) return;
      hydratedRef.current = true;
      if (msgs.length > 0) setMessages(reviveChat(msgs));
    });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      // Unmount = project switch: flush what the debounced save hasn't yet.
      if (projectId && hydratedRef.current) {
        void saveProjectChat(projectId, messagesRef.current.slice(-CHAT_LIMIT));
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change (debounced — streams update messages on every token).
  useEffect(() => {
    messagesRef.current = messages;
    if (!projectId || !hydratedRef.current) return;
    const t = setTimeout(() => void saveProjectChat(projectId, messages.slice(-CHAT_LIMIT)), 800);
    return () => clearTimeout(t);
  }, [messages, projectId]);

  useEffect(() => {
    fetchProviders()
      .then((list) => {
        setProviders(list);
        const firstAvailable = list.find((p) => p.available && p.models.length > 0) ?? list[0];
        // Keep a restored selection when it's still valid; otherwise default.
        setProvider((cur) =>
          cur && list.some((p) => p.id === cur && p.available) ? cur : firstAvailable?.id ?? "",
        );
        setModel((cur) => cur || firstAvailable?.models[0] || "");
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

  // Estimated tokens the next request will occupy vs the model's window. The
  // document lives outside this pane (no re-render on editor keystrokes), so
  // refresh on a slow interval as well as on chat state changes.
  const [ctxEstimate, setCtxEstimate] = useState(0);
  useEffect(() => {
    const compute = () => {
      const lastCompile = getLastCompile?.();
      setCtxEstimate(
        estimateRequestTokens({
          documentText: getDocument(),
          history: messages,
          draft: input,
          compileLog: lastCompile && !lastCompile.ok ? lastCompile.log : undefined,
        }),
      );
    };
    compute();
    const timer = setInterval(compute, 2000);
    return () => clearInterval(timer);
  }, [messages, input, getDocument, getLastCompile]);

  const ctxWindow = currentProvider?.context?.[model];
  const ctxSeverity = contextSeverity(ctxEstimate, ctxWindow);

  // Surface the pending edits to the editor pane (inline suggestions).
  useEffect(() => {
    onPendingEditsChange?.(
      messages.flatMap((m) => m.edits.filter((e) => e.status === "pending")),
    );
  }, [messages, onPendingEditsChange]);

  function updateMessage(id: string, fn: (m: UIMessage) => UIMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }

  /** Auto-edit mode: apply an incoming edit immediately and card it as such. */
  function autoApply(edit: ProposedEdit): EditCard {
    const result = applyEdit(edit);
    return result.ok
      ? { ...edit, status: "applied" }
      : { ...edit, status: "failed", failReason: result.reason };
  }

  async function send(textOverride?: string) {
    const raw = (textOverride ?? input).trim();
    if (!raw || streaming || !provider || !model) return;
    setInput("");

    // Slash commands (/check-bibtex …) expand into a full instruction: the
    // expanded prompt is the message content (history is rebuilt from content
    // every turn), the raw command is kept for the bubble.
    const expanded = expandSlashCommand(raw);
    const text = expanded?.prompt ?? raw;

    const userMsg: UIMessage = {
      id: nextId(),
      role: "user",
      content: text,
      ...(expanded ? { display: expanded.display } : {}),
      edits: [],
      activity: [],
    };
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

    // The agent reads project files from DISK — flush unsaved buffers first.
    await onBeforeSend?.();

    await streamChat(
      {
        provider,
        model,
        projectId: projectId ?? undefined,
        sessionId,
        documentText: getDocument(),
        files: getFiles?.(),
        lastCompile: getLastCompile?.() ?? undefined,
        messages: history,
      },
      {
        onText: (t) =>
          updateMessage(assistantId, (m) => ({ ...m, content: m.content + t })),
        onEdit: (edit) => {
          // Server edit ids restart at edit-1 every turn; prefix with the
          // message id so ids stay unique across the whole conversation.
          const prefixed = { ...edit, id: `${assistantId}:${edit.id}` };
          const card = autoEditRef.current ? autoApply(prefixed) : ({ ...prefixed, status: "pending" } as EditCard);
          updateMessage(assistantId, (m) => ({ ...m, edits: [...m.edits, card] }));
        },
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
              .map((p) =>
                autoEditRef.current ? autoApply(p) : { ...p, status: "pending" as const },
              );

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
    // The agent may have generated files (figures) into the shared compile
    // session — let the app refresh its file tree.
    onTurnEnd?.();
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Let the app trigger a turn (error-banner "Fix with AI", auto-fix loop).
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { send: (text) => void send(text), autoFix, streaming };
    return () => {
      controlRef.current = null;
    };
  });

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

  // Let the editor pane's inline suggestion cards resolve an edit by id;
  // the chat card's status updates through the same path.
  useEffect(() => {
    if (!resolverRef) return;
    resolverRef.current = (editId, action) => {
      for (const m of messages) {
        const edit = m.edits.find((e) => e.id === editId && e.status === "pending");
        if (!edit) continue;
        if (action === "accept") onAccept(m.id, edit);
        else onReject(m.id, edit.id);
        return;
      }
    };
    return () => {
      resolverRef.current = null;
    };
  });

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
              <div className="msg-user-bubble">{m.display ?? m.content}</div>
            ) : (
              <div className="msg-assistant-row">
                <div className="msg-avatar">
                  <Sparkle size={12} />
                </div>
                <div className="msg-assistant-content">
                  {m.activity.length > 0 && <ActivityList activity={m.activity} />}
                  {m.content && (
                    <div className="msg-text">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          // eslint-disable-next-line jsx-a11y/anchor-has-content
                          a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
                        }}
                      >
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  )}
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
          {slashMatches.length > 0 && (
            <div className="slash-menu" role="listbox">
              {slashMatches.map((c, i) => (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={i === slashSel}
                  className={`slash-item${i === slashSel ? " slash-item-active" : ""}`}
                  // onMouseDown so the textarea keeps focus (click fires after blur).
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlashCommand(c.name);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span className="slash-name">/{c.name}</span>
                  <span className="slash-desc">{c.description}</span>
                </button>
              ))}
            </div>
          )}
          <div
            className="composer-chips"
            title="Files the agent sees: it edits main.tex; the rest resolve in its compiles"
          >
            {(() => {
              const ctx = [
                "main.tex",
                ...Object.keys(getFiles?.() ?? {}),
                ...(generatedFiles ?? []),
              ];
              const shown = ctx.slice(0, 3);
              return (
                <>
                  {shown.map((f) => (
                    <span key={f} className="chip">
                      @{f}
                    </span>
                  ))}
                  {ctx.length > shown.length && (
                    <span className="chip chip-more">+{ctx.length - shown.length} more</span>
                  )}
                </>
              );
            })()}
          </div>
          <textarea
            value={input}
            placeholder={
              streaming
                ? "Streaming…"
                : "Ask the agent to edit, explain, or fix your LaTeX… (type / for commands)"
            }
            onChange={(e) => {
              setInput(e.target.value);
              setSlashDismissed(false);
            }}
            onKeyDown={(e) => {
              if (slashMatches.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIndex((slashSel + d + slashMatches.length) % slashMatches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickSlashCommand(slashMatches[slashSel].name);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            disabled={streaming}
          />
          <div className="composer-actions">
            <label
              className={`autofix-toggle${autoEdit ? " autofix-on" : ""}`}
              title="Apply the agent's edits the moment they arrive — no Accept/Reject step (full-document rewrites still ask)"
            >
              <input
                type="checkbox"
                checked={autoEdit}
                onChange={(e) => setAutoEdit(e.target.checked)}
              />
              auto-edit
            </label>
            <label
              className={`autofix-toggle${autoFix ? " autofix-on" : ""}`}
              title="When a compile fails, automatically ask the agent to fix it"
            >
              <input
                type="checkbox"
                checked={autoFix}
                onChange={(e) => setAutoFix(e.target.checked)}
              />
              auto-fix
            </label>
            <span
              className={`composer-hint mono ctx-info ctx-${ctxSeverity}`}
              title={
                `Estimated context use of the next agent request (document + chat history + prompt overhead)` +
                (ctxWindow
                  ? `, out of this model's ~${formatTokens(ctxWindow)}-token window.`
                  : ". This model's context window is unknown.") +
                (ctxSeverity === "over" || ctxSeverity === "warn"
                  ? " Near or over the window the prompt gets truncated from the top (silently, on Ollama) — start a new chat or trim the document."
                  : "")
              }
            >
              {formatTokens(ctxEstimate)}
              {ctxWindow ? ` / ${formatTokens(ctxWindow)}` : ""} ctx
            </span>
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
                onClick={() => void send()}
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
  fetch_url: "🌐",
  run_python: "🐍",
  view_pdf: "👁️",
  ats_check: "📋",
  check_bibtex: "📚",
  find_references: "📖",
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
        <span className="mono">{edit.file ?? "main.tex"}</span>
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
