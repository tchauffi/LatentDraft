export interface ProviderInfo {
  id: "ollama" | "openai-compatible" | "anthropic";
  label: string;
  available: boolean;
  models: string[];
  note?: string;
}

export interface ProposedEdit {
  id: string;
  explanation: string;
  old_string: string;
  new_string: string;
}

export type CompileResult =
  | { ok: true; pdf: ArrayBuffer }
  | { ok: false; log: string };

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch("/api/providers");
  if (!res.ok) throw new Error(`providers: ${res.status}`);
  const data = (await res.json()) as { providers: ProviderInfo[] };
  return data.providers;
}

export async function compile(
  sessionId: string,
  tex: string,
  files?: Record<string, string>,
): Promise<CompileResult> {
  try {
    const res = await fetch("/api/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, tex, files }),
    });
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/pdf")) {
      return { ok: true, pdf: await res.arrayBuffer() };
    }
    const data = (await res.json().catch(() => ({ log: "Unknown compile error" }))) as {
      log?: string;
    };
    return { ok: false, log: data.log ?? "Unknown compile error" };
  } catch (err) {
    // Network failure (server down, connection dropped) — surface it like a
    // compile error instead of leaving the UI stuck on "compiling…".
    return { ok: false, log: `Could not reach the compile server: ${String(err)}` };
  }
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CheckResult {
  ok: boolean;
  log: string;
}

export interface ToolActivity {
  name: string;
  summary: string;
  ok: boolean;
}

export interface StreamHandlers {
  onText: (text: string) => void;
  onEdit: (edit: ProposedEdit) => void;
  onCheck: (check: CheckResult) => void;
  onTool: (tool: ToolActivity) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

export interface ChatBody {
  provider: string;
  model: string;
  documentText: string;
  /** Auxiliary project files (refs.bib, sections/…) for the agent's compile sandbox. */
  files?: Record<string, string>;
  /** Result of the editor's most recent compile — lets the agent start from
   * the failure log the user is looking at instead of guessing. */
  lastCompile?: { ok: boolean; log: string };
  messages: ChatMessage[];
}

/** POST /api/chat and dispatch NDJSON events to the handlers. */
export async function streamChat(
  body: ChatBody,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    handlers.onError(`chat: ${res.status}`);
    handlers.onDone();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return;
    }
    switch (evt.type) {
      case "text":
        handlers.onText(String(evt.text ?? ""));
        break;
      case "edit":
        handlers.onEdit({
          id: String(evt.id ?? Math.random()),
          explanation: String(evt.explanation ?? ""),
          old_string: String(evt.old_string ?? ""),
          new_string: String(evt.new_string ?? ""),
        });
        break;
      case "check":
        handlers.onCheck({ ok: Boolean(evt.ok), log: String(evt.log ?? "") });
        break;
      case "tool":
        handlers.onTool({
          name: String(evt.name ?? ""),
          summary: String(evt.summary ?? ""),
          ok: Boolean(evt.ok),
        });
        break;
      case "error":
        handlers.onError(String(evt.message ?? "error"));
        break;
      case "done":
        handlers.onDone();
        break;
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      dispatch(line);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}
