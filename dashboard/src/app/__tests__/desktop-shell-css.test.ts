/** @jest-environment jsdom */
// The desktop-shell CSS has to work before React runs, so assert it against
// the real stylesheets rather than component state.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(__dirname, "..", "..", ...parts), "utf8");
const GLOBALS = read("app", "globals.css");

/** The top-level rules whose selector names `target`, exactly as written.
 * jsdom cannot parse the whole files (container queries, color-mix, nesting). */
function rulesFor(css: string, target: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes(target) && !selector.includes("@"))
    .map(([, selector, body]) => `${selector.trim()} {${body}}`);
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
    // Every custom scrollbar rule is scoped away from the desktop app.
    const scrollbarSelectors = GLOBALS.replace(/\/\*[\s\S]*?\*\//g, "").match(/^[^\n{]*::-webkit-scrollbar[^\n{]*$/gm) ?? [];
    expect(scrollbarSelectors.length).toBeGreaterThan(0);
    for (const selector of scrollbarSelectors) {
      expect(selector).toMatch(/^:where\(:root:not\(\[data-shell="desktop"\]\)\)/);
    }
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
