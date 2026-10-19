import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Update available" beside the agent's name in the surface bar. Above 900px
// the identity cluster was a fixed 280px, so the chip (which never shrinks)
// cut the agent's own name to a few letters; on a phone its words were hidden,
// leaving an unlabelled icon.
describe("the software chip in the agent page's surface bar", () => {
  const css = readFileSync(join(__dirname, "..", "ResourceWorkspace.module.css"), "utf8");
  const chipCss = readFileSync(join(__dirname, "..", "..", "..", "..", "..", "components", "hivra", "AgentSoftwareChip.module.css"), "utf8");

  it("lets the identity grow to fit the name and the chip on wide pages, only while the chip shows", () => {
    const wide = css.slice(css.indexOf("@container resource-workspace (width > 900px)"));
    expect(wide).toMatch(/^@container resource-workspace \(width > 900px\) \{\s*\.identity:has\(> \.softwareChip:not\(:empty\)\) \{ flex: 0 1 auto; max-width: 45%; \}\s*\}/);
    // The narrow layout's own identity rule (a full row) stays untouched by it.
    const narrow = css.slice(css.indexOf("@container resource-workspace (max-width: 900px)"));
    expect(narrow).toContain(".identity { flex-basis: 100%; max-width: none;");
  });

  it("keeps a short word next to the icon on a phone", () => {
    const phone = css.slice(css.indexOf("@container resource-workspace (max-width: 600px)"));
    expect(phone).toContain(".softwareChip [data-chip-text] { display: none; }");
    expect(phone).toContain(".softwareChip [data-chip-short] { display: inline; }");
    // Hidden everywhere else by the chip's own stylesheet, which the phone rule outranks.
    expect(chipCss).toMatch(/^\.short \{ display: none; \}$/m);
  });
});
