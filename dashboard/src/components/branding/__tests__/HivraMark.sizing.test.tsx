/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium, type Browser } from "@playwright/test";

import LandingHeader, { FunnelHeader } from "@/components/layout/LandingHeader";

// Every stylesheet resolves to one style mock, so this makes each CSS module
// class name equal to its key. The real stylesheets below then apply to the
// real component markup.
jest.mock("../../public-site/public-site.module.css", () =>
  new Proxy({}, { get: (_target, key) => (key === "__esModule" ? false : typeof key === "string" ? key : undefined) }),
);

jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>{children}</a>
  );
  return MockLink;
});

jest.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => <button type="button">Theme</button> }));

const readCss = (relative: string) =>
  readFileSync(path.join(__dirname, relative), "utf8").replace(/:global\(([^)]*)\)/g, "$1");

const PUBLIC_SITE_CSS = readCss("../../public-site/public-site.module.css");

/**
 * Layout width of every approved mark in the markup, at one viewport width.
 * offsetWidth, so a transformed ancestor never changes the size measured.
 */
async function markWidths(browser: Browser, css: string, element: ReactElement, width: number): Promise<number[]> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  try {
    await page.route("**/*", (route) => route.abort());
    await page.setContent(`<style>${css}</style>${renderToStaticMarkup(element)}`);
    return await page.$$eval("[data-testid=hivra-mark]", (marks) =>
      marks.map((mark) => (mark as HTMLElement).offsetWidth),
    );
  } finally {
    await page.close();
  }
}

// HivraMark is an <img>. The breakpoint rules that shrink it must select that
// element: rules left on `svg` silently keep the width/height attributes.
describe("approved mark sizing at breakpoints", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([
    [1280, 32],
    [1000, 32],
    [681, 32],
    [680, 27],
    [600, 27],
    [320, 27],
  ])("site header mark at %ipx is %ipx", async (width, expected) => {
    expect(await markWidths(browser, PUBLIC_SITE_CSS, <LandingHeader isSignedIn={false} />, width)).toEqual([expected]);
  }, 20_000);

  it.each([1280, 600, 320])("funnel bar mark is 28px at %ipx, linked or not", async (width) => {
    const bars = (
      <>
        <FunnelHeader homeHref="/" />
        <FunnelHeader />
      </>
    );
    expect(await markWidths(browser, PUBLIC_SITE_CSS, bars, width)).toEqual([28, 28]);
  }, 20_000);
});
