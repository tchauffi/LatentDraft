import { test } from "node:test";
import assert from "node:assert/strict";
import { expandSlashCommand, matchSlashCommands } from "../src/lib/slashCommands";

test("/check-bibtex expands to the check_bibtex instruction", () => {
  const exp = expandSlashCommand("/check-bibtex");
  assert.ok(exp);
  assert.equal(exp.display, "/check-bibtex");
  assert.match(exp.prompt, /check_bibtex/);
  assert.match(exp.prompt, /fabricated/);
});

test("expansion is case-insensitive and keeps trailing text as context", () => {
  const exp = expandSlashCommand("  /CHECK-BIBTEX focus on section 2  ");
  assert.ok(exp);
  assert.equal(exp.display, "/CHECK-BIBTEX focus on section 2");
  assert.match(exp.prompt, /Additional context from me: focus on section 2/);
});

test("/apply expands to the plan-first tailoring instruction", () => {
  const exp = expandSlashCommand("/apply");
  assert.ok(exp);
  assert.equal(exp.display, "/apply");
  assert.match(exp.prompt, /fetch_url/);
  assert.match(exp.prompt, /ats_check/);
  assert.match(exp.prompt, /do NOT call edit_document/);
  assert.match(exp.prompt, /NUMBERED improvement plan/);
});

test("/apply labels its trailing text as the job posting", () => {
  const exp = expandSlashCommand("/apply https://example.com/job/123");
  assert.ok(exp);
  assert.equal(exp.display, "/apply https://example.com/job/123");
  assert.match(
    exp.prompt,
    /Job posting \(URL or pasted job description\): https:\/\/example\.com\/job\/123/,
  );
  assert.doesNotMatch(exp.prompt, /Additional context from me/);
});

test("/find-refs expands to the find_references workflow", () => {
  const exp = expandSlashCommand("/find-refs attention mechanisms in transformers");
  assert.ok(exp);
  assert.match(exp.prompt, /find_references/);
  assert.match(exp.prompt, /NEVER write a \.bib/);
  assert.match(exp.prompt, /EXACTLY as the\s+tool returned it/);
  assert.match(
    exp.prompt,
    /What to find a source for \(topic, claim, or title fragment\): attention mechanisms in transformers/,
  );
});

test("/review expands to a plan-first proofread", () => {
  const exp = expandSlashCommand("/review");
  assert.ok(exp);
  assert.match(exp.prompt, /REVIEW AND PLANNING\s+ONLY/);
  assert.match(exp.prompt, /do NOT call edit_document/);
  assert.match(exp.prompt, /NUMBERED list of concrete\s+findings/);
  assert.match(exp.prompt, /Never change technical meaning/);
});

test("/check-submission expands to a plan-first compliance check", () => {
  const exp = expandSlashCommand("/check-submission NeurIPS 2026, 9 pages excl. refs");
  assert.ok(exp);
  assert.match(exp.prompt, /CHECKING AND PLANNING\s+ONLY/);
  assert.match(exp.prompt, /view_pdf/);
  assert.match(exp.prompt, /anonymization/);
  assert.match(exp.prompt, /Venue and its rules[^:]*: NeurIPS 2026, 9 pages excl\. refs/);
});

test("unknown commands and plain text pass through as null", () => {
  assert.equal(expandSlashCommand("/unknown-cmd"), null);
  assert.equal(expandSlashCommand("fix the intro"), null);
  assert.equal(expandSlashCommand("use a/b testing"), null);
});

test("matchSlashCommands offers commands while the name is being typed", () => {
  assert.ok(matchSlashCommands("/").some((c) => c.name === "check-bibtex"));
  assert.ok(matchSlashCommands("/").some((c) => c.name === "apply"));
  assert.ok(matchSlashCommands("/").some((c) => c.name === "find-refs"));
  assert.ok(matchSlashCommands("/").some((c) => c.name === "review"));
  assert.ok(matchSlashCommands("/").some((c) => c.name === "check-submission"));
  assert.equal(matchSlashCommands("/ap").length, 1);
  assert.equal(matchSlashCommands("/ap")[0].name, "apply");
  // "check-" is a shared prefix of check-bibtex and check-submission.
  assert.equal(matchSlashCommands("/che").length, 2);
  assert.equal(matchSlashCommands("/CHE").length, 2);
  assert.equal(matchSlashCommands("/check-b").length, 1);
  assert.equal(matchSlashCommands("/check-bibtex").length, 1);
  assert.equal(matchSlashCommands("/rev")[0].name, "review");
  assert.equal(matchSlashCommands("/fi")[0].name, "find-refs");
});

test("matchSlashCommands closes once the command is complete or off-menu", () => {
  assert.equal(matchSlashCommands("/check-bibtex ").length, 0, "space ends completion");
  assert.equal(matchSlashCommands("/zzz").length, 0);
  assert.equal(matchSlashCommands("plain text").length, 0);
  assert.equal(matchSlashCommands("").length, 0);
});
