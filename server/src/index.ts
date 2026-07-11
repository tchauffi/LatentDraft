import express from "express";
import {
  compileTex,
  writeSessionFiles,
  writeSessionUpload,
  cleanupStaleSessions,
  listSessionFiles,
  sessionFilePath,
} from "./compile.js";
import { listProviders } from "./providers.js";
import { streamChat, type ChatRequest } from "./chat.js";

// Node's default warning output (e.g. MaxListenersExceededWarning) is one
// line with no origin — print the stack so a report is actionable.
process.on("warning", (w) => {
  console.warn(`[server] ${w.name}: ${w.message}\n${w.stack ?? ""}`);
});

const app = express();
const PORT = Number(process.env.PORT ?? 5174);
// run_python executes arbitrary code — do not expose beyond this machine
// unless explicitly asked to (HOST=0.0.0.0).
const HOST = process.env.HOST ?? "127.0.0.1";

app.use(express.json({ limit: "8mb" }));

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

app.get("/api/providers", async (_req, res) => {
  try {
    const providers = await listProviders();
    res.json({ providers });
  } catch (err) {
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.post("/api/compile", async (req, res) => {
  const { sessionId, tex, files } = req.body ?? {};
  if (typeof tex !== "string") {
    res.status(400).json({ ok: false, log: "Missing 'tex' string in request body." });
    return;
  }
  const session = typeof sessionId === "string" ? sessionId : "default";
  // Auxiliary project files (refs.bib, sections/…) so \input and \bibliography resolve.
  await writeSessionFiles(session, stringFiles(files));
  const result = await compileTex(session, tex);
  if (result.ok && result.pdf) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Compile-Ok", "1");
    res.send(result.pdf);
  } else {
    res.status(200).json({ ok: false, log: result.log });
  }
});

/** Project files in a compile session (aux files + generated figures) — feeds the file tree. */
app.get("/api/session-files", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
  res.json({ files: await listSessionFiles(sessionId) });
});

/** Upload a data file (CSV/Excel/…) into the compile session, raw bytes in the body. */
app.put(
  "/api/session-file",
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "Empty upload body." });
      return;
    }
    const rel = await writeSessionUpload(sessionId, name, req.body);
    if (!rel) {
      res.status(400).json({
        error:
          "Unsupported file. Allowed: csv, tsv, xlsx, xls, json, txt, dat, png, jpg, svg, pdf, bib.",
      });
      return;
    }
    res.json({ ok: true, file: rel });
  },
);

/** Serve one session file (e.g. a generated PNG) for previewing in the client. */
app.get("/api/session-file", (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "default";
  const name = typeof req.query.name === "string" ? req.query.name : "";
  const filePath = sessionFilePath(sessionId, name);
  if (!filePath) {
    res.status(400).json({ error: "Bad file name." });
    return;
  }
  res.sendFile(filePath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Not found." });
  });
});

app.post("/api/chat", async (req, res) => {
  const body = req.body as Partial<ChatRequest>;
  if (!body || !body.provider || !body.model || !Array.isArray(body.messages)) {
    res.status(400).json({ error: "Expected { provider, model, messages, documentText }." });
    return;
  }
  await streamChat(res, {
    provider: body.provider,
    model: body.model,
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
});

app.listen(PORT, HOST, () => {
  console.log(`[server] LatentDraft API listening on http://${HOST}:${PORT}`);
});

void cleanupStaleSessions();
