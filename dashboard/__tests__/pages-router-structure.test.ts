import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

function collectFiles(rootDir: string): string[] {
  const entries = readdirSync(rootDir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

describe("legacy pages router structure", () => {
  it("keeps src/pages reserved for API routes only", () => {
    const pagesDir = path.join(process.cwd(), "src", "pages");
    if (!existsSync(pagesDir)) {
      expect(pagesDir).not.toBe("");
      return;
    }

    const files = collectFiles(pagesDir).map((fullPath) => path.relative(pagesDir, fullPath));
    const nonApiFiles = files.filter((relativePath) => !relativePath.startsWith(`api${path.sep}`));

    expect(nonApiFiles).toEqual([]);
  });
});
