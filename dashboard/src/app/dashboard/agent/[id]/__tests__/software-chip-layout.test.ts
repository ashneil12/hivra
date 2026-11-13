import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Update available" beside the agent's name now sits in the floating pill's
// dropdown header, which is wide enough for the chip's full words, so the old
// short-word rule for a narrow title bar is gone and must not come back unused.
describe("the software chip in the agent page's floating pill", () => {
  const root = join(__dirname, "..", "..", "..", "..", "..", "components", "hivra");
  const pill = readFileSync(join(root, "agent-shell", "AgentPill.tsx"), "utf8");
  const pillCss = readFileSync(join(root, "agent-shell", "AgentPill.module.css"), "utf8");
  const shell = readFileSync(join(root, "agent-shell", "AgentShell.tsx"), "utf8");

  it("draws the chip in the dropdown header, beside the status", () => {
    expect(pill).toContain("styles.head");
    expect(pill).toContain("{extras ? (");
    expect(pill).toContain("className={styles.extras}");
    expect(shell).toContain("extras={titleExtras}");
  });

  it("lets the chip keep its full words: the dropdown never hides them", () => {
    expect(pillCss).not.toContain("data-chip-text");
    expect(pillCss).not.toContain("data-chip-short");
  });

  it("keeps the column a size container, and a positioning box for the pill and its dropdown", () => {
    const column = readFileSync(join(root, "agent-shell", "AgentShell.module.css"), "utf8");
    expect(column).toMatch(/\.column \{[^}]*container-type: inline-size/);
    expect(column).toMatch(/\.column \{[^}]*position: relative/);
  });
});
