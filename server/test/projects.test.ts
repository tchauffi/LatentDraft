import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compileProject, projectBuildDir } from "../src/compile.js";

// projects.ts resolves PROJECTS_ROOT at import time — point it at a temp dir
// BEFORE importing (dynamic import; static imports would hoist above this).
const ROOT = path.join(os.tmpdir(), `latentdraft-projects-${Date.now().toString(36)}`);
process.env.PROJECTS_ROOT = ROOT;
const {
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
  safeProjectFilePath,
  slugifyProjectName,
  extractTexTitle,
  readProjectChat,
  writeProjectChat,
  projectDir,
} = await import("../src/projects.js");

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

test("createProject seeds the template, .gitignore, and shows up in the list", async () => {
  const result = await createProject("My Paper");
  assert.deepEqual(result, { id: "My Paper" });
  const dir = projectDir("My Paper")!;
  assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), ".latentdraft/\n");
  // The template's placeholder title is seeded with the project name.
  assert.match(await readFile(path.join(dir, "main.tex"), "utf8"), /\\title\{My Paper\}/);
  await access(path.join(dir, "main.tex"));
  await access(path.join(dir, "sections/intro.tex"));
  const projects = await listProjects();
  assert.ok(projects.some((p) => p.id === "My Paper"));
});

test("createProject refuses duplicates and unusable names", async () => {
  await createProject("dup");
  assert.match((await createProject("dup") as { error: string }).error, /already exists/);
  assert.match((await createProject("!!!") as { error: string }).error, /letter or digit/);
});

test("slugifyProjectName cleans punctuation without mangling names", () => {
  assert.equal(slugifyProjectName("Vibratory Mechanics!"), "Vibratory Mechanics");
  assert.equal(slugifyProjectName("../evil"), "evil");
  assert.equal(slugifyProjectName("...."), undefined);
});

test("extractTexTitle handles nesting and commands, listProjects carries it", async () => {
  assert.equal(extractTexTitle("\\title{Plain Title}"), "Plain Title");
  assert.equal(
    extractTexTitle("\\title{A \\textbf{Bold} Move\\\\with a break}"),
    "A Bold Move with a break",
  );
  assert.equal(extractTexTitle("\\title{}"), undefined);
  assert.equal(extractTexTitle("no title here"), undefined);

  await createProject("titled");
  const dir = projectDir("titled")!;
  await writeFile(
    path.join(dir, "main.tex"),
    "\\documentclass{article}\n\\title{Spectral Methods}\n\\begin{document}x\\end{document}\n",
  );
  const listed = (await listProjects()).find((p) => p.id === "titled")!;
  assert.equal(listed.title, "Spectral Methods");
});

test("renameProject moves the directory and refuses collisions", async () => {
  await createProject("old-name");
  await createProject("taken");
  assert.match((await renameProject("old-name", "taken") as { error: string }).error, /already exists/);
  const r = await renameProject("old-name", "New Name!");
  assert.deepEqual(r, { id: "New Name" });
  await access(path.join(ROOT, "New Name", "main.tex"));
  await assert.rejects(access(path.join(ROOT, "old-name")));
  // Renaming to the same id is a no-op, not a collision with itself.
  assert.deepEqual(await renameProject("taken", "taken"), { id: "taken" });
});

test("duplicateProject copies sources but not build artifacts or .git", async () => {
  await createProject("dupe-me");
  const dir = projectDir("dupe-me")!;
  await writeFile(path.join(dir, "extra.tex"), "copied");
  await mkdir(path.join(dir, ".latentdraft/build"), { recursive: true });
  await writeFile(path.join(dir, ".latentdraft/build/main.pdf"), "x");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await writeFile(path.join(dir, ".git/HEAD"), "x");

  const first = await duplicateProject("dupe-me");
  assert.deepEqual(first, { id: "dupe-me copy" });
  const copyDir = projectDir("dupe-me copy")!;
  assert.equal(await readFile(path.join(copyDir, "extra.tex"), "utf8"), "copied");
  await access(path.join(copyDir, "main.tex"));
  await assert.rejects(access(path.join(copyDir, ".latentdraft")));
  await assert.rejects(access(path.join(copyDir, ".git")));

  // The name is taken now — the next copy gets a numbered suffix.
  assert.deepEqual(await duplicateProject("dupe-me"), { id: "dupe-me copy 2" });
  assert.match((await duplicateProject("gone") as { error: string }).error, /not found/i);
});

test("project chat roundtrips through .latentdraft and stays out of the file list", async () => {
  await createProject("chatty");
  assert.deepEqual(await readProjectChat("chatty"), []); // no history yet
  const messages = [{ id: "m1", role: "user", content: "hello", edits: [], activity: [] }];
  assert.equal((await writeProjectChat("chatty", messages)).ok, true);
  assert.deepEqual(await readProjectChat("chatty"), messages);
  // chat.json lives in the hidden build dir — invisible to the file API.
  const files = (await listProjectFiles("chatty"))!;
  assert.ok(!files.some((f) => f.path.includes("chat.json")));
  // The chat survives a project rename (it moves with the folder).
  await renameProject("chatty", "chatty2");
  assert.deepEqual(await readProjectChat("chatty2"), messages);
  // Guards: bad ids and missing projects.
  assert.equal((await writeProjectChat("../evil", messages)).ok, false);
  assert.equal((await writeProjectChat("never-made", messages)).ok, false);
  assert.equal(await readProjectChat("../evil"), undefined);
});

test("deleteProject removes the whole directory, including hidden dirs", async () => {
  await createProject("doomed");
  const dir = projectDir("doomed")!;
  await mkdir(path.join(dir, ".latentdraft/build"), { recursive: true });
  await writeFile(path.join(dir, ".latentdraft/build/main.pdf"), "x");
  assert.equal((await deleteProject("doomed")).ok, true);
  await assert.rejects(access(dir));
  assert.equal((await deleteProject("doomed")).ok, false);
  assert.equal((await deleteProject("../escape")).ok, false);
});

test("listProjectFiles hides build artifacts, .git, and agent scratch files", async () => {
  await createProject("hidden-test");
  const dir = projectDir("hidden-test")!;
  await mkdir(path.join(dir, ".latentdraft/build"), { recursive: true });
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await writeFile(path.join(dir, ".latentdraft/build/main.pdf"), "x");
  await writeFile(path.join(dir, ".git/HEAD"), "x");
  await writeFile(path.join(dir, "_agent_script.py"), "x");
  await writeFile(path.join(dir, "figure.png"), "x");
  const files = (await listProjectFiles("hidden-test"))!;
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("main.tex"));
  assert.ok(paths.includes("figure.png"));
  assert.ok(
    !paths.some(
      (p) => p.startsWith(".latentdraft/") || p.startsWith(".git/") || path.basename(p).startsWith("_"),
    ),
  );
  assert.ok(paths.includes(".gitignore"), ".gitignore is a project file, not a hidden one");
  assert.equal(files.find((f) => f.path === "figure.png")!.binary, true);
  assert.equal(files.find((f) => f.path === "main.tex")!.binary, false);
});

test("write/read roundtrip, and a stale base mtime is refused with disk content", async () => {
  await createProject("conflict-test");
  const w1 = await writeProjectFile("conflict-test", "notes.txt", Buffer.from("mine"));
  assert.ok(w1.ok && w1.mtimeMs > 0);
  const read = (await readProjectFile("conflict-test", "notes.txt"))!;
  assert.equal(read.data.toString(), "mine");

  // Simulate an external edit: bump the file, then write with the OLD mtime.
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path.join(projectDir("conflict-test")!, "notes.txt"), "external");
  const w2 = await writeProjectFile(
    "conflict-test",
    "notes.txt",
    Buffer.from("mine v2"),
    (w1 as { mtimeMs: number }).mtimeMs,
  );
  assert.equal(w2.ok, false);
  assert.equal((w2 as { conflict: { content: string } }).conflict.content, "external");
  // And a matching base mtime writes fine.
  const disk = (await readProjectFile("conflict-test", "notes.txt"))!;
  const w3 = await writeProjectFile("conflict-test", "notes.txt", Buffer.from("mine v3"), disk.mtimeMs);
  assert.ok(w3.ok);
});

test("safeProjectFilePath rejects traversal and hidden dirs", () => {
  assert.equal(safeProjectFilePath("sections/intro.tex"), "sections/intro.tex");
  assert.equal(safeProjectFilePath("../escape.tex"), undefined);
  assert.equal(safeProjectFilePath("/etc/passwd"), undefined);
  assert.equal(safeProjectFilePath(".git/config"), undefined);
  assert.equal(safeProjectFilePath(".latentdraft/build/main.pdf"), undefined);
});

test("rename works and main.tex cannot be deleted", async () => {
  await createProject("rename-test");
  const r = await renameProjectFile("rename-test", "sections/intro.tex", "sections/introduction.tex");
  assert.equal(r.ok, true, r.error);
  await access(path.join(projectDir("rename-test")!, "sections/introduction.tex"));
  const d = await deleteProjectFile("rename-test", "main.tex");
  assert.equal(d.ok, false);
  assert.match(d.error!, /compile target/);
  assert.equal((await deleteProjectFile("rename-test", "refs.bib")).ok, true);
});

test("compileProject builds from disk into .latentdraft/build, sources untouched", async () => {
  const dir = path.join(ROOT, "compile-me");
  await mkdir(path.join(dir, "sections"), { recursive: true });
  await writeFile(
    path.join(dir, "main.tex"),
    "\\documentclass{article}\\begin{document}\\input{sections/body}\\end{document}",
  );
  await writeFile(path.join(dir, "sections/body.tex"), "Relative input resolves.");
  const result = await compileProject(dir);
  assert.equal(result.ok, true, result.log);
  await access(path.join(projectBuildDir(dir), "main.pdf"));
  // No artifacts polluting the project root (git cleanliness).
  await assert.rejects(access(path.join(dir, "main.pdf")));
  await assert.rejects(access(path.join(dir, "main.log")));
});

test("compileProject failure carries structured diagnostics", async () => {
  const dir = path.join(ROOT, "compile-broken");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nok\n\\badmacroX{}\n\\end{document}\n",
  );
  const result = await compileProject(dir);
  assert.equal(result.ok, false);
  const diag = result.diagnostics ?? [];
  assert.ok(diag.length > 0, "diagnostics expected");
  assert.equal(diag[0].file, "main.tex");
  assert.equal(diag[0].line, 4);
  assert.match(diag[0].message, /badmacroX|Undefined control sequence/i);
});

test("compileProject without a main.tex fails with guidance, not a crash", async () => {
  const dir = path.join(ROOT, "no-main");
  await mkdir(dir, { recursive: true });
  const result = await compileProject(dir);
  assert.equal(result.ok, false);
  assert.match(result.log, /no main\.tex/i);
});
