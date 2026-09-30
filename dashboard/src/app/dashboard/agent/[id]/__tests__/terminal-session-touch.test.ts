import { readFileSync } from "node:fs";
import { join } from "node:path";

// The terminal session strip's add and close controls are icon-only; on a
// phone they were 28px wide, well under a fingertip.
describe("terminal session strip touch targets", () => {
  const css = readFileSync(join(__dirname, "..", "ResourceWorkspace.module.css"), "utf8");

  it("gives add and close 44px on coarse pointers", () => {
    expect(css).toMatch(/@media \(pointer: coarse\) \{ \.sessionClose, \.sessionAdd \{ min-width: 44px; min-height: 44px; \} \}/);
  });

  it("gives add and close 44px in the narrow workspace layout", () => {
    const narrow = css.slice(css.indexOf("@container resource-workspace (max-width: 600px)"));
    expect(narrow).toContain(".sessionTab > button:first-child, .sessionClose, .sessionAdd { min-height: 44px; }");
    expect(narrow).toContain(".sessionClose, .sessionAdd { min-width: 44px; }");
  });
});
