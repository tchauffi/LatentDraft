import express from "express";
import { compileTex, writeSessionFiles, cleanupStaleSessions } from "./compile.js";
import { listProviders } from "./providers.js";
import { streamChat, type ChatRequest } from "./chat.js";

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

app.post("/api/chat", async (req, res) => {
  const body = req.body as Partial<ChatRequest>;
  if (!body || !body.provider || !body.model || !Array.isArray(body.messages)) {
    res.status(400).json({ error: "Expected { provider, model, messages, documentText }." });
    return;
  }
  await streamChat(res, {
    provider: body.provider,
    model: body.model,
    documentText: typeof body.documentText === "string" ? body.documentText : "",
    files: stringFiles(body.files),
    messages: body.messages,
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[server] LatentDraft API listening on http://${HOST}:${PORT}`);
});

void cleanupStaleSessions();
