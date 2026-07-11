import type { Response } from "express";
import { Agent } from "@mastra/core/agent";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { nanoid } from "nanoid";
import {
  getModel,
  ensureOllamaContextVariant,
  modelSupportsVision,
  type ProviderId,
} from "./providers.js";
import { writeSessionFiles, listSessionFiles } from "./compile.js";
import { createAgentTools, buildSystemPrompt } from "./tools.js";
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
  /** The editor's compile session. When given, the agent compiles and runs
   * Python in the SAME directory as the preview — so a figure it generates
   * still resolves when the user's editor recompiles the accepted document. */
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
// Extra rounds granted when the model writes tool calls as TEXT instead of
// using native function calling (common with small local models): each round
// executes the recovered calls and feeds the results back so the model can
// continue exactly as if the calls had been native.
const MAX_RECOVERY_ROUNDS = 8;

// Boilerplate used in the recovery-loop feedback messages. Kept as constants
// so the stream filter can suppress them when a small model echoes them back
// verbatim into its visible reply.
const RECOVERY_RESULTS_HEADER = "I executed the tool calls from your reply:";
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
  // Seed the sandbox with the project's aux files so \input / \bibliography
  // resolve when the agent runs compile_check.
  if (body.files && Object.keys(body.files).length > 0) {
    await writeSessionFiles(compileSessionId, body.files);
  }

  const agentTools = createAgentTools({
    initialDoc: body.documentText ?? "",
    compileSessionId,
    emitEdit: (e) =>
      write({
        type: "edit",
        id: e.id,
        explanation: e.explanation,
        old_string: e.old_string,
        new_string: e.new_string,
      }),
    emitCheck: (c) => write({ type: "check", ok: c.ok, log: c.log }),
    emitTool: (t) => write({ type: "tool", name: t.name, summary: t.summary, ok: t.ok }),
  });

  const knownToolNames: ReadonlySet<string> = new Set(Object.keys(agentTools.tools));
  const toolList = [...knownToolNames].join(", ");
  // Everything \includegraphics/\input can resolve: the project files sent
  // with this request plus what earlier turns left in the shared session dir
  // (e.g. figures generated by run_python).
  const auxFileNames = [
    ...new Set([...Object.keys(body.files ?? {}), ...(await listSessionFiles(compileSessionId))]),
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
    const filter = new ToolCallStreamFilter(
      knownToolNames,
      (text) => write({ type: "text", text }),
      [RECOVERY_CONTINUE_NOTE, RECOVERY_RESULTS_HEADER],
    );
    const stream = await agent.stream(messages as Parameters<typeof agent.stream>[0], {
      instructions: system,
      maxSteps: MAX_STEPS,
      abortSignal: abort.signal,
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
    for (let round = 0; round <= MAX_RECOVERY_ROUNDS; round++) {
      if (abort.signal.aborted) return;
      const { text, calls } = await runRound(convo, currentSystemPrompt());
      if (calls.length === 0) return;
      if (round === MAX_RECOVERY_ROUNDS) return; // executed enough; finalize() still verifies

      const resultBlocks: string[] = [];
      const images: string[] = [];
      for (const call of calls) {
        if (abort.signal.aborted) return;
        const r = await executeRecoveredCall(call);
        resultBlocks.push(`Result of ${call.name}:\n${r.text}`);
        images.push(...r.images);
      }

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
  } catch (err) {
    if (!abort.signal.aborted) {
      write({ type: "error", message: String(err instanceof Error ? err.message : err) });
    }
  }

  write({ type: "done" });
  res.end();
}
