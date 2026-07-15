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

/* ---- Multi-file (project mode) ---- */

import { mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function makeProjectAgent(dir: string, initialDoc: string) {
  const edits: EditEvent[] = [];
  const agent = createAgentTools({
    initialDoc,
    compileSessionId: "tools-proj-test",
    projectDir: dir,
    emitEdit: (e) => edits.push(e),
    emitCheck: () => {},
  });
  return { agent, edits };
}

test("project mode: edit_document routes to another file and tags the event", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-a`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sections"), { recursive: true });
  await writeFile(path.join(dir, "sections/intro.tex"), "Old intro text.\n");

  const { agent, edits } = makeProjectAgent(dir, "\\documentclass{article}");
  const result = await exec(agent.tools.edit_document, {
    explanation: "update intro",
    file: "sections/intro.tex",
    old_string: "Old intro text.",
    new_string: "New intro text.",
  });
  assert.match(String(result), /applied/i);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].file, "sections/intro.tex");
  // The REAL file is untouched — accept/reject belongs to the user.
  assert.equal(await readFile(path.join(dir, "sections/intro.tex"), "utf8"), "Old intro text.\n");
  // But the agent's working copy sees the change.
  const read = await exec(agent.tools.read_document, { file: "sections/intro.tex" });
  assert.match(String(read), /New intro text\./);
});

test("project mode: edit_document on a missing file points at list_files/create_file", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-b`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const { agent } = makeProjectAgent(dir, "doc");
  const result = await exec(agent.tools.edit_document, {
    explanation: "x",
    file: "sections/nope.tex",
    old_string: "a",
    new_string: "b",
  });
  assert.match(String(result), /NOT APPLIED/);
  assert.match(String(result), /does not exist/);
});

test("legacy mode (no projectDir): only main.tex is editable", async () => {
  const { agent } = makeAgent("doc");
  const result = await exec(agent.tools.edit_document, {
    explanation: "x",
    file: "refs.bib",
    old_string: "a",
    new_string: "b",
  });
  assert.match(String(result), /Only main\.tex/);
});

test("project mode: create_file stages a new file and emits a full-content edit", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-c`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const { agent, edits } = makeProjectAgent(dir, "doc");
  const result = await exec(agent.tools.create_file, {
    path: "sections/method.tex",
    content: "\\section{Method}\n",
  });
  assert.match(String(result), /Created sections\/method\.tex/);
  assert.equal(edits.length, 1);
  assert.deepEqual(
    [edits[0].file, edits[0].old_string, edits[0].new_string],
    ["sections/method.tex", "", "\\section{Method}\n"],
  );
  // Not on disk — pending the user's accept.
  await assert.rejects(access(path.join(dir, "sections/method.tex")));
  // And create_file refuses to clobber.
  await writeFile(path.join(dir, "notes.txt"), "existing");
  assert.match(String(await exec(agent.tools.create_file, { path: "notes.txt", content: "x" })), /already exists/);
});

test("project mode: compile_check compiles a mirror with working edits, real files untouched", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-d`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "sections"), { recursive: true });
  const disk = "\\documentclass{article}\\begin{document}\\input{sections/body}\\end{document}";
  await writeFile(path.join(dir, "main.tex"), disk);
  await writeFile(path.join(dir, "sections/body.tex"), "From disk. \\badmacroX{}");

  const { agent } = makeProjectAgent(dir, disk);
  // Fix the aux file ONLY in the working copy.
  await exec(agent.tools.edit_document, {
    explanation: "fix",
    file: "sections/body.tex",
    old_string: "\\badmacroX{}",
    new_string: "Fixed.",
  });
  const result = await exec(agent.tools.compile_check, {});
  assert.match(String(result), /SUCCEEDED/, String(result));
  // Real project untouched: source still broken on disk, no build artifacts in it.
  assert.match(await readFile(path.join(dir, "sections/body.tex"), "utf8"), /badmacroX/);
  await assert.rejects(access(path.join(dir, "main.pdf")));
});

test("project mode: check_bibtex reports missing keys from working copies, offline", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-e`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const doc = "\\documentclass{article}\\begin{document}\\cite{ghost2024} \\cite{real}\\end{document}";
  await writeFile(path.join(dir, "main.tex"), doc);
  await writeFile(path.join(dir, "refs.bib"), "@misc{real, title={A Real Paper}}\n");

  const toolEvents: { name: string; summary: string; ok: boolean }[] = [];
  const agent = createAgentTools({
    initialDoc: doc,
    compileSessionId: "tools-bib-test",
    projectDir: dir,
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => toolEvents.push(e),
  });

  const report = String(await exec(agent.tools.check_bibtex, { verify_online: false }));
  assert.match(report, /ghost2024/);
  assert.match(report, /> 1: .*\\cite\{ghost2024\}/);
  assert.doesNotMatch(report, /External verification/, "verify_online: false must stay offline");
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "check_bibtex");
  assert.equal(toolEvents[0].ok, false);
  assert.match(toolEvents[0].summary, /1 unresolved/);

  // A working-copy edit (not yet on disk) is what gets checked.
  await exec(agent.tools.edit_document, {
    explanation: "fix key",
    old_string: "\\cite{ghost2024}",
    new_string: "\\cite{real}",
  });
  const after = String(await exec(agent.tools.check_bibtex, { verify_online: false }));
  assert.match(after, /✅ All 1 citation key\(s\) resolve/);
});

test("finalizeBib rechecks the bibliography after edits, offline", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-f`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const doc = "\\documentclass{article}\\begin{document}\\cite{ghost}\\end{document}";
  await writeFile(path.join(dir, "main.tex"), doc);
  await writeFile(path.join(dir, "refs.bib"), "@misc{real, title={R}}\n");

  const toolEvents: { name: string; summary: string; ok: boolean }[] = [];
  const agent = createAgentTools({
    initialDoc: doc,
    compileSessionId: "tools-bibfin-test",
    projectDir: dir,
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => toolEvents.push(e),
  });

  // check_bibtex never ran → no recheck.
  assert.equal(await agent.finalizeBib(), undefined);

  // Failing check, then a fixing edit → recheck re-runs and passes.
  await exec(agent.tools.check_bibtex, { verify_online: false });
  await exec(agent.tools.edit_document, {
    explanation: "fix key",
    old_string: "\\cite{ghost}",
    new_string: "\\cite{real}",
  });
  const rechecked = await agent.finalizeBib();
  assert.ok(rechecked);
  assert.equal(rechecked.ok, true);
  assert.match(rechecked.summary, /All 1 citation/);
  assert.equal(toolEvents.filter((e) => e.name === "check_bibtex").length, 2);

  // Nothing changed since → same result returned, no third tool event.
  const again = await agent.finalizeBib();
  assert.equal(again, rechecked);
  assert.equal(toolEvents.filter((e) => e.name === "check_bibtex").length, 2);
});

test("fetch_url returns page text through the injected fetch and emits its event", async () => {
  const toolEvents: { name: string; summary: string; ok: boolean }[] = [];
  const fakeFetch = (async () =>
    new Response(
      `<html><body><h1>Staff Engineer</h1><p>${"We build LaTeX tooling. ".repeat(20)}</p></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    )) as typeof fetch;
  const agent = createAgentTools({
    initialDoc: "x",
    compileSessionId: "tools-fetch-test",
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => toolEvents.push(e),
    fetchFn: fakeFetch,
  });

  assert.ok(agent.tools.fetch_url, "fetch_url is registered");
  assert.match(buildSystemPrompt("x"), /fetch_url/);

  const text = String(await exec(agent.tools.fetch_url, { url: "https://example.com/job" }));
  assert.match(text, /Staff Engineer/);
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "fetch_url");
  assert.equal(toolEvents[0].ok, true);

  const bad = String(await exec(agent.tools.fetch_url, { url: "not a url" }));
  assert.match(bad, /Not a fetchable URL/);
  assert.equal(toolEvents[1].ok, false);
});

test("ask_user emits the question with its choices and tells the model to stop", async () => {
  const asks: { question: string; options: string[] }[] = [];
  const agent = createAgentTools({
    initialDoc: "x",
    compileSessionId: "tools-ask-test",
    emitEdit: () => {},
    emitCheck: () => {},
    emitAsk: (a) => asks.push(a),
  });

  assert.ok(agent.tools.ask_user, "ask_user is registered");
  assert.match(buildSystemPrompt("x"), /ask_user/);

  const result = String(
    await exec(agent.tools.ask_user, {
      question: "Which file is the resume?",
      options: ["main.tex", "cv.tex"],
    }),
  );
  assert.match(result, /END YOUR TURN/);
  assert.deepEqual(asks, [
    { question: "Which file is the resume?", options: ["main.tex", "cv.tex"] },
  ]);
  assert.equal(agent.hasAsked(), true);

  // The question is pending: document changes are hard-blocked, so the model
  // cannot "ask" and then keep editing before the user picks an answer.
  const blockedEdit = String(
    await exec(agent.tools.edit_document, {
      explanation: "sneaky edit",
      old_string: "x",
      new_string: "y",
    }),
  );
  assert.match(blockedEdit, /NOT APPLIED: you asked the user/);
  assert.equal(agent.getDoc(), "x", "document unchanged while a question is pending");
  const blockedCreate = String(
    await exec(agent.tools.create_file, { path: "a.tex", content: "hi" }),
  );
  assert.match(blockedCreate, /NOT APPLIED: you asked the user/);

  // One question per turn.
  const again = String(
    await exec(agent.tools.ask_user, { question: "And this?", options: ["a", "b"] }),
  );
  assert.match(again, /NOT SHOWN: you already asked/);
  assert.equal(asks.length, 1);
});

test("ask_user rejects fewer than two usable choices without blocking the turn", async () => {
  const asks: unknown[] = [];
  const agent = createAgentTools({
    initialDoc: "x",
    compileSessionId: "tools-ask-test-2",
    emitEdit: () => {},
    emitCheck: () => {},
    emitAsk: (a) => asks.push(a),
  });
  const bad = String(
    await exec(agent.tools.ask_user, { question: "Hm?", options: ["only", "  "] }),
  );
  assert.match(bad, /NOT SHOWN/);
  assert.equal(asks.length, 0);
  assert.equal(agent.hasAsked(), false, "a rejected ask must not block the turn");
});

test("find_references searches through the injected fetch and respects existing bib keys", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-r`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  const doc = "\\documentclass{article}\\begin{document}x\\end{document}";
  await writeFile(path.join(dir, "main.tex"), doc);
  await writeFile(
    path.join(dir, "refs.bib"),
    "@misc{vaswani2017attention, title={Placeholder}}\n",
  );

  const fakeFetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("api.crossref.org/works?")) {
      return new Response(
        JSON.stringify({
          message: {
            items: [
              {
                title: ["Attention Is All You Need"],
                author: [{ given: "Ashish", family: "Vaswani" }],
                issued: { "date-parts": [[2017]] },
                DOI: "10.5555/3295222",
                "container-title": ["NeurIPS"],
                type: "proceedings-article",
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response("<feed></feed>", { status: 200 });
  }) as typeof fetch;

  const toolEvents: { name: string; summary: string; ok: boolean }[] = [];
  const agent = createAgentTools({
    initialDoc: doc,
    compileSessionId: "tools-refs-test",
    projectDir: dir,
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => toolEvents.push(e),
    fetchFn: fakeFetch,
  });

  assert.ok(agent.tools.find_references, "find_references is registered");
  assert.match(buildSystemPrompt("x"), /find_references/);

  const report = String(await exec(agent.tools.find_references, { query: "attention" }));
  // The generated key steps around the key already taken in refs.bib.
  assert.match(report, /@inproceedings\{vaswani2017attentionb,/);
  assert.match(report, /doi = \{10.5555\/3295222\}/);
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].name, "find_references");
  assert.equal(toolEvents[0].ok, true);
  assert.match(toolEvents[0].summary, /1 reference candidate/);
});

test("finalizeBib stays inactive when the agent edited without ever checking", async (t) => {
  const dir = path.join(os.tmpdir(), `lat-tools-${Date.now().toString(36)}-g`);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "main.tex"), "hello \\cite{nope}");
  const agent = createAgentTools({
    initialDoc: "hello \\cite{nope}",
    compileSessionId: "tools-bibfin2-test",
    projectDir: dir,
    emitEdit: () => {},
    emitCheck: () => {},
  });
  await exec(agent.tools.edit_document, {
    explanation: "x",
    old_string: "hello",
    new_string: "hi",
  });
  assert.equal(await agent.finalizeBib(), undefined);
});

test("skill tool loads a skill's body and is absent without skills", async () => {
  const toolEvents: { name: string; summary: string; ok: boolean }[] = [];
  const skills = [
    { name: "thank-reviewers", description: "Draft a response", body: "BE POLITE.", source: "global" as const },
  ];
  const agent = createAgentTools({
    initialDoc: "x",
    compileSessionId: "tools-skill-test",
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => toolEvents.push(e),
    skills,
  });
  assert.ok(agent.tools.skill, "skill tool registered when skills exist");

  const loaded = String(await exec(agent.tools.skill!, { name: "thank-reviewers" }));
  assert.match(loaded, /skill 'thank-reviewers'/);
  assert.match(loaded, /BE POLITE\./);
  assert.deepEqual(toolEvents.at(-1), { name: "skill", summary: "loaded thank-reviewers", ok: true });

  const unknown = String(await exec(agent.tools.skill!, { name: "nope" }));
  assert.match(unknown, /Unknown skill 'nope'/);
  assert.match(unknown, /thank-reviewers — Draft a response/);
  assert.equal(toolEvents.at(-1)?.ok, false);

  const bare = createAgentTools({
    initialDoc: "x",
    compileSessionId: "tools-noskill-test",
    emitEdit: () => {},
    emitCheck: () => {},
  });
  assert.equal(bare.tools.skill, undefined, "no skill tool without skills");
});

test("buildSystemPrompt lists skills only when some are installed", () => {
  const withSkills = buildSystemPrompt("DOC", [], undefined, false, [
    { name: "thank-reviewers", description: "Draft a response" },
  ]);
  assert.match(withSkills, /Installed skills/);
  assert.match(withSkills, /- thank-reviewers: Draft a response/);
  assert.match(withSkills, /call skill\(\{name\}\) FIRST/);
  assert.doesNotMatch(buildSystemPrompt("DOC"), /Installed skills/);
});

test("view_pdf attaches pages for vision models and says so", async () => {
  const doc = "\\documentclass{article}\\begin{document}vision test\\end{document}";
  const events: { name: string; summary: string; ok: boolean }[] = [];
  const withVision = createAgentTools({
    initialDoc: doc,
    compileSessionId: "tools-vision-test",
    emitEdit: () => {},
    emitCheck: () => {},
    emitTool: (e) => events.push(e),
    vision: true,
  });
  const seen = String(await exec(withVision.tools.view_pdf, {}));
  assert.match(seen, /attached in the next message/);
  assert.match(events.at(-1)!.summary, /pages attached/);
  const pages = withVision.takeRenderedImages();
  assert.ok(pages.length > 0, "rendered pages are available for the feedback message");
  assert.equal(withVision.takeRenderedImages().length, 0, "takeRenderedImages clears on read");

  const textOnly = createAgentTools({
    initialDoc: doc,
    compileSessionId: "tools-novision-test",
    emitEdit: () => {},
    emitCheck: () => {},
  });
  const plain = String(await exec(textOnly.tools.view_pdf, {}));
  assert.doesNotMatch(plain, /attached in the next message/);
});
