import type { Response } from "express";
import { streamText, type CoreMessage } from "ai";
import { nanoid } from "nanoid";
import { getModel, type ProviderId } from "./providers.js";
import { writeSessionFiles } from "./compile.js";
import { createAgentTools, buildSystemPrompt } from "./tools.js";

export interface ChatRequest {
  provider: ProviderId;
  model: string;
  documentText: string;
  /** Auxiliary project files (refs.bib, sections/…) for the compile sandbox. */
  files?: Record<string, string>;
  messages: CoreMessage[];
}

// Generous budget: a research-heavy task (several web_searches) still needs
// room left to edit_document and compile_check. Too low and the agent runs out
// of steps mid-research and never writes the document.
const MAX_STEPS = 24;
const MAX_CORRECTIVE_ROUNDS = 5;

/**
 * Stream an agent turn as NDJSON. One JSON object per line:
 *   { type: "text",  text }                                    text delta
 *   { type: "edit",  id, explanation, old_string, new_string } proposed edit (validated to match)
 *   { type: "check", ok, log }                                 result of a compile_check
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
  try {
    model = getModel(body.provider, body.model);
  } catch (err) {
    write({ type: "error", message: String(err instanceof Error ? err.message : err) });
    write({ type: "done" });
    res.end();
    return;
  }

  const compileSessionId = `agent-${nanoid(8)}`;
  // Seed the sandbox with the project's aux files so \input / \bibliography
  // resolve when the agent runs compile_check.
  if (body.files && Object.keys(body.files).length > 0) {
    await writeSessionFiles(compileSessionId, body.files);
  }

  const agent = createAgentTools({
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

  /**
   * Keep a fumbled tool call from aborting the whole turn. Local models often
   * get the tool NAME or the ARGUMENT KEYS slightly wrong; this normalizes both
   * cases (bad name -> nearest real tool; aliased/missing keys -> the schema)
   * before the SDK re-validates. Only genuinely unrecoverable calls are surfaced.
   */
  const repairToolCall: NonNullable<Parameters<typeof streamText>[0]["experimental_repairToolCall"]> =
    async ({ toolCall, error }) => {
      const name = toolCall.toolName.toLowerCase();
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(toolCall.args || "{}");
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        /* args weren't valid JSON */
      }
      const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
      const fixed = (toolName: string, a: Record<string, unknown>) => ({
        toolCallType: "function" as const,
        toolCallId: toolCall.toolCallId,
        toolName,
        args: JSON.stringify(a),
      });

      // 1. Hallucinated web-search tool -> our real web_search.
      if (/search|google|browse|web|bing|duckduck/.test(name) && name !== "web_search") {
        const query = str(args.query) ?? str(args.q) ?? str(args.input) ?? str(args.text) ?? toolCall.args ?? "";
        return fixed("web_search", { query });
      }

      // 2. Right tool, wrong argument keys — remap common aliases to the schema.
      if (name === "edit_document") {
        const new_string =
          str(args.new_string) ?? str(args.content) ?? str(args.text) ?? str(args.new) ?? str(args.replacement) ?? str(args.value);
        if (new_string !== undefined) {
          const old_string = str(args.old_string) ?? str(args.old) ?? str(args.search) ?? str(args.target);
          const explanation = str(args.explanation) ?? str(args.description) ?? "Update the document";
          // old_string omitted => replace the whole document (matches the tool contract).
          return fixed("edit_document", old_string !== undefined ? { explanation, old_string, new_string } : { explanation, new_string });
        }
      }
      if (name === "web_search") {
        const query = str(args.query) ?? str(args.q) ?? str(args.input) ?? str(args.text);
        if (query !== undefined) return fixed("web_search", { query, ...(typeof args.max_results === "number" ? { max_results: args.max_results } : {}) });
      }
      if (name === "run_python") {
        const code = str(args.code) ?? str(args.python) ?? str(args.script) ?? str(args.source);
        if (code !== undefined) return fixed("run_python", { code });
      }

      // 3. Unrecoverable — surface the mistake to the model instead of crashing.
      write({
        type: "error",
        message: `Model made an invalid call to '${toolCall.toolName}'. Available tools: edit_document, compile_check, web_search, run_python, view_pdf, ats_check.`,
      });
      throw error;
    };

  // Run one model turn (multi-step, tools) and pipe text/errors to the client.
  async function runRound(messages: CoreMessage[], system: string): Promise<void> {
    const result = streamText({
      model,
      system,
      messages,
      tools: agent.tools,
      maxSteps: MAX_STEPS,
      abortSignal: abort.signal,
      experimental_repairToolCall: repairToolCall,
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          write({ type: "text", text: part.textDelta });
          break;
        case "error":
          write({
            type: "error",
            message: String(part.error instanceof Error ? part.error.message : part.error),
          });
          break;
        default:
          break;
      }
    }
  }

  const auxFileNames = Object.keys(body.files ?? {});

  try {
    await runRound(body.messages, buildSystemPrompt(body.documentText ?? "", auxFileNames));

    // Enforce verification the model may have skipped, and fix a broken result
    // rather than leaving the loop on a document that does not compile.
    for (let round = 0; round <= MAX_CORRECTIVE_ROUNDS; round++) {
      if (abort.signal.aborted) break;
      const check = await agent.finalize();
      if (!check || check.ok) break; // nothing changed, or it compiles
      if (round === MAX_CORRECTIVE_ROUNDS) break; // out of attempts; banner shows the failure
      write({ type: "text", text: "\n\n_Document still fails to compile — retrying a fix…_\n\n" });
      await runRound(
        [
          {
            role: "user",
            content:
              `The document currently FAILS to compile with this error:\n\n${check.log}\n\n` +
              `Make the minimal edit_document changes needed to fix it, then compile_check until it succeeds.`,
          },
        ],
        buildSystemPrompt(agent.getDoc(), auxFileNames),
      );
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      write({ type: "error", message: String(err instanceof Error ? err.message : err) });
    }
  }

  write({ type: "done" });
  res.end();
}
