import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Update available" beside the agent's name in the title bar. On a phone its
// words were hidden, leaving an unlabelled icon, so the bar keeps a short word.
describe("the software chip in the agent page's title bar", () => {
  const root = join(__dirname, "..", "..", "..", "..", "..", "components", "hivra");
  const css = readFileSync(join(root, "agent-shell", "AgentTitleBar.module.css"), "utf8");
  const chipCss = readFileSync(join(root, "AgentSoftwareChip.module.css"), "utf8");

  it("keeps a short word next to the icon in a narrow title bar", () => {
    const narrow = css.slice(css.indexOf("The \"Update available\" chip"));
    expect(narrow).toContain(".bar [data-chip-text] { display: none; }");
    expect(narrow).toContain(".bar [data-chip-short] { display: inline; }");
    // Hidden everywhere else by the chip's own stylesheet, which the narrow rule outranks.
    expect(chipCss).toMatch(/^\.short \{ display: none; \}$/m);
  });

  it("measures the title bar's own width, not the page's, so an open sidebar does not trip it early", () => {
    expect(css).toMatch(/@container \(max-width: 640px\)/);
    expect(readFileSync(join(root, "agent-shell", "AgentShell.module.css"), "utf8")).toMatch(/\.column \{[^}]*container-type: inline-size/);
  });
});
