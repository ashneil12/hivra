import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeTestWiring, workflowTriggers } from "../scripts/check-test-wiring.cjs";
import jestConfig from "../jest.config.js";

const dashboardRoot = path.resolve(__dirname, "..");
const guard = path.join(dashboardRoot, "scripts/check-test-wiring.cjs");

const JEST_CONFIG = {
  roots: ["<rootDir>/src", "<rootDir>/__tests__"],
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  testPathIgnorePatterns: ["/node_modules/"],
};

const PR_WORKFLOW = (steps: string) => `name: CI
on:
  pull_request:
    paths:
      - 'dashboard/**'
  push:
    branches: [canary]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

const MANUAL_WORKFLOW = (steps: string) => `name: Lab
on:
  workflow_dispatch:
jobs:
  lab:
    runs-on: ubuntu-latest
    steps:
${steps}
`;

type Exemption = { path: string; category: string; reason: string; runBy?: string };

function analyze(files: Record<string, string>, exemptions: Exemption[] = []) {
  return analyzeTestWiring({
    trackedFiles: Object.keys(files),
    readFile: (file: string) => files[file] ?? "",
    jestConfig: JEST_CONFIG,
    exemptions,
  });
}

function orphanPaths(result: ReturnType<typeof analyze>) {
  return result.orphans.map((orphan: { path: string }) => orphan.path);
}

function runGuard(args: string[] = []) {
  return spawnSync(process.execPath, [guard, ...args], { cwd: dashboardRoot, encoding: "utf8", timeout: 60_000 });
}

describe("test wiring guard on this repository", () => {
  it("every test file is run by jest, an automatic workflow or a package script CI runs, or is exempted with a reason", () => {
    const result = runGuard();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS test wiring: every test file is run by CI or exempted with a reason.");
    expect(result.status).toBe(0);
  });

  it("a stale exemption fails", () => {
    const real = JSON.parse(fs.readFileSync(path.join(dashboardRoot, "scripts/test-wiring-exemptions.json"), "utf8"));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "test-wiring-"));
    const exemptions = path.join(directory, "exemptions.json");
    fs.writeFileSync(exemptions, JSON.stringify({
      exemptions: [
        ...real.exemptions,
        // Run by the desktop-guest-phases jest wrapper, so it needs no exemption.
        { path: "dashboard/scripts/test-desktop-guest-phases.py", category: "vm", reason: "An exemption left behind after wiring." },
        { path: "dashboard/scripts/test-that-was-deleted.py", category: "live", reason: "An exemption for a file that no longer exists." },
      ],
    }));
    try {
      const result = runGuard(["--exemptions", exemptions]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Stale exemptions:");
      expect(result.stdout).toMatch(/dashboard\/scripts\/test-desktop-guest-phases\.py is already run \(jest wrapper dashboard\/__tests__\/desktop-guest-phases\.test\.ts\)/);
      expect(result.stdout).toContain("dashboard/scripts/test-that-was-deleted.py names no tracked test file");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("agrees with jest about which files jest runs", () => {
    const listed = spawnSync(process.execPath, [require.resolve("jest/bin/jest"), "--listTests", "--json"], {
      cwd: dashboardRoot,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(listed.status).toBe(0);
    const repoRoot = path.resolve(dashboardRoot, "..");
    const fromJest = (JSON.parse(listed.stdout) as string[]).map((file) => path.relative(repoRoot, file).split(path.sep).join("/")).sort();
    const report = JSON.parse(runGuard(["--json"]).stdout);
    const fromGuard = report.run
      .filter((entry: { evidence: string[] }) => entry.evidence.includes("jest"))
      .map((entry: { path: string }) => entry.path)
      .sort();
    expect(fromGuard).toEqual(fromJest);
  }, 60_000);

  it("models the jest config it is given", () => {
    expect(jestConfig.roots).toEqual(JEST_CONFIG.roots);
    expect(jestConfig.testMatch).toEqual(JEST_CONFIG.testMatch);
  });
});

describe("test wiring rules", () => {
  it("reports a script test that nothing runs", () => {
    const result = analyze({ "dashboard/scripts/test-orphan.cjs": "console.log('PASS orphan')" });
    expect(result.ok).toBe(false);
    expect(orphanPaths(result)).toEqual(["dashboard/scripts/test-orphan.cjs"]);
  });

  it("counts jest suites, and jest wrappers only when they start a process", () => {
    const result = analyze({
      "dashboard/src/lib/__tests__/unit.test.ts": "it('works', () => {});",
      "dashboard/src/lib/unit.test.ts": "it('is outside __tests__, so jest never runs it', () => {});",
      "dashboard/__tests__/runs-script.test.ts": "execFileSync(process.execPath, [path.join(root, 'scripts/test-run.cjs')]);",
      "dashboard/__tests__/reads-script.test.ts": "const text = readFileSync('scripts/test-read-only.cjs', 'utf8');",
      "dashboard/__tests__/comment-only.test.ts": "// scripts/test-commented.cjs covers this\nspawnSync('true');",
      "dashboard/scripts/test-run.cjs": "",
      "dashboard/scripts/test-read-only.cjs": "",
      "dashboard/scripts/test-commented.cjs": "",
    });
    expect(orphanPaths(result)).toEqual([
      "dashboard/scripts/test-commented.cjs",
      "dashboard/scripts/test-read-only.cjs",
      "dashboard/src/lib/unit.test.ts",
    ]);
  });

  it("counts automatic workflows but not manual-only ones or comments", () => {
    const result = analyze({
      ".github/workflows/ci.yml": PR_WORKFLOW("      - run: python3 -I -B scripts/test-wired.py\n      # - run: python3 scripts/test-commented.py"),
      ".github/workflows/lab.yml": MANUAL_WORKFLOW("      - run: sudo python3 dashboard/scripts/test-manual.py"),
      "dashboard/scripts/test-wired.py": "",
      "dashboard/scripts/test-commented.py": "",
      "dashboard/scripts/test-manual.py": "",
    });
    expect(orphanPaths(result)).toEqual(["dashboard/scripts/test-commented.py", "dashboard/scripts/test-manual.py"]);
    const manual = result.orphans.find((orphan: { path: string }) => orphan.path === "dashboard/scripts/test-manual.py");
    expect(manual?.weak).toEqual(["manual-only workflow .github/workflows/lab.yml"]);
  });

  it("names a file by its shortest unique path, so same-named files stay distinct", () => {
    const result = analyze({
      ".github/workflows/ci.yml": PR_WORKFLOW("      - run: node --test services/a/test/index.test.mjs"),
      "services/a/test/index.test.mjs": "",
      "services/b/test/index.test.mjs": "",
      "dashboard/scripts/test-prepare.cjs": "",
      "dashboard/scripts/test-prepare-abandon.cjs": "",
      "dashboard/__tests__/abandon.test.ts": "execFileSync(node, ['scripts/test-prepare-abandon.cjs']);",
    });
    expect(orphanPaths(result)).toEqual(["dashboard/scripts/test-prepare.cjs", "services/b/test/index.test.mjs"]);
  });

  it("counts a package script only when an automatic workflow runs it in that package", () => {
    const result = analyze({
      ".github/workflows/workers.yml": PR_WORKFLOW(
        "      - run: npm test\n        working-directory: services/${{ matrix.worker }}\n    strategy:\n      matrix:\n        worker: [relay]",
      ),
      "services/relay/package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.mjs" } }),
      "services/relay/test/index.test.mjs": "",
      "services/sidecar/package.json": JSON.stringify({ scripts: { test: "node --test test/*.test.mjs" } }),
      "services/sidecar/test/routes.test.mjs": "",
      "dashboard/package.json": JSON.stringify({ scripts: { "test:journal": "node scripts/test-journal.cjs" } }),
      "dashboard/scripts/test-journal.cjs": "",
    });
    expect(orphanPaths(result)).toEqual(["dashboard/scripts/test-journal.cjs", "services/sidecar/test/routes.test.mjs"]);
    const journal = result.orphans.find((orphan: { path: string }) => orphan.path === "dashboard/scripts/test-journal.cjs");
    expect(journal?.weak).toEqual(['dashboard/package.json "test:journal" (no workflow runs it)']);
  });

  it("counts a Python module run from its own directory", () => {
    const result = analyze({
      ".github/workflows/ci.yml": PR_WORKFLOW("      - run: python3 -m unittest -v test_connector\n        working-directory: services/connector"),
      "services/connector/test_connector.py": "",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts each exemption category with a reason and rejects unknown or unexplained ones", () => {
    const files = {
      "dashboard/scripts/test-vm.py": "",
      "dashboard/scripts/test-live.ts": "",
      "dashboard/scripts/test-artifact.py": "",
      "dashboard/scripts/test-bad-category.py": "",
      "dashboard/scripts/test-no-reason.py": "",
      "services/sidecar/tests/a.test.ts": "",
      "services/sidecar/tests/b.test.ts": "",
    };
    const result = analyze(files, [
      { path: "dashboard/scripts/test-vm.py", category: "vm", reason: "Boots a disposable VM under real systemd." },
      { path: "dashboard/scripts/test-live.ts", category: "live", reason: "Calls a live partner API with a real key." },
      { path: "dashboard/scripts/test-artifact.py", category: "needs-artifact", reason: "Needs the pinned release tarball in /tmp." },
      { path: "services/sidecar/tests/", category: "not-in-ci", reason: "Vitest suite with no CI job yet; blocked on a missing workflow." },
      { path: "dashboard/scripts/test-bad-category.py", category: "flaky", reason: "Sometimes fails on the hosted runners." },
      { path: "dashboard/scripts/test-no-reason.py", category: "vm", reason: "vm" },
      { path: "dashboard/scripts/test-vm.py", category: "vm", reason: "The same file listed a second time." },
    ]);
    expect(result.exempted.map((entry: { path: string }) => entry.path).sort()).toEqual([
      "dashboard/scripts/test-artifact.py",
      "dashboard/scripts/test-live.ts",
      "dashboard/scripts/test-vm.py",
      "services/sidecar/tests/a.test.ts",
      "services/sidecar/tests/b.test.ts",
    ]);
    expect(result.problems).toEqual([
      expect.objectContaining({ kind: "invalid", path: "dashboard/scripts/test-bad-category.py", detail: expect.stringContaining('unknown category "flaky"') }),
      expect.objectContaining({ kind: "invalid", path: "dashboard/scripts/test-no-reason.py", detail: expect.stringContaining("needs a reason") }),
      expect.objectContaining({ kind: "invalid", path: "dashboard/scripts/test-vm.py", detail: "is listed twice" }),
    ]);
    expect(orphanPaths(result)).toEqual(["dashboard/scripts/test-bad-category.py", "dashboard/scripts/test-no-reason.py"]);
  });

  it("marks exemptions stale once the file is run or gone", () => {
    const result = analyze({
      ".github/workflows/ci.yml": PR_WORKFLOW("      - run: python3 scripts/test-now-wired.py && node --test services/sidecar/tests/a.test.mjs"),
      "dashboard/scripts/test-now-wired.py": "",
      "services/sidecar/tests/a.test.mjs": "",
    }, [
      { path: "dashboard/scripts/test-now-wired.py", category: "vm", reason: "Used to need a disposable VM." },
      { path: "dashboard/scripts/test-removed.py", category: "live", reason: "Probed a service that is gone." },
      { path: "services/sidecar/tests/", category: "not-in-ci", reason: "Vitest suite with no CI job yet." },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.map((problem: { kind: string; path: string }) => [problem.kind, problem.path])).toEqual([
      ["stale", "dashboard/scripts/test-now-wired.py"],
      ["stale", "dashboard/scripts/test-removed.py"],
      ["stale", "services/sidecar/tests/"],
    ]);
  });

  it("accepts a helper only when a test that CI runs names it", () => {
    const files = {
      "dashboard/__tests__/parent.test.ts": "execFileSync(node, ['scripts/test-parent.cjs']);",
      "dashboard/scripts/test-parent.cjs": "require('./test-helper.cjs');",
      "dashboard/scripts/test-helper.cjs": "",
      "dashboard/scripts/test-unwired-parent.cjs": "require('./test-other-helper.cjs');",
      "dashboard/scripts/test-other-helper.cjs": "",
      "dashboard/scripts/test-forgotten-helper.cjs": "",
    };
    const reason = "Imported by its parent test, not an entry point.";
    const result = analyze(files, [
      { path: "dashboard/scripts/test-helper.cjs", category: "helper", runBy: "dashboard/scripts/test-parent.cjs", reason },
      { path: "dashboard/scripts/test-other-helper.cjs", category: "helper", runBy: "dashboard/scripts/test-unwired-parent.cjs", reason },
      { path: "dashboard/scripts/test-forgotten-helper.cjs", category: "helper", runBy: "dashboard/scripts/test-parent.cjs", reason },
      { path: "dashboard/scripts/test-unwired-parent.cjs", category: "helper", reason },
    ]);
    expect(result.exempted.map((entry: { path: string }) => entry.path)).toEqual(["dashboard/scripts/test-helper.cjs"]);
    expect(result.problems.map((problem: { kind: string; path: string }) => [problem.kind, problem.path])).toEqual([
      ["invalid", "dashboard/scripts/test-other-helper.cjs"],
      ["stale", "dashboard/scripts/test-forgotten-helper.cjs"],
      ["invalid", "dashboard/scripts/test-unwired-parent.cjs"],
    ]);
  });

  it("reads workflow triggers in block and inline form, ignoring comments", () => {
    expect(workflowTriggers("on:\n  # push:\n  pull_request:\n    paths: ['a']\n  workflow_dispatch:\njobs: {}\n")).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflowTriggers("on: [push, workflow_dispatch]\njobs: {}\n")).toEqual(["push", "workflow_dispatch"]);
    expect(workflowTriggers("on: workflow_dispatch\njobs: {}\n")).toEqual(["workflow_dispatch"]);
    expect(workflowTriggers("'on':\n  merge_group:\n")).toEqual(["merge_group"]);
  });
});
