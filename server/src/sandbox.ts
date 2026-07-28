import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Confinement for `run_python`. The agent decides what code to run, and that
 * decision can be steered by content the agent read (a web page, a fetched job
 * posting, an uploaded file) — so the snippet is treated as untrusted input,
 * not as something the user typed.
 *
 * Layers, strongest first:
 *   - "bwrap"    (Linux): a real OS sandbox — no network, no filesystem beyond
 *                the build directory, its own PID/IPC/UTS namespaces.
 *   - "landlock" (Linux ≥5.13): the kernel LSM the interpreter applies to
 *                itself, no privileges needed — which matters because many
 *                distros (Ubuntu ≥23.10's apparmor_restrict_unprivileged_userns)
 *                block the user namespaces bwrap needs. Reads are allowlisted
 *                to system paths + the build directory, writes to the build
 *                directory, and TCP is denied. UDP is out of Landlock's scope,
 *                so the socket block below covers it.
 *   - "seatbelt" (macOS): sandbox-exec denies network and all writes outside
 *                the build directory. Reads are NOT confined (a `deny default`
 *                profile breaks the Python runtime), so it is third-tier.
 *   - "none":    no OS confinement — only the in-process limits below.
 *
 * Every mode additionally applies, from inside the interpreter: hard rlimits
 * (address space, file size, CPU, core dumps), a socket block when the network
 * is disabled, and an environment stripped of API keys.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

/** Prefer the project venv (has matplotlib/numpy), fall back to system python3. */
const VENV_PYTHON = path.join(SERVER_ROOT, ".venv", "bin", "python");
export const PYTHON_BIN = process.env.PYTHON_BIN ?? VENV_PYTHON;

/** `auto` sandboxes when the OS can, `strict` refuses to run otherwise, `off` disables it. */
export type SandboxMode = "auto" | "strict" | "off";
const RAW_MODE = (process.env.PYTHON_SANDBOX ?? "auto").toLowerCase();
export const SANDBOX_MODE: SandboxMode =
  RAW_MODE === "strict" || RAW_MODE === "off" ? RAW_MODE : "auto";

const truthy = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
/** A limit that is NaN or negative would disable the very thing it limits. */
const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Figures are drawn from local/uploaded data — nothing legitimate needs the network. */
export const ALLOW_NET = truthy(process.env.PYTHON_ALLOW_NET);
export const TIMEOUT_MS = num(process.env.PYTHON_TIMEOUT_MS, 30_000);
export const MEM_MB = num(process.env.PYTHON_MEM_MB, 2048);
export const MAX_FILE_MB = num(process.env.PYTHON_MAX_FILE_MB, 128);

/** The user snippet, verbatim — so tracebacks carry ITS line numbers. */
export const SCRIPT_FILE = "_agent_script.py";
/** The hardening bootstrap that runs the snippet via runpy. */
export const BOOTSTRAP_FILE = "_ld_sandbox.py";
/** Matplotlib's font cache, shared across runs (rebuilding it costs seconds). */
const MPL_CACHE = path.join(SERVER_ROOT, "tmp", "_mplcache");

export type SandboxKind = "bwrap" | "landlock" | "seatbelt" | "none";

/** Read-only system paths the interpreter needs (Landlock allowlist). */
function readPaths(workDir: string): string[] {
  const pythonRoot = path.dirname(path.dirname(PYTHON_BIN));
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib32",
    "/lib64",
    "/etc",
    "/proc",
    "/sys",
    "/opt",
    "/dev",
    "/var/lib/fonts",
    "/var/cache/fontconfig",
    pythonRoot,
    workDir,
  ];
}

/** Everything the snippet is allowed to write to. */
function writePaths(workDir: string): string[] {
  return [workDir, MPL_CACHE, "/tmp", "/dev/null", "/dev/zero", "/dev/full", "/dev/shm", "/dev/pts"];
}

export interface SandboxStatus {
  kind: SandboxKind;
  /** Why confinement is unavailable, when kind is "none". */
  reason?: string;
}

/** Anything key-shaped is kept out of the child: a figure script has no business
 * reading ANTHROPIC_API_KEY, and an exfiltrated key is the worst-case outcome. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|COOKIE|AUTH/i;

/** process.env minus credentials, for the unsandboxed path. */
export function safeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!SECRET_ENV.test(k)) out[k] = v;
  }
  return out;
}

/** Environment the snippet sees inside an OS sandbox: minimal and credential-free. */
function sandboxEnvPairs(workDir: string): Record<string, string> {
  return {
    HOME: "/tmp",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    MPLBACKEND: "Agg",
    MPLCONFIGDIR: MPL_CACHE,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    PWD: workDir,
  };
}

/**
 * bubblewrap arguments: read-only system directories, a tmpfs /tmp, the build
 * directory read-write, and nothing else — no $HOME, no repo source, no
 * network unless PYTHON_ALLOW_NET is set.
 */
function bwrapArgs(workDir: string, pythonArgs: string[]): string[] {
  // .venv/bin/python -> .venv (site-packages live there); /usr/bin/python3 -> /usr.
  const pythonRoot = path.dirname(path.dirname(PYTHON_BIN));
  const args = [
    "--die-with-parent",
    "--new-session", // no controlling terminal to inject keystrokes into
    "--cap-drop",
    "ALL",
    "--unshare-user",
    "--unshare-ipc",
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-cgroup-try",
    ...(ALLOW_NET ? [] : ["--unshare-net"]),
    "--hostname",
    "latentdraft",
    "--clearenv",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // bwrap's minimal /dev has no shm; multiprocessing and joblib need it.
    "--tmpfs",
    "/dev/shm",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/usr",
    "/usr",
    // On merged-/usr distros these are symlinks into /usr; bind them anyway for the rest.
    "--ro-bind-try",
    "/bin",
    "/bin",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib32",
    "/lib32",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/sbin",
    "/sbin",
    // Just the /etc pieces the runtime and fonts need — not the whole directory.
    "--ro-bind-try",
    "/etc/ld.so.cache",
    "/etc/ld.so.cache",
    "--ro-bind-try",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf",
    "--ro-bind-try",
    "/etc/ld.so.conf.d",
    "/etc/ld.so.conf.d",
    "--ro-bind-try",
    "/etc/alternatives",
    "/etc/alternatives",
    "--ro-bind-try",
    "/etc/fonts",
    "/etc/fonts",
    "--ro-bind-try",
    "/etc/localtime",
    "/etc/localtime",
    // OpenBLAS/numpy read CPU topology from here; without it they warn and guess.
    "--ro-bind-try",
    "/sys/devices/system/cpu",
    "/sys/devices/system/cpu",
    ...(ALLOW_NET
      ? [
          "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
          "--ro-bind-try", "/etc/hosts", "/etc/hosts",
          "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
          "--ro-bind-try", "/etc/ssl", "/etc/ssl",
          "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
        ]
      : []),
    "--ro-bind-try",
    pythonRoot,
    pythonRoot,
    "--bind",
    MPL_CACHE,
    MPL_CACHE,
    "--bind",
    workDir,
    workDir,
    "--chdir",
    workDir,
  ];
  for (const [k, v] of Object.entries(sandboxEnvPairs(workDir))) args.push("--setenv", k, v);
  return [...args, "--", PYTHON_BIN, ...pythonArgs];
}

/**
 * macOS seatbelt profile. `(deny default)` cannot be used — the Python runtime
 * needs to read frameworks, dyld caches and the venv all over the disk — so
 * this confines what actually causes damage: writes and network.
 */
function seatbeltProfile(workDir: string): string {
  const paths = [workDir, "/tmp", "/private/tmp", "/private/var/folders", "/dev", MPL_CACHE];
  const writes = paths.map((p) => `  (subpath ${JSON.stringify(p)})`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    ALLOW_NET ? "" : "(deny network*)",
    "(deny file-write*)",
    `(allow file-write*\n${writes})`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PythonSpawn {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** The command line that runs `pythonArgs` under the given confinement. */
export function buildPythonSpawn(
  kind: SandboxKind,
  workDir: string,
  pythonArgs: string[],
): PythonSpawn {
  if (kind === "bwrap") {
    return {
      file: "bwrap",
      args: bwrapArgs(workDir, pythonArgs),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      cwd: workDir,
    };
  }
  if (kind === "seatbelt") {
    return {
      file: "sandbox-exec",
      args: ["-p", seatbeltProfile(workDir), PYTHON_BIN, ...pythonArgs],
      env: { ...safeEnv(), ...sandboxEnvPairs(workDir) },
      cwd: workDir,
    };
  }
  // "landlock" and "none" both run the interpreter directly — the difference is
  // what the bootstrap does once it starts. Credentials are stripped either way.
  return {
    file: PYTHON_BIN,
    args: pythonArgs,
    env: { ...safeEnv(), ...sandboxEnvPairs(workDir) },
    cwd: workDir,
  };
}

/** Run a command, resolving its exit code (null when it could not start). */
function exitCode(spec: PythonSpawn, timeoutMs = 15_000): Promise<number | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore" });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

let cached: Promise<SandboxStatus> | undefined;

/**
 * Which confinement this machine can actually provide. Probed by RUNNING the
 * real command line on a throwaway directory — a bwrap binary that exists but
 * cannot create user namespaces (hardened kernels, some containers) must not
 * count as available.
 */
export function resolveSandbox(): Promise<SandboxStatus> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<SandboxStatus> {
  if (SANDBOX_MODE === "off") {
    return { kind: "none", reason: "disabled with PYTHON_SANDBOX=off" };
  }
  const dir = path.join(SERVER_ROOT, "tmp", "_sandbox_probe");
  await mkdir(dir, { recursive: true });
  await mkdir(MPL_CACHE, { recursive: true });
  // Probe with the REAL bootstrap on a real snippet: a mode only counts as
  // available if a plain `print` survives every layer it would apply.
  await writeFile(path.join(dir, SCRIPT_FILE), "print('ok')\n", "utf8");

  const candidates: SandboxKind[] =
    process.platform === "linux"
      ? ["bwrap", "landlock"]
      : process.platform === "darwin"
        ? ["seatbelt"]
        : [];
  for (const kind of candidates) {
    await writeFile(path.join(dir, BOOTSTRAP_FILE), bootstrapSource(kind, dir), "utf8");
    if ((await exitCode(buildPythonSpawn(kind, dir, [BOOTSTRAP_FILE]))) === 0) return { kind };
  }
  const reason =
    process.platform === "linux"
      ? "this kernel offers neither usable bubblewrap (user namespaces are blocked) nor Landlock — " +
        "`apt install bubblewrap` and, on Ubuntu ≥23.10, allow user namespaces for it"
      : process.platform === "darwin"
        ? "sandbox-exec could not confine the interpreter"
        : `no sandbox is available on ${process.platform}`;
  return { kind: "none", reason };
}

/**
 * Python that applies the Landlock LSM to the interpreter itself: an
 * allowlist of readable system paths, a much shorter list of writable ones,
 * and (unless PYTHON_ALLOW_NET) a blanket TCP denial. It is inherited by any
 * child process and cannot be undone, and needs no privileges — the syscalls
 * are unprivileged by design. Unsupported access bits are masked off per the
 * kernel's reported ABI level, so newer rights degrade instead of failing.
 */
function landlockSource(workDir: string): string {
  const reads = JSON.stringify(readPaths(workDir));
  const writes = JSON.stringify(writePaths(workDir));
  return `
def _ld_apply_landlock():
    import ctypes, os
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.syscall.restype = ctypes.c_long
    libc.syscall.argtypes = [ctypes.c_long, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32]
    abi = libc.syscall(444, None, 0, 1)  # LANDLOCK_CREATE_RULESET_VERSION
    if abi < 1:
        return False
    FS_ALL = 0x1FFF                      # ABI 1: execute … make_sym
    if abi >= 2:
        FS_ALL |= 0x2000                 # REFER
    if abi >= 3:
        FS_ALL |= 0x4000                 # TRUNCATE
    if abi >= 5:
        FS_ALL |= 0x8000                 # IOCTL_DEV
    FS_READ = 0x1 | 0x4 | 0x8 | (0x8000 if abi >= 5 else 0)
    FS_FILE = FS_READ | 0x2 | (0x4000 if abi >= 3 else 0)
    NET = ${ALLOW_NET ? "0" : "(0x1 | 0x2) if abi >= 4 else 0"}  # bind_tcp | connect_tcp

    class _Ruleset(ctypes.Structure):
        _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]

    class _PathBeneath(ctypes.Structure):
        _pack_ = 1
        _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

    attr = _Ruleset(FS_ALL, NET)
    ruleset = libc.syscall(444, ctypes.byref(attr), 16 if abi >= 4 else 8, 0)
    if ruleset < 0:
        return False
    try:
        libc.syscall.argtypes = [
            ctypes.c_long, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
        ]

        def allow(pathname, access):
            try:
                pfd = os.open(pathname, os.O_PATH | os.O_CLOEXEC)
            except OSError:
                return  # a path this system doesn't have
            try:
                rule = _PathBeneath(access & FS_ALL, pfd)
                libc.syscall(445, ruleset, 1, ctypes.byref(rule), 0)  # RULE_PATH_BENEATH
            finally:
                os.close(pfd)

        for p in ${reads}:
            allow(p, FS_READ if os.path.isdir(p) else FS_FILE)
        for p in ${writes}:
            allow(p, FS_ALL if os.path.isdir(p) else FS_FILE)

        if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
            return False
        libc.syscall.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_uint32]
        return libc.syscall(446, ruleset, 0) == 0  # LANDLOCK_RESTRICT_SELF
    finally:
        os.close(ruleset)


try:
    _ld_locked = _ld_apply_landlock()
except Exception:
    _ld_locked = False
if not _ld_locked:
    # The probe said this kernel could confine us; if it now can't, do not run
    # the snippet unconfined.
    raise SystemExit("LatentDraft: could not apply the Landlock sandbox — refusing to run")
`;
}

/** One-line description for the startup log / diagnostics. */
export function describeSandbox(status: SandboxStatus): string {
  const net = ALLOW_NET ? "network ALLOWED" : "no network";
  if (status.kind === "bwrap") return `bubblewrap (${net}, ${MEM_MB} MB, ${TIMEOUT_MS / 1000}s)`;
  if (status.kind === "landlock") {
    return `Landlock LSM — build dir only (${net}, ${MEM_MB} MB, ${TIMEOUT_MS / 1000}s)`;
  }
  if (status.kind === "seatbelt") {
    return `macOS sandbox-exec — writes confined, reads are not (${net}, ${MEM_MB} MB)`;
  }
  const strict = SANDBOX_MODE === "strict" ? "run_python is DISABLED (PYTHON_SANDBOX=strict)" : "";
  return `NONE — ${status.reason}. ${strict || "in-process limits only; Python can read and write anything you can"}`;
}

/**
 * The bootstrap that runs before the snippet: hard rlimits (hard == soft, so
 * the snippet cannot raise them back), an optional socket block, the headless
 * matplotlib backend, then the user's file via runpy — which keeps tracebacks
 * pointing at the snippet's own line numbers.
 */
export function bootstrapSource(kind: SandboxKind, workDir = process.cwd()): string {
  const mem = Math.max(64, MEM_MB) * 1024 * 1024;
  const fsize = Math.max(1, MAX_FILE_MB) * 1024 * 1024;
  // RLIMIT_NPROC counts every process of the UID, not just this one, so a low
  // cap is only meaningful inside bwrap's fresh user namespace — on the host it
  // would collide with the desktop session's own process count.
  //
  // Wall-clock is the primary limit; CPU seconds are a backstop, and multi-core
  // BLAS burns them faster than wall time, so keep the ceiling generous.
  const cpu = Math.max(5, Math.ceil((TIMEOUT_MS / 1000) * 4));
  // socket.socket must stay a CLASS — ssl.py does `class SSLSocket(socket)` at
  // import time, so replacing it with a function breaks `import urllib.request`
  // with a baffling TypeError. Patching the methods keeps the module importable
  // and fails at the moment a connection is actually attempted.
  const netBlock = ALLOW_NET
    ? ""
    : `
try:
    import socket as _ld_socket
    def _ld_no_net(*_a, **_k):
        raise OSError(
            "network access is disabled in run_python — load data from files in "
            "this directory instead of URLs"
        )
    _ld_socket.socket.connect = _ld_no_net
    _ld_socket.socket.connect_ex = _ld_no_net
    _ld_socket.socket.bind = _ld_no_net
    _ld_socket.socket.sendto = _ld_no_net
    _ld_socket.create_connection = _ld_no_net
    _ld_socket.getaddrinfo = _ld_no_net
    _ld_socket.gethostbyname = _ld_no_net
    _ld_socket.gethostbyname_ex = _ld_no_net
except Exception:
    pass
`;
  const landlock = kind === "landlock" ? landlockSource(workDir) : "";
  return `# Generated by LatentDraft — hardening for ${SCRIPT_FILE}. Do not edit.
import os as _ld_os
_ld_os.environ.setdefault("MPLBACKEND", "Agg")

try:
    import resource as _ld_resource

    def _ld_limit(name, value):
        what = getattr(_ld_resource, name, None)
        if what is None:
            return
        try:
            _soft, hard = _ld_resource.getrlimit(what)
            if hard != _ld_resource.RLIM_INFINITY:
                value = min(value, hard)
            # hard == soft: lowering a hard limit is irreversible for non-root,
            # so the snippet cannot lift it again.
            _ld_resource.setrlimit(what, (value, value))
        except (ValueError, OSError):
            pass

    _ld_limit("RLIMIT_AS", ${mem})
    _ld_limit("RLIMIT_FSIZE", ${fsize})
    _ld_limit("RLIMIT_CPU", ${cpu})
    _ld_limit("RLIMIT_CORE", 0)
${kind === "bwrap" ? '    _ld_limit("RLIMIT_NPROC", 256)\n' : ""}except Exception:
    pass
${landlock}${netBlock}
try:
    import matplotlib as _ld_matplotlib
    _ld_matplotlib.use("Agg")
except Exception:
    pass

import runpy as _ld_runpy
import sys as _ld_sys
_ld_sys.argv = ["${SCRIPT_FILE}"]
_ld_runpy.run_path("${SCRIPT_FILE}", run_name="__main__")
`;
}

/** Ensure the shared matplotlib cache exists (bind-mounted into the sandbox). */
export async function ensureSandboxDirs(): Promise<void> {
  await mkdir(MPL_CACHE, { recursive: true });
}
