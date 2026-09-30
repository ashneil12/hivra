/** @jest-environment node */
import { existsSync } from "node:fs";
import path from "node:path";
import nextConfig, { tokenGeoRewrites } from "../../next.config";

const REPO = path.resolve(__dirname, "../../..");

describe("token-free static documents for listed countries", () => {
  it("rewrites each token-bearing static document, only for a listed country header", () => {
    const rules = tokenGeoRewrites(["GB"]);
    expect(rules.map(({ source, destination }) => [source, destination])).toEqual([
      ["/docs/litepaper/index.html", "/docs/litepaper/restricted.html"],
      ["/LITEPAPER.md", "/restricted/LITEPAPER.md"],
      ["/WHITEPAPER.md", "/restricted/WHITEPAPER.md"],
      ["/TOKENOMICS.md", "/restricted/TOKENOMICS.md"],
    ]);
    for (const rule of rules) {
      expect(rule.has).toEqual([{ type: "header", key: "x-vercel-ip-country", value: "(?:GB)" }]);
    }
  });

  it("does nothing while the list is empty, so every viewer gets the full documents", () => {
    expect(tokenGeoRewrites([])).toEqual([]);
  });

  it("runs before the filesystem, so it applies to files served from public/", async () => {
    const rewrites = (await nextConfig.rewrites?.()) as { beforeFiles: unknown[]; afterFiles: unknown[] };
    expect(Array.isArray(rewrites.beforeFiles)).toBe(true);
    expect(rewrites.beforeFiles).toEqual(tokenGeoRewrites());
    expect(rewrites.afterFiles.length).toBeGreaterThan(0);
  });

  it("points at documents that are committed, so a rewrite never lands on a missing file", () => {
    for (const file of ["restricted.html", "restricted/LITEPAPER.md", "restricted/WHITEPAPER.md", "restricted/TOKENOMICS.md"]) {
      expect(existsSync(path.join(REPO, "docs/litepaper", file))).toBe(true);
    }
  });
});
