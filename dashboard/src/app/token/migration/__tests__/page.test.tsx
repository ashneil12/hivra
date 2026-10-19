/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";
import type { HivraTokenLaunchConfig } from "@/lib/billing/hivra-token-launch";
import type { HivraMigrationConfig } from "@/lib/claim/hivra-migration-config";

import HivraMigrationPage, { generateMetadata } from "../page";

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
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const HIVRA = "0x1111111111111111111111111111111111111111";
const LIVE_LAUNCH: HivraTokenLaunchConfig = { contractAddress: HIVRA, decimals: 18, poolId: `0x${"ab".repeat(32)}`, activatesAt: "2026-01-01T00:00:00Z" };
const mockLaunch: { current: HivraTokenLaunchConfig } = { current: LIVE_LAUNCH };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch.current;
  },
}));
const mockMigration: { current: HivraMigrationConfig | null } = { current: null };
jest.mock("@/lib/claim/hivra-migration-config", () => {
  const actual = jest.requireActual("@/lib/claim/hivra-migration-config");
  return {
    ...actual,
    get HIVRA_MIGRATION() {
      return mockMigration.current ?? actual.HIVRA_MIGRATION;
    },
  };
});
jest.mock("@/lib/claim/hivra-airdrop-config", () => ({
  ...jest.requireActual("@/lib/claim/hivra-airdrop-config"),
  HIVRA_AIRDROP: {
    senderAddress: "0x3333333333333333333333333333333333333333",
    snapshotBlock: 36000000,
    snapshotUrl: "https://hivra.cloud/token/airdrop-snapshot",
    sentAt: null,
  },
}));
let mockAirdropHref: string | null = null;
jest.mock("@/lib/claim/hivra-airdrop-data", () => ({ hivraAirdropLookupHref: () => mockAirdropHref }));
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));

const { HIVRA_MIGRATION } = jest.requireActual<typeof import("@/lib/claim/hivra-migration-config")>("@/lib/claim/hivra-migration-config");
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function published(overrides: Partial<HivraMigrationConfig> = {}): HivraMigrationConfig {
  return {
    ...HIVRA_MIGRATION,
    published: true,
    announcedAt: "2026-01-02T16:00:00Z",
    founder: { ...HIVRA_MIGRATION.founder!, saleStart: "2026-01-17", saleDay: "Saturday", burnDate: "2026-04-18" },
    receipts: [
      { date: "2026-01-09", kind: "liquidity", txHash: HASH(1), note: "Week 1 fees" },
      { date: "2026-01-17", kind: "founder-sale", txHash: HASH(2), note: null },
      { date: "2026-01-05", kind: "airdrop-batch", txHash: HASH(3), note: "Batch 1" },
    ],
    ...overrides,
  };
}

async function renderPage() {
  return render(await HivraMigrationPage());
}

describe("/token/migration", () => {
  const env = process.env.HIVRA_NEW_TOKEN_SURFACES;
  beforeEach(() => {
    process.env.HIVRA_NEW_TOKEN_SURFACES = "1";
    mockLaunch.current = LIVE_LAUNCH;
    mockMigration.current = published();
    mockGeo = { blocked: false };
    mockAirdropHref = null;
  });
  afterAll(() => {
    if (env === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    else process.env.HIVRA_NEW_TOKEN_SURFACES = env;
  });

  it("is a 404 with a noindex head while the page is not published (the committed config)", async () => {
    mockMigration.current = null;
    await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
  });

  it("is a 404 while $HIVRA is dormant", async () => {
    mockLaunch.current = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
    await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is a 404 while the new token surfaces are switched off", async () => {
    delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
  });

  it("shows every section when all the data is in", async () => {
    mockAirdropHref = "/token/airdrop";
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "$HermesOS moved to $HIVRA" })).toBeInTheDocument();
    for (const name of ["What changed", "Check your wallet", "Contracts", "Where trading fees go", "The founder's tokens", "Receipts", "Stay safe"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByTestId("migration-one-for-one")).toHaveTextContent("Every wallet that held $HermesOS at Base block 36000000 is sent one $HIVRA for each $HermesOS it held.");
    expect(screen.getByRole("link", { name: "Check a wallet for the $HIVRA airdrop" })).toHaveAttribute("href", "/token/airdrop");
    expect(screen.getByRole("link", { name: "View the $HIVRA contract on BaseScan" })).toHaveAttribute("href", `https://basescan.org/token/${HIVRA}`);
    expect(screen.getByRole("link", { name: "View the $HermesOS contract on BaseScan" })).toHaveAttribute("href", "https://basescan.org/token/0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
    expect(screen.getByTestId("migration-fee")).toHaveTextContent("Each trade in the $HIVRA pool pays a 1.58% fee.");
    expect(screen.getByTestId("migration-fee")).toHaveTextContent("Doppler, the launch platform, keeps 5% of the fees. The rest goes to Hivra's Safe");
    expect(screen.getByTestId("migration-fee")).toHaveTextContent("Planned: each week, a fifth of what the Safe received is added to the pool's liquidity and locked.");
    expect(screen.getByRole("link", { name: "View the Safe on BaseScan" })).toHaveAttribute("href", "https://basescan.org/address/0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C");
    expect(screen.getByText("The founder holds no $HIVRA.")).toBeInTheDocument();
    expect(screen.getByTestId("migration-founder-held")).toHaveTextContent("He holds 11.34 billion $HermesOS. They are not migrated, so they are sent no $HIVRA.");
    const plan = within(screen.getByTestId("migration-founder-plan"));
    expect(plan.getByText(/No sales in the first 14 days after the announcement, so none before 16 January 2026, 16:00 UTC\./)).toBeInTheDocument();
    expect(plan.getByText("At most 500 million $HermesOS sold in any week.")).toBeInTheDocument();
    expect(plan.getByText("No single sale may move the $HermesOS pool by more than 5%.")).toBeInTheDocument();
    expect(screen.getByTestId("migration-founder-plan")).toHaveTextContent("Sales run for 13 weeks, starting 17 January 2026, on Saturdays.");
    expect(screen.getByTestId("migration-founder-plan")).toHaveTextContent("On 18 April 2026, any of his $HermesOS not sold are sent to the burn address");
    expect(screen.getByRole("link", { name: "View the founder's wallet on BaseScan" })).toHaveAttribute("href", "https://basescan.org/address/0x672b58B6d10413Fe69ab0907db5B17712BD45f7A");
    expect(screen.getByRole("link", { name: "View the burn address on BaseScan" })).toHaveAttribute("href", "https://basescan.org/address/0x000000000000000000000000000000000000dEaD");
    expect(within(screen.getByTestId("migration-receipts-liquidity")).getByRole("link")).toHaveAttribute("href", `https://basescan.org/tx/${HASH(1)}`);
    expect(within(screen.getByTestId("migration-receipts-founder-sale")).getByRole("link")).toHaveAttribute("href", `https://basescan.org/tx/${HASH(2)}`);
    expect(screen.getByTestId("migration-receipts-airdrop-batch")).toHaveTextContent("5 January 2026: Batch 1.");
    expect(screen.queryByTestId("migration-receipts-burn")).not.toBeInTheDocument();
    expect(screen.getByText(/Never connect a wallet to "claim" \$HIVRA\./)).toBeInTheDocument();
    expect(screen.getByTestId("token-lookalike-warning")).toHaveTextContent("Fake HIVRA tokens exist.");
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("$HermesOS to $HIVRA migration");
    expect(metadata.robots).toBeUndefined();
  });

  it("hides each section whose data is missing or invalid", async () => {
    mockMigration.current = published({
      announcedAt: null,
      treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c", // bad checksum: dropped
      fee: null,
      founder: null,
      receipts: [{ date: "2026-01-09", kind: "liquidity", txHash: "0xnot-a-hash", note: null }],
    });
    const { container } = await renderPage();
    for (const name of ["What changed", "Contracts", "Stay safe"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    for (const name of ["Check your wallet", "Where trading fees go", "The founder's tokens", "Receipts"]) {
      expect(screen.queryByRole("heading", { level: 2, name })).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId("migration-announced")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c|not-a-hash/i);
  });

  it("keeps the founder plan to the lines it has data for", async () => {
    mockMigration.current = published({
      fee: null,
      treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C",
      founder: { ...HIVRA_MIGRATION.founder!, wallet: null, heldTokens: null, weeklyCapTokens: null, maxPriceImpactPct: null, burnAddress: null },
    });
    await renderPage();
    expect(screen.getByText("Hivra's share of the trading fees goes to this Safe.")).toBeInTheDocument();
    expect(screen.queryByTestId("migration-fee")).not.toBeInTheDocument();
    expect(screen.getByTestId("migration-founder-held")).toHaveTextContent("His $HermesOS are not migrated, so they are sent no $HIVRA.");
    expect(screen.queryByText(/At most/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No single sale/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("migration-founder-wallet")).not.toBeInTheDocument();
    expect(screen.queryByTestId("migration-burn-address")).not.toBeInTheDocument();
  });

  it("gives a geo-blocked viewer the notice and no token details", async () => {
    mockAirdropHref = "/token/airdrop";
    mockGeo = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };
    const { container } = await renderPage();
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent("Token features aren't available to people in the United Kingdom.");
    expect(screen.getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");
    expect(container.textContent).not.toMatch(/\$HIVRA|Safe|founder|36000000|1\.58|airdrop|0x/i);
    expect(container.querySelector('a[href^="https://basescan.org"]')).toBeNull();
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("Hivra token contracts");
  });

  it("copy follows the token copy rules", async () => {
    mockAirdropHref = "/token/airdrop";
    const { container } = await renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\$\s?\d/);
    // The shared risk line (token-verification-content.ts) is the one approved place
    // these words appear; everything else on the page avoids them.
    const withoutRiskLine = text.replace(screen.getByTestId("token-risk-line").textContent ?? "", "");
    expect(withoutRiskLine).not.toMatch(/\b(price|prices|priced|return|returns|value|buy|buying|invest\w*|opportunit\w*|profit\w*)\b/i);
    expect(withoutRiskLine).not.toMatch(/licen[cs]e/i);
  });
});
