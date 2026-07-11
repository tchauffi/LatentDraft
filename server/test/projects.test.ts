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
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
  renameProjectFile,
  deleteProjectFile,
  safeProjectFilePath,
  slugifyProjectName,
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
