---
name: verify
description: Build, launch, and drive LatentDraft (client + server) to verify changes end-to-end in a headless browser.
---

# Verifying LatentDraft

## Isolated stack (don't touch the user's real ~/LatentDraft)

The user usually has `npm run dev` running on 5173/5174 against their real
projects root. Verify against a throwaway stack instead:

```bash
SCRATCH=$(mktemp -d)
PROJECTS_ROOT=$SCRATCH/projects PORT=5274 npx tsx server/src/index.ts &   # from repo root
API_TARGET=http://localhost:5274 npx vite --config client/vite.config.ts --port 5273 --strictPort client &
curl -s http://localhost:5274/api/health   # {"ok":true}
```

Gotcha: `kill` on the `npx tsx` wrapper pid leaves the node child alive and
the port occupied — kill the pid that actually listens:
`kill $(ss -tlnp | grep :5274 | grep -oP 'pid=\K[0-9]+' | head -1)`.

## Driving the UI

Puppeteer is in the repo's node_modules (chrome in `~/.cache/puppeteer`).
From a script outside the repo, resolve it via
`createRequire("/path/to/LatentDraft/package.json")("puppeteer")`.
Launch with `{ headless: true, args: ["--no-sandbox"] }`.

Useful selectors: `.project-btn` (toolbar → projects page), `.project-card`,
`.project-card-new`, `.cm-editor` / `.cm-content` (CodeMirror buffer),
`.composer-box textarea` + Enter (agent send), `.edit-card .edit-status`.
Project delete uses `window.confirm` — install a `page.on("dialog")` handler.

## Exercising the agent for real

Local Ollama is usually up; `GET /api/providers` shows availability.
`qwen2.5-coder:latest` reliably produces tool-call edits for prompts like
"Rename the section X to Y in main.tex" (allow up to ~3 min). Select the
model via the second `.agent-badge select`.

## Flows worth driving

- First run (empty PROJECTS_ROOT) → lands on the projects page.
- Create via the new-project card → editor opens, `\title{}` seeded with name.
- Toolbar project button → page; card click opens; Esc closes.
- Duplicate/rename/delete cards; deleting the open project resets the editor.
- Agent turn end-to-end: send prompt, wait for `.edit-card`, check `.cm-content`.
