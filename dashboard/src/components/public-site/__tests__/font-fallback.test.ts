/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";

const DASHBOARD = path.resolve(__dirname, "../../../..");
const css = readFileSync(path.join(DASHBOARD, "src/components/public-site/public-site.module.css"), "utf8");
const globals = readFileSync(path.join(DASHBOARD, "src/app/globals.css"), "utf8");

describe("public site fonts", () => {
  it("ships no web font: no @font-face and no Manrope or Plex Mono", () => {
    expect(css).not.toContain("@font-face");
    expect(css).not.toMatch(/Manrope|Plex Mono/);
  });

  it("uses the system stacks from the glass tokens", () => {
    expect(css).toContain("--public-font:var(--font-sans);");
    expect(css).toContain("--public-mono:var(--font-mono);");
    expect(globals).toMatch(/--font-sans:\s*system-ui, -apple-system/);
    expect(globals).toMatch(/--font-mono:\s*ui-monospace/);
  });

  it("sets headings in the display face", () => {
    expect(css).toContain(".site :where(h1,h2,h3,h4){font-family:var(--font-display)");
  });
});
