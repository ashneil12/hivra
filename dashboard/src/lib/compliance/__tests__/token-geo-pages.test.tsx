/** @jest-environment jsdom */
/* eslint-disable @next/next/no-img-element */
/**
 * Server pages under the token geo-policy. Dormant: every page renders
 * synchronously as before, without reading the request. With ['GB']: a GB
 * viewer gets the factual token information plus the notice, never a
 * promotion or the conversion link.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

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
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
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
  const MockImage = ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />;
  MockImage.displayName = "MockImage";
  return MockImage;
});
jest.mock("@/components/theme-toggle", () => ({ ThemeToggle: () => <button type="button">Theme</button> }));
jest.mock("@/components/landing/Footer", () => function MockFooter() {
  return <footer>Footer</footer>;
});
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn() }));
// A live $HIVRA with published links, so only the geo-policy can close conversion.
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    poolId: `0x${"ab".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
jest.mock("@/lib/claim/conversion-links-config", () => ({
  ...jest.requireActual("@/lib/claim/conversion-links-config"),
  CONVERSION_LINKS: { termsUrl: "https://hivra.cloud/terms", conversionUrl: "https://bankr.bot/convert" },
}));

import { auth } from "@clerk/nextjs/server";
import { readConversionAccessGate } from "@/lib/claim/conversion-access.server";
import ConvertPage from "@/app/dashboard/convert/page";
import TokenVerificationPage from "@/app/token/page";
import TokenomicsPage from "@/app/tokenomics/page";
import WhyHivraEvolutionPage from "@/app/why-hivra/evolution/page";

import { TOKEN_GEO_POLICY } from "../token-geo-policy";

const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";
const gate = jest.mocked(readConversionAccessGate);

function viewerFrom(country: string | null) {
  mockHeaders.mockResolvedValue(new Headers(country ? { "x-vercel-ip-country": country } : {}));
}

/** Renders a page that may be sync (dormant) or async (policy active). */
async function renderPage(page: () => unknown) {
  const element = page();
  render((element instanceof Promise ? await element : element) as React.ReactElement);
}

beforeEach(() => {
  jest.clearAllMocks();
  gate.mockResolvedValue({ grandfathered: false, convertedAt: null, conversionGraceEndsAt: null });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("dormant policy", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []));

  it("renders the public token pages synchronously, without reading the request", () => {
    viewerFrom("GB");
    for (const Page of [TokenVerificationPage, TokenomicsPage, WhyHivraEvolutionPage]) {
      const element = (Page as () => unknown)();
      expect(element).not.toBeInstanceOf(Promise);
    }
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("keeps a GB viewer's /tokenomics, /why-hivra/evolution and convert link exactly as today", async () => {
    viewerFrom("GB");
    await renderPage(TokenomicsPage);
    expect(screen.getByText(/a year of Pro is \$49 in the token against \$79 by card/)).toBeInTheDocument();
    await renderPage(WhyHivraEvolutionPage);
    expect(screen.getByText(/Pay for a plan, with the discount for paying in the token/)).toBeInTheDocument();
    await renderPage(ConvertPage);
    expect(screen.getByRole("link", { name: "Go to conversion" })).toBeInTheDocument();
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
    expect(mockHeaders).not.toHaveBeenCalled();
  });
});

describe("policy of ['GB']", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]));

  it("/token keeps the contracts and adds the notice for a GB viewer", async () => {
    viewerFrom("GB");
    await renderPage(TokenVerificationPage);
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.getByText("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "The proposed $HIVRA migration" })).not.toBeInTheDocument();
  });

  it("/tokenomics shows a GB viewer the contracts and the notice, with no discount or bonus copy", async () => {
    viewerFrom("GB");
    await renderPage(TokenomicsPage);
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.getByTestId("tokenomics-contracts")).toHaveTextContent("0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.queryByText(/costs less|bonus credits/)).not.toBeInTheDocument();
  });

  it("/why-hivra/evolution drops the token discount for a GB viewer", async () => {
    viewerFrom("GB");
    await renderPage(WhyHivraEvolutionPage);
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.queryByText(/discount/)).not.toBeInTheDocument();
  });

  it("the convert page offers a GB viewer no conversion link, but still shows their switch deadline", async () => {
    viewerFrom("GB");
    gate.mockResolvedValue({
      grandfathered: true,
      convertedAt: "2026-10-02T00:00:00.000Z",
      conversionGraceEndsAt: "2026-10-05T00:00:00.000Z",
    });
    await renderPage(ConvertPage);
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    expect(screen.queryByRole("link", { name: /go to conversion/i })).not.toBeInTheDocument();
    expect(screen.getByText(/holding either token keeps your tier/)).toBeInTheDocument();
    expect(gate).toHaveBeenCalledWith(null, expect.any(Date));
  });

  describe("a signed-in ops admin (OPS_ADMIN_USER_IDS) in the UK", () => {
    // An obviously fake ID: the repo is public and no real admin is named.
    const ADMIN_ID = "user_ops_admin_test";
    const original = process.env.OPS_ADMIN_USER_IDS;
    beforeEach(() => {
      process.env.OPS_ADMIN_USER_IDS = ADMIN_ID;
      jest.mocked(auth).mockResolvedValue({ userId: ADMIN_ID } as never);
    });
    afterEach(() => {
      if (original === undefined) delete process.env.OPS_ADMIN_USER_IDS;
      else process.env.OPS_ADMIN_USER_IDS = original;
      jest.mocked(auth).mockResolvedValue({ userId: null } as never);
    });

    it("sees every token page as an unblocked viewer does", async () => {
      viewerFrom("GB");
      await renderPage(TokenomicsPage);
      expect(screen.getByText(/a year of Pro is \$49 in the token/)).toBeInTheDocument();
      await renderPage(WhyHivraEvolutionPage);
      expect(screen.getByText(/Pay for a plan, with the discount for paying in the token/)).toBeInTheDocument();
      await renderPage(ConvertPage);
      expect(screen.getByRole("link", { name: "Go to conversion" })).toBeInTheDocument();
      expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
    });

    it("while another signed-in user in the UK still gets the notice", async () => {
      jest.mocked(auth).mockResolvedValue({ userId: "user_b" } as never);
      viewerFrom("GB");
      await renderPage(TokenomicsPage);
      expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(GB_NOTICE);
    });
  });

  it("pages are unchanged for a viewer from elsewhere", async () => {
    viewerFrom("FR");
    await renderPage(TokenomicsPage);
    expect(screen.getByText(/a year of Pro is \$49 in the token/)).toBeInTheDocument();
    await renderPage(ConvertPage);
    expect(screen.getByRole("link", { name: "Go to conversion" })).toBeInTheDocument();
    expect(screen.queryByTestId("token-geo-notice")).not.toBeInTheDocument();
  });
});
