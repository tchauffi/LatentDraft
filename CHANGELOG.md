# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-15

### Added

- **Vision models see the rendered PDF**: when the selected model is multimodal, `view_pdf` now attaches the **rendered page images** (at a sharper 150 dpi) right after the call — on the native tool-calling path, not just the small-model text-recovery path — so the model visually inspects layout, figures, colors, and typography instead of inferring them from the text report. Works with Ollama vision models (detected automatically), Anthropic (always on), and OpenAI-compatible endpoints via the new `OPENAI_VISION_MODELS` env var. Text-only models are unaffected (images are never sent to a model that would reject them).
- **Iterative visual improvement**: a vision model that edits *after* looking at the pages can't end the turn on faith — like the compile and bibliography enforcement, the server **re-renders the document after the edits** and shows the model the updated pages so it verifies (or keeps improving) its own fix, up to 2 extra looks per turn. **Generated figures too**: `run_python` plots and `render_mermaid` diagrams are attached as images the moment they're produced, so the model checks labels, legends, and readability and regenerates if needed. `view_pdf`'s page budget also rose from 5 to **20 pages** (ask for the full page count to review a whole slide deck), and the re-render reuses the same budget.
- **VS Code–style file tree**: create files of any text type (`.py`, `.md`, `.yml`, `.json`, `.sh`, …) and **folders** — including empty ones, now real project entries — via an **inline naming row** (`/` in the name nests, Enter creates, Esc cancels, errors show in place). Folders **collapse/expand** with a chevron and have hover actions to **rename** (open tabs and unsaved buffers follow) or **delete** with contents. Non-LaTeX buffers get **syntax highlighting** (Python, Markdown, YAML, JSON, shell); `.tex` keeps its LaTeX autocomplete, squiggles, and SyncTeX. Shell scripts (`.sh`) are now editable text like Python.
- **Skills** — bring-your-own chat commands, compatible with the Claude Code `SKILL.md` format. Drop a folder with a `SKILL.md` (YAML frontmatter `description:`, optional `name:`, then the instructions) into `~/.latentdraft/skills/` or, per project, `<project>/.latentdraft/skills/`, and it becomes **both** a `/slash` command in the composer **and** an agent-loadable skill: the system prompt lists installed skills and a new `skill` tool loads one when your request matches its description. Skills written for Claude Code load unchanged (unknown frontmatter keys are ignored); project skills shadow global ones of the same name; built-in commands always win over skills; broken skill files are skipped with a server warning, never break the chat. Re-read every turn, so edits apply on the next message.
- **`/find-refs`** chat command + `find_references` agent tool: reference **discovery**, the constructive counterpart to `/check-bibtex`'s verification. Ask for a citation for a topic, claim, or half-remembered title — the agent searches **Crossref and arXiv**, presents real candidates (title, authors, year, venue, citation counts), and inserts the chosen entry's **ready-made BibTeX verbatim** plus the `\cite` as accept/reject diffs. Entries already in your bibliography are recognized (by DOI or title) and reused instead of duplicated; generated keys never collide with existing ones. Because every candidate comes from a real indexed record, the agent never writes a `.bib` entry from memory — the system prompt now forbids it outright.
- **`/review`** chat command: a plan-first proofreading pass — spelling/grammar, clarity, inconsistent terminology/notation/capitalization, undefined acronyms, tense shifts, and LaTeX-level nits (`\ref` vs `\eqref`, heading case, missing `~` before citations). Replies with an overall assessment and a numbered findings list quoting the exact text; edits only after you approve, then recompiles.
- **`/check-submission`** chat command: check the compiled document against a venue's submission rules. Uses the real layout from `view_pdf` (page count, margins, fonts, overfull lines), looks up the venue's author guidelines if you only name the venue, and hunts the source for anonymization leaks (`\author`/`\thanks`/emails, acknowledgements, "our previous work"). Replies with a pass/fail checklist plus a numbered fix plan; edits only after you approve, then re-verifies with `view_pdf`.
- **`ask_user`** agent tool + **clickable answer choices** in the chat: when the agent needs a decision (approve a plan, pick a file or reference candidate, supply a missing detail), it can present 2–5 options that render as **buttons** — click one and it's sent as your reply, or hit "Other…" to type a custom answer. Earlier questions stay in the history with your pick highlighted. Works with text-form tool-call recovery, so small local models get the buttons too. Asking **hard-stops the turn**: once the question is on screen, document changes are blocked and the agent's turn ends, so it can't edit before you answer.

## [0.2.0] - 2026-07-12

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

[0.3.0]: https://github.com/tchauffi/LatentDraft/releases/tag/v0.3.0
[0.2.0]: https://github.com/tchauffi/LatentDraft/releases/tag/v0.2.0
[0.1.0]: https://github.com/tchauffi/LatentDraft/releases/tag/v0.1.0
