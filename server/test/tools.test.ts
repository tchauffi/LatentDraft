import { test } from "node:test";
import assert from "node:assert/strict";
import { RuntimeContext } from "@mastra/core/runtime-context";
import { createAgentTools, buildSystemPrompt, type EditEvent } from "../src/tools.js";

/** Invoke a Mastra tool directly, the way the recovery path does. */
function exec(
  tool: { execute?: (ctx: { context: unknown; runtimeContext: RuntimeContext }) => Promise<unknown> },
  args: Record<string, unknown> = {},
): Promise<unknown> {
  return tool.execute!({ context: args, runtimeContext: new RuntimeContext() });
}

function makeAgent(initialDoc: string) {
  const edits: EditEvent[] = [];
  const agent = createAgentTools({
    initialDoc,
    compileSessionId: "tools-test",
    emitEdit: (e) => edits.push(e),
    emitCheck: () => {},
  });
  return { agent, edits };
}

test("edit_document replaces a unique match and emits the edit", async () => {
  const { agent, edits } = makeAgent("Hello world\nfoo bar\n");
  const result = await exec(agent.tools.edit_document, {
    explanation: "greet",
    old_string: "Hello world",
    new_string: "Hi there",
  });
  assert.match(String(result), /applied/i);
  assert.equal(agent.getDoc(), "Hi there\nfoo bar\n");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].old_string, "Hello world");
});

test("edit_document rejects an old_string that is not in the document", async () => {
  const { agent, edits } = makeAgent("Hello world\n");
  const result = await exec(agent.tools.edit_document, {
    explanation: "x",
    old_string: "not present",
    new_string: "y",
  });
  assert.match(String(result), /NOT APPLIED/);
  assert.match(String(result), /not found/i);
  assert.equal(agent.getDoc(), "Hello world\n", "document must be unchanged");
  assert.equal(edits.length, 0, "no edit event for a failed edit");
});

test("edit_document rejects an ambiguous old_string", async () => {
  const { agent } = makeAgent("foo bar\nfoo baz\n");
  const result = await exec(agent.tools.edit_document, {
    explanation: "x",
    old_string: "foo",
    new_string: "qux",
  });
  assert.match(String(result), /NOT APPLIED/);
  assert.match(String(result), /multiple/i);
  assert.equal(agent.getDoc(), "foo bar\nfoo baz\n");
});

test("edit_document with omitted old_string replaces the whole document", async () => {
  const { agent, edits } = makeAgent("old content");
  const newDoc = "\\documentclass{article}\n\\begin{document}new\\end{document}";
  await exec(agent.tools.edit_document, { explanation: "rewrite", new_string: newDoc });
  assert.equal(agent.getDoc(), newDoc);
  assert.equal(edits[0].old_string, "");
});

test("edit_document inserts a fragment before \\end{document} instead of replacing the doc", async () => {
  const { agent, edits } = makeAgent(
    "\\documentclass{article}\n\\begin{document}\nbody\n\\end{document}\n",
  );
  const result = await exec(agent.tools.edit_document, {
    explanation: "insert",
    new_string: "\\section{Background}\nJust a fragment.",
  });
  assert.match(String(result), /INSERTED/);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].old_string, "\\end{document}");
  assert.match(agent.getDoc(), /documentclass/);
  assert.match(agent.getDoc(), /body\n\\section\{Background\}\nJust a fragment\.\n\n\\end\{document\}/);
});

test("edit_document rejects a fragment replacement when there is no \\end{document} anchor", async () => {
  const { agent, edits } = makeAgent("just some plain text notes");
  const result = await exec(agent.tools.edit_document, {
    explanation: "insert",
    new_string: "\\section{Background}\nJust a fragment.",
  });
  assert.match(String(result), /NOT APPLIED/);
  assert.equal(edits.length, 0);
  assert.equal(agent.getDoc(), "just some plain text notes");
});

test("edit_document rejects repeating an already-applied edit", async () => {
  const { agent, edits } = makeAgent(
    "\\documentclass{article}\n\\begin{document}\nbody\n\\end{document}\n",
  );
  const args = {
    explanation: "insert",
    new_string: "\\section{Background}\nA paragraph about history.",
  };
  await exec(agent.tools.edit_document, args);
  const second = await exec(agent.tools.edit_document, args);
  assert.match(String(second), /NOT APPLIED/);
  assert.match(String(second), /already/i);
  assert.equal(edits.length, 1, "the duplicate must not emit a second edit");
});

test("edit_document allows a full replacement when the document is empty", async () => {
  const { agent } = makeAgent("   ");
  await exec(agent.tools.edit_document, {
    explanation: "start",
    new_string: "plain notes, not latex yet",
  });
  assert.equal(agent.getDoc(), "plain notes, not latex yet");
});

test("sequential edits apply to the updated working copy", async () => {
  const { agent } = makeAgent("a b c");
  await exec(agent.tools.edit_document, { explanation: "1", old_string: "a", new_string: "x" });
  await exec(agent.tools.edit_document, { explanation: "2", old_string: "x b", new_string: "x y" });
  assert.equal(agent.getDoc(), "x y c");
});

test("read_document returns the current working copy", async () => {
  const { agent } = makeAgent("doc body here");
  await exec(agent.tools.edit_document, { explanation: "e", old_string: "body", new_string: "BODY" });
  const result = await exec(agent.tools.read_document);
  assert.match(String(result), /doc BODY here/);
});

test("finalize returns undefined when nothing was edited", async () => {
  const { agent } = makeAgent("untouched");
  assert.equal(await agent.finalize(), undefined);
});

test("system prompt tells the agent to read the log before fixing a broken document", () => {
  const prompt = buildSystemPrompt("DOC");
  assert.match(prompt, /compile_check FIRST/);
  assert.match(prompt, /NEVER guess/i);
});

test("system prompt surfaces the editor's failure log when provided", () => {
  const withLog = buildSystemPrompt("DOC", [], "error: main.tex:5: Undefined control sequence");
  assert.match(withLog, /<compile_log>/);
  assert.match(withLog, /Undefined control sequence/);
  assert.match(withLog, /FAILED/);
  const withoutLog = buildSystemPrompt("DOC", []);
  assert.doesNotMatch(withoutLog, /<compile_log>/);
});

test("hasChecked flips once the agent compiles", async () => {
  const { agent } = makeAgent("\\documentclass{article}\\begin{document}x\\end{document}");
  assert.equal(agent.hasChecked(), false);
  await exec(agent.tools.compile_check);
  assert.equal(agent.hasChecked(), true);
});

test("system prompt embeds the document and lists aux files when present", () => {
  const withAux = buildSystemPrompt("DOC-BODY", ["refs.bib", "sections/intro.tex"]);
  assert.match(withAux, /DOC-BODY/);
  assert.match(withAux, /refs\.bib, sections\/intro\.tex/);
  const withoutAux = buildSystemPrompt("DOC-BODY");
  assert.doesNotMatch(withoutAux, /compile directory also contains/);
});
