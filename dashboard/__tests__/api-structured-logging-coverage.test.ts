import fs from "node:fs";
import path from "node:path";

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const CONSOLE_CALL_PATTERN = /\bconsole\.(?:log|warn|error|info|debug)\b/;

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "__mocks__") return [];
      return listSourceFiles(fullPath);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  });
}

describe("API structured logging coverage", () => {
  it("keeps API route handlers off raw console logging", () => {
    const offenders = listSourceFiles(API_ROOT).flatMap((filePath) => {
      const relativePath = path.relative(process.cwd(), filePath);
      return fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => CONSOLE_CALL_PATTERN.test(line))
        .map(({ line, lineNumber }) => `${relativePath}:${lineNumber}: ${line.trim()}`);
    });

    expect(offenders).toEqual([]);
  });
});
