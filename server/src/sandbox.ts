import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as FS, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
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
 *                directory, and TCP is denied — but only from ABI 4 (kernel
 *                6.7) up, and UDP is outside Landlock's scope at every ABI.
 *                The seccomp filter below is what actually denies the network.
 *   - "seatbelt" (macOS): sandbox-exec denies network and all writes outside
 *                the build directory. Reads are NOT confined (a `deny default`
 *                profile breaks the Python runtime), so it is third-tier.
 *   - "none":    no OS confinement — only the in-process limits below.
 *
 * Every mode additionally applies, from inside the interpreter: hard rlimits
 * (address space, file size, CPU, core dumps), an environment stripped of API
 * keys, and — where the OS layer does not already unshare the network — a
 * seccomp filter refusing IPv4/IPv6 sockets outright, behind which the socket
 * patch turns the kernel's EACCES into a message the agent can act on.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..");

/** Prefer the project venv (has matplotlib/numpy), fall back to system python3. */
const VENV_PYTHON = path.join(SERVER_ROOT, ".venv", "bin", "python");

/**
 * Resolve the interpreter to an ABSOLUTE path, against the SERVER's PATH.
 * `PYTHON_BIN=python3` is a natural thing to set (this project's own CI does),
 * but the snippet runs with a deliberately minimal PATH — so a bare name was
 * re-resolved *inside* the sandbox and quietly picked whichever interpreter
 * `/usr/bin` happened to hold, not the one probed here. The packages the user
 * installed then go missing, reported as a baffling ModuleNotFoundError (or,
 * when nothing matches at all, `spawn python ENOENT`).
 */
export function resolvePythonBin(bin: string): string {
  if (bin.includes(path.sep)) return path.resolve(bin);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      accessSync(candidate, FS.X_OK);
      return candidate;
    } catch {
      /* not in this PATH entry — keep looking */
    }
  }
  return bin; // let the spawn fail loudly rather than silently run another python
}

export const PYTHON_BIN = resolvePythonBin(process.env.PYTHON_BIN ?? VENV_PYTHON);

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

/**
 * Where this interpreter actually keeps its standard library and packages.
 * ASKED OF THE INTERPRETER rather than guessed from its path: a venv, pyenv,
 * conda, or a CI runner's hosted Python each put them somewhere different, and
 * a prefix we fail to allowlist becomes a missing module at import time. The
 * probe runs once, at the first sandboxed launch, and is cached.
 *
 * The user site-packages directory is deliberately NOT included: the sandbox
 * sets PYTHONNOUSERSITE, so it is never read, and allowlisting it would open a
 * hole into $HOME for nothing.
 */
let libDirsCache: string[] | undefined;
export function pythonLibDirs(): string[] {
  if (libDirsCache) return libDirsCache;
  const probe = spawnSync(
    PYTHON_BIN,
    [
      "-c",
      "import sys,site\n" +
        "d={sys.prefix,sys.base_prefix,sys.exec_prefix,sys.base_exec_prefix}\n" +
        "d.update(getattr(site,'getsitepackages',lambda:[])())\n" +
        "print('\\n'.join(sorted(p for p in d if p)))\n",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  const found = probe.status === 0 ? probe.stdout.split("\n") : [];
  // The interpreter's own directory too — it can sit outside every prefix when
  // /usr/local/bin/python3 symlinks off to somewhere else entirely.
  try {
    found.push(path.dirname(realpathSync(PYTHON_BIN)));
  } catch {
    found.push(path.dirname(PYTHON_BIN));
  }
  // Fall back to the old guess if the probe told us nothing usable.
  if (found.length === 0) found.push(path.dirname(path.dirname(PYTHON_BIN)));

  const home = os.homedir();
  const dirs: string[] = [];
  for (const raw of found) {
    const p = raw.trim();
    // "/" or $HOME itself would hand back everything the sandbox just took away.
    if (!p || !path.isAbsolute(p) || p === "/" || p === home) continue;
    if (dirs.some((kept) => p === kept || p.startsWith(`${kept}/`))) continue; // already covered
    dirs.push(p);
  }
  libDirsCache = dirs.filter((p) => !dirs.some((other) => other !== p && p.startsWith(`${other}/`)));
  return libDirsCache;
}

/** Read-only system paths the interpreter needs (Landlock allowlist). */
function readPaths(workDir: string): string[] {
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
    ...pythonLibDirs(),
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
    // The interpreter's own stdlib/site-packages, wherever they actually live
    // (venv, pyenv, conda, a CI runner's hosted Python — see pythonLibDirs).
    ...pythonLibDirs().flatMap((dir) => ["--ro-bind-try", dir, dir]),
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

/**
 * Python that installs a seccomp-BPF filter rejecting `socket(2)` for AF_INET
 * and AF_INET6. This is what makes "no network" true rather than merely likely.
 *
 * Patching `socket.socket` from Python cannot be the boundary: it is a
 * *subclass* of the C-level `_socket.socket`, so the patch never reaches the
 * base class and `socket.socket.__bases__[0](2, 2)` hands the snippet an
 * untouched constructor. Landlock cannot be the boundary either — it has no
 * UDP right at any ABI, and no network rights at all below kernel 6.7. The
 * kernel refusing the syscall is the only thing that covers both.
 *
 * Only IPv4/IPv6 are filtered: AF_UNIX has to keep working, because
 * multiprocessing and joblib build their worker channels on socketpair().
 */
function seccompSource(): string {
  return `
def _ld_apply_seccomp():
    import ctypes, platform, struct

    # (AUDIT_ARCH token, socket(2) number) — the number is per-architecture.
    _ld_arch = {"x86_64": (0xC000003E, 41), "aarch64": (0xC00000B7, 198)}
    native = _ld_arch.get(platform.machine())
    if native is None:
        return False  # an architecture whose syscall numbering we have not pinned
    arch_token, sock_nr = native

    LD_W_ABS, JEQ_K, RET_K = 0x20, 0x15, 0x06
    ALLOW, DENY = 0x7FFF0000, 0x00050000 | 13  # RET_ALLOW, RET_ERRNO(EACCES)

    def ins(code, jt, jf, k):
        return struct.pack("HBBI", code, jt, jf, k)

    # Offsets are into struct seccomp_data: nr at 0, arch at 4, args[0] at 16.
    prog = b"".join([
        ins(LD_W_ABS, 0, 0, 4),
        # A foreign arch denies rather than allows: i386 compat mode numbers
        # socket() differently (359), which would otherwise walk straight past
        # the nr check below. Native CPython never issues a foreign syscall.
        ins(JEQ_K, 0, 6, arch_token),
        ins(LD_W_ABS, 0, 0, 0),
        ins(JEQ_K, 0, 3, sock_nr),      # anything but socket() -> allow
        ins(LD_W_ABS, 0, 0, 16),        # args[0] is the address family
        ins(JEQ_K, 2, 0, 2),            # AF_INET
        ins(JEQ_K, 1, 0, 10),           # AF_INET6
        ins(RET_K, 0, 0, ALLOW),
        ins(RET_K, 0, 0, DENY),
    ])
    # The kernel copies the program during the syscall, so the buffer has to
    # outlive the pointer we hand it — both stay alive in these locals.
    buf = ctypes.create_string_buffer(prog, len(prog))
    fprog = struct.pack("HxxxxxxP", len(prog) // 8, ctypes.addressof(buf))

    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    # An unprivileged filter needs NO_NEW_PRIVS. Landlock already set it when it
    # ran; in the "none" mode it did not, and setting it twice is harmless.
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        return False
    libc.syscall.restype = ctypes.c_long
    libc.syscall.argtypes = [ctypes.c_long, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p]
    # Filters stack, so an existing container filter is not a conflict.
    return libc.syscall(317, 1, 0, ctypes.c_char_p(fprog)) == 0  # SECCOMP_SET_MODE_FILTER
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
  // NOT the boundary — seccomp above is (this patch misses `_socket` entirely,
  // since socket.socket only subclasses it). Its job is the error message: a
  // bare EACCES from the kernel tells the agent nothing, while this says what
  // to do instead, at the moment a connection is actually attempted.
  //
  // socket.socket must stay a CLASS — ssl.py does `class SSLSocket(socket)` at
  // import time, so replacing it with a function breaks `import urllib.request`
  // with a baffling TypeError. Patching the methods keeps the module importable.
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

    # seccomp refuses an IPv4/IPv6 socket at construction, so the methods above
    # are never reached by code that builds one directly — answer there too.
    # Only when fileno is None: wrapping an existing fd (accept, socketpair,
    # SSLSocket._create) leaves the family to the C constructor and is not a
    # new connection to anywhere.
    _ld_inet = (_ld_socket.AF_INET, _ld_socket.AF_INET6, -1)  # -1 defaults to AF_INET
    _ld_real_init = _ld_socket.socket.__init__
    def _ld_init(self, family=-1, type=-1, proto=-1, fileno=None):
        if fileno is None and family in _ld_inet:
            _ld_no_net()
        return _ld_real_init(self, family, type, proto, fileno)
    _ld_socket.socket.__init__ = _ld_init

    _ld_socket.create_connection = _ld_no_net
    _ld_socket.getaddrinfo = _ld_no_net
    _ld_socket.gethostbyname = _ld_no_net
    _ld_socket.gethostbyname_ex = _ld_no_net
except Exception:
    pass
`;
  const landlock = kind === "landlock" ? landlockSource(workDir) : "";
  // bwrap already unshared the network and seatbelt denies it in the profile;
  // seccomp is for the two modes that run the interpreter directly on Linux.
  const seccomp =
    ALLOW_NET || kind === "bwrap" || kind === "seatbelt"
      ? ""
      : `${seccompSource()}
try:
    _ld_netlocked = _ld_apply_seccomp()
except Exception:
    _ld_netlocked = False
${
  kind === "landlock"
    ? `if not _ld_netlocked:
    # Same posture as the Landlock ruleset above: the probe already ran this
    # bootstrap successfully, so a filter that fails now is a reason to stop
    # rather than to run the snippet with the network open.
    raise SystemExit("LatentDraft: could not apply the seccomp network filter — refusing to run")
`
    : "" /* "none" promises no OS confinement — best effort, never fatal. */
}`;
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
${landlock}${seccomp}${netBlock}
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
