import type { Response } from "express";
import { setMaxListeners } from "node:events";
import { Agent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { nanoid } from "nanoid";
import {
  getModel,
  ensureOllamaContextVariant,
  modelSupportsVision,
  type ProviderId,
} from "./providers.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeSessionFiles, listSessionFiles } from "./compile.js";
import { projectDir as resolveProjectDir, listFilesInDir } from "./projects.js";
import { createAgentTools, buildSystemPrompt } from "./tools.js";
import { listSkills } from "./skills.js";
import { ToolCallStreamFilter, type RecoveredToolCall } from "./textToolCalls.js";

/** Message content parts we exchange with the model (AI SDK v5 shape). */
type MessagePart = { type: "text"; text: string } | { type: "image"; image: string };
export interface ChatMessage {
  role: "user" | "assistant";
  content: string | MessagePart[];
}

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  /** The PROJECT the agent works on. When given, the agent reads/edits any
   * project file (from disk — the client saves dirty buffers before sending)
   * and its figures land in the project itself. */
  projectId?: string;
  /** The editor's compile session (legacy mode, no project). When given, the
   * agent compiles and runs Python in the SAME directory as the preview. */
  sessionId?: string;
  documentText: string;
  /** Auxiliary project files (refs.bib, sections/…) for the compile sandbox. */
  files?: Record<string, string>;
  /** Result of the editor's most recent compile, so a failure log the user is
   * looking at reaches the agent without a redundant compile_check. */
  lastCompile?: { ok: boolean; log: string };
  messages: ChatMessage[];
}

// Generous budget: a research-heavy task (several web_searches) still needs
// room left to edit_document and compile_check. Too low and the agent runs out
// of steps mid-research and never writes the document.
const MAX_STEPS = 24;
const MAX_CORRECTIVE_ROUNDS = 5;
// End-of-turn bibliography recheck: when the agent used check_bibtex and then
// edited files, verify the fixes actually resolved the findings. Kept low —
// a genuinely unfixable reference (fabricated, user must decide) should be
// explained, not retried forever.
const MAX_BIB_RECHECK_ROUNDS = 2;
// Extra rounds granted when the model writes tool calls as TEXT instead of
// using native function calling (common with small local models): each round
// executes the recovered calls and feeds the results back so the model can
// continue exactly as if the calls had been native.
const MAX_RECOVERY_ROUNDS = 8;

// Boilerplate used in the recovery-loop feedback messages. Kept as constants
// so the stream filter can suppress them when a small model echoes them back
// verbatim into its visible reply.
const RECOVERY_RESULTS_HEADER = "I executed the tool calls from your reply:";
// Thinking models (qwen3.5, deepseek-r1, …) routinely end the turn right
// after PLANNING inside their hidden reasoning channel — no visible text, no
// tool calls, task not done. This nudge makes them execute the plan.
const EMPTY_ROUND_NUDGE =
  "Your last reply was empty: no visible answer and no completed edits. Do not stop after " +
  "thinking or planning — carry out the plan NOW using native tool calls (edit_document / " +
  "create_file / compile_check). When the task is done and the document compiles, reply " +
  "with a short plain-text summary.";
const MAX_EMPTY_ROUND_NUDGES = 2;
// Sent WITH the rendered pages after a native view_pdf, so a vision model can
// actually look at the document instead of trusting the text report alone.
const VISION_RESULTS_NOTE =
  "Here are the rendered pages from your view_pdf call — inspect them. If the layout, " +
  "figures, and typography look right, continue (or wrap up); if not, fix what you see " +
  "and verify again.";
const RECOVERY_CONTINUE_NOTE =
  "(The current document is in the system prompt.) Continue the task — do not repeat " +
  "or summarize these results. Prefer native tool calls; if you must write one as text, " +
  'use exactly one JSON object per call on its own line: {"name": "tool_name", "arguments": {...}}. ' +
  "When you are done and the document compiles, reply with a short plain-text summary — no JSON.";

/** Minimal structural view of a Mastra tool, for direct (recovered) invocation. */
interface InvokableTool {
  inputSchema: {
    safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message?: string } };
  };
  execute?: (ctx: { context: unknown; runtimeContext: RuntimeContext }) => Promise<unknown>;
}

/**
 * Stream an agent turn as NDJSON. One JSON object per line:
 *   { type: "text",  text }                                    text delta
 *   { type: "edit",  id, explanation, old_string, new_string } proposed edit (validated to match)
 *   { type: "check", ok, log }                                 result of a compile_check
 *   { type: "tool",  name, summary, ok }                       non-edit tool activity
 *   { type: "ask",   question, options }                       clickable answer choices
 *   { type: "error", message }
 *   { type: "done" }
 */
export async function streamChat(res: Response, body: ChatRequest): Promise<void> {
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const write = (obj: unknown) => {
    if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
  };

  // Stop the agent (model stream + tool loop) as soon as the browser disconnects
  // or the user hits Stop — otherwise the turn keeps burning tokens unseen.
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  let model: ReturnType<typeof getModel>;
  let visionOk = false;
  try {
    // Ollama loads models with a tiny default context and silently truncates
    // the prompt (losing the system prompt) — swap in a derived variant with a
    // real context window.
    const modelId =
      body.provider === "ollama" ? await ensureOllamaContextVariant(body.model) : body.model;
    model = getModel(body.provider, modelId);
    visionOk = await modelSupportsVision(body.provider, modelId);
  } catch (err) {
    write({ type: "error", message: String(err instanceof Error ? err.message : err) });
    write({ type: "done" });
    res.end();
    return;
  }

  const compileSessionId = body.sessionId?.trim() || `agent-${nanoid(8)}`;

  // Project mode: the agent works on the project directory itself. The doc is
  // seeded from DISK (the client saves dirty buffers before sending).
  const projectDir = body.projectId ? resolveProjectDir(body.projectId) : undefined;
  let initialDoc = body.documentText ?? "";
  if (projectDir) {
    try {
      initialDoc = await readFile(path.join(projectDir, "main.tex"), "utf8");
    } catch {
      /* no main.tex yet — fall back to whatever the client sent */
    }
  } else if (body.files && Object.keys(body.files).length > 0) {
    // Legacy mode: seed the sandbox with aux files so \input / \bibliography
    // resolve when the agent runs compile_check.
    await writeSessionFiles(compileSessionId, body.files);
  }

  // User-authored SKILL.md packs (global + this project's). Read once per
  // request — a mid-turn install shows up on the next message.
  const skills = await listSkills(projectDir);

  const agentTools = createAgentTools({
    initialDoc,
    compileSessionId,
    projectDir,
    skills,
    vision: visionOk,
    emitEdit: (e) =>
      write({
        type: "edit",
        id: e.id,
        explanation: e.explanation,
        old_string: e.old_string,
        new_string: e.new_string,
        file: e.file,
      }),
    emitCheck: (c) => write({ type: "check", ok: c.ok, log: c.log }),
    emitTool: (t) => write({ type: "tool", name: t.name, summary: t.summary, ok: t.ok }),
    emitAsk: (a) => write({ type: "ask", question: a.question, options: a.options }),
  });

  const knownToolNames: ReadonlySet<string> = new Set(Object.keys(agentTools.tools));
  const toolList = [...knownToolNames].join(", ");
  // Everything \includegraphics/\input can resolve: project files (project
  // mode) or the files sent with this request plus what earlier turns left in
  // the shared session dir (legacy mode).
  const auxFileNames = projectDir
    ? ((await listFilesInDir(projectDir)) ?? [])
        .map((f) => f.path)
        .filter((p) => p !== "main.tex")
    : [
        ...new Set([
          ...Object.keys(body.files ?? {}),
          ...(await listSessionFiles(compileSessionId)),
        ]),
      ].sort();
  // The editor's failure log is context for the FIRST compile only — once the
  // agent has run its own compile it has fresher information.
  const editorFailureLog =
    body.lastCompile && !body.lastCompile.ok && body.lastCompile.log.trim()
      ? body.lastCompile.log
      : undefined;
  const currentSystemPrompt = () =>
    buildSystemPrompt(
      agentTools.getDoc(),
      auxFileNames,
      agentTools.hasChecked() ? undefined : editorFailureLog,
      Boolean(projectDir),
      skills,
    );

  // One Agent per request: the tools close over this request's working copy,
  // and the model is the user's per-request pick. Instructions are overridden
  // per round so the model always sees the current document.
  const agent = new Agent({
    name: "latentdraft",
    instructions: currentSystemPrompt(),
    model,
    tools: agentTools.tools,
  });

  // Run one model round (multi-step, native tools) and pipe text/errors to the
  // client through a filter that captures tool calls written as plain text.
  async function runRound(
    messages: ChatMessage[],
    system: string,
  ): Promise<{ text: string; calls: RecoveredToolCall[] }> {
    // Each round gets its OWN signal, chained to the request's. The AI SDK
    // registers a listener per model step on whatever signal it is handed and
    // only releases them when that signal dies — reusing the request signal
    // across every round of a long turn accumulates listeners until Node
    // prints MaxListenersExceededWarning. The chain listener is detached the
    // moment the round finishes, so the request signal stays at ~2 listeners.
    const round = new AbortController();
    const propagate = () => round.abort();
    abort.signal.addEventListener("abort", propagate, { once: true });
    // One step ≈ one fetch ≈ one listener on the round signal; allow MAX_STEPS
    // of them plus slack instead of Node's default 10.
    setMaxListeners(MAX_STEPS + 8, round.signal);
    try {
      const filter = new ToolCallStreamFilter(
        knownToolNames,
        (text) => write({ type: "text", text }),
        [RECOVERY_CONTINUE_NOTE, RECOVERY_RESULTS_HEADER, EMPTY_ROUND_NUDGE, VISION_RESULTS_NOTE],
      );
      const stream = await agent.stream(messages as Parameters<typeof agent.stream>[0], {
        instructions: system,
        maxSteps: MAX_STEPS,
        abortSignal: round.signal,
      });
      for await (const chunk of stream.fullStream) {
        const c = chunk as { type: string; payload?: Record<string, unknown> };
        switch (c.type) {
          case "text-delta":
            filter.push(String(c.payload?.text ?? ""));
            break;
          case "error": {
            const err = c.payload?.error;
            write({
              type: "error",
              message: String(err instanceof Error ? err.message : (err ?? "stream error")),
            });
            break;
          }
          default:
            break;
        }
      }
      return filter.finish();
    } finally {
      abort.signal.removeEventListener("abort", propagate);
    }
  }

  /** Execute one recovered (text-form) tool call against the real agent tools. */
  async function executeRecoveredCall(
    call: RecoveredToolCall,
  ): Promise<{ text: string; images: string[] }> {
    const tool = (agentTools.tools as unknown as Record<string, InvokableTool>)[call.name];
    if (!tool?.execute) {
      return { text: `Unknown tool '${call.name}'. Available tools: ${toolList}.`, images: [] };
    }
    const parsed = tool.inputSchema.safeParse(call.args);
    if (!parsed.success) {
      return {
        text: `Invalid arguments for ${call.name}: ${parsed.error?.message ?? "schema mismatch"}`,
        images: [],
      };
    }
    try {
      const result = await tool.execute({
        context: parsed.data,
        runtimeContext: new RuntimeContext(),
      });
      const text = typeof result === "string" ? result : JSON.stringify(result);
      // view_pdf leaves its rendered pages in a side channel; attach them as
      // image parts in the feedback message rather than inline in the result —
      // but only for models that can actually see them (a text-only model
      // rejects the whole request when it receives image parts).
      const images =
        call.name === "view_pdf" && visionOk ? agentTools.takeRenderedImages() : [];
      return { text, images };
    } catch (err) {
      return { text: `Tool ${call.name} failed: ${String(err)}`, images: [] };
    }
  }

  /**
   * A full agent turn: run a round; if the model wrote tool calls as text
   * instead of calling them, execute the recovered calls, feed the results
   * back, and loop so the model can keep going (edit -> compile -> fix).
   * The system prompt is rebuilt every round so the model always sees the
   * current working document.
   */
  async function runAgentTurn(initialMessages: ChatMessage[]): Promise<void> {
    let convo: ChatMessage[] = [...initialMessages];
    let nudges = 0;
    for (let round = 0; round <= MAX_RECOVERY_ROUNDS; round++) {
      if (abort.signal.aborted) return;
      const { text, calls } = await runRound(convo, currentSystemPrompt());
      // ask_user ran (natively): the question is on screen and further edits
      // are blocked — end the turn so the user can actually answer.
      if (calls.length === 0 && agentTools.hasAsked()) return;
      if (calls.length === 0) {
        // A native view_pdf left rendered pages: a vision model gets them as
        // image parts in a follow-up user message (Ollama accepts images ONLY
        // there, never in tool results) and one more round to actually look.
        // takeRenderedImages() clears on read, so this can't repeat itself.
        if (visionOk && round < MAX_RECOVERY_ROUNDS) {
          const pages = agentTools.takeRenderedImages();
          if (pages.length > 0) {
            convo = [
              ...convo,
              ...(text.trim() ? [{ role: "assistant" as const, content: text.trim() }] : []),
              {
                role: "user",
                content: [
                  { type: "text" as const, text: VISION_RESULTS_NOTE },
                  ...pages.map((data) => ({ type: "image" as const, image: data })),
                ],
              },
            ];
            continue;
          }
        }
        // Silent stall: nothing visible and nothing recovered. Nudge the model
        // to act on its (hidden) plan instead of ending the turn on nothing.
        if (
          text.trim().length === 0 &&
          nudges < MAX_EMPTY_ROUND_NUDGES &&
          round < MAX_RECOVERY_ROUNDS
        ) {
          nudges++;
          convo = [...convo, { role: "user", content: EMPTY_ROUND_NUDGE }];
          continue;
        }
        return;
      }
      if (round === MAX_RECOVERY_ROUNDS) return; // executed enough; finalize() still verifies

      const resultBlocks: string[] = [];
      const images: string[] = [];
      for (const call of calls) {
        if (abort.signal.aborted) return;
        const r = await executeRecoveredCall(call);
        resultBlocks.push(`Result of ${call.name}:\n${r.text}`);
        images.push(...r.images);
      }
      // ask_user recovered from text: don't feed results back for another
      // round — the turn is over until the user picks an answer.
      if (agentTools.hasAsked()) return;

      // Keep only the model's own prose in the assistant slot — a template-y
      // summary of the calls gets parroted verbatim by small models. The call
      // results (which imply the calls) go in the user message instead.
      convo = [
        ...convo,
        ...(text.trim() ? [{ role: "assistant" as const, content: text.trim() }] : []),
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: `${RECOVERY_RESULTS_HEADER}\n\n${resultBlocks.join("\n\n")}\n\n${RECOVERY_CONTINUE_NOTE}`,
            },
            ...images.map((data) => ({ type: "image" as const, image: data })),
          ],
        },
      ];
    }
  }

  try {
    await runAgentTurn(body.messages);

    // Enforce verification the model may have skipped, and fix a broken result
    // rather than leaving the loop on a document that does not compile.
    for (let round = 0; round <= MAX_CORRECTIVE_ROUNDS; round++) {
      if (abort.signal.aborted) break;
      const check = await agentTools.finalize();
      if (!check || check.ok) break; // nothing changed, or it compiles
      if (round === MAX_CORRECTIVE_ROUNDS) break; // out of attempts; banner shows the failure
      // A question is pending: edits are blocked, so a fix round can't fix
      // anything — leave the banner and let the user answer first.
      if (agentTools.hasAsked()) break;
      write({ type: "text", text: "\n\n_Document still fails to compile — retrying a fix…_\n\n" });
      await runAgentTurn([
        {
          role: "user",
          content:
            `The document currently FAILS to compile with this error:\n\n${check.log}\n\n` +
            `Make the minimal edit_document changes needed to fix it, then compile_check until it succeeds. ` +
            `Use read_document first if you need to see the current state of the document.`,
        },
      ]);
    }

    // Same enforcement for the bibliography: if check_bibtex was part of this
    // turn and the agent edited files, recheck the references before ending.
    let prevBibReport: string | undefined;
    for (let round = 0; round <= MAX_BIB_RECHECK_ROUNDS; round++) {
      if (abort.signal.aborted) break;
      const bib = await agentTools.finalizeBib();
      if (!bib || bib.ok) break;
      // The agent stopped without further edits (it chose to flag instead of
      // fix, or already explained) — don't nag it with the same report again.
      if (bib.report === prevBibReport) break;
      prevBibReport = bib.report;
      if (round === MAX_BIB_RECHECK_ROUNDS) break;
      if (agentTools.hasAsked()) break; // pending question — no fix rounds
      write({ type: "text", text: "\n\n_Rechecking references after the edits…_\n\n" });
      await runAgentTurn([
        {
          role: "user",
          content:
            `check_bibtex re-ran after your edits and STILL reports problems:\n\n${bib.report}\n\n` +
            `Fix what can be fixed (correct keys via the quoted lines; correct .bib fields only ` +
            `with real data confirmed via web_search). If a reference genuinely cannot be ` +
            `verified or replaced, leave it unchanged and clearly tell the user instead of ` +
            `guessing. NEVER invent bibliographic data.`,
        },
      ]);
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      write({ type: "error", message: String(err instanceof Error ? err.message : err) });
    }
  }

  write({ type: "done" });
  res.end();
}
