# LatentDraft

A Cursor-style LaTeX editor. Three panes:

- **Editor** — raw LaTeX source (CodeMirror)
- **Preview** — the compiled PDF, live-updating as you type
- **Chat** — an AI agent that reads your document and proposes edits as **accept/reject diffs**

The agent is **provider-agnostic**: it defaults to a local **Ollama** model (no API key), and can also use any OpenAI-compatible endpoint (LM Studio, vLLM, OpenRouter, OpenAI) or Anthropic — all behind one interface (Vercel AI SDK).

## Requirements

- **Node.js** 20+
- **Tectonic** — the LaTeX engine. A prebuilt binary is already vendored at `./bin/tectonic`. To re-fetch it:
  ```sh
  cd bin && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh
  ```
  (Or install system-wide and set `TECTONIC_BIN=/path/to/tectonic`.) The **first** compile downloads LaTeX packages and is slow; later compiles hit the cache.
- **Ollama** (for the default agent) — install from https://ollama.com, then pull a model:
  ```sh
  ollama serve            # if not already running
  ollama pull qwen2.5-coder   # or llama3.1 / mistral-nemo — tool-capable models work best
  ```
  Models that can't call tools still work via a fenced-block edit fallback.
- **Python** (for the `run_python` / `view_pdf` / `ats_check` tools) — a virtualenv with matplotlib, numpy and PyMuPDF at `server/.venv`. Create it once:
  ```sh
  cd server && python3 -m venv .venv && .venv/bin/pip install matplotlib numpy pymupdf
  ```
  (Or point `PYTHON_BIN` at any interpreter that has those packages.)

## Install & run

```sh
npm install       # installs client + server (npm workspaces)
npm run dev       # starts API (:5174) and Vite dev server (:5173)
```

Open http://localhost:5173.

## Configuration (environment variables)

The server reads these at startup:

| Variable            | Default                  | Purpose                                              |
| ------------------- | ------------------------ | ---------------------------------------------------- |
| `PORT`              | `5174`                   | API server port                                      |
| `HOST`              | `127.0.0.1`              | Bind address. Keep localhost — `run_python` executes arbitrary code |
| `COMPILE_TIMEOUT_MS`| `300000`                 | Kill a Tectonic compile after this many ms           |
| `TECTONIC_BIN`      | `./bin/tectonic`         | Path to the Tectonic binary                          |
| `OLLAMA_BASE_URL`   | `http://localhost:11434` | Ollama host                                          |
| `OPENAI_BASE_URL`   | —                        | Enables the "OpenAI-compatible" provider (e.g. `https://api.openai.com/v1`) |
| `OPENAI_API_KEY`    | —                        | Key for the OpenAI-compatible endpoint               |
| `OPENAI_MODELS`     | —                        | Comma-separated model ids to show in the picker      |
| `ANTHROPIC_API_KEY` | —                        | Enables the Anthropic provider                       |
| `ANTHROPIC_MODELS`  | `claude-opus-4-8,claude-sonnet-5` | Anthropic models to show                    |
| `PYTHON_BIN`        | `server/.venv/bin/python` | Interpreter for `run_python`/`view_pdf`/`ats_check` |
| `TAVILY_API_KEY`    | —                        | Use Tavily for `web_search` (else Brave, else DuckDuckGo) |
| `BRAVE_API_KEY`     | —                        | Use the Brave Search API for `web_search`            |

Example — add OpenAI alongside Ollama:

```sh
OPENAI_BASE_URL=https://api.openai.com/v1 OPENAI_API_KEY=sk-... OPENAI_MODELS=gpt-4o-mini npm run dev
```

Switch provider/model from the dropdowns in the Chat pane header.

## How the agent works

The agent runs a multi-step loop against a **working copy** of your document, using these tools:

- `edit_document(old_string, new_string)` — applies an edit to the working copy and shows it to you as a diff card.
- `compile_check()` — compiles the working copy with Tectonic and returns success or the error log.
- `web_search(query)` — researches on the web (DuckDuckGo by default; Tavily/Brave with a key).
- `run_python(code)` — runs Python (matplotlib/numpy) in the build dir, mainly to generate figures you then `\includegraphics`.
- `view_pdf()` — compiles and **looks** at the rendered PDF pages as images, to judge layout/spacing/overflow.
- `ats_check(job_description?)` — extracts the compiled PDF's text and reports ATS parseability, contact/section coverage, and keyword match against a posting.

Only `edit_document` changes your document, and every edit is yours to accept or reject.

So a typical turn is: **edit → compile_check → (if it fails) read the log, fix, compile_check again → summarize.** This means the changes it proposes are **verified to compile** before you ever see them. When the turn ends you get a green *"✓ Verified — the document compiles with these changes"* banner (or a red one with the log if it couldn't).

You stay in control:

1. Each edit appears as a diff card with **Accept / Reject** — nothing is applied to your editor automatically.
2. **Accept** (or **Accept all**) performs the exact string replacement in the editor and triggers a recompile. Accept multi-edit sets top-to-bottom so later edits build on earlier ones.
3. If an `old_string` doesn't match uniquely, the card shows why (not found / matches multiple places) instead of applying a wrong edit.

The compile-verification loop needs a **tool-capable model** (e.g. `qwen2.5-coder`, `llama3.1`, `mistral-nemo`, or a hosted model). Models that can't call tools fall back to emitting ` ```latex-edit ` blocks — you still get diff cards, but without the agent's self-verification.

## Project layout

```
server/   Express API (tsx). /api/compile (Tectonic), /api/chat (agent), /api/providers
client/   Vite + React. EditorPane, PreviewPane, ChatPane
bin/      vendored tectonic binary (gitignored)
```

## Notes & limits

- The editor's file tabs (`main.tex`, `refs.bib`, `sections/…`) are all sent along on every compile, so `\input` and `\bibliography` resolve — for both the live preview and the agent's `compile_check` sandbox. The agent itself only edits `main.tex`; adding/removing files from the UI is not built yet.
- Stale compile dirs under `server/tmp/` are deleted automatically after 24h (on server start).
- The document is sent to the model on each chat turn; very large documents may exceed a local model's context window.
