/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

import { parseHivraAirdropData } from "@/lib/claim/hivra-airdrop-lookup";
import type { OpenHivraAirdrop } from "@/lib/claim/hivra-airdrop-data";
import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";

import HivraAirdropLookupPage, { generateMetadata } from "../page";

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

let mockOpen: OpenHivraAirdrop | null = null;
jest.mock("@/lib/claim/hivra-airdrop-data", () => ({ getOpenHivraAirdrop: () => mockOpen }));
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const HASH = `0x${"ab".repeat(32)}`;
const SENDER = "0x3B954866d4329E19C1B9165774c88508f2fefA0c";

function openAirdrop(): OpenHivraAirdrop {
  const result = parseHivraAirdropData({
    version: 1,
    snapshotBlock: 36000000,
    decimals: 18,
    totals: { holders: 3, includedWei: "1234500000000000000001", percentOfSupply: "0.01" },
    batches: [
      { index: 1, recipients: 2, totalWei: "1234000000000000000000", tx: HASH },
      { index: 2, recipients: 1, totalWei: "500000000000000001", tx: null },
    ],
    holders: [
      { address: A(1), amountWei: "1230000000000000000000", batch: 1 },
      { address: A(0xa1), amountWei: "4000000000000000000", remapped: true, sent: true },
      { address: A(2), amountWei: "500000000000000001", batch: 2 },
    ],
    excluded: [{ address: A(0xbeef), label: "Uniswap pool" }],
  });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return { airdrop: result.airdrop, snapshot: { block: 36000000, url: "https://hivra.cloud/token/airdrop-snapshot" }, senderAddress: SENDER };
}

async function renderPage(address?: string) {
  const element = await HivraAirdropLookupPage({ searchParams: Promise.resolve(address === undefined ? {} : { address }) });
  return render(element);
}

describe("/token/airdrop", () => {
  const env = process.env.HIVRA_NEW_TOKEN_SURFACES;
  beforeEach(() => {
    process.env.HIVRA_NEW_TOKEN_SURFACES = "1";
    mockOpen = openAirdrop();
    mockGeo = { blocked: false };
  });
  afterAll(() => {
    process.env.HIVRA_NEW_TOKEN_SURFACES = env;
  });

  it("is a 404 while the lookup is closed (dormant launch, no snapshot or no list)", async () => {
    mockOpen = null;
    await expect(HivraAirdropLookupPage({ searchParams: Promise.resolve({ address: A(1) }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata({ searchParams: Promise.resolve({}) })).toEqual({ robots: { index: false, follow: false } });
  });

  it("is a 404 while the new token surfaces are switched off", async () => {
    delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    await expect(HivraAirdropLookupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the form, totals, snapshot and sender before a lookup", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: "Check a wallet" })).toBeInTheDocument();
    expect(screen.getByLabelText("WALLET ADDRESS")).toHaveAttribute("name", "address");
    expect(screen.queryByTestId("airdrop-result")).not.toBeInTheDocument();
    expect(screen.getByTestId("airdrop-totals")).toHaveTextContent("3 wallets are sent 1,234.500000000000000001 $HIVRA in total, 0.01% of the 100 billion supply (rounded up).");
    expect(screen.getByRole("link", { name: "Open the published snapshot" })).toHaveAttribute("href", "https://hivra.cloud/token/airdrop-snapshot");
    expect(screen.getByText(SENDER)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /buy|claim|connect/i })).not.toBeInTheDocument();
  });

  it("shows a sent holder's amount and the Disperse transaction", async () => {
    await renderPage(A(1));
    expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("1,230 $HIVRA");
    expect(screen.getByRole("link", { name: "View the transfer on BaseScan" })).toHaveAttribute("href", `https://basescan.org/tx/${HASH}`);
  });

  it("says a holder in an unsent batch is not sent yet", async () => {
    await renderPage(A(2));
    expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("0.500000000000000001 $HIVRA");
    expect(screen.getByText(/Not sent yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View the transfer on BaseScan" })).not.toBeInTheDocument();
  });

  it("shows a Hivra-managed wallet's snapshot amount and label, and no transaction", async () => {
    await renderPage(A(0xa1));
    expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("4 $HIVRA");
    expect(screen.getByText("Hivra-managed wallet: sent to the owner.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View the transfer on BaseScan" })).not.toBeInTheDocument();
  });

  it("explains an excluded wallet, an absent one and a bad address", async () => {
    const excluded = await renderPage(A(0xbeef));
    expect(screen.getByText("Not in the snapshot airdrop.")).toBeInTheDocument();
    expect(screen.getByText("This wallet is left out: Uniswap pool.")).toBeInTheDocument();
    excluded.unmount();
    const absent = await renderPage(A(9));
    expect(screen.getByText("This wallet held no $HermesOS at Base block 36000000.")).toBeInTheDocument();
    absent.unmount();
    await renderPage("not-an-address");
    expect(screen.getByText(/That is not a wallet address/)).toBeInTheDocument();
  });

  it("never shows an amount, a total or the form to a viewer the geo-policy blocks", async () => {
    mockGeo = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };
    const { container } = await renderPage(A(1));
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent("Token features aren't available to people in the United Kingdom.");
    expect(screen.queryByTestId("airdrop-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("airdrop-totals")).not.toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/1,230|\$HIVRA|36000000|airdrop/i);
    const metadata = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.title).toBe("Hivra token contracts");
  });

  it("copy uses no em dashes", async () => {
    const { container } = await renderPage(A(1));
    expect(container.textContent).not.toContain("—");
  });
});
