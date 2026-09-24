/** @jest-environment jsdom */
import {
  DESKTOP_SHELL_ATTRIBUTE,
  DESKTOP_SHELL_BOOTSTRAP,
  DESKTOP_SHELL_VALUE,
  detectDesktopShell,
  isDesktopShell,
} from "../desktop-shell";

const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

type Case = { name: string; userAgent: string; marker?: unknown; desktop: boolean };

// One table for the helper and the pre-paint script: they must never disagree.
const CASES: Case[] = [
  { name: "a plain browser", userAgent: CHROME, desktop: false },
  { name: "plain Safari", userAgent: SAFARI, desktop: false },
  { name: "the macOS alpha's user agent", userAgent: `${SAFARI} HivraMac/0.1`, desktop: true },
  { name: "a later desktop shell's user agent", userAgent: `${CHROME} HivraDesktop/1.4.2`, desktop: true },
  { name: "a desktop token at the start", userAgent: "HivraDesktop/2.0", desktop: true },
  { name: "the macOS alpha's workspace marker", userAgent: SAFARI, marker: { version: 1 }, desktop: true },
  { name: "a later marker version", userAgent: SAFARI, marker: { version: 2 }, desktop: true },
  { name: "a token inside another product name", userAgent: `${CHROME} NotHivraMac/1.0`, desktop: false },
  { name: "a longer product name", userAgent: `${CHROME} HivraMacintosh/1.0`, desktop: false },
  { name: "the product name without a version", userAgent: `${CHROME} HivraDesktop`, desktop: false },
  { name: "a marker that is not an object", userAgent: CHROME, marker: true, desktop: false },
  { name: "a null marker", userAgent: CHROME, marker: null, desktop: false },
];

type TestWindow = Window & { __HIVRA_NATIVE_WORKSPACE__?: unknown };

function setEnvironment({ userAgent, marker }: { userAgent: string; marker?: unknown }) {
  Object.defineProperty(window.navigator, "userAgent", { value: userAgent, configurable: true });
  const host = window as TestWindow;
  if (marker === undefined) delete host.__HIVRA_NATIVE_WORKSPACE__;
  else host.__HIVRA_NATIVE_WORKSPACE__ = marker;
}

function runBootstrap() {
  // The layout inlines this exact text into <head>; run it as the parser would.
  new Function(DESKTOP_SHELL_BOOTSTRAP)();
}

describe("desktop shell detection", () => {
  afterEach(() => {
    delete (window.navigator as unknown as Record<string, unknown>).userAgent;
    delete (window as TestWindow).__HIVRA_NATIVE_WORKSPACE__;
    document.documentElement.removeAttribute(DESKTOP_SHELL_ATTRIBUTE);
  });

  it.each(CASES)("$name → desktop: $desktop (helper and pre-paint script agree)", (testCase) => {
    setEnvironment(testCase);

    expect(detectDesktopShell({ __HIVRA_NATIVE_WORKSPACE__: testCase.marker, navigator: { userAgent: testCase.userAgent } }))
      .toBe(testCase.desktop);
    expect(isDesktopShell()).toBe(testCase.desktop);

    runBootstrap();
    expect(document.documentElement.getAttribute(DESKTOP_SHELL_ATTRIBUTE))
      .toBe(testCase.desktop ? DESKTOP_SHELL_VALUE : null);
  });

  it("leaves an ordinary browser's document untouched", () => {
    setEnvironment({ userAgent: CHROME });
    const before = document.documentElement.outerHTML;
    runBootstrap();
    expect(document.documentElement.outerHTML).toBe(before);
  });

  it("never throws, even when the browser hides its user agent or the marker throws", () => {
    Object.defineProperty(window.navigator, "userAgent", { value: undefined, configurable: true });
    expect(() => runBootstrap()).not.toThrow();
    expect(detectDesktopShell({ navigator: {} })).toBe(false);
    expect(detectDesktopShell({})).toBe(false);

    Object.defineProperty(window, "__HIVRA_NATIVE_WORKSPACE__", {
      configurable: true,
      get() { throw new Error("hostile getter"); },
    });
    expect(() => runBootstrap()).not.toThrow();
    expect(isDesktopShell()).toBe(false);
    expect(document.documentElement.hasAttribute(DESKTOP_SHELL_ATTRIBUTE)).toBe(false);
  });

  it("stays a small, self-contained script with no dependency on the bundle", () => {
    expect(DESKTOP_SHELL_BOOTSTRAP.length).toBeLessThan(400);
    expect(DESKTOP_SHELL_BOOTSTRAP).not.toMatch(/require\(|import\s|__webpack|document\.cookie|fetch\(|postMessage/);
  });
});
