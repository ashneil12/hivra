import fs from "node:fs";
import path from "node:path";

// Hivra renders in the system faces (globals.css: --font-sans, --font-display,
// --font-mono). next/font preloads every font declared in the root layout on
// every route, so a Google font declared here would put woff2 files on the
// same constrained link as the render-blocking CSS for no visible gain.
const layout = fs.readFileSync(path.resolve(__dirname, "..", "layout.tsx"), "utf8");
const globals = fs.readFileSync(path.resolve(__dirname, "..", "globals.css"), "utf8");

describe("root layout fonts", () => {
  it("declares no next/font faces", () => {
    expect(layout).not.toMatch(/next\/font/);
  });

  it("names system faces for the sans, display and mono stacks", () => {
    expect(globals).toMatch(/--font-sans:\s*system-ui/);
    expect(globals).toMatch(/--font-display:\s*system-ui/);
    expect(globals).toMatch(/--font-mono:\s*ui-monospace/);
  });
});
