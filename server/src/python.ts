import { spawn } from "node:child_process";
import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "./compile.js";
import {
  BOOTSTRAP_FILE,
  MAX_FILE_MB,
  MEM_MB,
  PYTHON_BIN,
  SANDBOX_MODE,
  SCRIPT_FILE,
  TIMEOUT_MS,
  bootstrapSource,
  buildPythonSpawn,
  describeSandbox,
  ensureSandboxDirs,
  resolveSandbox,
} from "./sandbox.js";

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

/** Our own scratch files — never reported to the model as generated output. */
const INTERNAL_FILES = new Set([SCRIPT_FILE, BOOTSTRAP_FILE]);

/**
 * Run a Python snippet in the session's working directory (the same directory
 * Tectonic compiles in), so any figure it writes — e.g. matplotlib saving
 * `figure.png` — can be pulled into the document with `\includegraphics`.
 * The snippet is confined (see sandbox.ts): no network, no filesystem outside
 * that directory, bounded memory/CPU/output size. Matplotlib is forced onto
 * the headless Agg backend.
 */
export async function runPython(sessionId: string, code: string): Promise<PythonResult> {
  return runPythonIn(sessionDir(sessionId), code);
}

/** Same, but in an explicit working directory (a project dir). */
export async function runPythonIn(dir: string, code: string): Promise<PythonResult> {
  await mkdir(dir, { recursive: true });
  await ensureSandboxDirs();

  const sandbox = await resolveSandbox();
  if (sandbox.kind === "none" && SANDBOX_MODE === "strict") {
    return {
      ok: false,
      output:
        `run_python is disabled: PYTHON_SANDBOX=strict requires an OS sandbox, and ${sandbox.reason}. ` +
        `Install one, or set PYTHON_SANDBOX=auto to run with in-process limits only.`,
      createdFiles: [],
    };
  }

  const before = await snapshot(dir);
  // The snippet goes in a file of its own, run via runpy from the bootstrap, so
  // tracebacks report ITS line numbers rather than bootstrap-shifted ones.
  await writeFile(path.join(dir, SCRIPT_FILE), code, "utf8");
  await writeFile(path.join(dir, BOOTSTRAP_FILE), bootstrapSource(sandbox.kind, dir), "utf8");

  const spec = buildPythonSpawn(sandbox.kind, dir, [BOOTSTRAP_FILE]);

  return new Promise<PythonResult>((resolve) => {
    let out = "";
    let timedOut = false;
    let child;
    try {
      // Own process group: a timeout kills whatever the snippet spawned too.
      child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true });
    } catch (err) {
      resolve({
        ok: false,
        output: `Failed to launch Python (${spec.file}): ${String(err)}`,
        createdFiles: [],
      });
      return;
    }

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      out += `\n[killed: exceeded ${TIMEOUT_MS / 1000}s time limit]`;
      killTree();
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: `${out}\nPython process error (${spec.file}): ${String(err)}`,
        createdFiles: [],
      });
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      // A limit hit as a signal is otherwise reported as a bare non-zero exit.
      if (signal === "SIGXFSZ") {
        out += `\n[killed: wrote a file larger than the ${MAX_FILE_MB} MB limit]`;
      } else if (signal === "SIGXCPU") {
        out += `\n[killed: exceeded the CPU time limit]`;
      } else if (signal === "SIGKILL" && !timedOut) {
        out += `\n[killed: the process was terminated — usually the ${MEM_MB} MB memory limit]`;
      }
      const after = await snapshot(dir);
      const createdFiles = [...after.keys()]
        .filter(
          (name) =>
            !INTERNAL_FILES.has(name) && (!before.has(name) || before.get(name) !== after.get(name)),
        )
        .sort();
      resolve({ ok: code === 0, output: truncate(out.trim()), createdFiles });
    });
  });
}

/** Startup diagnostic: what confinement run_python will actually get. */
export async function pythonSandboxSummary(): Promise<string> {
  const status = await resolveSandbox();
  return `${describeSandbox(status)} [python: ${PYTHON_BIN}]`;
}
