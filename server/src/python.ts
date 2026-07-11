import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionDir } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

// Prefer the project venv (has matplotlib/numpy), fall back to system python3.
const VENV_PYTHON = path.join(SERVER_ROOT, ".venv", "bin", "python");
const PYTHON_BIN = process.env.PYTHON_BIN ?? VENV_PYTHON;

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8_000;

export interface PythonResult {
  ok: boolean;
  /** Combined stdout+stderr, truncated. */
  output: string;
  /** Files created/modified by the script, relative to the session dir. */
  createdFiles: string[];
}

function truncate(s: string, max = MAX_OUTPUT): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (output truncated, ${s.length - max} more chars)`;
}

/** Snapshot filename -> mtimeMs for a directory (non-recursive). */
async function snapshot(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (name) => {
      try {
        const st = await stat(path.join(dir, name));
        if (st.isFile()) out.set(name, st.mtimeMs);
      } catch {
        /* ignore */
      }
    }),
  );
  return out;
}

/**
 * Run a Python snippet in the session's working directory (the same directory
 * Tectonic compiles in), so any figure it writes — e.g. matplotlib saving
 * `figure.png` — can be pulled into the document with `\includegraphics`.
 * Matplotlib is forced onto the headless Agg backend.
 */
export async function runPython(sessionId: string, code: string): Promise<PythonResult> {
  return runPythonIn(sessionDir(sessionId), code);
}

/** Same, but in an explicit working directory (a project dir). */
export async function runPythonIn(dir: string, code: string): Promise<PythonResult> {
  await mkdir(dir, { recursive: true });
  const before = await snapshot(dir);

  // Force a non-interactive backend before user code runs, regardless of imports.
  const preamble =
    "import os\nos.environ.setdefault('MPLBACKEND', 'Agg')\n" +
    "try:\n    import matplotlib\n    matplotlib.use('Agg')\nexcept Exception:\n    pass\n";
  const scriptPath = path.join(dir, "_agent_script.py");
  await writeFile(scriptPath, preamble + "\n" + code, "utf8");

  return new Promise<PythonResult>((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(PYTHON_BIN, [scriptPath], {
        cwd: dir,
        env: { ...process.env, MPLBACKEND: "Agg" },
      });
    } catch (err) {
      resolve({ ok: false, output: `Failed to launch Python (${PYTHON_BIN}): ${String(err)}`, createdFiles: [] });
      return;
    }

    const timer = setTimeout(() => {
      out += `\n[killed: exceeded ${TIMEOUT_MS / 1000}s time limit]`;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${out}\nPython process error: ${String(err)}`, createdFiles: [] });
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const after = await snapshot(dir);
      const createdFiles = [...after.keys()]
        .filter((name) => name !== "_agent_script.py" && (!before.has(name) || before.get(name) !== after.get(name)))
        .sort();
      resolve({ ok: code === 0, output: truncate(out.trim()), createdFiles });
    });
  });
}
