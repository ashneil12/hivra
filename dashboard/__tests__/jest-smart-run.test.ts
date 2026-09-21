import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- test exercises the shipped CommonJS entrypoint.
const { normalizeJestArgs, shouldForceRunTestsByPath } = require("../scripts/jest-smart-run.cjs");

function makeTempDashboard(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jest-smart-run-"));
}

function writeFile(filePath: string, content = "test"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("jest-smart-run", () => {
  it("forces runTestsByPath for existing bracketed test file paths", () => {
    const dashboardRoot = makeTempDashboard();
    const testPath = "src/app/api/instances/[id]/health/__tests__/route.test.ts";
    writeFile(path.join(dashboardRoot, testPath));

    expect(shouldForceRunTestsByPath([testPath], dashboardRoot)).toBe(true);
    expect(normalizeJestArgs([testPath], dashboardRoot)).toEqual([
      "--runTestsByPath",
      testPath,
    ]);
  });

  it("handles npm's -- separator and converts only the trailing test paths", () => {
    const dashboardRoot = makeTempDashboard();
    const testPath = "src/app/api/instances/[id]/health/__tests__/route.test.ts";
    writeFile(path.join(dashboardRoot, testPath));

    expect(
      normalizeJestArgs(["--runInBand", "--", testPath], dashboardRoot)
    ).toEqual(["--runInBand", "--runTestsByPath", testPath]);
  });

  it("keeps normal regex-style positional filters unchanged", () => {
    expect(shouldForceRunTestsByPath(["chat-stream"], process.cwd())).toBe(false);
    expect(normalizeJestArgs(["chat-stream"], process.cwd())).toEqual([
      "chat-stream",
    ]);
  });

  it("does not add runTestsByPath when Jest is already in an explicit path mode", () => {
    const dashboardRoot = makeTempDashboard();
    const testPath = "src/app/api/conversations/[conversationId]/__tests__/generate-title.route.test.ts";
    writeFile(path.join(dashboardRoot, testPath));

    expect(
      normalizeJestArgs(["--runTestsByPath", testPath], dashboardRoot)
    ).toEqual(["--runTestsByPath", testPath]);

    expect(
      normalizeJestArgs(["--findRelatedTests", "src/lib/response-text.ts"], dashboardRoot)
    ).toEqual(["--findRelatedTests", "src/lib/response-text.ts"]);
  });

  it("preserves other flags while switching exact test paths into runTestsByPath mode", () => {
    const dashboardRoot = makeTempDashboard();
    const testPath = "src/app/api/instances/[id]/health/__tests__/route.test.ts";
    writeFile(path.join(dashboardRoot, testPath));

    expect(
      normalizeJestArgs(["-t", "rejects empty chat bodies", testPath], dashboardRoot)
    ).toEqual([
      "--runTestsByPath",
      "-t",
      "rejects empty chat bodies",
      testPath,
    ]);
  });
});
