/**
 * Lightweight web search for the agent's `web_search` tool.
 *
 * Provider is chosen from the environment, best-first:
 *   - TAVILY_API_KEY  -> Tavily (clean, LLM-oriented results)
 *   - BRAVE_API_KEY   -> Brave Search API
 *   - (none)          -> DuckDuckGo HTML endpoint, best-effort, no key required
 *
 * Always returns a compact, model-readable string (title + url + snippet per
 * result) or a short human-readable error — it never throws.
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

function fmt(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => {
      const snippet = r.snippet ? `\n   ${r.snippet.replace(/\s+/g, " ").trim()}` : "";
      return `${i + 1}. ${r.title || "(untitled)"}\n   ${r.url}${snippet}`;
    })
    .join("\n\n");
}

async function tavily(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: maxResults,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: { title?: string; url?: string; content?: string }[];
  };
  return (data.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

async function brave(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(
    query,
  )}&count=${maxResults}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_API_KEY ?? "" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

/** Decode the handful of HTML entities that show up in DuckDuckGo result text. */
function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

async function duckduckgo(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  const results: SearchResult[] = [];
  // Each result anchor: <a ... class="result__a" href="...">Title</a>
  const linkRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(decodeEntities(sm[1]));

  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null && results.length < maxResults) {
    let href = m[1];
    // DuckDuckGo wraps targets in a redirect: //duckduckgo.com/l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) href = decodeURIComponent(uddg[1]);
    results.push({ title: decodeEntities(m[2]), url: href, snippet: snippets[i] ?? "" });
    i++;
  }
  return results;
}

export async function webSearch(query: string, maxResults = 5): Promise<string> {
  const n = Math.min(Math.max(maxResults, 1), 10);
  try {
    let results: SearchResult[];
    let provider: string;
    if (TAVILY_API_KEY) {
      provider = "Tavily";
      results = await tavily(query, n);
    } else if (BRAVE_API_KEY) {
      provider = "Brave";
      results = await brave(query, n);
    } else {
      provider = "DuckDuckGo";
      results = await duckduckgo(query, n);
    }
    return `Web search results for "${query}" (via ${provider}):\n\n${fmt(results)}`;
  } catch (err) {
    return `Web search failed: ${String(
      err instanceof Error ? err.message : err,
    )}. (Set TAVILY_API_KEY or BRAVE_API_KEY for a more reliable search provider.)`;
  }
}
