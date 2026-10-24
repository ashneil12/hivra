/** @jest-environment node */
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DESKTOP_SHELL_BOOTSTRAP } from "@/lib/desktop-shell";

jest.mock("next/font/google", () => {
  const font = (variable: string) => () => ({ variable, className: variable });
  return {
    Outfit: font("font-outfit"),
    Playfair_Display: font("font-playfair"),
    Space_Mono: font("font-mono"),
    Space_Grotesk: font("font-grotesk"),
  };
});
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Headers(),
}));
jest.mock("next/script", () => ({ __esModule: true, default: () => null }));
const passThrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
jest.mock("@/components/theme-provider", () => ({ ThemeProvider: passThrough }));
jest.mock("@/components/PreloadHandler", () => ({ PreloadHandler: () => null }));
jest.mock("@/components/DeferredGTM", () => ({ DeferredGTM: () => null }));
jest.mock("@/components/consent/CookieConsentBanner", () => ({ CookieConsentBanner: () => null }));
jest.mock("@/components/pwa/ServiceWorkerRegistration", () => ({ ServiceWorkerRegistration: () => null }));
jest.mock("../providers/OpsTelemetryProvider", () => ({ OpsTelemetryProvider: passThrough }));
jest.mock("../providers/PostHogProvider", () => ({ PostHogProvider: passThrough }));

import RootLayout from "../layout";

describe("root layout desktop shell signal", () => {
  it("inlines the desktop-shell script in <head>, so it runs before the body is parsed", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <main>page</main> }));
    const head = html.slice(html.indexOf("<head>") + "<head>".length, html.indexOf("</head>"));

    // Inline and synchronous: no src, async or defer that would let the body paint first.
    expect(head).toContain(`<script id="hivra-desktop-shell">${DESKTOP_SHELL_BOOTSTRAP}</script>`);
    expect(html.indexOf('id="hivra-desktop-shell"')).toBeLessThan(html.indexOf("<body"));
    // The attribute belongs to the browser: the server never renders it, so
    // cached HTML stays identical for every visitor.
    expect(html).not.toMatch(/<html[^>]*data-shell=/);
  });

  it("marks the page-wide noise overlay as web chrome", async () => {
    const html = renderToStaticMarkup(await RootLayout({ children: <main>page</main> }));
    expect(html).toMatch(/<div class="vellum-texture" data-web-chrome="true"><\/div>/);
  });
});
