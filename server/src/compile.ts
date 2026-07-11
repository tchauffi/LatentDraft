import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TMP_ROOT = path.resolve(__dirname, "..", "tmp");

// Prefer the locally-downloaded Tectonic, fall back to PATH.
const LOCAL_TECTONIC = path.join(REPO_ROOT, "bin", "tectonic");
const TECTONIC_BIN = process.env.TECTONIC_BIN ?? LOCAL_TECTONIC;

// Generous: the first-ever compile downloads LaTeX packages over the network.
const COMPILE_TIMEOUT_MS = Number(process.env.COMPILE_TIMEOUT_MS ?? 300_000);

// Session dirs older than this are deleted at startup.
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CompileResult {
  ok: boolean;
  /** PDF bytes when ok; undefined otherwise. */
  pdf?: Buffer;
  /** Combined stdout+stderr from Tectonic (the build log). */
  log: string;
}

/** A sessionId is used as the working-directory name; sanitize to avoid traversal. */
function safeSessionDir(sessionId: string): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
  return path.join(TMP_ROOT, clean);
}

/**
 * The working directory Tectonic compiles in for a given session. Other tools
 * (e.g. run_python generating figures) write here so `\includegraphics{fig}`
 * resolves against the same directory the compiler runs in.
 */
export function sessionDir(sessionId: string): string {
  return safeSessionDir(sessionId);
}

/**
 * Validate a project-relative file path (e.g. "refs.bib", "sections/intro.tex").
 * Rejects absolute paths, traversal, and unusual characters. Returns the
 * normalized relative path, or undefined if it is not safe to write.
 */
function safeRelPath(name: string): string | undefined {
  if (!/^[a-zA-Z0-9._/-]{1,128}$/.test(name)) return undefined;
  const norm = path.posix.normalize(name);
  if (norm.startsWith("/") || norm.startsWith("..") || norm.includes("/../")) return undefined;
  return norm;
}

/**
 * Write auxiliary project files (bibliographies, \input'd sections, …) into a
 * session's compile directory so Tectonic can resolve them. Unsafe paths are
 * skipped. `main.tex` is skipped too — compileTex owns it.
 */
export async function writeSessionFiles(
  sessionId: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = safeSessionDir(sessionId);
  for (const [name, content] of Object.entries(files)) {
    const rel = safeRelPath(name);
    if (!rel || rel === "main.tex") continue;
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

/** Delete session dirs that have not been touched in SESSION_MAX_AGE_MS. */
export async function cleanupStaleSessions(): Promise<void> {
  let names: string[];
  try {
    names = await readdir(TMP_ROOT);
  } catch {
    return; // no tmp dir yet
  }
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  for (const name of names) {
    const dir = path.join(TMP_ROOT, name);
    try {
      const st = await stat(dir);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
      }
    } catch {
      /* ignore races and permission issues */
    }
  }
}

/**
 * Detect a native engine crash (as opposed to a normal LaTeX error) and return
 * an actionable hint. The most common cause on this setup is the fontawesome5
 * package: at load time it introspects glyph names via \XeTeXglyphname, which
 * aborts Tectonic's XeTeX engine (`free(): invalid pointer`). The classic v4
 * `fontawesome` package does not do this and compiles fine.
 */
function diagnoseCrash(
  log: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  tex: string,
): string | undefined {
  const crashMarkers =
    /free\(\): invalid pointer|double free|corrupted|segmentation fault|core dumped|SIGABRT|SIGSEGV/i;
  const crashed = code === null || signal !== null || crashMarkers.test(log);
  if (!crashed) return undefined;

  const base = `The LaTeX engine (Tectonic) CRASHED${
    signal ? ` with signal ${signal}` : ""
  } — this is an engine abort, not a normal LaTeX error, so re-running the same source will crash again.`;

  if (/fontawesome/i.test(log) || /fontawesome/i.test(tex) || /\.otf\b/i.test(log)) {
    return (
      base +
      " Cause: the fontawesome5 package crashes this system's XeTeX engine (it probes glyph names via \\XeTeXglyphname at load time). Fix: replace \\usepackage{fontawesome5} with \\usepackage{fontawesome} — the classic v4 package compiles fine here and keeps the same \\faXxx icon commands (\\faEnvelope, \\faPhone, \\faGithub, \\faLinkedin, \\faMapMarker, …)."
    );
  }
  return (
    base +
    " It is usually triggered by loading OTF fonts via fontspec/fontawesome on this system. Try removing custom OTF font packages and using standard LaTeX fonts."
  );
}

/**
 * Per-session compile queue. Two Tectonic processes must never run in the same
 * directory at once (they share main.tex/main.pdf), so compiles for a given
 * session are chained; different sessions still compile in parallel.
 */
const sessionQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = sessionQueues.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  sessionQueues.set(key, next);
  // Drop the queue entry once idle so the map doesn't grow forever.
  next.finally(() => {
    if (sessionQueues.get(key) === next) sessionQueues.delete(key);
  });
  return next;
}

export async function compileTex(sessionId: string, tex: string): Promise<CompileResult> {
  const dir = safeSessionDir(sessionId);
  return enqueue(dir, () => compileTexNow(dir, tex));
}

async function compileTexNow(dir: string, tex: string): Promise<CompileResult> {
  await mkdir(dir, { recursive: true });
  const mainPath = path.join(dir, "main.tex");
  await writeFile(mainPath, tex, "utf8");

  const args = [
    "-X",
    "compile",
    "--outdir",
    dir,
    "--keep-logs",
    "main.tex",
  ];

  return new Promise<CompileResult>((resolve) => {
    let log = "";
    let child;
    try {
      child = spawn(TECTONIC_BIN, args, { cwd: dir });
    } catch (err) {
      resolve({ ok: false, log: `Failed to launch Tectonic (${TECTONIC_BIN}): ${String(err)}` });
      return;
    }

    const timer = setTimeout(() => {
      log += `\n[killed: compile exceeded ${Math.round(COMPILE_TIMEOUT_MS / 1000)}s time limit]`;
      child.kill("SIGKILL");
    }, COMPILE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (log += d.toString()));
    child.stderr.on("data", (d) => (log += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, log: `${log}\nTectonic process error: ${String(err)}` });
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const hint = diagnoseCrash(log, code, signal, tex);
      const withHint = (body: string) => (hint ? `${hint}\n\n${body}` : body);
      if (code !== 0) {
        resolve({ ok: false, log: withHint(log || `Tectonic exited with code ${code}`) });
        return;
      }
      try {
        const pdf = await readFile(path.join(dir, "main.pdf"));
        resolve({ ok: true, pdf, log });
      } catch (err) {
        resolve({
          ok: false,
          log: withHint(`${log}\nCompile succeeded but PDF not found: ${String(err)}`),
        });
      }
    });
  });
}
