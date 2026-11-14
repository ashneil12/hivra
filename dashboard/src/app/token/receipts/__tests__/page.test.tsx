/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";
import type { ServedTokenReceipts } from "@/lib/token-receipts/token-receipts-chain";
import type { TokenReceiptsBase } from "@/lib/token-receipts/token-receipts";

import TokenReceiptsPage, { generateMetadata } from "../page";

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
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));
let mockMigrationHref: string | null = null;
jest.mock("@/lib/claim/hivra-migration", () => ({
  ...jest.requireActual("@/lib/claim/hivra-migration"),
  hivraMigrationHref: () => mockMigrationHref,
}));
let mockBase: TokenReceiptsBase | null = null;
jest.mock("@/lib/token-receipts/token-receipts", () => ({
  ...jest.requireActual("@/lib/token-receipts/token-receipts"),
  getServedTokenReceiptsBase: () => mockBase,
}));
// The Base reader is replaced: no network, and viem is not loaded in jsdom.
const mockLoad = jest.fn();
jest.mock("@/lib/token-receipts/token-receipts-chain", () => ({ loadTokenReceipts: (...args: unknown[]) => mockLoad(...args) }));

const HIVRA = "0x1111111111111111111111111111111111111111";
const HERMESOS = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";
const SAFE = "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C";
const FOUNDER = "0x672b58B6d10413Fe69ab0907db5B17712BD45f7A";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const LOCKER = "0x2222222222222222222222222222222222222222";
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const E18 = 10n ** 18n;
const day = (iso: string) => ({ iso: `${iso}T00:00:00.000Z`, dateOnly: true });

const BASE: TokenReceiptsBase = {
  hivraAddress: HIVRA,
  hermesosAddress: HERMESOS,
  treasurySafe: SAFE,
  fee: { totalPct: 1.58, protocolSharePct: 5, liquiditySharePct: 20 },
  founder: {
    wallet: FOUNDER, heldTokens: "11.34 billion", headStartDays: 14, weeklyCapTokens: "500 million", maxPriceImpactPct: 5, weeks: 2,
    saleStart: day("2026-11-04"), saleDay: null, burnDate: day("2027-02-01"), burnAddress: DEAD,
  },
  weeklyCapWei: 500_000_000n * E18,
  receipts: [],
};

function served(overrides: Partial<ServedTokenReceipts> = {}): ServedTokenReceipts {
  return {
    ...BASE,
    receipts: [],
    chainComplete: true,
    balances: { safeEthWei: 2n * E18, safeHivraWei: 1_500n * E18, founderHermesosWei: 10_840_000_000n * E18 },
    totals: { feesReceived: [], liquidityAdded: [], founderSoldWei: 0n, founderBurnedWei: 0n },
    founderWeeks: null,
    checkedAt: "2026-11-20T09:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mockGeo = { blocked: false };
  mockMigrationHref = null;
  mockBase = BASE;
  mockLoad.mockResolvedValue(served());
});

async function renderPage() {
  render(await TokenReceiptsPage());
}

describe("/token/receipts", () => {
  it("is a 404, with no index, while it is not served", async () => {
    mockBase = null;
    await expect(TokenReceiptsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("gives a geo-blocked viewer the notice and does not read Base", async () => {
    mockGeo = { blocked: true, message: "Token features are not available in the United Kingdom." } as TokenGeoDecision;
    await renderPage();
    expect(screen.getByText("Token features are not available in the United Kingdom.")).toBeInTheDocument();
    expect(screen.queryByTestId("receipts-summary")).not.toBeInTheDocument();
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("says plainly when nothing has happened yet, with the live balances and addresses", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Token receipts" })).toBeInTheDocument();
    expect(screen.getByTestId("token-risk-line")).toBeInTheDocument();
    expect(within(screen.getByTestId("receipts-total-fees")).getByText("None recorded yet")).toBeInTheDocument();
    expect(within(screen.getByTestId("receipts-total-burned")).getByText("Not burned yet")).toBeInTheDocument();
    expect(screen.getByTestId("receipts-safe-balance")).toHaveTextContent("In the Safe right now: 2 ETH and 1,500 $HIVRA. Money waiting in the Safe is not locked liquidity.");
    expect(screen.getByTestId("receipts-founder-balance")).toHaveTextContent("Held in the founder wallet right now: 10.84 billion $HermesOS.");
    expect(screen.getByTestId("receipts-safe")).toHaveTextContent(SAFE);
    expect(screen.getByTestId("receipts-burn-address")).toHaveTextContent(DEAD);
    expect(screen.getByTestId("receipts-fee-claims-empty")).toHaveTextContent("No fee claims recorded yet.");
    expect(screen.getByTestId("receipts-burns-empty")).toHaveTextContent("The burn has not happened yet.");
    expect(screen.getByText(/at most 500 million \$HermesOS in any week, over 2 weeks from 4 November 2026/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Final burn" })).toHaveTextContent("go to the burn address on 1 February 2027.");
    expect(screen.getByTestId("receipts-checked-at")).toHaveTextContent("Checked against Base: 20 November 2026, 09:30 UTC");
    expect(screen.queryByTestId("receipts-chain-incomplete")).not.toBeInTheDocument();
    expect(screen.queryByText("Read the migration details")).not.toBeInTheDocument();
  });

  it("lists each verified transaction with what Base says it moved", async () => {
    mockMigrationHref = "/token/migration";
    mockLoad.mockResolvedValue(served({
      receipts: [
        { date: day("2026-11-12"), kind: "founder-burn", txHash: HASH(6), note: null, lock: null, check: "verified", blockNumber: 6n, timestamp: 0, amounts: [{ token: "HermesOS", wei: 9_840_000_000n * E18 }], positionIds: [], otherTransfers: 0 },
        { date: day("2026-11-11"), kind: "liquidity-lock", txHash: HASH(5), note: null, lock: { locker: "UNCX", lockerAddress: LOCKER, url: "https://app.uncx.network/lock/1", unlocksAt: day("2027-11-11") }, check: "verified", blockNumber: 5n, timestamp: 0, amounts: [], positionIds: ["4242"], otherTransfers: 0 },
        { date: day("2026-11-11"), kind: "liquidity-add", txHash: HASH(5), note: "First weekly addition.", lock: null, check: "verified", blockNumber: 5n, timestamp: 0, amounts: [{ token: "ETH", wei: E18 / 10n }, { token: "HIVRA", wei: 200n * E18 }], positionIds: [], otherTransfers: 0 },
        { date: day("2026-11-05"), kind: "founder-sale", txHash: HASH(3), note: null, lock: null, check: "verified", blockNumber: 3n, timestamp: 0, amounts: [{ token: "HermesOS", wei: 500_000_000n * E18 }], positionIds: [], otherTransfers: 0 },
        { date: day("2026-11-04"), kind: "fee-claim", txHash: HASH(1), note: null, lock: null, check: "verified", blockNumber: 1n, timestamp: 0, amounts: [{ token: "ETH", wei: E18 / 2n }], positionIds: [], otherTransfers: 1 },
      ],
      totals: { feesReceived: [{ token: "ETH", wei: E18 / 2n }], liquidityAdded: [{ token: "ETH", wei: E18 / 10n }, { token: "HIVRA", wei: 200n * E18 }], founderSoldWei: 500_000_000n * E18, founderBurnedWei: 9_840_000_000n * E18 },
      founderWeeks: {
        rows: [
          { week: 1, startsAt: "2026-11-04T00:00:00.000Z", endsAt: "2026-11-11T00:00:00.000Z", soldWei: 500_000_000n * E18, overCap: false, upcoming: false },
          { week: 2, startsAt: "2026-11-11T00:00:00.000Z", endsAt: "2026-11-18T00:00:00.000Z", soldWei: 600_000_000n * E18, overCap: true, upcoming: false },
        ],
        afterPlanWei: 0n,
      },
    }));
    await renderPage();

    expect(within(screen.getByTestId("receipts-total-fees")).getByText("0.5 ETH")).toBeInTheDocument();
    expect(within(screen.getByTestId("receipts-total-liquidity")).getByText("0.1 ETH and 200 $HIVRA")).toBeInTheDocument();
    expect(within(screen.getByTestId("receipts-total-sold")).getByText("500 million $HermesOS")).toBeInTheDocument();
    expect(within(screen.getByTestId("receipts-total-burned")).getByText("9.84 billion $HermesOS")).toBeInTheDocument();

    const fees = screen.getByTestId("receipts-fee-claims");
    expect(fees).toHaveTextContent("4 November 2026: The Safe received 0.5 ETH and 1 other token transfer.");
    expect(within(fees).getByRole("link", { name: "View on BaseScan" })).toHaveAttribute("href", `https://basescan.org/tx/${HASH(1)}`);

    const liquidity = screen.getByTestId("receipts-liquidity");
    expect(liquidity).toHaveTextContent("The Safe locked position #4242 with UNCX, locked until 11 November 2027.");
    expect(liquidity).toHaveTextContent("The Safe added 0.1 ETH and 200 $HIVRA to liquidity. First weekly addition.");
    expect(within(liquidity).getByRole("link", { name: "View the lock" })).toHaveAttribute("href", "https://app.uncx.network/lock/1");

    expect(screen.getByTestId("receipts-founder-sales")).toHaveTextContent("The founder wallet sold 500 million $HermesOS.");
    expect(screen.getByTestId("receipts-burns")).toHaveTextContent("The founder wallet burned 9.84 billion $HermesOS.");

    expect(screen.getByTestId("receipts-founder-week-1")).toHaveTextContent("4 November 2026 to 10 November 2026500 million $HermesOSYes");
    expect(screen.getByTestId("receipts-founder-week-2")).toHaveTextContent("No, over the limit");
    expect(screen.getByRole("link", { name: "Read the migration details" })).toHaveAttribute("href", "/token/migration");
  });

  it("marks lines it could not check and says Base was not reachable", async () => {
    mockLoad.mockResolvedValue(served({
      chainComplete: false,
      balances: { safeEthWei: null, safeHivraWei: null, founderHermesosWei: null },
      receipts: [{ date: day("2026-11-05"), kind: "founder-sale", txHash: HASH(3), note: null, lock: null, check: "unchecked" }],
    }));
    await renderPage();
    expect(screen.getByTestId("receipts-chain-incomplete")).toBeInTheDocument();
    expect(screen.getByTestId("receipts-founder-sales")).toHaveTextContent("5 November 2026: Not checked: Base could not be reached just now.");
    expect(screen.queryByTestId("receipts-safe-balance")).not.toBeInTheDocument();
    expect(screen.queryByTestId("receipts-founder-balance")).not.toBeInTheDocument();
  });

  it("sets the page title and description", async () => {
    const metadata = await generateMetadata();
    expect(metadata.title).toEqual({ absolute: "Token receipts | Fees, liquidity, founder sales and burn | Hivra" });
    expect(metadata.description).toContain("read from its transaction on Base");
  });
});
