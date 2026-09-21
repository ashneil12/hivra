import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SIDECAR_ANCHOR_SCAN_ROOTS = [
  path.join(PACKAGE_ROOT, "src"),
  path.join(PACKAGE_ROOT, "caddy"),
  path.join(PACKAGE_ROOT, "docker"),
];

const EXPECTED_SIDECAR_ANCHORS = [
  {
    file: "src/server.ts",
    id: "server-watch",
    reference: "Habakkuk 2:1",
  },
  {
    file: "src/logger.ts",
    id: "log-light",
    reference: "Ephesians 5:13",
  },
  {
    file: "src/routes/health.ts",
    id: "health-days",
    reference: "Psalm 90:12",
  },
  {
    file: "src/auth/signed-url.ts",
    id: "signed-seal",
    reference: "Daniel 6:17",
  },
  {
    file: "src/auth/bearer.ts",
    id: "bearer-watch",
    reference: "Proverbs 4:23",
  },
  {
    file: "src/playwright/session-manager.ts",
    id: "session-stewards",
    reference: "1 Peter 4:10",
  },
  {
    file: "src/routes/_validate.ts",
    id: "validate-good",
    reference: "1 Thessalonians 5:21",
  },
  {
    file: "src/config.ts",
    id: "config-measure",
    reference: "Proverbs 24:3",
  },
  {
    file: "src/routes/navigation.ts",
    id: "nav-path",
    reference: "Proverbs 3:6",
  },
  {
    file: "src/routes/interaction.ts",
    id: "interaction-hands",
    reference: "Colossians 3:23",
  },
  {
    file: "src/routes/assertion.ts",
    id: "assert-true",
    reference: "Zechariah 8:16",
  },
  {
    file: "src/routes/capture.ts",
    id: "capture-remember",
    reference: "Psalm 77:11",
  },
  {
    file: "src/routes/flows.ts",
    id: "flows-river",
    reference: "Amos 5:24",
  },
  {
    file: "src/routes/novnc-verify.ts",
    id: "verify-gate",
    reference: "Psalm 118:20",
  },
  {
    file: "src/tier/revalidate.ts",
    id: "tier-fruit",
    reference: "Matthew 7:20",
  },
  {
    file: "src/imap/client.ts",
    id: "mail-answer",
    reference: "Proverbs 15:23",
  },
  {
    file: "caddy/Caddyfile",
    id: "caddy-wall",
    reference: "Nehemiah 4:6",
  },
  {
    file: "docker/entrypoint.sh",
    id: "entry-door",
    reference: "John 10:9",
  },
] as const;

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    return /\.(ts|sh)$/.test(entry.name) || entry.name === "Caddyfile" ? [fullPath] : [];
  });
}

function anchorCommentPrefix(filePath: string): string {
  if (filePath.endsWith(".sh") || filePath.endsWith("Caddyfile")) return "# SCRIPTURE_ANCHOR:";
  return "// SCRIPTURE_ANCHOR:";
}

describe("browser sidecar scripture architecture anchors", () => {
  it("keeps each sidecar anchor in the intended backend source file", () => {
    for (const anchor of EXPECTED_SIDECAR_ANCHORS) {
      const source = fs.readFileSync(path.join(PACKAGE_ROOT, anchor.file), "utf8");
      expect(source).toContain(
        `${anchorCommentPrefix(anchor.file)} ${anchor.id} | ${anchor.reference} | Verse: `
      );
    }
  });

  it("keeps sidecar anchors expected and comment-only", () => {
    const expectedFiles: Set<string> = new Set(EXPECTED_SIDECAR_ANCHORS.map((anchor) => anchor.file));
    const scanFiles = SIDECAR_ANCHOR_SCAN_ROOTS.flatMap(listSourceFiles);
    const offenders = scanFiles.flatMap((filePath) => {
      const relativePath = path.relative(PACKAGE_ROOT, filePath);
      const prefix = anchorCommentPrefix(relativePath);
      return fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .map((line, index) => ({ line, lineNumber: index + 1 }))
        .filter(({ line }) => line.includes("SCRIPTURE_ANCHOR:"))
        .filter(({ line }) => !line.trimStart().startsWith(prefix))
        .map(({ line, lineNumber }) => `${relativePath}:${lineNumber}: ${line.trim()}`);
    });

    const misplaced = scanFiles.flatMap((filePath) => {
      const relativePath = path.relative(PACKAGE_ROOT, filePath);
      if (expectedFiles.has(relativePath)) return [];
      if (!fs.readFileSync(filePath, "utf8").includes("SCRIPTURE_ANCHOR:")) return [];
      return [relativePath];
    });

    expect(offenders).toEqual([]);
    expect(misplaced).toEqual([]);
  });
});
