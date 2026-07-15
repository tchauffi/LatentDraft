import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// skills.ts resolves SKILLS_ROOT at import time — point it at a temp dir
// BEFORE importing (dynamic import; static imports would hoist above this).
const ROOT = path.join(os.tmpdir(), `latentdraft-skills-${Date.now().toString(36)}`);
process.env.SKILLS_ROOT = ROOT;
const { listSkills, parseSkillMd, projectSkillsDir } = await import("../src/skills.js");

const PROJECT = path.join(os.tmpdir(), `latentdraft-skillsproj-${Date.now().toString(36)}`);

after(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(PROJECT, { recursive: true, force: true });
});

async function install(root: string, folder: string, content: string): Promise<void> {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), content, "utf8");
}

const md = (front: string, body = "Do the thing.") => `---\n${front}\n---\n\n${body}\n`;

test("parseSkillMd extracts name/description/body and ignores unknown keys", () => {
  const parsed = parseSkillMd(
    md(
      'name: my-skill\ndescription: "Does a thing"\nallowed-tools: Bash, Read\nmetadata:\n  foo: bar',
      "# Steps\n\n1. Do it.",
    ),
  );
  assert.equal(parsed?.name, "my-skill");
  assert.equal(parsed?.description, "Does a thing");
  assert.equal(parsed?.body, "# Steps\n\n1. Do it.");
});

test("parseSkillMd returns undefined without a frontmatter block", () => {
  assert.equal(parseSkillMd("# just markdown\n"), undefined);
});

test("listSkills loads valid skills; folder name fills a missing name", async () => {
  await install(ROOT, "thank-reviewers", md("description: Draft a reviewer response"));
  const skills = await listSkills();
  const found = skills.find((s) => s.name === "thank-reviewers");
  assert.ok(found, "skill named after its folder");
  assert.equal(found?.description, "Draft a reviewer response");
  assert.equal(found?.body, "Do the thing.");
  assert.equal(found?.source, "global");
});

test("frontmatter name wins over the folder name, normalized to a slug", async () => {
  await install(ROOT, "Fancy Folder", md("name: My Skill!\ndescription: d"));
  const skills = await listSkills();
  assert.ok(skills.some((s) => s.name === "my-skill"));
});

test("invalid skills are skipped, never thrown", async () => {
  await install(ROOT, "no-description", md("name: no-description"));
  await install(ROOT, "no-frontmatter", "just a plain markdown file\n");
  await install(ROOT, "empty-body", md("description: d", ""));
  await install(ROOT, "123", md("description: name normalizes to nothing usable"));
  const names = (await listSkills()).map((s) => s.name);
  for (const bad of ["no-description", "no-frontmatter", "empty-body", "123"]) {
    assert.ok(!names.includes(bad), `${bad} must be skipped`);
  }
});

test("oversized SKILL.md is skipped", async () => {
  await install(ROOT, "huge", md("description: d", "x".repeat(65 * 1024)));
  assert.ok(!(await listSkills()).some((s) => s.name === "huge"));
});

test("project skills merge in and shadow a global skill of the same name", async () => {
  await install(ROOT, "shared", md("description: global version", "GLOBAL"));
  await install(projectSkillsDir(PROJECT), "shared", md("description: project version", "PROJECT"));
  await install(projectSkillsDir(PROJECT), "local-only", md("description: only here"));

  const skills = await listSkills(PROJECT);
  const shared = skills.find((s) => s.name === "shared");
  assert.equal(shared?.body, "PROJECT");
  assert.equal(shared?.source, "project");
  assert.ok(skills.some((s) => s.name === "local-only" && s.source === "project"));

  // Without a project dir, the global version is back.
  const globalOnly = await listSkills();
  assert.equal(globalOnly.find((s) => s.name === "shared")?.body, "GLOBAL");
  assert.ok(!globalOnly.some((s) => s.name === "local-only"));
});

test("a missing project skills dir contributes nothing (and never throws)", async () => {
  const skills = await listSkills(path.join(PROJECT, "does-not-exist"));
  assert.ok(skills.every((s) => s.source === "global"));
});
