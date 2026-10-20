/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import { parseHivraAirdropData } from "@/lib/claim/hivra-airdrop-lookup";
import type { OpenHivraAirdrop } from "@/lib/claim/hivra-airdrop-data";
import { resolveHivraClaim } from "@/lib/claim/hivra-claim";
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
// The real served check is "surfaces on AND list open"; only the list is faked here.
jest.mock("@/lib/claim/hivra-airdrop-data", () => ({
  getServedHivraAirdrop: () =>
    jest.requireActual<typeof import("@/lib/token-surfaces")>("@/lib/token-surfaces").newTokenSurfacesEnabled() ? mockOpen : null,
}));
let mockMigrationHref: string | null = null;
jest.mock("@/lib/claim/hivra-migration", () => ({ hivraMigrationHref: () => mockMigrationHref }));
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const SENDER = "0x3B954866d4329E19C1B9165774c88508f2fefA0c";
const CAMPAIGN = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const OPENS = "2026-11-01T16:00:00Z";
const CLOSES = "2026-12-01T16:00:00Z";
const DURING = new Date("2026-11-10T12:00:00Z");

type Overrides = { final?: boolean; claim?: { campaignUrl: string | null; opensAt: string | null; closesAt: string | null }; now?: Date };

function openAirdrop({ final = false, claim = { campaignUrl: null, opensAt: null, closesAt: null }, now = DURING }: Overrides = {}): OpenHivraAirdrop {
  const result = parseHivraAirdropData({
    version: 2,
    final,
    snapshotBlock: 52826055,
    decimals: 18,
    totals: { holders: 3, includedWei: "1234500000000000000001", percentOfSupply: "0.01" },
    holders: [
      { address: A(1), amountWei: "1230000000000000000000" },
      { address: A(0xa1), amountWei: "4000000000000000000", remapped: true },
      { address: A(2), amountWei: "500000000000000001" },
    ],
    excluded: [{ address: A(0xbeef), label: "Uniswap pool" }],
  });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return {
    airdrop: result.airdrop,
    snapshot: { block: 52826055, url: "https://hivra.cloud/token/airdrop-snapshot", takenAt: null },
    senderAddress: SENDER,
    claim: resolveHivraClaim(claim, now).claim,
  };
}

const OPEN_CLAIM = { campaignUrl: CAMPAIGN, opensAt: OPENS, closesAt: CLOSES };

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
    mockMigrationHref = null;
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

  it("uses the pack's browser title and search description, verbatim", async () => {
    const metadata = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.title).toEqual({ absolute: "Check your $HIVRA allocation and claim | Hivra" });
    expect(metadata.description).toBe("Check whether your wallet qualified in the $HermesOS snapshot, see your $HIVRA allocation and find the official Sablier claim process.");
    expect(metadata.openGraph).toMatchObject({ title: "Check your $HIVRA allocation and claim | Hivra" });
    expect(metadata.robots).toBeUndefined();
    const looked = await generateMetadata({ searchParams: Promise.resolve({ address: A(1) }) });
    expect(looked.robots).toEqual({ index: false, follow: true });
  });

  describe("the pack's copy (03-token-airdrop.md), verbatim", () => {
    it("opens with the eyebrow, title and the three paragraphs and the risk line", async () => {
      await renderPage();
      expect(screen.getByRole("link", { name: "Token" })).toHaveAttribute("href", "/token");
      expect(screen.getByText("$HIVRA HOLDER CLAIM").tagName).toBe("STRONG");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Check your $HIVRA allocation");
      expect(screen.getByText("The $HermesOS snapshot has been completed. If your wallet was eligible, you can check how much $HIVRA was allocated to it and claim through Sablier once the official claim window is open.")).toBeInTheDocument();
      const allocation = screen.getByText(/^The allocation is/);
      expect(allocation).toHaveTextContent("The allocation is one $HIVRA for each $HermesOS held in an eligible wallet at the snapshot block. You don't need to burn or surrender your original $HermesOS tokens.");
      expect(within(allocation).getByText("one $HIVRA for each $HermesOS held in an eligible wallet at the snapshot block").tagName).toBe("STRONG");
      const claim = screen.getByText(/Claiming requires a wallet transaction/);
      expect(claim).toHaveTextContent("This is a claim, not an automatic transfer. Claiming requires a wallet transaction, and you pay the applicable claim and network fees. You'll be shown the relevant costs before confirming.");
      expect(within(claim).getByText("This is a claim, not an automatic transfer.").tagName).toBe("STRONG");
      const risk = screen.getByTestId("token-risk-line");
      expect(risk).toHaveTextContent("Cryptoassets are high risk and can lose all their value. This page explains the holder claim process and is not an offer or invitation to buy.");
      expect(within(risk).getByText(/Cryptoassets are high risk/).tagName).toBe("EM");
    });

    it("has the headings in the pack's order and levels", async () => {
      await renderPage();
      const headings = screen.getAllByRole("heading").map((heading) => [heading.tagName, heading.textContent]);
      expect(headings).toEqual([
        ["H1", "Check your $HIVRA allocation"],
        ["H2", "Check a wallet"],
        ["H3", "Claim your allocation"],
        ["H2", "The published snapshot"],
        ["H2", "Claim safely"],
      ]);
    });

    it("has the check-a-wallet form with the pack's labels", async () => {
      await renderPage();
      expect(screen.getByText("Enter a public Base wallet address to check whether it appears in the published snapshot and see its allocation.")).toBeInTheDocument();
      expect(screen.getByLabelText("WALLET ADDRESS")).toHaveAttribute("name", "address");
      expect(screen.getByLabelText("WALLET ADDRESS")).toHaveAttribute("placeholder", "0x…");
      expect(screen.getByRole("button", { name: "CHECK WALLET" })).toBeInTheDocument();
      const note = screen.getByText(/You can check an address without connecting a wallet/);
      expect(note).toHaveTextContent("You can check an address without connecting a wallet. To make a claim, follow the verified Sablier link shown here and connect the eligible wallet there.");
      expect(within(note).getByText("To make a claim").tagName).toBe("STRONG");
    });

    it("has the claim section and the fees line", async () => {
      await renderPage();
      expect(screen.getByText("If you're eligible, you'll be able to claim during the published claim window.")).toBeInTheDocument();
      const fees = screen.getByText("Fees:").closest("p")!;
      expect(fees).toHaveTextContent("Fees: Claimants pay the applicable Sablier claim fee and network transaction cost. Check the amounts shown before confirming.");
      expect(within(fees).getByText("Fees:").tagName).toBe("STRONG");
    });

    it("has the published-snapshot section with the block shown with thousands separators", async () => {
      await renderPage();
      expect(screen.getByText("The snapshot records the wallets and balances used to calculate eligibility. It has already taken place; buying or receiving $HermesOS after the snapshot does not change your allocation.")).toBeInTheDocument();
      expect(screen.getByTestId("airdrop-snapshot-block")).toHaveTextContent("Snapshot block: 52,826,055");
      expect(screen.getByRole("link", { name: "VIEW THE PUBLISHED SNAPSHOT" })).toHaveAttribute("href", "https://hivra.cloud/token/airdrop-snapshot");
      expect(screen.getByText("The published eligibility data should also explain exclusions, including liquidity pools, launch contracts and the founder's wallet, where applicable.")).toBeInTheDocument();
    });

    it("has the claim-safely section: paragraph, four bullets, bold runs and the contracts link", async () => {
      await renderPage();
      const intro = screen.getByText(/^There may be fake \$HIVRA tokens/);
      expect(intro).toHaveTextContent("There may be fake $HIVRA tokens, sites and messages that look convincing. A legitimate claim will still require you to approve a transaction, so don't treat every wallet-connection request as a scam or every transaction as safe. Check that you're using the official Sablier campaign linked from this page, and read what your wallet is asking you to approve.");
      expect(within(intro).getByText("don't treat every wallet-connection request as a scam or every transaction as safe").tagName).toBe("STRONG");
      const bullets = screen.getAllByRole("listitem").map((item) => item.textContent);
      expect(bullets).toEqual([
        "Start from hivra.cloud/token or this claim page, not a link sent to you in a DM.",
        "Confirm you're on the verified Sablier campaign before connecting your wallet.",
        "Check the displayed transaction and fees. Never share your seed phrase or private key.",
        "You do not need to buy more $HermesOS, send it to someone, or burn it to qualify for your existing snapshot allocation.",
      ]);
      expect(screen.getByText("hivra.cloud/token").tagName).toBe("STRONG");
      expect(screen.getByText("not").tagName).toBe("STRONG");
      expect(screen.getByRole("link", { name: "VERIFY OFFICIAL TOKEN CONTRACTS" })).toHaveAttribute("href", "/token");
    });

    it("shows no placeholder, editor note or obsolete push-airdrop wording", async () => {
      const { container } = await renderPage();
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\[[^\]]*\]/);
      expect(text).not.toMatch(/CONFIRM|VERIFIED START|VERIFIED END|Editor/);
      expect(text).not.toMatch(/nothing to claim|sent automatically|never asks you to connect|Not sent yet|dry run/i);
      // The app cannot verify claims, so it does not offer a claim status check.
      expect(text).not.toContain("Already claimed?");
      expect(text).not.toContain("Check the claim status and transaction record");
      expect(text).not.toMatch(/—/);
    });

    it("adds only the one sentence about Hivra-managed wallets that the pack leaves unexplained, and makes no claim about how Sablier treats them", async () => {
      await renderPage();
      expect(screen.getByText("Wallets that Hivra manages for a user, such as lock wallets and agent wallets, are handled separately.")).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/cannot connect to Sablier/i);
    });
  });

  describe("data-driven lines and links", () => {
    it("hides the claim link and the claim window until the claim exists", async () => {
      await renderPage();
      expect(screen.queryByRole("link", { name: "CLAIM THROUGH SABLIER" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("airdrop-claim-window")).not.toBeInTheDocument();
      expect(document.querySelectorAll('a[href*="sablier"]')).toHaveLength(0);
    });

    it("shows the claim link only while the claim is open, in a new tab", async () => {
      mockOpen = openAirdrop({ claim: OPEN_CLAIM });
      await renderPage();
      const link = screen.getByRole("link", { name: "CLAIM THROUGH SABLIER" });
      expect(link).toHaveAttribute("href", CAMPAIGN);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.getByTestId("airdrop-claim-window")).toHaveTextContent(/^Claim window: 1 November 2026.*16:00 UTC to 1 December 2026.*16:00 UTC$/);
      expect(within(screen.getByTestId("airdrop-claim-window")).getByText("Claim window:").tagName).toBe("STRONG");
    });

    it("shows the window but no link before the claim opens and after it closes", async () => {
      for (const now of [new Date("2026-10-31T00:00:00Z"), new Date("2026-12-02T00:00:00Z")]) {
        mockOpen = openAirdrop({ claim: OPEN_CLAIM, now });
        const { unmount } = await renderPage();
        expect(screen.queryByRole("link", { name: "CLAIM THROUGH SABLIER" })).not.toBeInTheDocument();
        expect(screen.getByTestId("airdrop-claim-window")).toBeInTheDocument();
        unmount();
      }
    });

    it("shows the window only when both ends exist", async () => {
      mockOpen = openAirdrop({ claim: { campaignUrl: CAMPAIGN, opensAt: null, closesAt: CLOSES } });
      await renderPage();
      expect(screen.getByRole("link", { name: "CLAIM THROUGH SABLIER" })).toBeInTheDocument();
      expect(screen.queryByTestId("airdrop-claim-window")).not.toBeInTheDocument();
    });

    it("never shows counts for a dry-run list, and shows the verified counts for a final one", async () => {
      const dry = await renderPage();
      expect(screen.queryByTestId("airdrop-totals")).not.toBeInTheDocument();
      expect(dry.container.textContent).not.toMatch(/Eligible wallets|Total \$HIVRA allocated|Percentage of supply|1,234\.5/);
      dry.unmount();

      mockOpen = openAirdrop({ final: true });
      await renderPage();
      const totals = screen.getByTestId("airdrop-totals");
      expect(totals).toHaveTextContent("Eligible wallets: 3");
      expect(totals).toHaveTextContent("Total $HIVRA allocated: 1,234.500000000000000001 $HIVRA");
      expect(totals).toHaveTextContent("Percentage of supply: 0.01% (rounded up)");
      expect(within(totals).getByText("Eligible wallets:").tagName).toBe("STRONG");
    });

    it("links to the migration details only when that page is served", async () => {
      const without = await renderPage();
      expect(screen.queryByRole("link", { name: "READ THE FULL MIGRATION DETAILS" })).not.toBeInTheDocument();
      without.unmount();
      mockMigrationHref = "/token/migration";
      await renderPage();
      expect(screen.getByRole("link", { name: "READ THE FULL MIGRATION DETAILS" })).toHaveAttribute("href", "/token/migration");
    });
  });

  describe("lookup results show only states the app can verify", () => {
    it("says Eligible with the amount, and Claim not yet open while there is no claim", async () => {
      await renderPage(A(1));
      expect(screen.getByTestId("airdrop-state")).toHaveTextContent("Eligible");
      expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("1,230 $HIVRA");
      expect(screen.getByTestId("airdrop-claim-state")).toHaveTextContent("Claim not yet open");
      expect(screen.queryByRole("link", { name: /transaction|BaseScan/ })).not.toBeInTheDocument();
    });

    it("says Claim not yet open before the window, Available to claim during it, Claim window closed after it", async () => {
      const states: [Date, string][] = [
        [new Date("2026-10-31T00:00:00Z"), "Claim not yet open"],
        [DURING, "Available to claim"],
        [new Date("2026-12-02T00:00:00Z"), "Claim window closed"],
      ];
      for (const [now, label] of states) {
        mockOpen = openAirdrop({ claim: OPEN_CLAIM, now });
        const { unmount } = await renderPage(A(2));
        expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("0.500000000000000001 $HIVRA");
        expect(screen.getByTestId("airdrop-claim-state")).toHaveTextContent(label);
        unmount();
      }
    });

    it("never says Claimed or Unable to verify", async () => {
      mockOpen = openAirdrop({ claim: OPEN_CLAIM });
      const { container } = await renderPage(A(1));
      expect(container.textContent).not.toMatch(/\bClaimed\b|Unable to verify|already claimed/i);
    });

    it("shows a Hivra-managed wallet's snapshot amount with no claim state and no destination", async () => {
      mockOpen = openAirdrop({ claim: OPEN_CLAIM });
      await renderPage(A(0xa1));
      expect(screen.getByTestId("airdrop-state")).toHaveTextContent("Eligible");
      expect(screen.getByTestId("airdrop-amount")).toHaveTextContent("4 $HIVRA");
      expect(screen.getByText("Hivra-managed wallet: this allocation is handled separately.")).toBeInTheDocument();
      expect(screen.queryByTestId("airdrop-claim-state")).not.toBeInTheDocument();
    });

    it("says Not eligible for an excluded wallet (with its public reason) and an absent one, and refuses a bad address", async () => {
      const excluded = await renderPage(A(0xbeef));
      expect(screen.getByTestId("airdrop-state")).toHaveTextContent("Not eligible");
      expect(screen.getByText("This wallet is left out: Uniswap pool.")).toBeInTheDocument();
      expect(screen.queryByTestId("airdrop-claim-state")).not.toBeInTheDocument();
      excluded.unmount();
      const absent = await renderPage(A(9));
      expect(screen.getByTestId("airdrop-state")).toHaveTextContent("Not eligible");
      expect(screen.getByText("This wallet held no $HermesOS at Base block 52,826,055.")).toBeInTheDocument();
      absent.unmount();
      await renderPage("not-an-address");
      expect(screen.getByText(/That is not a wallet address/)).toBeInTheDocument();
    });
  });

  it("never shows an amount, a total, the claim link or the form to a viewer the geo-policy blocks", async () => {
    mockOpen = openAirdrop({ final: true, claim: OPEN_CLAIM });
    mockMigrationHref = "/token/migration";
    mockGeo = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };
    const { container } = await renderPage(A(1));
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent("Token features aren't available to people in the United Kingdom.");
    expect(screen.queryByTestId("airdrop-amount")).not.toBeInTheDocument();
    expect(screen.queryByTestId("airdrop-totals")).not.toBeInTheDocument();
    expect(screen.queryByRole("search")).not.toBeInTheDocument();
    expect(document.querySelectorAll('a[href*="sablier"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/1,230|\$HIVRA|36000000|52,826,055|airdrop|Sablier/i);
    const metadata = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(metadata.title).toBe("Hivra token contracts");
  });

  it("copy uses no em dashes", async () => {
    mockOpen = openAirdrop({ final: true, claim: OPEN_CLAIM });
    const { container } = await renderPage(A(1));
    expect(container.textContent).not.toContain("—");
  });
});
