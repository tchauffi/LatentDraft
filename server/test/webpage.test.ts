import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, fetchPageText } from "../src/webpage.js";

/** Fake fetch that returns a canned Response and records its calls. */
function fakeFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const calls: string[] = [];
  const fn = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(body, {
      status: init.status ?? 200,
      headers: { "content-type": init.contentType ?? "text/html; charset=utf-8" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

describe("htmlToText", () => {
  test("strips script/style/head content and comments", () => {
    const text = htmlToText(
      "<head><title>t</title></head><body><script>var hidden = 1;</script>" +
        "<style>.x{color:red}</style><!-- secret --><p>Visible text</p></body>",
    );
    assert.equal(text.includes("hidden"), false);
    assert.equal(text.includes("color"), false);
    assert.equal(text.includes("secret"), false);
    assert.ok(text.includes("Visible text"));
  });

  test("block tags become line breaks", () => {
    const text = htmlToText("<p>First</p><ul><li>one</li><li>two</li></ul>Line<br>Break");
    const lines = text.split("\n").map((l) => l.trim());
    assert.ok(lines.includes("First"));
    assert.ok(lines.includes("one"));
    assert.ok(lines.includes("two"));
    assert.ok(lines.includes("Line"));
    assert.ok(lines.includes("Break"));
  });

  test("decodes named and numeric entities", () => {
    assert.equal(htmlToText("R&amp;D &#8211; ML &amp; AI, O&#x27;Brien&nbsp;here"), "R&D – ML & AI, O'Brien here");
  });

  test("collapses whitespace runs and excess blank lines", () => {
    const text = htmlToText("<p>a   b</p>\n\n\n\n<p>c</p>");
    assert.equal(text, "a b\n\nc");
  });
});

describe("fetchPageText", () => {
  const JOB_HTML =
    "<html><head><script>analytics()</script></head><body>" +
    "<h1>Senior LaTeX Engineer</h1>" +
    "<p>We are hiring a Senior LaTeX Engineer to join our documentation platform team. " +
    "You will own the typesetting pipeline end to end and mentor junior engineers.</p>" +
    "<ul><li>5+ years TeX experience</li><li>Strong TypeScript skills</li></ul>" +
    "<p>We offer remote work, a learning budget, and a friendly team that cares about " +
    "documentation quality and reproducible builds across all our products.</p>" +
    "</body></html>";

  test("returns readable text with the URL header on success", async () => {
    const { fn } = fakeFetch(JOB_HTML);
    const res = await fetchPageText("https://example.com/job", fn);
    assert.equal(res.ok, true);
    assert.ok(res.text.startsWith("Page text from https://example.com/job"));
    assert.ok(res.text.includes("Senior LaTeX Engineer"));
    assert.ok(res.text.includes("5+ years TeX experience"));
    assert.equal(res.text.includes("<"), false);
    assert.equal(res.text.includes("analytics"), false);
  });

  test("HTTP error suggests pasting the text and never throws", async () => {
    const { fn } = fakeFetch("Forbidden", { status: 403 });
    const res = await fetchPageText("https://example.com/job", fn);
    assert.equal(res.ok, false);
    assert.match(res.text, /HTTP 403/);
    assert.match(res.text, /paste/i);
  });

  test("network failure is reported, not thrown", async () => {
    const fn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND example.com");
    }) as typeof fetch;
    const res = await fetchPageText("https://example.com/job", fn);
    assert.equal(res.ok, false);
    assert.match(res.text, /Fetch failed/);
    assert.match(res.text, /ENOTFOUND/);
  });

  test("non-text content types are rejected with the type named", async () => {
    const { fn } = fakeFetch("%PDF-1.5", { contentType: "application/pdf" });
    const res = await fetchPageText("https://example.com/posting.pdf", fn);
    assert.equal(res.ok, false);
    assert.match(res.text, /application\/pdf/);
  });

  test("plain text bodies pass through without HTML processing", async () => {
    const body = "Role: Engineer <senior>\n".repeat(20);
    const { fn } = fakeFetch(body, { contentType: "text/plain" });
    const res = await fetchPageText("https://example.com/job.txt", fn);
    assert.equal(res.ok, true);
    // Angle brackets survive: plain text is not stripped as HTML.
    assert.ok(res.text.includes("<senior>"));
  });

  test("long pages are truncated with a notice", async () => {
    const { fn } = fakeFetch(`<p>${"word ".repeat(10_000)}</p>`);
    const res = await fetchPageText("https://example.com/long", fn);
    assert.equal(res.ok, true);
    assert.match(res.text, /page text truncated, \d+ chars omitted/);
    assert.ok(res.text.length < 19_000);
  });

  test("invalid or non-http URLs are rejected without calling fetch", async () => {
    for (const url of ["not a url", "ftp://example.com/x", "javascript:alert(1)"]) {
      const { fn, calls } = fakeFetch(JOB_HTML);
      const res = await fetchPageText(url, fn);
      assert.equal(res.ok, false, url);
      assert.match(res.text, /paste the page text/i);
      assert.equal(calls.length, 0, url);
    }
  });

  test("near-empty pages get the login-wall / JS-rendered hint", async () => {
    const { fn } = fakeFetch("<html><body><div id='app'></div></body></html>");
    const res = await fetchPageText("https://example.com/spa-job", fn);
    assert.equal(res.ok, false);
    assert.match(res.text, /JavaScript|login wall/);
    assert.match(res.text, /paste/i);
  });
});
