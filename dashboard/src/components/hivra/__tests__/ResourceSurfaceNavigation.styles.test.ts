import { readFileSync } from "node:fs";
import { join } from "node:path";

// Agent pages on a phone. The group buttons keep their words, and Export data,
// when it sits in the bar because Manage has no row of its own, shrinks to a
// 44px icon, so "Dashboard · Computer · Manage" plus Export fits a 375px screen.
describe("grouped surface bar on a phone", () => {
  const css = readFileSync(join(__dirname, "..", "ResourceSurfaceNavigation.module.css"), "utf8");
  const narrow = css.slice(css.indexOf("@container (max-width: 600px)"), css.indexOf("/* Grouped agent pages"));

  it("keeps the group buttons' words next to their icons", () => {
    expect(narrow).toContain('.navigation[data-grouped="true"] .primary .surface { min-width: 0; padding: 6px 10px; }');
    expect(narrow).toContain('.navigation[data-grouped="true"] .primary .surface svg { display: inline; }');
  });

  it("shows Export data in the bar as a 44px icon", () => {
    expect(narrow).toContain(".barExport { width: 44px; }");
    expect(narrow).toContain(".barExport > span { display: none; }");
  });

  it("lets a group's row scroll inside itself instead of widening the page", () => {
    expect(css).toMatch(/\.subnav \{[^}]*min-width: 0;[^}]*overflow-x: auto;/);
  });
});
