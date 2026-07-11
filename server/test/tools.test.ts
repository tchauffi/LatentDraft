import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentTools, buildSystemPrompt, type EditEvent } from "../src/tools.js";

const CALL_OPTS = { toolCallId: "t1", messages: [] };

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
  const result = await agent.tools.edit_document.execute!(
    { explanation: "greet", old_string: "Hello world", new_string: "Hi there" },
    CALL_OPTS,
  );
  assert.match(String(result), /applied/i);
  assert.equal(agent.getDoc(), "Hi there\nfoo bar\n");
  assert.equal(edits.length, 1);
  assert.equal(edits[0].old_string, "Hello world");
});

test("edit_document rejects an old_string that is not in the document", async () => {
  const { agent, edits } = makeAgent("Hello world\n");
  const result = await agent.tools.edit_document.execute!(
    { explanation: "x", old_string: "not present", new_string: "y" },
    CALL_OPTS,
  );
  assert.match(String(result), /NOT APPLIED/);
  assert.match(String(result), /not found/i);
  assert.equal(agent.getDoc(), "Hello world\n", "document must be unchanged");
  assert.equal(edits.length, 0, "no edit event for a failed edit");
});

test("edit_document rejects an ambiguous old_string", async () => {
  const { agent } = makeAgent("foo bar\nfoo baz\n");
  const result = await agent.tools.edit_document.execute!(
    { explanation: "x", old_string: "foo", new_string: "qux" },
    CALL_OPTS,
  );
  assert.match(String(result), /NOT APPLIED/);
  assert.match(String(result), /multiple/i);
  assert.equal(agent.getDoc(), "foo bar\nfoo baz\n");
});

test("edit_document with omitted old_string replaces the whole document", async () => {
  const { agent, edits } = makeAgent("old content");
  await agent.tools.edit_document.execute!(
    { explanation: "rewrite", new_string: "brand new document" },
    CALL_OPTS,
  );
  assert.equal(agent.getDoc(), "brand new document");
  assert.equal(edits[0].old_string, "");
});

test("sequential edits apply to the updated working copy", async () => {
  const { agent } = makeAgent("a b c");
  await agent.tools.edit_document.execute!(
    { explanation: "1", old_string: "a", new_string: "x" },
    CALL_OPTS,
  );
  await agent.tools.edit_document.execute!(
    { explanation: "2", old_string: "x b", new_string: "x y" },
    CALL_OPTS,
  );
  assert.equal(agent.getDoc(), "x y c");
});

test("finalize returns undefined when nothing was edited", async () => {
  const { agent } = makeAgent("untouched");
  assert.equal(await agent.finalize(), undefined);
});

test("system prompt embeds the document and lists aux files when present", () => {
  const withAux = buildSystemPrompt("DOC-BODY", ["refs.bib", "sections/intro.tex"]);
  assert.match(withAux, /DOC-BODY/);
  assert.match(withAux, /refs\.bib, sections\/intro\.tex/);
  const withoutAux = buildSystemPrompt("DOC-BODY");
  assert.doesNotMatch(withoutAux, /compile directory also contains/);
});
