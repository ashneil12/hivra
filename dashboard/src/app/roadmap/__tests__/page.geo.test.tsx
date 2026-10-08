/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
/**
 * /roadmap under the token geo-policy. The April 2026 plan carries a whole token
 * section and token lines in its phases, so a viewer in a listed country gets
 * the same plan without them. Dormant, the page renders synchronously as before.
 * These cases run against the COMMITTED country list (GB), not the empty list
 * jest.setup.tsx gives other suites, so a list that stops reaching the page fails.
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
jest.mock("next/image", () => {
  const MockImage = ({ src, alt, ...rest }: { src: string; alt: string; [key: string]: unknown }) => (
    <img src={src} alt={alt} {...rest} />
  );
  MockImage.displayName = "MockImage";
  return MockImage;
});
jest.mock("@/components/InteractiveBackground", () => function MockInteractiveBackground() {
  return null;
});
jest.mock("@/components/theme-toggle", () => ({
  ThemeToggle: () => <button data-testid="theme-toggle">Theme</button>,
}));
jest.mock("framer-motion", () => {
  const motionOnlyProps = new Set(["initial", "animate", "exit", "whileInView", "transition", "viewport"]);
  const createComponent = (tag: keyof React.JSX.IntrinsicElements) => {
    const MockMotionComponent = React.forwardRef(
      ({ children, ...props }: React.HTMLAttributes<HTMLElement> & Record<string, unknown>, ref: React.Ref<HTMLElement>) => {
        const domProps = Object.fromEntries(Object.entries(props).filter(([name]) => !motionOnlyProps.has(name)));
        return React.createElement(tag, { ...domProps, ref }, children as React.ReactNode);
      }
    );
    MockMotionComponent.displayName = `MockMotion(${tag})`;
    return MockMotionComponent;
  };
  return {
    motion: {
      div: createComponent("div"),
      section: createComponent("section"),
      header: createComponent("header"),
      nav: createComponent("nav"),
      span: createComponent("span"),
      p: createComponent("p"),
      h1: createComponent("h1"),
      h2: createComponent("h2"),
      h3: createComponent("h3"),
      ul: createComponent("ul"),
      li: createComponent("li"),
      a: createComponent("a"),
      button: createComponent("button"),
    },
    useScroll: () => ({ scrollYProgress: 0 }),
    useTransform: () => 0,
    useReducedMotion: () => true,
  };
});

import { auth } from "@clerk/nextjs/server";

import RoadmapPage from "../page";
import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";

// The project's own token words (docs/litepaper/restrict.py) plus the wallet and payment words the roadmap uses.
const TOKEN_WORDS = /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b|wallets?|x402|on-chain|cryptocurrenc/i;

function viewerFrom(country: string | null) {
  mockHeaders.mockResolvedValue(new Headers(country ? { "x-vercel-ip-country": country } : {}));
}

/** Renders a page that may be sync (dormant) or async (policy active). */
async function renderPage() {
  const element = (RoadmapPage as () => unknown)();
  return render((element instanceof Promise ? await element : element) as React.ReactElement);
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: null } as never);
});

describe("dormant policy", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []));

  it("renders the whole roadmap synchronously, without reading the request", async () => {
    viewerFrom("GB");
    expect((RoadmapPage as () => unknown)()).not.toBeInstanceOf(Promise);
    await renderPage();
    expect(screen.getByRole("heading", { level: 2, name: /fair launch\. community owned\./i })).toBeInTheDocument();
    expect(mockHeaders).not.toHaveBeenCalled();
  });
});

describe("the committed country list (GB)", () => {
  it("is what the page reads: GB is listed", () => {
    expect(TOKEN_GEO_POLICY.blockedCountries).toContain("GB");
  });

  it("gives a GB viewer the plan with no token section, no token line and no token link", async () => {
    viewerFrom("GB");
    const { container } = await renderPage();

    // The page itself: its main content and its chapter links. The site-wide
    // footer has a "Token" link on every public page (the /token page is
    // factual and shows the notice), so it is left out of this scan.
    const roadmapNav = screen.getByRole("navigation", { name: /roadmap navigation/i });
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(`${roadmapNav.textContent} ${main?.textContent}`).not.toMatch(TOKEN_WORDS);
    expect(container.querySelector("#hermesos-token")).toBeNull();
    for (const anchor of [...roadmapNav.querySelectorAll("a"), ...(main?.querySelectorAll("a") ?? [])]) {
      expect(anchor.getAttribute("href") ?? "").not.toMatch(/token|bankr/i);
    }
    expect(roadmapNav.querySelectorAll("a")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: /token verification/i })).not.toBeInTheDocument();
    expect(screen.queryByText("TOKEN UTILITY")).not.toBeInTheDocument();
  });

  it("still gives that viewer the rest of the roadmap: what is live, the vision and all four phases", async () => {
    viewerFrom("GB");
    const { container } = await renderPage();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Hivra Product Roadmap 2026$/);
    expect(screen.getByRole("link", { name: /deploy hivra/i })).toHaveAttribute("href", "/sign-up");
    expect(screen.getByRole("heading", { level: 2, name: /what is live today/i })).toBeInTheDocument();
    expect(screen.getByText("Agents on their own computers")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "From deployment to operators" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "From isolated agents to a connected network" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3, name: "From platform to economy" })).not.toBeInTheDocument();
    for (const tag of ["Phase 1", "Phase 2", "Phase 3", "Phase 4"]) expect(screen.getByText(tag)).toBeInTheDocument();
    expect(screen.getByText("Flagship Operator Packs")).toBeInTheDocument();
    expect(screen.getByText("Operator Marketplace")).toBeInTheDocument();
    expect(screen.queryByText(/Card and Token Access/i)).not.toBeInTheDocument();
    // The card path stays, worded for everyone.
    expect(within(container).getByText(/Get started with a standard subscription using a credit card\./)).toBeInTheDocument();
    // The section numbers run on without a gap.
    expect(screen.getByText("05 · ROADMAP")).toBeInTheDocument();
    expect(screen.getByText("06 · OUT OF SCOPE")).toBeInTheDocument();
    expect(screen.getByText("07 · WHERE THIS IS HEADING")).toBeInTheDocument();
  });

  it("gives a viewer from elsewhere, or with no country, exactly today's full roadmap", async () => {
    for (const country of ["FR", null]) {
      viewerFrom(country);
      const { container, unmount } = await renderPage();
      expect(screen.getByRole("heading", { level: 2, name: /fair launch\. community owned\./i })).toBeInTheDocument();
      expect(screen.getByText("TOKEN UTILITY")).toBeInTheDocument();
      expect(container.querySelector("#hermesos-token")).not.toBeNull();
      expect(within(screen.getByRole("navigation", { name: /roadmap navigation/i })).getByRole("link", { name: /token verification/i })).toBeInTheDocument();
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
      expect(screen.getByText("TOKEN UTILITY")).toBeInTheDocument();
    } finally {
      if (original === undefined) delete process.env.OPS_ADMIN_USER_IDS;
      else process.env.OPS_ADMIN_USER_IDS = original;
    }
  });
});

describe("the browser bundle", () => {
  it("never imports the roadmap content value, so a blocked viewer is not sent the token copy", () => {
    const client = readFileSync(path.resolve(__dirname, "../../../components/roadmap/RoadmapPageClient.tsx"), "utf8");
    const imports = [...client.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+"@\/lib\/roadmap-content"/g)];
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) expect(statement[1]).toBe("type ");
    expect(client).not.toMatch(/import\s+(?!type\b)[^;]*from\s+"@\/lib\/roadmap-content"/);
  });
});
