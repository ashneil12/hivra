/** @jest-environment jsdom */
/**
 * /roadmap under the token geo-policy. The plan has a few token sentences (the pay-by-card
 * note, the migration, the launchpad research, the litepaper link), so a viewer in a listed
 * country gets the same plan without them. Dormant, the page reads nothing from the request.
 * These cases run against the COMMITTED country list (GB), not the empty list jest.setup.tsx
 * gives other suites, so a list that stops reaching the page fails.
 */
import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { render, screen, within } from "@testing-library/react";

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

import { auth } from "@clerk/nextjs/server";

import RoadmapPage from "../page";
import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { ROADMAP_NEGATIONS } from "@/lib/roadmap-content";

// The project's own token words (docs/litepaper/restrict.py) plus the wallet, launch and migration words the roadmap uses.
const TOKEN_WORDS =
  /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b|wallets?|x402|on-chain|cryptocurrenc|launchpad|litepaper|snapshot|airdrop|Sablier|migration/i;

function viewerFrom(country: string | null) {
  mockHeaders.mockResolvedValue(new Headers(country ? { "x-vercel-ip-country": country } : {}));
}

async function renderPage() {
  const result = render(await RoadmapPage());
  // The shared header and footer have their own headings and links; the plan is inside <main>.
  const main = within(result.container.querySelector("main") as HTMLElement);
  return { ...result, main };
}

/** The page's own text with the three "you do not need a token" sentences the copy rules allow taken out. */
function readableMainText(container: HTMLElement): string {
  let text = container.querySelector("main")?.textContent ?? "";
  for (const negation of ROADMAP_NEGATIONS) text = text.split(negation).join("");
  return text;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: null } as never);
});

describe("dormant policy", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []));

  it("renders the whole roadmap without reading the request", async () => {
    viewerFrom("GB");
    await renderPage();
    expect(screen.getByRole("heading", { level: 3, name: "A possible launchpad and builder programme" })).toBeInTheDocument();
    expect(mockHeaders).not.toHaveBeenCalled();
  });
});

describe("the committed country list (GB)", () => {
  it("is what the page reads: GB is listed", () => {
    expect(TOKEN_GEO_POLICY.blockedCountries).toContain("GB");
  });

  it("gives a GB viewer the plan with no token section, no token sentence and no token link", async () => {
    viewerFrom("GB");
    const { container } = await renderPage();

    // The page itself. The site-wide footer has a "Token" link on every public page (the
    // /token page is factual and shows the notice), so it is left out of this scan.
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(readableMainText(container)).not.toMatch(TOKEN_WORDS);
    for (const anchor of main?.querySelectorAll("a") ?? []) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/token|bankr|litepaper/i);
    }
    expect(within(main as HTMLElement).queryByRole("link", { name: /litepaper/i })).not.toBeInTheDocument();
    expect(within(main as HTMLElement).queryByRole("heading", { level: 3, name: /launchpad/i })).not.toBeInTheDocument();
    // The only token words left are the short "you do not need a token" sentences.
    const leftover = (main?.textContent ?? "").match(/\btokens?\b/gi) ?? [];
    expect(leftover).toHaveLength(ROADMAP_NEGATIONS.length);
  });

  it("still gives that viewer the rest of the roadmap: the four stages, their topics, the notes and the close", async () => {
    viewerFrom("GB");
    const { main } = await renderPage();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("The Hivra roadmap.");
    expect(main.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Available today",
      "Next: make the computer easier to trust and easier to use",
      "Then: the supporting pieces",
      "Research: where this could lead",
      "What happened to the original 2026 plan?",
      "How to read progress",
      "Build with us",
    ]);
    expect(main.getAllByRole("heading", { level: 3 })).toHaveLength(8);
    expect(main.getByText("Gate: clearer authority for agents")).toBeInTheDocument();
    expect(main.getByRole("link", { name: /^get started/i })).toHaveAttribute("href", "/sign-up");
    expect(main.getByRole("link", { name: /^start a computer/i })).toHaveAttribute("href", "/sign-up");
    // The card path stays, worded for everyone.
    expect(screen.getByText(/Hivra Cloud has ordinary subscription pricing\./)).toBeInTheDocument();
  });

  it("gives a viewer from elsewhere, or with no country, the full roadmap", async () => {
    for (const country of ["FR", null]) {
      viewerFrom(country);
      const { main, unmount } = await renderPage();
      expect(main.getByRole("heading", { level: 3, name: "A possible launchpad and builder programme" })).toBeInTheDocument();
      expect(main.getByText(/During the migration from \$HermesOS to \$HIVRA/)).toBeInTheDocument();
      expect(main.getAllByRole("link", { name: /litepaper/i }).length).toBeGreaterThanOrEqual(2);
      unmount();
    }
  });

  it("gives a signed-in ops admin in the UK the full roadmap, as the other token pages do", async () => {
    const original = process.env.OPS_ADMIN_USER_IDS;
    // An obviously fake ID: the repo is public and no real admin is named.
    process.env.OPS_ADMIN_USER_IDS = "user_ops_admin_test";
    jest.mocked(auth).mockResolvedValue({ userId: "user_ops_admin_test" } as never);
    try {
      viewerFrom("GB");
      await renderPage();
      expect(screen.getByRole("heading", { level: 3, name: "A possible launchpad and builder programme" })).toBeInTheDocument();
    } finally {
      if (original === undefined) delete process.env.OPS_ADMIN_USER_IDS;
      else process.env.OPS_ADMIN_USER_IDS = original;
    }
  });
});

describe("the browser bundle", () => {
  const appDir = path.resolve(__dirname, "..");

  it("is rendered on the server only, so a viewer who cannot see token copy is never sent it", () => {
    for (const file of [
      path.join(appDir, "page.tsx"),
      path.join(appDir, "RoadmapView.tsx"),
      path.resolve(appDir, "../../lib/inline-copy.tsx"),
      path.resolve(appDir, "../../lib/roadmap-content.ts"),
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("keeps the full copy in one place, resolved per viewer before it reaches the view", () => {
    const view = readFileSync(path.join(appDir, "RoadmapView.tsx"), "utf8");
    // The view takes the resolved roadmap; it never imports the content value itself.
    expect(view).not.toMatch(/import\s+\{[^}]*\broadmapContent\b[^}]*\}\s+from/);
    const page = readFileSync(path.join(appDir, "page.tsx"), "utf8");
    expect(page).toMatch(/resolveRoadmap\(tokenSurfacesVisible\(view\)\)/);
  });
});

describe("the page chrome", () => {
  it("shows the shared header and footer around the plan", async () => {
    viewerFrom("GB");
    const { container } = await renderPage();
    expect(within(container).getByRole("main")).toBeInTheDocument();
    expect(container.querySelector("[data-public-site]")).not.toBeNull();
  });
});
