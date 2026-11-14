/** @jest-environment jsdom */
/**
 * /token and /dashboard/convert link to /token/migration only when that page is
 * served (the same getServedHivraMigration check as its 404), and never for a
 * viewer the token geo-policy blocks.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render } from "@testing-library/react";

import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";
import type { HivraTokenLaunchConfig } from "@/lib/billing/hivra-token-launch";

import ConvertPage from "@/app/dashboard/convert/page";
import TokenVerificationPage from "@/app/token/page";

jest.mock("@/lib/logger", () => ({ log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("next/link", () => {
  const MockLink = ({ href, children, ...rest }: { href: string; children: React.ReactNode; [key: string]: unknown }) => <a href={href} {...rest}>{children}</a>;
  MockLink.displayName = "MockLink";
  return MockLink;
});
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: "user_1" })) }));
jest.mock("@/lib/claim/conversion-access.server", () => ({ readConversionAccessGate: jest.fn(async () => null) }));
jest.mock("@/components/layout/DashboardPageShell", () => ({
  DashboardPageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const LIVE_LAUNCH: HivraTokenLaunchConfig = {
  contractAddress: "0x1111111111111111111111111111111111111111",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-01-01T00:00:00Z",
};
const mockLaunch: { current: HivraTokenLaunchConfig } = { current: LIVE_LAUNCH };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch.current;
  },
}));
const mockPublished = { current: true };
jest.mock("@/lib/claim/hivra-migration-config", () => {
  const actual = jest.requireActual("@/lib/claim/hivra-migration-config");
  return {
    ...actual,
    get HIVRA_MIGRATION() {
      return { ...actual.HIVRA_MIGRATION, published: mockPublished.current };
    },
  };
});
let mockGeo: TokenGeoDecision = { blocked: false };
let mockPolicyActive = false;
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));
jest.mock("@/lib/compliance/token-geo-policy", () => ({
  ...jest.requireActual("@/lib/compliance/token-geo-policy"),
  isTokenGeoPolicyActive: () => mockPolicyActive,
}));

const GB: TokenGeoDecision = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };

async function renderBoth() {
  const tokenPage = TokenVerificationPage() as React.ReactElement | Promise<React.ReactElement>;
  const token = render(tokenPage instanceof Promise ? await tokenPage : tokenPage);
  const tokenHasLink = token.container.querySelector('a[href="/token/migration"]') !== null;
  token.unmount();
  const convert = render(await ConvertPage());
  const convertHasLink = convert.container.querySelector('a[href="/token/migration"]') !== null;
  convert.unmount();
  return { tokenHasLink, convertHasLink };
}

describe("links to /token/migration", () => {
  const env = process.env.HIVRA_NEW_TOKEN_SURFACES;
  beforeEach(() => {
    process.env.HIVRA_NEW_TOKEN_SURFACES = "1";
    mockLaunch.current = LIVE_LAUNCH;
    mockPublished.current = true;
    mockGeo = { blocked: false };
    mockPolicyActive = false;
  });
  afterAll(() => {
    if (env === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    else process.env.HIVRA_NEW_TOKEN_SURFACES = env;
  });

  it("appear on both pages when the migration page is served", async () => {
    expect(await renderBoth()).toEqual({ tokenHasLink: true, convertHasLink: true });
  });

  it("appear for a viewer the active geo-policy does not block", async () => {
    mockPolicyActive = true;
    expect(await renderBoth()).toEqual({ tokenHasLink: true, convertHasLink: true });
  });

  it.each([
    ["the page is not published", () => { mockPublished.current = false; }],
    ["$HIVRA is dormant", () => { mockLaunch.current = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" }; }],
    ["the new token surfaces are off", () => { delete process.env.HIVRA_NEW_TOKEN_SURFACES; }],
    ["the viewer is geo-blocked", () => { mockPolicyActive = true; mockGeo = GB; }],
  ])("are absent when %s", async (_why, arrange) => {
    arrange();
    expect(await renderBoth()).toEqual({ tokenHasLink: false, convertHasLink: false });
  });
});
