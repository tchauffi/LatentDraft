# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- **`run_python`'s network block is now enforced by the kernel.** The interpreter-level socket block introduced in 0.3.0 patched `socket.socket`, which is a *subclass* of the C-level `_socket.socket` — so it never reached the base class, and `import _socket` (or `socket.socket.__bases__[0]`) walked straight past it. Landlock could not make up the difference: it has no UDP access right at any ABI, and no network rights at all below kernel 6.7 (Debian 12, Ubuntu 22.04). On a Landlock host the snippet could therefore open a UDP socket and send data off the machine. A **seccomp-BPF filter** now refuses `socket(2)` for `AF_INET` and `AF_INET6` before the snippet runs, closing TCP and UDP together on every kernel and behind every Python-level escape; `AF_UNIX` stays open so `multiprocessing` and `joblib` are unaffected. Landlock mode fails closed if the filter cannot be installed. bubblewrap (`--unshare-net`) and macOS `sandbox-exec` were never affected.

### Added

- **Drag and drop in the file tree.** Drop files — or a whole folder, whose structure is preserved — from your desktop anywhere on the tree to add them to the project: onto a folder row to land inside it, onto the background for the project root. Dragging rows within the tree reorganises the project, so a figure or a section finally moves into a folder without a rename dialog and a retyped path. Dropping onto a *file* means "into the folder it lives in", the target highlights as you hover, and open tabs, unsaved buffers and the active file all follow the move. Moves are plain renames on disk, so git sees them as moves. The picker under the tree now takes several files at once too.

### Fixed

- Renaming or moving a file onto an existing one no longer silently destroys the destination — `fs.rename` reported success while replacing it. The server refuses the collision (a case-only rename on a case-insensitive filesystem still works), and also refuses to move `main.tex`, which would leave the project with no compile target, or to bury a folder inside its own descendant.
### Security

- **`run_python` is now sandboxed.** The agent's Python snippets are treated as untrusted input — what the model writes can be steered by a web page it searched, a URL it fetched, or a spreadsheet you uploaded — so they no longer run with your full user rights. On **Linux**: bubblewrap when the kernel allows unprivileged user namespaces (no network, no filesystem beyond the build directory, own PID/IPC/UTS namespaces, no `$HOME`), and otherwise the **Landlock** LSM, which the interpreter applies to itself — reads allowlisted to system paths plus the build directory, writes confined to the build directory, TCP denied in the kernel. This matters because Ubuntu ≥23.10 blocks the user namespaces bubblewrap needs, which would otherwise have left the sandbox as a no-op on the most common desktop setup. On **macOS**: `sandbox-exec` denies the network and every write outside the build directory. On **every** platform: hard rlimits the snippet cannot raise (address space, file size, CPU, core dumps), a wall-clock timeout that kills the whole process group, a socket block inside the interpreter, and an environment **stripped of every API key** — so a figure script can no longer read `ANTHROPIC_API_KEY`, your SSH keys, or anything outside the document it is illustrating. The mode is probed by actually running the real command line at startup and reported in the log; `PYTHON_SANDBOX=strict` refuses to run when no OS sandbox is available, `PYTHON_ALLOW_NET=1` re-enables the network, and `PYTHON_TIMEOUT_MS` / `PYTHON_MEM_MB` / `PYTHON_MAX_FILE_MB` tune the limits.

### Fixed

- `run_python` tracebacks report the **snippet's own line numbers** again: the hardening runs from a separate bootstrap file and launches the snippet through `runpy`, instead of being prepended to it, so "line 3" means line 3 of the code the model wrote.

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
