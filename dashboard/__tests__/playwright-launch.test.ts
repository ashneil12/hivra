import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { browserLaunchOptions, launchOptions } from "../scripts/lib/playwright-launch.cjs";

const DASHBOARD = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", ".jest-cache", "coverage", "playwright-report", "test-results"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    if (SKIP_DIRS.has(name) || name.startsWith("node_modules.")) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(c|m)?[jt]sx?$/.test(name) ? [full] : [];
  });
}

describe("Playwright launch options", () => {
  it("uses the installed Chrome with the sandbox on for local runs", () => {
    expect(browserLaunchOptions({})).toEqual({ channel: "chrome", chromiumSandbox: true });
    expect(launchOptions({ headless: true }, {})).toEqual({ channel: "chrome", chromiumSandbox: true, headless: true });
  });

  it("keeps Playwright's pinned build on CI", () => {
    expect(browserLaunchOptions({ CI: "true" })).toEqual({});
    expect(launchOptions({ headless: true }, { CI: "true" })).toEqual({ headless: true });
  });

  it("routes every dashboard Chromium launch through the shared options", () => {
    const unguarded = sourceFiles(DASHBOARD)
      .filter(file => !file.endsWith(path.join("scripts", "lib", "playwright-launch.cjs")))
      .flatMap(file =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${path.relative(DASHBOARD, file)}:${i + 1}` }))
          .filter(({ line }) => /chromium\.(launch|launchPersistentContext)\(/.test(line) && !line.includes("launchOptions(")),
      )
      .map(({ at }) => at);
    expect(unguarded).toEqual([]);
  });
});
