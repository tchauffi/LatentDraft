# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`/check-bibtex`** chat command + `check_bibtex` agent tool: verifies references locally (every `\cite` key resolves to a `.bib` entry / `\bibitem`; unused entries; missing `\bibliography` targets) **and against the real world** — Crossref DOI lookup, arXiv ids, and Crossref title search catch hallucinated references (fabricated papers, fake or mismatched DOIs). Network failures report as "could not check", never as fabricated. Optional `CROSSREF_MAILTO` env var for Crossref's polite pool.
- **Slash-command autocomplete** in the chat composer: type `/` for a menu of commands (registry-based, ready for more).
- **End-of-turn bibliography recheck**: like the compile verification, `check_bibtex` re-runs automatically when the agent edited files after checking, so bibliography fixes can't end the turn unverified.
- **`/apply`** chat command: tailor the resume to a job posting (URL or pasted text) — the agent fetches the posting, runs the ATS analysis against it, and replies with a review plus a **numbered improvement plan**; it only edits after you approve, then re-verifies keyword coverage with `ats_check`.
- **`fetch_url`** agent tool: fetch any web page's readable text (HTML → text conversion, entity decoding, 18k-char cap, graceful handling of login walls and non-text content).

## [0.1.0] - 2026-07-12

First public release.

### Added

- **Three-pane editor**: CodeMirror LaTeX source (multi-file, `\cite`/`\ref` autocomplete, inline compile-error squiggles), live PDF preview, and an agent chat pane.
- **Projects as plain folders** under `~/LatentDraft` (or `PROJECTS_ROOT`): create from a template gallery (article, beamer, CV), rename, duplicate, delete; file tree with create/rename/delete; autosave; build artifacts isolated in `.latentdraft/`.
- **Live compile with Tectonic**, structured error diagnostics, and **SyncTeX** both ways (Ctrl/Cmd+click source → PDF, double-click PDF → source).
- **Provider-agnostic AI agent** (Mastra over AI SDK v5): local Ollama by default, plus Ollama Cloud, any OpenAI-compatible endpoint, and Anthropic. Edits are proposed as accept/reject diff cards and **verified to compile** before you see them.
- **Small-model resilience**: text-form tool-call recovery (bare JSON, `<tool_call>` tags, fenced blocks, pseudo-code), `<think>` stripping, automatic Ollama `num_ctx` variants to avoid silent prompt truncation.
- **Agent tools**: `edit_document`, `read_document`, `compile_check`, `web_search` (Tavily/Brave/DuckDuckGo), `run_python` (matplotlib/seaborn figures, data-file import), `render_mermaid`, `view_pdf` layout inspection, `ats_check`.
- **Production mode**: `npm run build && npm start` serves the UI and API together on one port; unknown `/api` routes return JSON 404s; async route errors return JSON 500s instead of hanging.
- **Setup script** (`npm run setup`): fetches the Tectonic binary and creates the Python venv.
- Per-project chat history, context meter, markdown chat rendering.

[0.1.0]: https://github.com/tchauffi/LatentDraft/releases/tag/v0.1.0
