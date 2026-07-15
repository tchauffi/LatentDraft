import type { SkillInfo } from "./slashCommands";

export interface ProviderInfo {
  id: "ollama" | "ollama-cloud" | "openai-compatible" | "anthropic";
  label: string;
  available: boolean;
  models: string[];
  note?: string;
  /** modelId → usable context window in tokens, when the server knows it. */
  context?: Record<string, number>;
}

export interface ProposedEdit {
  id: string;
  explanation: string;
  old_string: string;
  new_string: string;
  /** Project file the edit targets; absent/empty means main.tex. */
  file?: string;
}

export interface CompileDiagnostic {
  file: string;
  line: number;
  message: string;
  severity: "error" | "warning";
}

export type CompileResult =
  | { ok: true; pdf: ArrayBuffer }
  | { ok: false; log: string; diagnostics?: CompileDiagnostic[] };

/* ---- Projects: plain folders on the server's disk ---- */

export interface ProjectInfo {
  id: string;
  mtimeMs: number;
  /** Document title from main.tex's \title{…}, when one is set. */
  title?: string;
}

export interface ProjectFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
}

export interface ProjectsResponse {
  projects: ProjectInfo[];
  templates: string[];
  /** Where projects live on the server's disk, for display (e.g. ~/LatentDraft). */
  root: string;
}

export async function fetchProjects(): Promise<ProjectsResponse> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error(`projects: ${res.status}`);
  return (await res.json()) as ProjectsResponse;
}

export async function createProjectApi(
  name: string,
  template?: string,
): Promise<{ id: string } | { error: string }> {
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, template }),
  });
  return (await res.json()) as { id: string } | { error: string };
}

/** Rename a project directory; returns the new (slugified) id. */
export async function renameProjectApi(
  id: string,
  name: string,
): Promise<{ id: string } | { error: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()) as { id: string } | { error: string };
}

/** Copy a project's sources into a fresh "<id> copy" project. */
export async function duplicateProjectApi(
  id: string,
): Promise<{ id: string } | { error: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
  return (await res.json()) as { id: string } | { error: string };
}

/** Delete a whole project directory from disk. */
export async function deleteProjectApi(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: data.error };
}

export async function fetchProjectFiles(id: string): Promise<ProjectFileInfo[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/files`);
  if (!res.ok) throw new Error(`project files: ${res.status}`);
  return ((await res.json()) as { files: ProjectFileInfo[] }).files;
}

export function projectFileUrl(id: string, path: string): string {
  return `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`;
}

export async function fetchProjectFileText(
  id: string,
  path: string,
): Promise<{ content: string; mtimeMs: number } | null> {
  const res = await fetch(projectFileUrl(id, path));
  if (!res.ok) return null;
  return {
    content: await res.text(),
    mtimeMs: Number(res.headers.get("X-Mtime") ?? 0),
  };
}

export type SaveResult =
  | { ok: true; mtimeMs: number }
  | { ok: false; conflict: { mtimeMs: number; content: string } }
  | { ok: false; error: string };

/** Save one file; a base mtime makes the server refuse to clobber external edits. */
export async function saveProjectFile(
  id: string,
  path: string,
  content: string | Blob,
  baseMtimeMs?: number,
): Promise<SaveResult> {
  try {
    const res = await fetch(projectFileUrl(id, path), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        ...(baseMtimeMs !== undefined ? { "X-Base-Mtime": String(baseMtimeMs) } : {}),
      },
      body: content,
    });
    const data = (await res.json()) as { mtimeMs?: number; content?: string; error?: string };
    if (res.ok && data.mtimeMs !== undefined) return { ok: true, mtimeMs: data.mtimeMs };
    if (res.status === 409 && data.content !== undefined) {
      return { ok: false, conflict: { mtimeMs: data.mtimeMs ?? 0, content: data.content } };
    }
    return { ok: false, error: data.error ?? `save failed (${res.status})` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function renameProjectFileApi(
  id: string,
  from: string,
  to: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: data.error };
}

export async function deleteProjectFileApi(
  id: string,
  path: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, {
    method: "DELETE",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return res.ok ? { ok: true } : { ok: false, error: data.error };
}

/* ---- Per-project chat history (.latentdraft/chat.json on the server) ---- */

export async function fetchProjectChat<T>(id: string): Promise<T[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/chat`);
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: T[] };
  return Array.isArray(data.messages) ? data.messages : [];
}

/** Best-effort save — chat history is a convenience, never worth blocking on. */
export async function saveProjectChat(id: string, messages: unknown[]): Promise<void> {
  try {
    await fetch(`/api/projects/${encodeURIComponent(id)}/chat`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } catch {
    /* offline or racing a delete — drop it */
  }
}

/** SyncTeX forward: source position → PDF position (pt, top-left origin). */
export async function synctexForward(
  id: string,
  file: string,
  line: number,
): Promise<{ page: number; x: number; y: number } | null> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/synctex/forward`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, line }),
    });
    return res.ok ? ((await res.json()) as { page: number; x: number; y: number }) : null;
  } catch {
    return null;
  }
}

/** SyncTeX inverse: PDF position (pt) → source file + line. */
export async function synctexReverse(
  id: string,
  page: number,
  x: number,
  y: number,
): Promise<{ file: string; line: number } | null> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/synctex/reverse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page, x, y }),
    });
    return res.ok ? ((await res.json()) as { file: string; line: number }) : null;
  } catch {
    return null;
  }
}

/** Compile the project FROM DISK — dirty buffers must be saved first. */
export async function compileProjectApi(id: string): Promise<CompileResult> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}/compile`, { method: "POST" });
    const contentType = res.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/pdf")) {
      return { ok: true, pdf: await res.arrayBuffer() };
    }
    const data = (await res.json().catch(() => ({ log: "Unknown compile error" }))) as {
      log?: string;
      diagnostics?: CompileDiagnostic[];
    };
    return { ok: false, log: data.log ?? "Unknown compile error", diagnostics: data.diagnostics };
  } catch (err) {
    return { ok: false, log: `Could not reach the compile server: ${String(err)}` };
  }
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch("/api/providers");
  if (!res.ok) throw new Error(`providers: ${res.status}`);
  const data = (await res.json()) as { providers: ProviderInfo[] };
  return data.providers;
}

/** Installed SKILL.md packs — become slash commands and agent-loadable skills. */
export async function fetchSkills(projectId?: string): Promise<SkillInfo[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const res = await fetch(`/api/skills${qs}`);
  if (!res.ok) throw new Error(`skills: ${res.status}`);
  const data = (await res.json()) as { skills: SkillInfo[] };
  return data.skills;
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

/** A question from the agent with clickable answer choices (ask_user tool). */
export interface AskChoices {
  question: string;
  options: string[];
}

export interface StreamHandlers {
  onText: (text: string) => void;
  onEdit: (edit: ProposedEdit) => void;
  onCheck: (check: CheckResult) => void;
  onTool: (tool: ToolActivity) => void;
  onAsk: (ask: AskChoices) => void;
  onError: (message: string) => void;
  onDone: () => void;
}

export interface ChatBody {
  provider: string;
  model: string;
  /** The project the agent works on (multi-file mode). */
  projectId?: string;
  /** The editor's compile session, shared with the agent so generated files
   * (figures from run_python) resolve when the preview recompiles. */
  sessionId?: string;
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
          file: typeof evt.file === "string" && evt.file ? evt.file : undefined,
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
      case "ask":
        if (Array.isArray(evt.options) && evt.options.length > 0) {
          handlers.onAsk({
            question: String(evt.question ?? ""),
            options: evt.options.map(String),
          });
        }
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
