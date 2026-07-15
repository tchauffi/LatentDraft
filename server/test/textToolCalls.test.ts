import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ToolCallStreamFilter,
  coerceToolCall,
  extractCallsFromText,
  normalizeToolName,
  normalizeToolArgs,
  scanBalancedJson,
  type RecoveredToolCall,
} from "../src/textToolCalls.js";

const KNOWN = new Set([
  "edit_document",
  "read_document",
  "compile_check",
  "web_search",
  "run_python",
  "view_pdf",
  "ats_check",
  "fetch_url",
  "check_bibtex",
  "find_references",
  "ask_user",
]);

/** Run the filter over the input in chunks and return the outcome. */
function filterAll(
  input: string,
  chunkSize = input.length,
): { text: string; calls: RecoveredToolCall[]; streamed: string } {
  let streamed = "";
  const f = new ToolCallStreamFilter(KNOWN, (t) => (streamed += t));
  for (let i = 0; i < input.length; i += chunkSize) f.push(input.slice(i, i + chunkSize));
  const { text, calls } = f.finish();
  return { text, calls, streamed };
}

test("recovers a bare-JSON tool call written as text (qwen style)", () => {
  const input =
    '{\n  "name": "edit_document",\n  "arguments": {\n    "explanation": "Insert a section.",\n    "old_string": "A",\n    "new_string": "B"\n  }\n}\n\n{"name": "compile_check", "arguments": {}}';
  const { text, calls } = filterAll(input);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "edit_document");
  assert.deepEqual(calls[0].args, { explanation: "Insert a section.", old_string: "A", new_string: "B" });
  assert.equal(calls[1].name, "compile_check");
  assert.equal(text.trim(), "");
});

test("streaming char-by-char gives the same result as one chunk", () => {
  const input = 'Sure, let me do that.\n{"name": "compile_check", "arguments": {}}\nDone.';
  const whole = filterAll(input);
  const chars = filterAll(input, 1);
  assert.deepEqual(chars.calls, whole.calls);
  assert.equal(chars.text, whole.text);
  assert.equal(chars.streamed, chars.text);
  assert.equal(whole.text, "Sure, let me do that.\n\nDone.");
});

test("recovers <tool_call> tagged calls", () => {
  const input = 'Before <tool_call>{"name": "web_search", "arguments": {"query": "latex"}}</tool_call> after';
  const { text, calls } = filterAll(input, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "web_search");
  assert.deepEqual(calls[0].args, { query: "latex" });
  assert.equal(text, "Before  after");
});

test("recovers fenced ```json tool calls", () => {
  const input = 'Let me edit:\n```json\n{"name": "edit_document", "arguments": {"explanation": "x", "new_string": "full doc"}}\n```\nok';
  const { text, calls } = filterAll(input, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.new_string, "full doc");
  assert.equal(text, "Let me edit:\n\nok");
});

test("strips <think> reasoning blocks", () => {
  const input = "<think>私は考える… lots of hidden reasoning {\"name\": \"x\"}</think>The answer is 42.";
  const { text, calls } = filterAll(input, 4);
  assert.equal(calls.length, 0);
  assert.equal(text, "The answer is 42.");
});

test("passes ordinary prose with braces and math through unchanged", () => {
  const input = "In LaTeX, use \\frac{a}{b} and {\\bf bold}. Sets like {1, 2} are fine.";
  const { text, calls } = filterAll(input, 2);
  assert.equal(calls.length, 0);
  assert.equal(text, input);
});

test("passes non-tool code fences through verbatim", () => {
  const input = "Example:\n```latex\n\\section{Intro}\n{\"name\": \"not a call\"}\n```\ntail";
  const { text, calls } = filterAll(input, 7);
  assert.equal(calls.length, 0);
  assert.equal(text, input);
});

test("leaves non-tool JSON in the text", () => {
  const input = 'Config: {"name": "John", "age": 3} end';
  const { text, calls } = filterAll(input, 3);
  assert.equal(calls.length, 0);
  assert.equal(text, input);
});

test("handles arguments given as a JSON-encoded string", () => {
  const input = '{"name": "run_python", "arguments": "{\\"code\\": \\"print(1)\\"}"}';
  const { calls } = filterAll(input);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { code: "print(1)" });
});

test("handles OpenAI-style {type: function, function: {...}} shape", () => {
  const call = coerceToolCall(
    { type: "function", function: { name: "web_search", arguments: { query: "q" } } },
    KNOWN,
  );
  assert.ok(call);
  assert.equal(call.name, "web_search");
  assert.deepEqual(call.args, { query: "q" });
});

test("handles args inlined next to the name and aliased keys", () => {
  const call = coerceToolCall(
    { name: "edit_document", description: "add intro", content: "NEW", old: "OLD" },
    KNOWN,
  );
  assert.ok(call);
  assert.deepEqual(call.args, { explanation: "add intro", old_string: "OLD", new_string: "NEW" });
});

test("normalizeToolName maps hallucinated names onto real tools", () => {
  assert.equal(normalizeToolName("read", KNOWN), "read_document");
  assert.equal(normalizeToolName("google_search", KNOWN), "web_search");
  assert.equal(normalizeToolName("Edit_Document", KNOWN), "edit_document");
  assert.equal(normalizeToolName("compile", KNOWN), "compile_check");
  assert.equal(normalizeToolName("nonsense_zzz", KNOWN), undefined);
});

test("normalizeToolName routes fetch-style aliases to fetch_url, not web_search", () => {
  assert.equal(normalizeToolName("fetch_page", KNOWN), "fetch_url");
  assert.equal(normalizeToolName("open_url", KNOWN), "fetch_url");
  assert.equal(normalizeToolName("get_url", KNOWN), "fetch_url");
  assert.equal(normalizeToolName("web_fetch", KNOWN), "fetch_url");
  assert.equal(normalizeToolName("scrape_website", KNOWN), "fetch_url");
  // Search-style names still land on web_search.
  assert.equal(normalizeToolName("google_search", KNOWN), "web_search");
  assert.equal(normalizeToolName("browse", KNOWN), "web_search");
});

test("normalizeToolName routes discovery aliases to find_references, checks to check_bibtex", () => {
  assert.equal(normalizeToolName("find_papers", KNOWN), "find_references");
  assert.equal(normalizeToolName("search_references", KNOWN), "find_references");
  assert.equal(normalizeToolName("lookup_citation", KNOWN), "find_references");
  assert.equal(normalizeToolName("search_arxiv", KNOWN), "find_references");
  // Verification-style names still land on check_bibtex.
  assert.equal(normalizeToolName("check_references", KNOWN), "check_bibtex");
  assert.equal(normalizeToolName("verify_citations", KNOWN), "check_bibtex");
  assert.equal(normalizeToolName("check_bibliography", KNOWN), "check_bibtex");
});

test("normalizeToolName and arg aliases route question-style calls to ask_user", () => {
  assert.equal(normalizeToolName("ask_question", KNOWN), "ask_user");
  assert.equal(normalizeToolName("clarify", KNOWN), "ask_user");
  assert.equal(normalizeToolName("user_choice", KNOWN), "ask_user");
  assert.deepEqual(
    normalizeToolArgs("ask_user", { prompt: "Which one?", choices: ["a", "b"] }),
    { question: "Which one?", options: ["a", "b"] },
  );
});

test("normalizeToolArgs maps aliased fetch_url keys onto url", () => {
  assert.deepEqual(normalizeToolArgs("fetch_url", { link: "https://x" }), { url: "https://x" });
  assert.deepEqual(normalizeToolArgs("fetch_url", { href: "https://y" }), { url: "https://y" });
  assert.deepEqual(normalizeToolArgs("fetch_url", { nope: 1 }), {});
});

test("recovers fetch_url(\"url\") text-form calls via the primary argument", () => {
  const { calls } = filterAll('fetch_url("https://example.com/job")', 4);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "fetch_url");
  assert.deepEqual(calls[0].args, { url: "https://example.com/job" });
});

test("normalizeToolArgs keeps canonical keys as-is", () => {
  assert.deepEqual(
    normalizeToolArgs("edit_document", { explanation: "e", old_string: "o", new_string: "n" }),
    { explanation: "e", old_string: "o", new_string: "n" },
  );
});

test("scanBalancedJson respects strings with escaped braces and quotes", () => {
  const s = '{"a": "close } brace and \\" quote", "b": {"c": 1}} tail';
  const end = scanBalancedJson(s);
  assert.equal(s.slice(end), " tail");
});

test("extractCallsFromText finds multiple calls amid prose", () => {
  const text =
    'first {"name": "compile_check", "arguments": {}} middle {"name": "view_pdf", "arguments": {"max_pages": 2}} last';
  const { calls, leftover } = extractCallsFromText(text, KNOWN);
  assert.equal(calls.length, 2);
  assert.equal(leftover, "first  middle  last");
});

test("recovers python-style name(json) calls written as text", () => {
  const input = 'Now: edit_document({"explanation": "e", "old_string": "a", "new_string": "b"}) then compile_check()';
  const { text, calls } = filterAll(input, 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "edit_document");
  assert.deepEqual(calls[0].args, { explanation: "e", old_string: "a", new_string: "b" });
  assert.equal(calls[1].name, "compile_check");
  assert.equal(text, "Now:  then ");
});

test("recovers name(kwargs) and name(\"string\") call styles", () => {
  const input = 'web_search(query="latex tips", max_results=3)\nrun_python("print(1)")';
  const { calls } = filterAll(input, 5);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, { query: "latex tips", max_results: 3 });
  assert.deepEqual(calls[1].args, { code: "print(1)" });
});

test("leaves quoted tool signatures in prose alone", () => {
  const input = "You can use web_search(query, max_results?) or edit_document(explanation, old_string, new_string) here.";
  const { text, calls } = filterAll(input, 3);
  assert.equal(calls.length, 0);
  assert.equal(text, input);
});

test("tool name in prose without parentheses is untouched", () => {
  const input = "Let me call read_document first, then compile_check afterwards.";
  const { text, calls } = filterAll(input, 2);
  assert.equal(calls.length, 0);
  assert.equal(text, input);
});

test("suppressed boilerplate strings are dropped from the stream", () => {
  const NOTE = "(The current document is in the system prompt.) Continue the task.";
  let streamed = "";
  const f = new ToolCallStreamFilter(KNOWN, (t) => (streamed += t), [NOTE]);
  const input = `${NOTE}Here is my actual summary.`;
  for (let i = 0; i < input.length; i += 3) f.push(input.slice(i, i + 3));
  const { text } = f.finish();
  assert.equal(text, "Here is my actual summary.");
  assert.equal(streamed, text);
});

test("truncated tool JSON at end of stream is dropped, keeping prior text", () => {
  const input = 'Working… {"name": "edit_document", "arguments": {"new_string": "unterminated';
  const { text, calls } = filterAll(input, 6);
  assert.equal(calls.length, 0);
  assert.equal(text, "Working… ");
});
