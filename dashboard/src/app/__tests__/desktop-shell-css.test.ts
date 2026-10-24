/** @jest-environment jsdom */
// The desktop-shell CSS has to work before React runs, so assert it against
// the real stylesheets rather than component state.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(__dirname, "..", "..", ...parts), "utf8");
const GLOBALS = read("app", "globals.css");

/** Every style rule (innermost block) as written, comments dropped.
 * jsdom cannot parse the whole files (container queries, color-mix, nesting). */
function styleRules(css: string): { selector: string; body: string }[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => !selector.includes("@"))
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));
}

/** Each comma-separated selector of every rule that styles a WebKit scrollbar. */
function scrollbarSelectors(css: string): string[] {
  return styleRules(css)
    .filter(({ selector }) => selector.includes("::-webkit-scrollbar"))
    .flatMap(({ selector }) => selector.split(",").map((part) => part.trim()));
}
const OUTSIDE_DESKTOP_SHELL = /^:where\(:root:not\(\[data-shell="desktop"\]\)\)/;

/** One declared value of the rule with exactly this selector. */
function declared(css: string, selector: string, property: string): string {
  const rule = styleRules(css).find((candidate) => candidate.selector === selector);
  expect(rule).toBeDefined();
  const value = rule!.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  expect(value).toBeDefined();
  return value!;
}

/** The rules whose selector names `target`, exactly as written. */
function rulesFor(css: string, target: string): string {
  const rules = styleRules(css)
    .filter(({ selector }) => selector.includes(target))
    .map(({ selector, body }) => `${selector} {${body}}`);
  expect(rules.length).toBeGreaterThan(0);
  return rules.join("\n");
}

function mount(css: string, markup: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = markup;
  return () => {
    style.remove();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-shell");
  };
}

const display = (selector: string) => getComputedStyle(document.querySelector(selector)!).display;

describe("desktop shell stylesheet", () => {
  let cleanup = () => {};
  afterEach(() => cleanup());

  it("hides web chrome only inside a desktop app", () => {
    const rules = rulesFor(GLOBALS, "[data-web-chrome]");
    cleanup = mount(rules, `
      <aside id="sidebar" data-web-chrome></aside>
      <header id="funnel" data-web-chrome=""></header>
      <main id="page"></main>
    `);
    expect(display("#sidebar")).not.toBe("none");
    expect(display("#funnel")).not.toBe("none");

    document.documentElement.setAttribute("data-shell", "desktop");
    expect(display("#sidebar")).toBe("none");
    expect(display("#funnel")).toBe("none");
    expect(display("#page")).not.toBe("none");
    // The phone bar sets display inline, which only an !important rule
    // outranks (jsdom's cascade does not model that, so assert the rule).
    expect(rules).toMatch(/display:\s*none\s*!important/);
  });

  it("shortens the hover fade and keeps the platform's overlay scrollbars in a desktop app only", () => {
    expect(GLOBALS).toMatch(/:root\[data-shell="desktop"\]\s*\{[^}]*--chrome-fade:\s*0\.12s/);
    expect(GLOBALS).toMatch(/transition: background-color var\(--chrome-fade, 0\.5s\) ease/);
    // Every selector of every custom scrollbar rule is scoped away from the
    // desktop app, whether the rule is written on one line or several.
    const selectors = scrollbarSelectors(GLOBALS);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toMatch(OUTSIDE_DESKTOP_SHELL);
  });

  it("would catch an unscoped one-line scrollbar rule", () => {
    const withUnscopedRule = `${GLOBALS}\n::-webkit-scrollbar { width: 4px; }\n`;
    expect(scrollbarSelectors(withUnscopedRule).filter((selector) => !OUTSIDE_DESKTOP_SHELL.test(selector)))
      .toEqual(["::-webkit-scrollbar"]);
  });

  it("fits the funnel bar and page to the window exactly in a desktop app", () => {
    const css = read("components", "public-site", "public-site.module.css");
    const desktop = ':global(:root[data-shell="desktop"])';
    const px = (value: string) => {
      expect(value).toMatch(/^\d+(?:px)?$/);
      return Number.parseInt(value, 10);
    };
    // With tools (get-started's language switcher), the bar is as tall as its
    // min-height or its padding plus the 44px switcher, whichever is more...
    const switcher = px(declared(css, ".funnelTools>div>button", "min-height"));
    const bar = Math.max(
      px(declared(css, `${desktop} .funnelBar`, "min-height")),
      px(declared(css, `${desktop} .funnelBar`, "padding-top")) + switcher,
    );
    // ...and the page takes exactly the rest, so nothing scrolls by the bar.
    expect(declared(css, `${desktop} .funnelPage`, "min-height")).toBe(`calc(100dvh - ${bar}px)`);
    // Without tools the whole bar is web chrome, hidden, and the page is the window.
    expect(declared(css, `${desktop} .funnelBar[data-web-chrome]+.funnelPage`, "min-height")).toBe("100dvh");
  });

  it("drops the resource bar's native actions strip when nothing was lifted into it", () => {
    const css = rulesFor(read("components", "hivra", "ResourceSurfaceNavigation.module.css"), ".nativeActions");
    cleanup = mount(css, `
      <div id="empty" class="nativeActions"></div>
      <div id="filled" class="nativeActions"><a href="/export">Export data</a></div>
    `);
    expect(display("#empty")).toBe("none");
    expect(display("#filled")).toBe("flex");
  });
});
