/**
 * Guards for billing CSS that jsdom cannot check (it applies no stylesheets):
 * the tab focus ring and small red text contrast. A real browser check of
 * the same rules lives in the preview harness; these keep the rules from
 * being undone by an edit.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { DANGER_INK } from "../_components/BillingAlerts";

const root = path.resolve(__dirname, "../../../../..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const BILLING_CSS = "src/app/dashboard/billing/Billing.module.css";
const PANELS_CSS = "src/components/billing/BillingPanels.module.css";
const TABS_CSS = "src/components/ui/Tabs.module.css";

/** Innermost `selector { declarations }` blocks, comments removed. */
function rules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return Array.from(clean.matchAll(/([^{}]+)\{([^{}]*)\}/g), (match) => ({
    selector: match[1].trim(),
    body: match[2],
  }));
}

describe("billing focus rings", () => {
  it("keeps the page-wide outset ring off the tabs, whose list scrolls and would clip it", () => {
    const pageRule = rules(read(BILLING_CSS)).find(
      (rule) => rule.selector.startsWith(".page :is(") && rule.selector.endsWith(":focus-visible")
    );
    expect(pageRule?.selector).toContain(':where(:not([role="tab"]))');
    expect(pageRule?.body).toMatch(/outline-offset:\s*3px/);

    const tabRule = rules(read(TABS_CSS)).find((rule) => rule.selector === ".tab:focus-visible");
    expect(tabRule?.body).toMatch(/outline-offset:\s*-3px/);
  });
});

describe("small red text contrast", () => {
  it.each([BILLING_CSS, PANELS_CSS])(
    "uses the plain danger token only for icons in %s (text uses the darkened ink)",
    (file) => {
      const plainTokenText = rules(read(file)).filter((rule) =>
        /(^|[\s;])color:\s*var\(--skills-danger-text\)/.test(rule.body)
      );
      for (const rule of plainTokenText) {
        expect(rule.selector).toMatch(/icon/i);
      }
    }
  );

  it("darkens the danger token with ink for text", () => {
    expect(read(BILLING_CSS)).toContain(
      "--billing-danger-ink: color-mix(in srgb, var(--skills-danger-text) 78%, var(--ink-black))"
    );
    const negative = rules(read(PANELS_CSS)).find((rule) => rule.selector === ".toneNegative");
    expect(negative?.body).toContain("color-mix(in srgb, var(--skills-danger-text) 78%, var(--ink-black))");
    // The "Report a problem" link in the danger alert is styled inline.
    expect(DANGER_INK).toBe("color-mix(in srgb, var(--skills-danger-text) 78%, var(--ink-black))");
  });
});
