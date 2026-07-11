import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAts } from "../src/ats.js";

const GOOD_RESUME = `
Jane Doe
jane.doe@example.com  +1 (555) 123-4567
linkedin.com/in/janedoe  github.com/janedoe

Summary
Senior software engineer with a focus on distributed systems.

Work Experience
Acme Corp — built Python services on Kubernetes, wrote Terraform modules.

Education
B.Sc. Computer Science.

Skills
Python, Kubernetes, PostgreSQL, CI/CD pipelines, monitoring and observability,
incident response, code review, mentoring, documentation, agile delivery.
`;

test("a complete resume passes parseability, contact and section checks", () => {
  const report = analyzeAts({ resumeText: GOOD_RESUME });
  assert.match(report, /✅ Parseable/);
  assert.doesNotMatch(report, /MISSING email/);
  assert.doesNotMatch(report, /MISSING phone/);
  assert.match(report, /LinkedIn/);
  assert.match(report, /GitHub/);
  assert.match(report, /experience/);
  assert.match(report, /education/);
  assert.match(report, /skills/);
});

test("near-empty text triggers the parseability warning", () => {
  const report = analyzeAts({ resumeText: "John\n" });
  assert.match(report, /⛔ PARSEABILITY/);
  assert.match(report, /MISSING email/);
});

test("keyword coverage reports terms missing from the resume", () => {
  const report = analyzeAts({
    resumeText: GOOD_RESUME,
    jobDescription: "We need Python and Kubernetes experience; Elasticsearch is a plus.",
  });
  assert.match(report, /Keyword coverage vs job description: \d+%/);
  assert.match(report, /elasticsearch/);
  // Terms the resume does contain must not be listed as missing.
  const missingLine = report.split("\n").find((l) => l.includes("NOT found")) ?? "";
  assert.ok(!missingLine.includes("python"), "python should not be reported missing");
});

test("private-use glyphs (icon fonts) are flagged", () => {
  const report = analyzeAts({ resumeText: GOOD_RESUME + "\n icons here" });
  assert.match(report, /Private-use Unicode glyphs/);
});
