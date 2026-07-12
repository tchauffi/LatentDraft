/**
 * Page fetcher for the agent's `fetch_url` tool: fetch one URL and reduce it
 * to readable text (job postings, articles, docs). Best-effort HTML→text with
 * no DOM dependency — good enough for the model to read, not for rendering.
 * Never throws; failures come back as short human-readable messages that tell
 * the model what to do next (typically: ask the user to paste the text).
 */

export interface FetchPageResult {
  /** false when nothing useful was fetched — `text` then explains why. */
  ok: boolean;
  text: string;
}

const MAX_TEXT = 18_000;
const TIMEOUT_MS = 15_000;
/** Below this many extracted chars the page was probably a JS shell/login wall. */
const MIN_USEFUL_CHARS = 200;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/** Decode named + numeric HTML entities that matter for readable text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return m;
      }
    })
    .replace(/&#(\d+);/g, (m, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return m;
      }
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Collapse whitespace: runs of spaces/tabs → one space, 3+ newlines → 2. */
function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Reduce an HTML document to readable plain text. */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  // Block boundaries become line breaks so lists and paragraphs stay readable.
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|ul|ol|table|blockquote|dd|dt)\s*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, "  ");
  s = s.replace(/<[^>]+>/g, " ");
  return collapseWhitespace(decodeEntities(s));
}

function truncatePage(text: string): string {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n… (page text truncated, ${text.length - MAX_TEXT} chars omitted)`;
}

/**
 * Fetch a URL and return its readable text. `fetchFn` is injectable so tests
 * stay offline.
 */
export async function fetchPageText(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<FetchPageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      text: `Not a fetchable URL: "${url}". Provide a full http(s) URL, or paste the page text directly.`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      text: `Not a fetchable URL: "${url}" (only http/https is supported). Provide a full http(s) URL, or paste the page text directly.`,
    };
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    return {
      ok: false,
      text:
        `Fetch failed: ${String(err instanceof Error ? err.message : err)} (URL: ${url}). ` +
        `Ask the user to paste the page text if this persists.`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      text:
        `Fetch failed: HTTP ${res.status} ${res.statusText} for ${url}. The page may require a ` +
        `login or block automated access — ask the user to paste the relevant text ` +
        `(e.g. the job description) instead.`,
    };
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (
    contentType.includes("pdf") ||
    /^(image|audio|video)\//.test(contentType) ||
    contentType.includes("octet-stream")
  ) {
    return {
      ok: false,
      text: `The URL returned ${contentType}, not a text page. Ask the user to paste the text content instead.`,
    };
  }

  let text: string;
  try {
    const body = await res.text();
    text =
      contentType.includes("html") || contentType.includes("xml") || contentType === ""
        ? htmlToText(body)
        : collapseWhitespace(body);
  } catch (err) {
    return {
      ok: false,
      text: `Fetch failed: could not read the response body (${String(err)}). Ask the user to paste the page text.`,
    };
  }

  const finalUrl = res.url || url;
  if (text.length < MIN_USEFUL_CHARS) {
    return {
      ok: false,
      text:
        `Page text from ${finalUrl} (${text.length} chars):\n\n${text}\n\n` +
        `(Very little text could be extracted — the page is probably rendered with JavaScript ` +
        `or behind a login wall. Ask the user to paste the content, e.g. the job description text.)`,
    };
  }
  return {
    ok: true,
    text: `Page text from ${finalUrl} (${text.length} chars):\n\n${truncatePage(text)}`,
  };
}
