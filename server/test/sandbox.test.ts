import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPythonIn } from "../src/python.js";
import {
  BOOTSTRAP_FILE,
  bootstrapSource,
  buildPythonSpawn,
  PYTHON_BIN,
  pythonLibDirs,
  resolvePythonBin,
  resolveSandbox,
  safeEnv,
  SCRIPT_FILE,
  type SandboxKind,
} from "../src/sandbox.js";
import { execFileSync, spawn } from "node:child_process";

// run_python executes code the MODEL wrote, and what the model writes can be
// steered by anything it read (a web page, an uploaded file). These tests pin
// the confinement: no credentials, no network, nothing outside the build dir.

const dir = await mkdtemp(path.join(os.tmpdir(), "ld-sandbox-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sandbox = await resolveSandbox();
const confined = sandbox.kind !== "none";
// Reads are confined by bwrap and Landlock only. The macOS seatbelt profile is
// `(allow default)` plus write/network denials — it deliberately does NOT
// restrict reads, because a deny-default profile breaks the Python runtime.
const confinesReads = sandbox.kind === "bwrap" || sandbox.kind === "landlock";

test("credentials are stripped from the interpreter's environment", () => {
  const env = safeEnv({
    ANTHROPIC_API_KEY: "sk-secret",
    OPENAI_API_KEY: "sk-secret",
    GITHUB_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "secret",
    PATH: "/usr/bin",
    LANG: "C.UTF-8",
  });
  assert.deepEqual(Object.keys(env).sort(), ["LANG", "PATH"]);
});

test("the bootstrap applies hard rlimits and blocks sockets", () => {
  const src = bootstrapSource("none", dir);
  assert.match(src, /RLIMIT_AS/);
  assert.match(src, /RLIMIT_FSIZE/);
  assert.match(src, /RLIMIT_CPU/);
  assert.match(src, /socket\.connect = _ld_no_net/);
  // NPROC counts processes per UID, so it is only meaningful in bwrap's userns.
  assert.doesNotMatch(src, /RLIMIT_NPROC/);
  assert.match(bootstrapSource("bwrap", dir), /RLIMIT_NPROC/);
});

test("Landlock rules are emitted only for the landlock mode", () => {
  assert.match(bootstrapSource("landlock", dir), /LANDLOCK_RESTRICT_SELF|446/);
  // …and it fails closed if the kernel refuses the ruleset at runtime.
  assert.match(bootstrapSource("landlock", dir), /refusing to run/);
  assert.doesNotMatch(bootstrapSource("none", dir), /_ld_apply_landlock/);
});

test("bwrap confines the filesystem to the build directory", () => {
  const spec = buildPythonSpawn("bwrap", dir, ["script.py"]);
  assert.equal(spec.file, "bwrap");
  const args = spec.args.join(" ");
  assert.match(args, /--unshare-net/);
  assert.match(args, /--unshare-user/);
  assert.match(args, new RegExp(`--bind ${dir} ${dir}`));
  assert.match(args, /--ro-bind \/usr \/usr/);
  assert.match(args, /--clearenv/);
  // No $HOME, and nothing writable outside the bound directories.
  assert.doesNotMatch(args, new RegExp(`--bind ${os.homedir()} `));
});

test("the snippet runs with no credentials in its environment", async () => {
  process.env.LD_TEST_FAKE_API_KEY = "sk-must-not-leak";
  try {
    const res = await runPythonIn(
      dir,
      'import os\nprint("LEAK" if any("must-not-leak" in v for v in os.environ.values()) else "CLEAN")',
    );
    assert.equal(res.ok, true, res.output);
    assert.match(res.output, /CLEAN/);
  } finally {
    delete process.env.LD_TEST_FAKE_API_KEY;
  }
});

test("the memory limit stops a runaway allocation", async () => {
  const res = await runPythonIn(dir, "a = bytearray(8 * 1024 * 1024 * 1024)\nprint(len(a))");
  assert.equal(res.ok, false);
  assert.match(res.output, /MemoryError|killed/);
});

test("tracebacks carry the snippet's own line numbers", async () => {
  const res = await runPythonIn(dir, 'x = 1\ny = 2\nraise ValueError("boom")');
  assert.equal(res.ok, false);
  // Line 3 of what the model wrote — not shifted by the bootstrap around it.
  assert.match(res.output, /_agent_script\.py", line 3/);
  assert.match(res.output, /ValueError: boom/);
});

test("internal sandbox files are never reported as generated figures", async () => {
  const res = await runPythonIn(dir, 'open("figure.png", "wb").write(b"x")');
  assert.deepEqual(res.createdFiles, ["figure.png"]);
});

test("the network is unreachable", async () => {
  const res = await runPythonIn(
    dir,
    'import urllib.request\nprint(urllib.request.urlopen("http://example.com", timeout=5).status)',
  );
  assert.equal(res.ok, false, "run_python must not be able to reach the network");
  assert.match(res.output, /network access is disabled|Permission denied|URLError/);
});

test("raw sockets are unreachable too, not just the patched module", { skip: !confined }, async () => {
  const res = await runPythonIn(
    dir,
    [
      // TCP, and UDP — which Landlock has no access bit for at any ABI, so it
      // is the seccomp filter that has to stop this one.
      "import _socket",
      's = _socket.socket()\ns.settimeout(4)\ntry:\n    s.connect(("1.1.1.1", 80))\n    print("CONNECTED")\nexcept OSError as e:\n    print("tcp blocked:", e)',
      'u = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)\nprint("SENT", u.sendto(b"x", ("1.1.1.1", 53)))',
    ].join("\n"),
  );
  assert.equal(res.ok, false, res.output);
  assert.doesNotMatch(res.output, /CONNECTED/);
  assert.doesNotMatch(res.output, /SENT/);
});

test("files outside the build directory cannot be written", { skip: !confined }, async () => {
  const target = path.join(os.homedir(), "latentdraft-sandbox-escape.txt");
  const res = await runPythonIn(dir, `open(${JSON.stringify(target)}, "w").write("escaped")`);
  await rm(target, { force: true }); // in case a future regression lets it through
  assert.equal(res.ok, false, "the snippet escaped the build directory");
  assert.match(res.output, /Permission denied|Read-only file system|No such file/);
});

test("files outside the build directory cannot be read", { skip: !confinesReads }, async () => {
  const secret = path.join(os.homedir(), ".latentdraft-sandbox-secret");
  await writeFile(secret, "top secret\n", "utf8");
  try {
    const res = await runPythonIn(dir, `print(open(${JSON.stringify(secret)}).read())`);
    assert.equal(res.ok, false, res.output);
    assert.doesNotMatch(res.output, /top secret/);
  } finally {
    await rm(secret, { force: true });
  }
});

test("the build directory itself stays fully usable", async () => {
  await writeFile(path.join(dir, "data.csv"), "t,v\n0,1\n1,2\n2,4\n", "utf8");
  const res = await runPythonIn(
    dir,
    [
      "import pandas as pd, seaborn as sns",
      "import matplotlib.pyplot as plt",
      'df = pd.read_csv("data.csv")',
      'sns.lineplot(data=df, x="t", y="v")',
      'plt.savefig("trend.png", dpi=100, bbox_inches="tight")',
      'print("rows:", len(df))',
    ].join("\n"),
  );
  assert.equal(res.ok, true, res.output);
  assert.match(res.output, /rows: 3/);
  assert.ok(res.createdFiles.includes("trend.png"), res.createdFiles.join(", "));
});

// The snippet runs with a deliberately minimal PATH, so a bare PYTHON_BIN
// ("python3", which this project's own CI sets) used to be re-resolved INSIDE
// the sandbox — silently running whichever interpreter /usr/bin held instead
// of the one the server probed, and losing every package with it.
test("PYTHON_BIN is resolved to an absolute path before the sandbox sees it", () => {
  assert.ok(path.isAbsolute(PYTHON_BIN), `PYTHON_BIN not absolute: ${PYTHON_BIN}`);
  // A bare name is looked up on the SERVER's PATH...
  const sh = resolvePythonBin("sh");
  assert.ok(path.isAbsolute(sh), `bare name not resolved: ${sh}`);
  // ...a relative path is made absolute...
  assert.ok(path.isAbsolute(resolvePythonBin("./python")));
  // ...and an absolute one is left alone.
  assert.equal(resolvePythonBin("/usr/bin/python3"), "/usr/bin/python3");
  // Nothing on PATH matches: hand it back so the spawn fails loudly rather
  // than quietly resolving to some other interpreter.
  assert.equal(resolvePythonBin("ld-no-such-interpreter"), "ld-no-such-interpreter");
});

test("the interpreter's own prefix is allowlisted, wherever it lives", () => {
  const prefix = execFileSync(PYTHON_BIN, ["-c", "import sys;print(sys.prefix)"], {
    encoding: "utf8",
  }).trim();
  const dirs = pythonLibDirs();
  assert.ok(
    dirs.some((d) => prefix === d || prefix.startsWith(`${d}/`)),
    `sys.prefix ${prefix} is not covered by ${JSON.stringify(dirs)}`,
  );
  // Never the whole of $HOME or / — that would undo the confinement.
  assert.ok(!dirs.includes("/"));
  assert.ok(!dirs.includes(os.homedir()));
});

test("bwrap binds the interpreter's libraries, not a guess from its path", () => {
  const spec = buildPythonSpawn("bwrap", dir, ["-c", "pass"]);
  for (const libDir of pythonLibDirs()) {
    // Some (e.g. /usr for a venv on the system python) are already covered by
    // the static system binds, which use --ro-bind rather than --ro-bind-try.
    const bound = spec.args.some(
      (arg, i) => arg === libDir && /^--ro-bind(-try)?$/.test(spec.args[i - 1] ?? ""),
    );
    assert.ok(bound, `${libDir} is never bound into the sandbox`);
  }
  // And it execs the resolved absolute interpreter, not a bare name.
  assert.ok(spec.args.includes(PYTHON_BIN));
});

// ---------------------------------------------------------------------------
// The network block, pinned against the mode that actually needs it.
//
// Every test above goes through resolveSandbox(), which picks bwrap on a
// typical Linux box — and bwrap's --unshare-net hides everything the Landlock
// path gets wrong. So drive the landlock bootstrap explicitly: that is the
// mode where a hole is reachable, and where a regression would go unnoticed.

/** Run `code` under a specific sandbox kind, bypassing the probe's choice. */
async function runUnderKind(kind: SandboxKind, code: string): Promise<string> {
  const box = await mkdtemp(path.join(os.tmpdir(), "ld-kind-"));
  try {
    await writeFile(path.join(box, SCRIPT_FILE), code, "utf8");
    await writeFile(path.join(box, BOOTSTRAP_FILE), bootstrapSource(kind, box), "utf8");
    const spec = buildPythonSpawn(kind, box, [BOOTSTRAP_FILE]);
    return await new Promise((resolve) => {
      const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => resolve(`spawn failed: ${e}`));
      child.on("close", () => resolve(out));
    });
  } finally {
    await rm(box, { recursive: true, force: true });
  }
}

// Landlock is Linux-only and needs ≥5.13; skip where it cannot apply at all.
const landlockUsable =
  process.platform === "linux" &&
  !/refusing to run/.test(await runUnderKind("landlock", 'print("ok")'));

test(
  "the seccomp filter closes the network in landlock mode, UDP included",
  { skip: !landlockUsable },
  async () => {
    const out = await runUnderKind(
      "landlock",
      [
        "import _socket, socket",
        "def t(label, fn):",
        "    try: print(label, 'OPEN', fn())",
        "    except OSError as e: print(label, 'blocked')",
        // UDP: no Landlock access bit exists for it at any ABI.
        "t('udp', lambda: _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM).sendto(b'x', ('1.1.1.1', 53)))",
        // TCP: Landlock only denies this from ABI 4 (kernel 6.7) up.
        "t('tcp', lambda: _socket.socket().connect(('1.1.1.1', 80)))",
        "t('v6', lambda: _socket.socket(_socket.AF_INET6, _socket.SOCK_STREAM))",
        // The escape no Python-level patch can close: socket.socket is a
        // subclass, so its base is the untouched C constructor.
        "t('base', lambda: socket.socket.__bases__[0](_socket.AF_INET, _socket.SOCK_DGRAM))",
      ].join("\n"),
    );
    assert.doesNotMatch(out, /OPEN/, out);
    for (const probe of ["udp", "tcp", "v6", "base"]) {
      assert.match(out, new RegExp(`${probe} blocked`), out);
    }
  },
);

test(
  "…without taking AF_UNIX with it — multiprocessing and joblib need it",
  { skip: !landlockUsable },
  async () => {
    const out = await runUnderKind(
      "landlock",
      [
        "import socket, _socket",
        "s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)",
        "a, b = socket.socketpair()",
        "print('AF_UNIX ok', s.fileno() >= 0, a.fileno() >= 0, b.fileno() >= 0)",
      ].join("\n"),
    );
    assert.match(out, /AF_UNIX ok True True True/, out);
  },
);

test("the seccomp filter is emitted for the modes that run the interpreter directly", () => {
  // bwrap already unshared the network; seatbelt denies it in the profile.
  for (const kind of ["landlock", "none"] as SandboxKind[]) {
    assert.match(bootstrapSource(kind, dir), /_ld_apply_seccomp/, kind);
    assert.match(bootstrapSource(kind, dir), /SECCOMP_SET_MODE_FILTER|317/, kind);
  }
  for (const kind of ["bwrap", "seatbelt"] as SandboxKind[]) {
    assert.doesNotMatch(bootstrapSource(kind, dir), /_ld_apply_seccomp/, kind);
  }
  // Landlock fails closed when the filter will not install; "none" promises no
  // OS confinement in the first place, so there it is best effort.
  assert.match(bootstrapSource("landlock", dir), /seccomp network filter — refusing to run/);
  assert.doesNotMatch(bootstrapSource("none", dir), /seccomp network filter — refusing to run/);
});
