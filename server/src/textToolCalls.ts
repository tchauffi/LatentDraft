/**
 * Recovery of tool calls that the model wrote as TEXT instead of using native
 * function calling. Small local models (Ollama 7–9B) routinely do this — they
 * print `{"name": "edit_document", "arguments": {…}}`, a <tool_call> tag, or a
 * fenced ```json block into their reply. Without recovery the agent "answers"
 * but never edits or compiles anything.
 *
 * ToolCallStreamFilter sits between the model's text deltas and the client:
 * it streams ordinary prose through immediately, withholds anything that looks
 * like a tool-call payload (and <think> reasoning), and hands back the parsed
 * calls at the end of the round so chat.ts can execute them for real.
 */

export interface RecoveredToolCall {
  name: string;
  args: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Name + argument normalization (shared with experimental_repairToolCall) */
/* ------------------------------------------------------------------ */

/** Map an exact, aliased, or hallucinated tool name onto the real tool set. */
export function normalizeToolName(raw: string, known: ReadonlySet<string>): string | undefined {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  if (known.has(name)) return name;
  const has = (n: string) => (known.has(n) ? n : undefined);
  if (/ats/.test(name)) return has("ats_check");
  if (/pdf|preview|render|screenshot|look/.test(name)) return has("view_pdf");
  if (/read|show|cat|inspect/.test(name)) return has("read_document");
  if (/edit|write|replace|update|modify|insert|patch|apply|create|compose/.test(name)) return has("edit_document");
  if (/bib|cit/.test(name)) return has("check_bibtex");
  if (/compile|build|check|verify/.test(name)) return has("compile_check");
  if (/python|execute|run_|script|calc/.test(name)) return has("run_python");
  if (/fetch|url|scrape|crawl|visit|open_?page|get_?page|web_?page/.test(name)) return has("fetch_url");
  if (/search|google|browse|bing|duckduck|web|lookup/.test(name)) return has("web_search");
  return undefined;
}

/** Remap commonly-aliased argument keys onto each tool's real schema. */
export function normalizeToolArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  switch (name) {
    case "edit_document": {
      const new_string =
        str(args.new_string) ?? str(args.newString) ?? str(args.new_text) ?? str(args.content) ??
        str(args.text) ?? str(args.new) ?? str(args.replacement) ?? str(args.value);
      const old_string =
        str(args.old_string) ?? str(args.oldString) ?? str(args.old_text) ?? str(args.old) ??
        str(args.search) ?? str(args.target);
      const explanation =
        str(args.explanation) ?? str(args.description) ?? str(args.reason) ?? "Update the document";
      const out: Record<string, unknown> = { explanation };
      if (old_string !== undefined) out.old_string = old_string;
      if (new_string !== undefined) out.new_string = new_string;
      return out;
    }
    case "web_search": {
      const query = str(args.query) ?? str(args.q) ?? str(args.input) ?? str(args.text) ?? str(args.search);
      const out: Record<string, unknown> = {};
      if (query !== undefined) out.query = query;
      if (typeof args.max_results === "number") out.max_results = args.max_results;
      return out;
    }
    case "run_python": {
      const code = str(args.code) ?? str(args.python) ?? str(args.script) ?? str(args.source);
      return code !== undefined ? { code } : {};
    }
    case "fetch_url": {
      const url =
        str(args.url) ?? str(args.link) ?? str(args.href) ?? str(args.uri) ??
        str(args.address) ?? str(args.page);
      return url !== undefined ? { url } : {};
    }
    case "view_pdf":
      return typeof args.max_pages === "number" ? { max_pages: args.max_pages } : {};
    case "ats_check": {
      const jd = str(args.job_description) ?? str(args.job) ?? str(args.jd) ?? str(args.description);
      return jd !== undefined ? { job_description: jd } : {};
    }
    default:
      return args;
  }
}

/** The argument a tool cannot run without (used to reject unusable repairs). */
export function hasRequiredArgs(name: string, args: Record<string, unknown>): boolean {
  switch (name) {
    case "edit_document":
      return typeof args.new_string === "string";
    case "web_search":
      return typeof args.query === "string";
    case "run_python":
      return typeof args.code === "string";
    case "fetch_url":
      return typeof args.url === "string";
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* Parsing tool-call payloads out of plain text                        */
/* ------------------------------------------------------------------ */

/** Index just past a balanced top-level {…} starting at `start`, or -1. */
export function scanBalancedJson(s: string, start = 0): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Interpret a parsed JSON object as a tool call. Accepts the shapes local
 * models actually produce: {name, arguments}, {name, parameters}, OpenAI's
 * {type:"function", function:{…}}, Anthropic's {type:"tool_use", name, input},
 * ReAct's {action, action_input}, and args inlined next to the name.
 */
export function coerceToolCall(
  obj: unknown,
  known: ReadonlySet<string>,
): RecoveredToolCall | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
  const o = obj as Record<string, unknown>;
  if (o.function && typeof o.function === "object" && !Array.isArray(o.function)) {
    return coerceToolCall(o.function, known);
  }
  const rawName = [o.name, o.tool, o.tool_name, o.function_name, o.action].find(
    (v): v is string => typeof v === "string",
  );
  if (!rawName) return undefined;
  const name = normalizeToolName(rawName, known);
  if (!name) return undefined;

  let rawArgs: unknown =
    o.arguments ?? o.parameters ?? o.params ?? o.args ?? o.input ?? o.action_input ?? o.tool_input;
  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      rawArgs = undefined;
    }
  }
  let args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : undefined;
  if (!args) {
    // Args inlined beside the name: {"name": "edit_document", "new_string": …}
    const { name: _n, tool: _t, tool_name: _tn, function_name: _fn, action: _a, type: _ty, ...rest } = o;
    args = rest;
  }
  return { name, args: normalizeToolArgs(name, args) };
}

/** Pull every tool-call JSON object out of a blob of text. */
export function extractCallsFromText(
  text: string,
  known: ReadonlySet<string>,
): { calls: RecoveredToolCall[]; leftover: string } {
  const calls: RecoveredToolCall[] = [];
  let leftover = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "{") {
      const end = scanBalancedJson(text, i);
      if (end !== -1) {
        try {
          const call = coerceToolCall(JSON.parse(text.slice(i, end)), known);
          if (call) {
            calls.push(call);
            i = end;
            continue;
          }
        } catch {
          /* not JSON — fall through */
        }
      }
    }
    leftover += text[i];
    i++;
  }
  return { calls, leftover };
}

/** Index just past a balanced (…) starting at `start`, or -1. */
export function scanBalancedParens(s: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Where a bare string/number argument lands for each tool, e.g. web_search("x"). */
const PRIMARY_ARG: Record<string, string> = {
  web_search: "query",
  fetch_url: "url",
  run_python: "code",
  ats_check: "job_description",
  view_pdf: "max_pages",
};

/**
 * Interpret the inside of a `tool_name(…)` call written as text. Accepts an
 * empty argument list, a JSON object, a single quoted string / number (mapped
 * to the tool's primary argument), or python-style key=value pairs.
 * Returns undefined when the content is not a usable argument list (e.g. the
 * model was just quoting a signature like `web_search(query, max_results?)`).
 */
export function parseCallArgs(name: string, inner: string): Record<string, unknown> | undefined {
  const t = inner.trim();
  if (t === "") return {};
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return undefined;
  }
  const primary = PRIMARY_ARG[name];
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) {
    try {
      return primary ? { [primary]: JSON.parse(t) } : undefined;
    } catch {
      return undefined;
    }
  }
  if (/^'(?:[^'\\]|\\.)*'$/.test(t)) {
    return primary ? { [primary]: t.slice(1, -1).replace(/\\(['"\\])/g, "$1") } : undefined;
  }
  if (/^\d+$/.test(t)) return primary ? { [primary]: Number(t) } : undefined;
  // key=value pairs: query="latex", max_results=3
  const kw: Record<string, unknown> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(t)) !== null) {
    const raw = m[2];
    try {
      kw[m[1]] =
        raw.startsWith('"') ? JSON.parse(raw)
        : raw.startsWith("'") ? raw.slice(1, -1).replace(/\\(['"\\])/g, "$1")
        : Number(raw);
    } catch {
      return undefined;
    }
    consumed += m[0].length;
  }
  if (Object.keys(kw).length === 0) return undefined;
  // Reject if the pairs only cover a small part of the content (likely prose).
  if (consumed < t.length * 0.6) return undefined;
  return kw;
}

/* ------------------------------------------------------------------ */
/* Streaming filter                                                    */
/* ------------------------------------------------------------------ */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const TAG_OPEN = "<tool_call>";
const TAG_CLOSE = "</tool_call>";
const FENCE = "```";

/** First JSON keys that can plausibly start a tool-call object. */
const CALL_KEYS = ["name", "tool", "tool_name", "function", "function_name", "action", "type"];
const isCallKey = (k: string) => CALL_KEYS.includes(k);
const isCallKeyPrefix = (p: string) => CALL_KEYS.some((k) => k.startsWith(p));

/** Fence languages that usually wrap tool-call JSON (held + parsed). */
const TOOL_FENCE_LANGS = new Set(["", "json", "tool_call", "tool_code", "tool", "function_call"]);

type Mode = "text" | "think" | "tooltag" | "fence" | "fencepass" | "json" | "call" | "suppress";

interface Trigger {
  index: number;
  mode: Mode;
}

function findTrigger(
  s: string,
  callRegex: RegExp | undefined,
  suppress: readonly string[],
): Trigger | undefined {
  const candidates: Trigger[] = [];
  const think = s.indexOf(THINK_OPEN);
  if (think !== -1) candidates.push({ index: think, mode: "think" });
  const tag = s.indexOf(TAG_OPEN);
  if (tag !== -1) candidates.push({ index: tag, mode: "tooltag" });
  const fence = s.indexOf(FENCE);
  if (fence !== -1) candidates.push({ index: fence, mode: "fence" });
  const json = /\{\s*"/.exec(s);
  if (json) candidates.push({ index: json.index, mode: "json" });
  if (callRegex) {
    callRegex.lastIndex = 0;
    const call = callRegex.exec(s);
    if (call) candidates.push({ index: call.index + call[1].length, mode: "call" });
  }
  for (const sup of suppress) {
    const idx = s.indexOf(sup);
    if (idx !== -1) candidates.push({ index: idx, mode: "suppress" });
  }
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.index < a.index ? b : a));
}

/** How many trailing chars might be the start of a trigger and must be held. */
function tailHoldLen(s: string, names: readonly string[], suppress: readonly string[]): number {
  let hold = 0;
  const max = Math.min(s.length, 64);
  for (let n = max; n > 0; n--) {
    const tail = s.slice(s.length - n);
    if (TAG_OPEN.startsWith(tail) || THINK_OPEN.startsWith(tail) || FENCE.startsWith(tail)) {
      hold = n;
      break;
    }
    const json = /^\{\s*(?:"([a-zA-Z_]*)?)?$/.exec(tail);
    if (json && isCallKeyPrefix(json[1] ?? "")) {
      hold = n;
      break;
    }
    // Possible start of `tool_name(` — only at a word boundary.
    const word = /^([a-zA-Z_]+)\s*$/.exec(tail);
    if (
      word &&
      (s.length === n || /[^a-zA-Z0-9_]/.test(s[s.length - n - 1])) &&
      names.some((nm) => nm === word[1] || (word[1].length < nm.length && nm.startsWith(word[1])))
    ) {
      hold = n;
      break;
    }
  }
  // Suppressed strings can be longer than the generic 64-char window.
  for (const sup of suppress) {
    const cap = Math.min(s.length, sup.length - 1);
    for (let n = cap; n > hold; n--) {
      if (sup.startsWith(s.slice(s.length - n))) {
        hold = n;
        break;
      }
    }
  }
  return hold;
}

/**
 * Streaming text filter: pass prose through, swallow <think> blocks, and
 * capture tool calls written as text. Feed deltas with push(); call finish()
 * at end of stream to flush and collect the recovered calls.
 */
export class ToolCallStreamFilter {
  private buf = "";
  private emitted = "";
  private calls: RecoveredToolCall[] = [];
  private mode: Mode = "text";
  private names: readonly string[];
  /** Matches `tool_name(` at a word boundary, capturing the boundary prefix. */
  private callRegex: RegExp | undefined;

  constructor(
    private known: ReadonlySet<string>,
    private out: (text: string) => void,
    /** Literal strings to drop from the output — e.g. our own loop-feedback
     * boilerplate, which small models love to echo back verbatim. */
    private suppress: readonly string[] = [],
  ) {
    this.names = [...known];
    this.callRegex = this.names.length
      ? new RegExp(`(^|[^a-zA-Z0-9_])(?:${this.names.join("|")})\\s*\\(`, "g")
      : undefined;
  }

  push(delta: string): void {
    this.buf += delta;
    this.drain(false);
  }

  finish(): { text: string; calls: RecoveredToolCall[] } {
    this.drain(true);
    return { text: this.emitted, calls: this.calls };
  }

  private emit(s: string): void {
    if (!s) return;
    this.emitted += s;
    this.out(s);
  }

  private drain(final: boolean): void {
    // Every iteration either consumes input, changes mode, or returns.
    for (;;) {
      switch (this.mode) {
        case "text": {
          const trig = findTrigger(this.buf, this.callRegex, this.suppress);
          const hold = final ? 0 : tailHoldLen(this.buf, this.names, this.suppress);
          const holdStart = this.buf.length - hold;
          // A trigger inside a held tail is not actionable yet: the tail may
          // still complete into a suppressed string (whose own JSON example
          // would otherwise fire the json trigger first).
          if (!trig || holdStart <= trig.index) {
            this.emit(this.buf.slice(0, holdStart));
            this.buf = this.buf.slice(holdStart);
            return;
          }
          this.emit(this.buf.slice(0, trig.index));
          this.buf = this.buf.slice(trig.index);
          this.mode = trig.mode;
          break;
        }

        case "suppress": {
          // buf starts with one of the suppressed strings — drop it.
          const sup = this.suppress.find((s) => this.buf.startsWith(s));
          if (!sup) {
            this.emit(this.buf[0] ?? "");
            this.buf = this.buf.slice(1);
          } else {
            this.buf = this.buf.slice(sup.length);
          }
          this.mode = "text";
          break;
        }

        case "think": {
          const end = this.buf.indexOf(THINK_CLOSE);
          if (end === -1) {
            if (final) this.buf = ""; // drop unterminated reasoning
            return;
          }
          this.buf = this.buf.slice(end + THINK_CLOSE.length);
          this.mode = "text";
          break;
        }

        case "tooltag": {
          const end = this.buf.indexOf(TAG_CLOSE);
          if (end === -1 && !final) return;
          const inner =
            end === -1 ? this.buf.slice(TAG_OPEN.length) : this.buf.slice(TAG_OPEN.length, end);
          this.buf = end === -1 ? "" : this.buf.slice(end + TAG_CLOSE.length);
          const found = extractCallsFromText(inner, this.known);
          if (found.calls.length) this.calls.push(...found.calls);
          else this.emit(inner); // wasn't a tool call after all — show it
          this.mode = "text";
          break;
        }

        case "fence": {
          const open = /^```([^\n`]*)\r?\n/.exec(this.buf);
          if (!open) {
            if (!final && !this.buf.includes("\n") && this.buf.length < 80) return; // wait for the info line
            // No plain info line (inline/odd fence) — emit the backticks and rescan.
            this.emit(FENCE);
            this.buf = this.buf.slice(FENCE.length);
            this.mode = "text";
            break;
          }
          const lang = open[1].trim().toLowerCase();
          if (!TOOL_FENCE_LANGS.has(lang)) {
            // Ordinary code block — stream it through untouched.
            this.emit(open[0]);
            this.buf = this.buf.slice(open[0].length);
            this.mode = "fencepass";
            break;
          }
          const close = this.buf.indexOf("\n" + FENCE, open[0].length - 1);
          if (close === -1 && !final) return;
          const inner = close === -1 ? this.buf.slice(open[0].length) : this.buf.slice(open[0].length, close);
          const after = close === -1 ? "" : this.buf.slice(close + 1 + FENCE.length);
          const found = extractCallsFromText(inner, this.known);
          if (found.calls.length && found.leftover.replace(/[\s,]/g, "") === "") {
            this.calls.push(...found.calls);
            this.buf = after;
          } else {
            // Fence held but not a tool call — emit it verbatim.
            const originalEnd = close === -1 ? this.buf.length : close + 1 + FENCE.length;
            this.emit(this.buf.slice(0, originalEnd));
            this.buf = this.buf.slice(originalEnd);
          }
          this.mode = "text";
          break;
        }

        case "fencepass": {
          const close = this.buf.indexOf("\n" + FENCE);
          if (close === -1) {
            const cut = final ? this.buf.length : Math.max(0, this.buf.length - FENCE.length - 1);
            this.emit(this.buf.slice(0, cut));
            this.buf = this.buf.slice(cut);
            if (final) this.mode = "text";
            return;
          }
          const end = close + 1 + FENCE.length;
          this.emit(this.buf.slice(0, end));
          this.buf = this.buf.slice(end);
          this.mode = "text";
          break;
        }

        case "json": {
          const key = /^\{\s*"([^"]*)"\s*:/.exec(this.buf);
          if (!key) {
            if (!final) {
              const partial = /^\{\s*(?:"([^"]*)"?)?$/.exec(this.buf);
              if (partial && isCallKeyPrefix(partial[1] ?? "")) return; // wait for more
            }
            // First key can't start a tool call — release the brace and rescan.
            this.emit(this.buf[0]);
            this.buf = this.buf.slice(1);
            this.mode = "text";
            break;
          }
          if (!isCallKey(key[1])) {
            this.emit(this.buf[0]);
            this.buf = this.buf.slice(1);
            this.mode = "text";
            break;
          }
          const end = scanBalancedJson(this.buf);
          if (end === -1) {
            if (!final) return; // object still streaming in
            // Stream ended mid-object: an unterminated tool call is garbage to
            // the user and unsafe to execute — drop it rather than showing it.
            this.buf = "";
            this.mode = "text";
            return;
          }
          const candidate = this.buf.slice(0, end);
          let call: RecoveredToolCall | undefined;
          try {
            call = coerceToolCall(JSON.parse(candidate), this.known);
          } catch {
            /* invalid JSON */
          }
          if (call) this.calls.push(call);
          else this.emit(candidate);
          this.buf = this.buf.slice(end);
          this.mode = "text";
          break;
        }

        case "call": {
          // buf starts at a known tool name followed by '('.
          const head = /^([a-zA-Z_]+)\s*\(/.exec(this.buf);
          if (!head) {
            this.emit(this.buf[0] ?? "");
            this.buf = this.buf.slice(1);
            this.mode = "text";
            break;
          }
          const openIdx = head[0].length - 1;
          const end = scanBalancedParens(this.buf, openIdx);
          if (end === -1) {
            if (!final) return; // arguments still streaming in
            // Unterminated call at end of stream — drop it (see json mode).
            this.buf = "";
            this.mode = "text";
            return;
          }
          const name = normalizeToolName(head[1], this.known);
          const args = name ? parseCallArgs(name, this.buf.slice(openIdx + 1, end - 1)) : undefined;
          if (name && args) {
            this.calls.push({ name, args: normalizeToolArgs(name, args) });
          } else {
            // Just prose quoting a signature — emit verbatim.
            this.emit(this.buf.slice(0, end));
          }
          this.buf = this.buf.slice(end);
          this.mode = "text";
          break;
        }
      }
    }
  }
}
