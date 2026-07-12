import express from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupStaleSessions,
  compileProject,
} from "./compile.js";
import {
  listProjects,
  createProject,
  renameProject,
  duplicateProject,
  deleteProject,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  renameProjectFile,
  deleteProjectFile,
  readProjectChat,
  writeProjectChat,
  projectDir,
  PROJECTS_ROOT,
} from "./projects.js";
import { TEMPLATES } from "./templates.js";
import { loadProjectSyncTex, forwardSearch, reverseSearch } from "./synctex.js";
import { listProviders } from "./providers.js";
import { streamChat, type ChatRequest } from "./chat.js";

// Node's default warning output (e.g. MaxListenersExceededWarning) is one
// line with no origin — print the stack so a report is actionable.
process.on("warning", (w) => {
  console.warn(`[server] ${w.name}: ${w.message}\n${w.stack ?? ""}`);
});

// Log-and-continue: a crash would lose in-flight compiles, and this is a
// local single-user tool — surfacing the error beats dying on it.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] Uncaught exception:", err);
});

const app = express();
const PORT = Number(process.env.PORT ?? 5174);
// run_python executes arbitrary code — do not expose beyond this machine
// unless explicitly asked to (HOST=0.0.0.0).
const HOST = process.env.HOST ?? "127.0.0.1";

app.use(express.json({ limit: "8mb" }));

/** Express 4 doesn't catch async rejections — route them to the error middleware. */
const wrap = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => (req, res, next) => {
  fn(req, res, next).catch(next);
};

/** Pick the string-valued entries out of an untrusted `files` payload. */
function stringFiles(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [name, content] of Object.entries(input as Record<string, unknown>)) {
    if (typeof content === "string") out[name] = content;
  }
  return out;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/providers", wrap(async (_req, res) => {
  const providers = await listProviders();
  res.json({ providers });
}));

/* ---- Projects: plain directories under PROJECTS_ROOT ---- */

/** Where projects live on disk, with the home dir shortened for display. */
function displayRoot(): string {
  const home = os.homedir();
  return PROJECTS_ROOT.startsWith(home) ? `~${PROJECTS_ROOT.slice(home.length)}` : PROJECTS_ROOT;
}

app.get("/api/projects", wrap(async (_req, res) => {
  res.json({ projects: await listProjects(), templates: Object.keys(TEMPLATES), root: displayRoot() });
}));

app.post("/api/projects", wrap(async (req, res) => {
  const { name, template } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Expected { name, template? }." });
    return;
  }
  const result = await createProject(name, typeof template === "string" ? template : undefined);
  if ("error" in result) res.status(400).json(result);
  else res.json(result);
}));

/** Rename a project (its directory). Body: { name } — the new display name. */
app.patch("/api/projects/:id", wrap(async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Expected { name }." });
    return;
  }
  const result = await renameProject(req.params.id, name);
  if ("error" in result) res.status(400).json(result);
  else res.json(result);
}));

/** Copy a project's sources into a fresh "<id> copy" directory. */
app.post("/api/projects/:id/duplicate", wrap(async (req, res) => {
  const result = await duplicateProject(req.params.id);
  if ("error" in result) res.status(400).json(result);
  else res.json(result);
}));

app.delete("/api/projects/:id", wrap(async (req, res) => {
  const result = await deleteProject(req.params.id);
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ error: result.error });
}));

app.get("/api/projects/:id/files", wrap(async (req, res) => {
  const files = await listProjectFiles(req.params.id);
  if (!files) res.status(404).json({ error: "Project not found." });
  else res.json({ files });
}));

app.get("/api/projects/:id/file", wrap(async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const file = await readProjectFile(req.params.id, rel);
  if (!file) {
    res.status(404).json({ error: "Not found." });
    return;
  }
  res.setHeader("X-Mtime", String(file.mtimeMs));
  res.type(rel.split("/").pop() ?? "bin").send(file.data);
}));

app.put(
  "/api/projects/:id/file",
  express.raw({ type: () => true, limit: "25mb" }),
  wrap(async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const baseHeader = req.header("X-Base-Mtime");
    const baseMtimeMs = baseHeader ? Number(baseHeader) : undefined;
    const result = await writeProjectFile(
      req.params.id,
      rel,
      body,
      Number.isFinite(baseMtimeMs) ? baseMtimeMs : undefined,
    );
    if (result.ok) res.json({ mtimeMs: result.mtimeMs });
    else if ("conflict" in result) {
      res.status(409).json({
        error: "File changed on disk since it was loaded.",
        mtimeMs: result.conflict.mtimeMs,
        content: result.conflict.content,
      });
    } else res.status(400).json({ error: result.error });
  }),
);

app.post("/api/projects/:id/rename", wrap(async (req, res) => {
  const { from, to } = req.body ?? {};
  if (typeof from !== "string" || typeof to !== "string") {
    res.status(400).json({ error: "Expected { from, to }." });
    return;
  }
  const result = await renameProjectFile(req.params.id, from, to);
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ error: result.error });
}));

app.delete("/api/projects/:id/file", wrap(async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const result = await deleteProjectFile(req.params.id, rel);
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ error: result.error });
}));

/* ---- Per-project chat history (.latentdraft/chat.json) ---- */

app.get("/api/projects/:id/chat", wrap(async (req, res) => {
  const messages = await readProjectChat(req.params.id);
  if (!messages) res.status(404).json({ error: "Project not found." });
  else res.json({ messages });
}));

app.put("/api/projects/:id/chat", wrap(async (req, res) => {
  const { messages } = req.body ?? {};
  if (!Array.isArray(messages)) {
    res.status(400).json({ error: "Expected { messages: [...] }." });
    return;
  }
  const result = await writeProjectChat(req.params.id, messages);
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ error: result.error });
}));

/** SyncTeX forward search: source {file, line} → PDF {page, x, y} in pt. */
app.post("/api/projects/:id/synctex/forward", wrap(async (req, res) => {
  const dir = projectDir(req.params.id);
  const { file, line } = req.body ?? {};
  if (!dir || typeof file !== "string" || typeof line !== "number") {
    res.status(400).json({ error: "Expected { file, line }." });
    return;
  }
  const data = await loadProjectSyncTex(dir);
  const hit = data && forwardSearch(data, file, Math.round(line));
  if (!hit) res.status(404).json({ error: "No synctex data for that location yet." });
  else res.json(hit);
}));

/** SyncTeX inverse search: PDF {page, x, y} in pt → source {file, line}. */
app.post("/api/projects/:id/synctex/reverse", wrap(async (req, res) => {
  const dir = projectDir(req.params.id);
  const { page, x, y } = req.body ?? {};
  if (!dir || typeof page !== "number" || typeof x !== "number" || typeof y !== "number") {
    res.status(400).json({ error: "Expected { page, x, y }." });
    return;
  }
  const data = await loadProjectSyncTex(dir);
  const hit = data && reverseSearch(data, Math.round(page), x, y);
  if (!hit) res.status(404).json({ error: "No synctex data for that location yet." });
  else res.json(hit);
}));

/** Compile a project FROM DISK — no source in the body; save first. */
app.post("/api/projects/:id/compile", wrap(async (req, res) => {
  const dir = projectDir(req.params.id);
  if (!dir) {
    res.status(404).json({ error: "Project not found." });
    return;
  }
  const result = await compileProject(dir);
  if (result.ok && result.pdf) {
    res.setHeader("Content-Type", "application/pdf");
    res.send(result.pdf);
  } else {
    res.status(200).json({ ok: false, log: result.log, diagnostics: result.diagnostics ?? [] });
  }
}));

app.post("/api/chat", wrap(async (req, res) => {
  const body = req.body as Partial<ChatRequest>;
  if (!body || !body.provider || !body.model || !Array.isArray(body.messages)) {
    res.status(400).json({ error: "Expected { provider, model, messages, documentText }." });
    return;
  }
  await streamChat(res, {
    provider: body.provider,
    model: body.model,
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    documentText: typeof body.documentText === "string" ? body.documentText : "",
    files: stringFiles(body.files),
    lastCompile:
      body.lastCompile &&
      typeof body.lastCompile.ok === "boolean" &&
      typeof body.lastCompile.log === "string"
        ? { ok: body.lastCompile.ok, log: body.lastCompile.log }
        : undefined,
    messages: body.messages,
  });
}));

/* ---- Static client (production) ---- */

// Unknown /api paths must 404 as JSON, not fall through to the SPA shell.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// tsx runs the TypeScript sources directly, so import.meta.url points at
// server/src/ — ../../client/dist is the repo's built client.
const CLIENT_DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/dist",
);

if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: "1h" }));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
  console.log(`[server] serving client from ${CLIENT_DIST}`);
} else {
  console.log(
    "[server] client/dist not found — run `npm run build` for the UI, or use `npm run dev`",
  );
}

app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  console.error(`[server] ${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return next(err); // e.g. /api/chat mid-stream
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[server] LatentDraft API listening on http://${HOST}:${PORT}`);
});
// Startup failures (e.g. EADDRINUSE) must exit, not linger as a dead process
// kept alive by the log-and-continue uncaughtException handler above.
server.on("error", (err) => {
  console.error("[server] Failed to start:", err);
  process.exit(1);
});

void cleanupStaleSessions();
