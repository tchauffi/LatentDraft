import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runPythonIn } from "../src/python.js";
import { bootstrapSource, buildPythonSpawn, resolveSandbox, safeEnv } from "../src/sandbox.js";

// run_python executes code the MODEL wrote, and what the model writes can be
// steered by anything it read (a web page, an uploaded file). These tests pin
// the confinement: no credentials, no network, nothing outside the build dir.

const dir = await mkdtemp(path.join(os.tmpdir(), "ld-sandbox-"));
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sandbox = await resolveSandbox();
const confined = sandbox.kind !== "none";

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
    'import _socket\ns = _socket.socket()\ns.settimeout(4)\ns.connect(("1.1.1.1", 80))\nprint("CONNECTED")',
  );
  assert.equal(res.ok, false, res.output);
  assert.doesNotMatch(res.output, /CONNECTED/);
});

test("files outside the build directory cannot be written", { skip: !confined }, async () => {
  const target = path.join(os.homedir(), "latentdraft-sandbox-escape.txt");
  const res = await runPythonIn(dir, `open(${JSON.stringify(target)}, "w").write("escaped")`);
  await rm(target, { force: true }); // in case a future regression lets it through
  assert.equal(res.ok, false, "the snippet escaped the build directory");
  assert.match(res.output, /Permission denied|Read-only file system|No such file/);
});

test("files outside the build directory cannot be read", { skip: !confined }, async () => {
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
