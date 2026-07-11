import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBoxWarnings, formatLayoutReport } from "../src/layout.js";
import { compileTex } from "../src/compile.js";
import { analyzePdfLayout } from "../src/pdftools.js";
import { sessionDir } from "../src/compile.js";
import path from "node:path";

test("parseBoxWarnings extracts Tectonic-style warnings with file:line", () => {
  const log = [
    "note: Running TeX ...",
    "warning: main.tex:23: Overfull \\hbox (15.2pt too wide) in paragraph at lines 23--25",
    "warning: main.tex:41: Underfull \\hbox (badness 10000) in paragraph at lines 41--41",
    "note: Writing `main.xdv'",
  ].join("\n");
  const w = parseBoxWarnings(log);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], {
    kind: "Overfull",
    box: "hbox",
    detail: "15.2pt too wide",
    where: "main.tex:23",
  });
  assert.equal(w[1].kind, "Underfull");
  assert.equal(w[1].where, "main.tex:41");
});

test("parseBoxWarnings handles plain TeX 'at lines' form and vbox", () => {
  const log =
    "Overfull \\vbox (10.0pt too high) detected at line 92\n" +
    "Underfull \\hbox (badness 1234) in paragraph at lines 5--7";
  const w = parseBoxWarnings(log);
  assert.equal(w.length, 2);
  assert.equal(w[0].box, "vbox");
  assert.equal(w[0].where, "line 92");
  assert.equal(w[1].where, "line 5–7");
});

test("formatLayoutReport flags overfull lines and clean layouts", () => {
  const layout = {
    pageCount: 1,
    pageSize: [612, 792] as [number, number],
    pages: [
      {
        page: 1,
        coverage: 0.55,
        margins: { left: 72, top: 72, right: 72, bottom: 72 },
        overflowRight: 0,
        overflowBottom: 0,
        chars: 1500,
        imageCount: 0,
      },
    ],
    fonts: [["LMRoman10-Regular 10.0pt", 0.9] as [string, number]],
  };
  const clean = formatLayoutReport(layout, "no warnings here");
  assert.match(clean, /1 page\(s\), paper: US Letter/);
  assert.match(clean, /No overflow problems detected/);
  assert.match(clean, /LMRoman10-Regular/);

  const dirty = formatLayoutReport(
    layout,
    "warning: main.tex:23: Overfull \\hbox (15.2pt too wide) in paragraph at lines 23--25",
  );
  assert.match(dirty, /Overfull \\hbox/);
  assert.match(dirty, /main\.tex:23/);
  assert.doesNotMatch(dirty, /No overflow problems/);
});

test("analyzePdfLayout measures a real compiled PDF", async () => {
  const tex = `\\documentclass{article}
\\begin{document}
\\section{Hello}
Some regular paragraph text for the layout analyzer to measure.
\\end{document}
`;
  const sessionId = "layout-test";
  const result = await compileTex(sessionId, tex);
  assert.equal(result.ok, true, `compile failed:\n${result.log}`);
  const layout = await analyzePdfLayout(path.join(sessionDir(sessionId), "main.pdf"));
  assert.equal(layout.pageCount, 1);
  assert.equal(layout.pages.length, 1);
  assert.ok(layout.pages[0].chars > 20, "should see the paragraph text");
  assert.ok(layout.pages[0].coverage > 0 && layout.pages[0].coverage < 1);
  assert.ok(layout.pages[0].margins, "margins should be measured");
  assert.ok(layout.fonts.length > 0, "fonts should be detected");
  assert.equal(layout.pages[0].overflowRight, 0);
});
