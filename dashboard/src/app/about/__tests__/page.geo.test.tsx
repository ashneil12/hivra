/** @jest-environment jsdom */
/**
 * /about under the token geo-policy. The token sentences render only when the token surfaces are on
 * AND the viewer is not in a listed country (GB today), so a blocked viewer gets the same page as
 * with the switch off. These cases run against the COMMITTED country list, not the empty list
 * jest.setup.tsx gives other suites, so a list that stops reaching the page fails.
 * Pattern: lib/compliance/__tests__/token-surface-view.geo.test.ts and roadmap/__tests__/page.geo.test.tsx.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const mockHeaders = jest.fn();
jest.mock("next/headers", () => ({ ...jest.requireActual("next/headers"), headers: () => mockHeaders() }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: null })) }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
  },
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { NEW_TOKEN_SURFACES_ENV } from "@/lib/token-surfaces";

import AboutPage from "../page";

const saved = process.env[NEW_TOKEN_SURFACES_ENV];

function requestFrom(country?: string) {
  mockHeaders.mockReturnValue(new Headers(country ? { "x-vercel-ip-country": country } : {}));
}

function jsonLdText(container: HTMLElement): string {
  return [...container.querySelectorAll('script[type="application/ld+json"]')].map((node) => node.textContent ?? "").join("\n");
}

const TOKEN_WORDS = /\$HIVRA|token ecosystem|token pages|economic plans|wallet|litepaper/i;

beforeEach(() => {
  process.env[NEW_TOKEN_SURFACES_ENV] = "true";
});

afterEach(() => {
  if (saved === undefined) delete process.env[NEW_TOKEN_SURFACES_ENV];
  else process.env[NEW_TOKEN_SURFACES_ENV] = saved;
});

describe("/about with a country listed", () => {
  it("is running against a non-empty policy", () => {
    expect(isTokenGeoPolicyActive()).toBe(true);
  });

  it("gives a viewer in a listed country the page without any token sentence, link, question or markup", async () => {
    requestFrom("GB");
    const { container } = render(await AboutPage());
    const main = container.querySelector("main") as HTMLElement;
    expect(main.textContent).not.toMatch(TOKEN_WORDS);
    expect(jsonLdText(container)).not.toMatch(TOKEN_WORDS);
    expect(main.querySelector('a[href*="litepaper"], a[href="/token"]')).toBeNull();
    expect(screen.getByText("Do I need a token?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ecosystem map" })).toHaveAttribute("href", "/ecosystem");
    // The honest negation stays.
    expect(main).toHaveTextContent("Hivra's software can be self-hosted without buying or holding a token.");
  });

  it("hides the token links in the shared header and footer for that viewer too, and shows them elsewhere", async () => {
    requestFrom("GB");
    const blocked = render(await AboutPage());
    expect(screen.queryAllByRole("link", { name: /litepaper/i })).toHaveLength(0);
    expect(blocked.container.querySelector('a[href="/token"]')).toBeNull();
    blocked.unmount();

    requestFrom("US");
    render(await AboutPage());
    expect(screen.queryAllByRole("link", { name: /litepaper/i }).length).toBeGreaterThan(0);
  });

  it("shows the token sentences to a viewer anywhere else", async () => {
    requestFrom("US");
    const { container } = render(await AboutPage());
    const main = container.querySelector("main") as HTMLElement;
    expect(main).toHaveTextContent("Hivra also has a token and future economic plans");
    expect(main).toHaveTextContent("explained on the token pages");
    expect(screen.getByText("Do I need $HIVRA?")).toBeInTheDocument();
    expect(jsonLdText(container)).toContain("Do I need $HIVRA?");
    expect(main.querySelector('a[href="/docs/litepaper/index.html"]')).not.toBeNull();
  });

  it("does not block a request with no country (a self-hosted install has no edge)", async () => {
    requestFrom();
    const { container } = render(await AboutPage());
    expect(container.querySelector("main")).toHaveTextContent("Hivra also has a token and future economic plans");
  });

  it("reads no country and shows no token copy while the switch is off, whatever the viewer", async () => {
    process.env[NEW_TOKEN_SURFACES_ENV] = "false";
    requestFrom("US");
    mockHeaders.mockClear();
    const { container } = render(await AboutPage());
    expect(mockHeaders).not.toHaveBeenCalled();
    expect(container.querySelector("main")?.textContent).not.toMatch(TOKEN_WORDS);
  });
});
