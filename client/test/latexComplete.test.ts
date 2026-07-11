import { test } from "node:test";
import assert from "node:assert/strict";
import { bibKeys, labels, targetsFor } from "../src/lib/latexComplete";

const FILES = {
  "main.tex": "\\section{Intro}\\label{sec:intro}\nSee \\eqref{eq:quad}.\n\\begin{equation}\\label{eq:quad}x\\end{equation}",
  "sections/method.tex": "\\label{sec:method}",
  "refs.bib": "@article{shannon1948,\n  title={X}\n}\n@book{ knuth1984 , title={Y}}\n@misc{no-comma-yet",
  "notes.txt": "\\label{not-a-tex-label} @article{not-a-bib,",
};

test("bibKeys extracts keys from .bib buffers only", () => {
  assert.deepEqual(bibKeys(FILES), ["knuth1984", "shannon1948"]);
});

test("labels extracts \\label targets from .tex buffers only", () => {
  assert.deepEqual(labels(FILES), ["eq:quad", "sec:intro", "sec:method"]);
});

test("targetsFor routes commands to the right sources", () => {
  const all = ["main.tex", "sections/method.tex", "refs.bib", "figure.png", "plot.pdf", "data.csv"];
  assert.deepEqual(targetsFor("cite", FILES, all), ["knuth1984", "shannon1948"]);
  assert.deepEqual(targetsFor("ref", FILES, all), ["eq:quad", "sec:intro", "sec:method"]);
  assert.deepEqual(targetsFor("input", FILES, all), ["sections/method"]);
  assert.deepEqual(targetsFor("includegraphics", FILES, all), ["figure.png", "plot.pdf"]);
  assert.deepEqual(targetsFor("bibliography", FILES, all), ["refs"]);
  assert.ok(targetsFor("begin", FILES, all).includes("equation"));
  assert.ok(targetsFor("usepackage", FILES, all).includes("amsmath"));
  assert.deepEqual(targetsFor("textbf", FILES, all), []);
});
