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

test("unknown commands and plain text pass through as null", () => {
  assert.equal(expandSlashCommand("/unknown-cmd"), null);
  assert.equal(expandSlashCommand("fix the intro"), null);
  assert.equal(expandSlashCommand("use a/b testing"), null);
});

test("matchSlashCommands offers commands while the name is being typed", () => {
  assert.ok(matchSlashCommands("/").some((c) => c.name === "check-bibtex"));
  assert.equal(matchSlashCommands("/che").length, 1);
  assert.equal(matchSlashCommands("/CHE").length, 1);
  assert.equal(matchSlashCommands("/check-bibtex").length, 1);
});

test("matchSlashCommands closes once the command is complete or off-menu", () => {
  assert.equal(matchSlashCommands("/check-bibtex ").length, 0, "space ends completion");
  assert.equal(matchSlashCommands("/zzz").length, 0);
  assert.equal(matchSlashCommands("plain text").length, 0);
  assert.equal(matchSlashCommands("").length, 0);
});
