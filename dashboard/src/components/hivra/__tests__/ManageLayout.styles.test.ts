import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGE_SIDE_NAV_MIN_WIDTH } from "../ManageLayout";

// Manage's layout rules, which jsdom can't apply: the pane is its own
// container, the section nav is a sticky strip on a phone and a sticky side
// nav from 760px, and every section tab keeps a 44px target.

const css = readFileSync(join(__dirname, "..", "ManageLayout.module.css"), "utf8");
const tabs = readFileSync(join(__dirname, "..", "..", "ui", "Tabs.module.css"), "utf8");

function rule(source: string, selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(source);
  return match?.[1] ?? "";
}

describe("Manage layout", () => {
  it("follows the width Manage is given, not the viewport", () => {
    expect(rule(css, ".root")).toMatch(/container:\s*manage\s*\/\s*inline-size/);
    expect(rule(css, ".root")).toMatch(/overflow-y:\s*auto/);
    expect(rule(css, ".root")).toMatch(/overflow-x:\s*hidden/);
  });

  it("keeps the section strip at the top of the scroller on a phone", () => {
    expect(rule(css, ".nav")).toMatch(/position:\s*sticky/);
    expect(rule(css, ".nav")).toMatch(/top:\s*0/);
    expect(rule(css, ".nav")).toMatch(/background:\s*var\(--vellum-bg\)/);
  });

  it("turns into a side nav beside sections of at most 720px from the same width the page measures", () => {
    expect(MANAGE_SIDE_NAV_MIN_WIDTH).toBe(760);
    const wide = css.slice(css.indexOf(`@container manage (min-width: ${MANAGE_SIDE_NAV_MIN_WIDTH}px)`));
    expect(wide).toContain("grid-template-columns: 196px minmax(0, 720px);");
    expect(rule(css, ".inner")).toMatch(/max-width:\s*1040px/);
  });

  it("keeps hidden sections out of the layout", () => {
    expect(rule(css, ".panel[hidden]")).toMatch(/display:\s*none/);
  });

  it("gives section tabs a 44px target in both orientations", () => {
    expect(rule(tabs, ".tab")).toMatch(/min-height:\s*48px/);
    expect(rule(tabs, '.bar[data-orientation="vertical"] .tab')).toMatch(/min-height:\s*44px/);
    expect(rule(tabs, '.bar[data-orientation="vertical"] .list')).toMatch(/mask-image:\s*none/);
  });
});
