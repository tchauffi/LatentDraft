import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { runPython } from "../src/python.js";
import { writeSessionFiles, sessionDir } from "../src/compile.js";

// Integration test for the data-plotting stack: an uploaded CSV must be
// readable with pandas and plottable with seaborn from run_python.

const SESSION = `py-${Date.now().toString(36)}`;

after(async () => {
  await rm(sessionDir(SESSION), { recursive: true, force: true });
});

test("run_python plots an uploaded CSV with pandas + seaborn", async () => {
  await writeSessionFiles(SESSION, {
    "measurements.csv": "t,value\n0,1.0\n1,1.8\n2,3.1\n3,4.2\n",
  });
  const res = await runPython(
    SESSION,
    [
      "import pandas as pd, seaborn as sns",
      "import matplotlib.pyplot as plt",
      'df = pd.read_csv("measurements.csv")',
      'sns.lineplot(data=df, x="t", y="value")',
      'plt.savefig("trend.png", dpi=150, bbox_inches="tight")',
      'print("rows:", len(df))',
    ].join("\n"),
  );
  assert.equal(res.ok, true, res.output);
  assert.match(res.output, /rows: 4/);
  assert.ok(res.createdFiles.includes("trend.png"), `created: ${res.createdFiles.join(", ")}`);
});
