#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const dashboardRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const committedReportPath = path.join(dashboardRoot, "hermes_upstream_audit.md");

function normalizeAudit(text) {
  return text
    .split("\n")
    .filter((line) => !line.startsWith("Generated: "))
    .join("\n")
    .trim();
}

function fail(lines, exitCode = 1) {
  for (const line of lines) {
    console.error(line);
  }
  process.exit(exitCode);
}

function main() {
  if (!fs.existsSync(committedReportPath)) {
    fail([
      "Committed Hermes upstream audit report not found.",
      `Expected: ${committedReportPath}`,
    ]);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-upstream-audit-"));
  const generatedReportPath = path.join(tempDir, "hermes_upstream_audit.md");

  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, "hermes-upstream-audit.cjs"), "--output", generatedReportPath],
      {
        cwd: repoRoot,
        stdio: "inherit",
      },
    );

    const committed = normalizeAudit(fs.readFileSync(committedReportPath, "utf8"));
    const generated = normalizeAudit(fs.readFileSync(generatedReportPath, "utf8"));

    if (committed !== generated) {
      fail([
        "Hermes upstream audit drift detected.",
        "",
        "The committed dashboard/hermes_upstream_audit.md no longer matches the live upstream/fork state.",
        "Regenerate it with:",
        "  cd dashboard && npm run audit:upstream",
        "",
        "Why this guard exists:",
        "  - cross-repo regressions can arrive from upstream Hermes changes without any local code edit",
        "  - keeping the committed audit fresh makes those contract shifts visible before they surprise the dashboard",
      ]);
    }

    console.log("Hermes upstream audit check passed: committed report matches live upstream state.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main();
