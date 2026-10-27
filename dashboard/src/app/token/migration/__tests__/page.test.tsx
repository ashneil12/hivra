/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen, within } from "@testing-library/react";

import type { TokenGeoDecision } from "@/lib/compliance/token-geo-gate";
import type { HivraTokenLaunchConfig } from "@/lib/billing/hivra-token-launch";
import type { HivraAirdropConfig } from "@/lib/claim/hivra-airdrop-config";
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
const mockAirdrop: { current: HivraAirdropConfig | null } = { current: null };
jest.mock("@/lib/claim/hivra-airdrop-config", () => {
  const actual = jest.requireActual("@/lib/claim/hivra-airdrop-config");
  return {
    ...actual,
    get HIVRA_AIRDROP() {
      return mockAirdrop.current ?? actual.HIVRA_AIRDROP;
    },
  };
});
let mockAirdropHref: string | null = null;
// The founder-wallet check reads the committed list through getOpenHivraAirdrop; null means no list is published yet.
let mockOpenList: unknown = null;
jest.mock("@/lib/claim/hivra-airdrop-data", () => ({
  hivraAirdropLookupHref: () => mockAirdropHref,
  getOpenHivraAirdrop: () => mockOpenList,
}));
let mockGeo: TokenGeoDecision = { blocked: false };
jest.mock("@/lib/compliance/token-geo-page", () => ({ resolveTokenGeoBlockForPage: async () => mockGeo }));

const { HIVRA_MIGRATION } = jest.requireActual<typeof import("@/lib/claim/hivra-migration-config")>("@/lib/claim/hivra-migration-config");
const HASH = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

// Only Date is faked: the page reads the clock for the claim window, the snapshot time and the receipts.
const NOW = new Date("2026-12-01T00:00:00Z");
const REAL_TIMERS = ["hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] as const;

const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";
const CAMPAIGN = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const OPEN_CLAIM = { campaignUrl: CAMPAIGN, opensAt: "2026-11-01T16:00:00Z", closesAt: "2027-01-27T23:59:59Z" };
const NO_CLAIM_CONFIG = { campaignUrl: null, opensAt: null, closesAt: null };

function airdrop(overrides: Partial<HivraAirdropConfig> = {}): HivraAirdropConfig {
  return {
    senderAddress: "0x3333333333333333333333333333333333333333",
    snapshotBlock: 36000000,
    snapshotTakenAt: "2026-10-20T16:30:00Z",
    snapshotUrl: SNAPSHOT_URL,
    claim: OPEN_CLAIM,
    ...overrides,
  };
}

function published(overrides: Partial<HivraMigrationConfig> = {}): HivraMigrationConfig {
  return {
    ...HIVRA_MIGRATION,
    published: true,
    announcedAt: "2026-10-21T16:00:00Z",
    // 21 Oct 16:00 UTC + 14 days ends during 4 Nov, so 5 Nov 2026 (a Thursday) is the first sale day.
    // Thirteen weekly sales end on 28 Jan 2027, the day after the claim window's last day (27 Jan).
    founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, saleStart: "2026-11-05", saleDay: "Thursday", burnDate: "2027-02-04" },
    receipts: [
      { date: "2026-11-12", kind: "liquidity", txHash: HASH(1), note: "Week 1 fees" },
      { date: "2026-11-05", kind: "founder-sale", txHash: HASH(2), note: null },
      { date: "2026-11-02", kind: "claim", txHash: HASH(3), note: "First claims" },
    ],
    ...overrides,
  };
}

async function renderPage() {
  return render(await HivraMigrationPage());
}

/** The <p> or <li> whose full text is exactly `text`. */
function block(container: HTMLElement, text: string): HTMLElement {
  const match = Array.from(container.querySelectorAll("p, li")).find((element) => element.textContent === text);
  if (!match) throw new Error(`No paragraph or bullet with the text: ${text}`);
  return match as HTMLElement;
}

function runs(element: Element, tag: "strong" | "em" | "code"): string[] {
  return Array.from(element.querySelectorAll(tag)).map((node) => node.textContent ?? "");
}

/** The lines of a block that uses <br /> between lines, as plain text. */
function lines(element: Element): string[] {
  return element.innerHTML.split("<br>").map((part) => part.replace(/<[^>]+>/g, ""));
}

describe("/token/migration", () => {
  const env = process.env.HIVRA_NEW_TOKEN_SURFACES;
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: [...REAL_TIMERS] });
    process.env.HIVRA_NEW_TOKEN_SURFACES = "1";
    mockLaunch.current = LIVE_LAUNCH;
    mockMigration.current = published();
    mockAirdrop.current = airdrop();
    mockGeo = { blocked: false };
    mockAirdropHref = "/token/airdrop";
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    if (env === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
    else process.env.HIVRA_NEW_TOKEN_SURFACES = env;
  });

  describe("when it is not served", () => {
    it("is a 404 with a noindex head while the page is not published (the committed config)", async () => {
      mockMigration.current = null;
      await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
    });

    it("is a 404 while $HIVRA is dormant", async () => {
      mockLaunch.current = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
      await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
    });

    it("is a 404 while the new token surfaces are switched off", async () => {
      delete process.env.HIVRA_NEW_TOKEN_SURFACES;
      await expect(HivraMigrationPage()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(await generateMetadata()).toEqual({ robots: { index: false, follow: false } });
    });
  });

  it("uses the pack's browser title and search description, verbatim", async () => {
    const metadata = await generateMetadata();
    // The title already ends in "| Hivra", so it is absolute (it skips the root layout's template).
    expect(metadata.title).toEqual({ absolute: "$HermesOS to $HIVRA | Migration, claims and on-chain records | Hivra" });
    expect(metadata.description).toBe("How the $HermesOS to $HIVRA transition works, who can claim through Sablier, what happens to existing access, and where to verify the contracts and transactions.");
    expect(metadata.openGraph).toMatchObject({ title: "$HermesOS to $HIVRA | Migration, claims and on-chain records | Hivra" });
    expect(metadata.alternates).toMatchObject({ canonical: expect.stringMatching(/\/token\/migration$/) });
    expect(metadata.robots).toBeUndefined();
  });

  describe("the pack's copy (02-token-migration.md), verbatim", () => {
    it("opens with the Token link, the eyebrow, the title, two paragraphs and the risk line", async () => {
      const { container } = await renderPage();
      expect(screen.getByRole("link", { name: "Token" })).toHaveAttribute("href", "/token");
      expect(screen.getByText("TOKEN TRANSITION").tagName).toBe("STRONG");
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("From $HermesOS to $HIVRA");
      block(container, "HermesOS was the beginning of Hivra. What started as a way to deploy Hermes Agent has grown into a platform for giving different AI agents computers of their own, with a much wider ecosystem planned around them.");
      block(container, "$HIVRA is the new token for that direction. This page explains what the transition means for existing $HermesOS holders, how to claim if you're eligible, and how to check the on-chain records.");
      const risk = screen.getByTestId("token-risk-line");
      expect(risk).toHaveTextContent("Cryptoassets are high risk and can lose all their value. This page provides information about the transition, not an offer or invitation to buy.");
      expect(runs(risk, "em")).toEqual(["Cryptoassets are high risk and can lose all their value. This page provides information about the transition, not an offer or invitation to buy."]);
    });

    it("has the headings in the pack's order and levels", async () => {
      await renderPage();
      expect(screen.getAllByRole("heading").map((heading) => [heading.tagName, heading.textContent])).toEqual([
        ["H1", "From $HermesOS to $HIVRA"],
        ["H2", "What changed?"],
        ["H2", "Check your eligibility and claim"],
        ["H2", "Official token contracts"],
        ["H2", "How trading fees are handled"],
        ["H2", "What happens to the founder's $HermesOS?"],
        ["H2", "On-chain records"],
        ["H3", "Snapshot and claims"],
        ["H3", "Liquidity added and locked"],
        ["H3", "Founder sales and burn"],
        ["H2", "A few things to remember"],
      ]);
    });

    it("has What changed? with its five paragraphs and bold runs", async () => {
      const { container } = await renderPage();
      const first = block(container, "The original $HermesOS token remains on Base. It hasn't been converted or replaced inside your wallet automatically.");
      expect(runs(first, "strong")).toEqual([]);
      const snapshot = block(container, "A snapshot of eligible $HermesOS holdings has already been taken. Wallets included in that snapshot are eligible to claim one $HIVRA for each eligible $HermesOS recorded at the snapshot block.");
      expect(runs(snapshot, "strong")).toEqual(["already been taken", "one $HIVRA for each eligible $HermesOS"]);
      const sablier = block(container, "The new token is claimed through Sablier. This isn't an automatic airdrop: you initiate the claim and pay the small claim fee, along with any applicable network transaction costs shown before confirmation.");
      expect(runs(sablier, "strong")).toEqual(["Sablier", "you initiate the claim and pay the small claim fee"]);
      const burn = block(container, "You do not need to burn or surrender $HermesOS to make a claim under the current arrangement. The old token remains a separate token on Base.");
      expect(runs(burn, "strong")).toEqual(["do not need to burn or surrender $HermesOS"]);
      block(container, "Existing accounts that previously qualified for token-based compute access keep that entitlement under the existing access rules. Claiming $HIVRA is separate from keeping that access.");
    });

    it("shows the snapshot block, the time it was taken (UTC) and the published snapshot link from the airdrop config", async () => {
      await renderPage();
      const facts = screen.getByTestId("migration-snapshot-facts");
      expect(lines(facts)).toEqual(["Snapshot block: 36000000", "Snapshot taken: 20 October 2026, 16:30 UTC", "View the published snapshot"]);
      expect(runs(facts, "strong")).toEqual(["Snapshot block:", "Snapshot taken:"]);
      expect(runs(facts, "code")).toEqual(["36000000", "20 October 2026, 16:30 UTC"]);
      expect(within(facts).getByRole("link", { name: "View the published snapshot" })).toHaveAttribute("href", SNAPSHOT_URL);
    });

    it("has Check your eligibility and claim with its paragraphs, the two links and the Important note", async () => {
      const { container } = await renderPage();
      const checker = block(container, "Not sure whether your wallet was included? Use the snapshot checker to look up a public wallet address and see the eligible allocation.");
      expect(runs(checker, "strong")).toEqual(["public wallet address"]);
      const claim = block(container, "If you're eligible, follow the official Sablier claim link published by Hivra. Check the claim amount and any fees in your wallet before approving a transaction.");
      expect(runs(claim, "strong")).toEqual(["official Sablier claim link published by Hivra"]);
      const links = within(screen.getByTestId("migration-claim-links")).getAllByRole("link");
      expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
        ["Check a wallet", "/token/airdrop"],
        ["Claim through Sablier", CAMPAIGN],
      ]);
      const important = block(container, "Important: A legitimate Sablier claim involves connecting a wallet and authorising the necessary claim transaction. Don't trust a claim link sent through a DM. Start from Hivra's official token page, and verify the destination before signing.");
      expect(runs(important, "strong")).toEqual(["Important:"]);
    });

    it("has both contracts as the pack lays them out, with the registry's $HIVRA", async () => {
      const { container } = await renderPage();
      const hivra = screen.getByTestId("migration-hivra-contract");
      expect(lines(hivra)).toEqual(["$HIVRA · New ecosystem token", "Network: Base", `Contract: ${HIVRA}`, "View $HIVRA on BaseScan"]);
      expect(runs(hivra, "strong")).toEqual(["$HIVRA · New ecosystem token"]);
      expect(runs(hivra, "code")).toEqual([HIVRA]);
      expect(within(hivra).getByRole("link", { name: "View $HIVRA on BaseScan" })).toHaveAttribute("href", `https://basescan.org/token/${HIVRA}`);
      const hermesos = screen.getByTestId("migration-hermesos-contract");
      expect(lines(hermesos)).toEqual(["$HermesOS · Legacy token", "Network: Base", "Contract: 0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3", "View $HermesOS on BaseScan"]);
      expect(within(hermesos).getByRole("link", { name: "View $HermesOS on BaseScan" })).toHaveAttribute("href", "https://basescan.org/token/0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3");
      const compare = block(container, "Always compare the full contract address with the official token page. A matching name or symbol is not enough.");
      expect(within(compare).getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");
    });

    it("has How trading fees are handled with its two paragraphs and the Safe", async () => {
      const { container } = await renderPage();
      const fee = block(container, "The planned $HIVRA pool has a 1.58% trading fee. Under the documented arrangement, Doppler receives 5% of the collected fees, with the remaining 95% directed to Hivra's Safe, a multisignature wallet requiring two of three approvals to move funds.");
      expect(runs(fee, "strong")).toEqual(["1.58% trading fee", "5% of the collected fees", "95%"]);
      const liquidity = block(container, "The stated liquidity plan is to use one-fifth of the fees received by the Safe each week to add liquidity to the pool and lock that position. We will publish transaction links when additions happen, so the activity can be checked rather than taken on trust.");
      expect(runs(liquidity, "strong")).toEqual(["one-fifth of the fees received by the Safe each week"]);
      const safe = screen.getByTestId("migration-safe");
      expect(lines(safe)).toEqual(["Hivra Safe", "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C", "View the Safe on BaseScan"]);
      expect(runs(safe, "strong")).toEqual(["Hivra Safe"]);
      expect(within(safe).getByRole("link", { name: "View the Safe on BaseScan" })).toHaveAttribute("href", "https://basescan.org/address/0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10C");
    });

    it("has the founder section: paragraph, the five-bullet plan, the planned-actions note, both wallets and the two dates", async () => {
      const { container } = await renderPage();
      const held = block(container, "There is no separate team allocation of $HIVRA in the current migration plan. The founder's approximately 11.34 billion $HermesOS are excluded from the eligible snapshot allocation, so those holdings do not receive $HIVRA through the migration.");
      expect(runs(held, "strong")).toEqual(["no separate team allocation of $HIVRA", "11.34 billion $HermesOS"]);
      block(container, "The existing plan for the founder's legacy tokens is to:");
      const plan = screen.getByTestId("migration-founder-plan");
      expect(within(plan).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "Make no sales during the first 14 days following the confirmed migration announcement.",
        "Sell no more than 500 million $HermesOS in any week during the planned sale period.",
        "Limit each planned sale according to a 5% legacy-pool price-impact threshold, while recognising that actual market movements cannot be guaranteed.",
        "Run the sales over 13 weeks, starting on the final published date.",
        "Send any remaining founder-held $HermesOS to the stated burn address on the final published date.",
      ]);
      expect(runs(plan, "strong")).toEqual(["500 million $HermesOS in any week", "5% legacy-pool price-impact threshold", "13 weeks"]);
      const planned = block(container, "These are planned actions, not transactions that have already happened. Completed transactions will be linked below.");
      expect(runs(planned, "strong")).toEqual(["planned actions"]);
      const wallet = screen.getByTestId("migration-founder-wallet");
      expect(lines(wallet)).toEqual(["Founder wallet", "0x672b58B6d10413Fe69ab0907db5B17712BD45f7A", "View on BaseScan"]);
      expect(within(wallet).getByRole("link")).toHaveAttribute("href", "https://basescan.org/address/0x672b58B6d10413Fe69ab0907db5B17712BD45f7A");
      const burn = screen.getByTestId("migration-burn-address");
      expect(lines(burn)).toEqual(["Intended burn address", "0x000000000000000000000000000000000000dEaD", "View on BaseScan"]);
      expect(within(burn).getByRole("link")).toHaveAttribute("href", "https://basescan.org/address/0x000000000000000000000000000000000000dEaD");
      const dates = screen.getByTestId("migration-founder-dates");
      expect(lines(dates)).toEqual(["Sale start: 5 November 2026", "Final burn date: 4 February 2027"]);
      expect(runs(dates, "strong")).toEqual(["Sale start:", "Final burn date:"]);
    });

    it("has On-chain records with its three groups, in order, and the closing sentence", async () => {
      const { container } = await renderPage();
      block(container, "The point of publishing addresses and transactions is straightforward: anyone should be able to check what has actually happened.");
      const snapshot = screen.getByTestId("migration-records-snapshot");
      const snapshotLinks = within(snapshot).getAllByRole("link");
      expect(snapshotLinks.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
        ["Published eligibility snapshot", SNAPSHOT_URL],
        ["Official Sablier claim campaign / contract", CAMPAIGN],
        ["View on BaseScan", `https://basescan.org/tx/${HASH(3)}`],
      ]);
      expect(within(snapshot).getByRole("listitem")).toHaveTextContent("2 November 2026: First claims. View on BaseScan");
      const liquidity = screen.getByTestId("migration-records-liquidity");
      expect(within(liquidity).getByRole("listitem")).toHaveTextContent("12 November 2026: Week 1 fees. View on BaseScan");
      expect(within(liquidity).getByRole("link")).toHaveAttribute("href", `https://basescan.org/tx/${HASH(1)}`);
      const founder = screen.getByTestId("migration-records-founder");
      expect(within(founder).getByRole("listitem")).toHaveTextContent("5 November 2026. View on BaseScan");
      expect(within(founder).getByRole("link")).toHaveAttribute("href", `https://basescan.org/tx/${HASH(2)}`);
      block(container, "We won't present example transactions as completed activity.");
    });

    it("has A few things to remember with its bullets, bold runs and two links", async () => {
      await renderPage();
      const section = screen.getByRole("heading", { level: 2, name: "A few things to remember" }).closest("section")!;
      const bullets = within(section).getAllByRole("listitem");
      expect(bullets.map((item) => item.textContent)).toEqual([
        "The snapshot is complete. Buying or receiving $HermesOS after the snapshot does not add to the recorded allocation.",
        "Claims are not automatic. Eligible holders claim through Sablier and cover the applicable claim fee.",
        "No burn of your original $HermesOS is required by the current claim process.",
        "Never follow a claim link from a DM. Start from Hivra's official site and check the contract and transaction details before signing.",
        "You can still use Hivra through ordinary card billing, or self-host the open-source platform without a token.",
      ]);
      expect(bullets.map((item) => runs(item, "strong"))).toEqual([
        ["snapshot is complete"],
        ["Claims are not automatic"],
        ["No burn of your original $HermesOS is required"],
        ["Never follow a claim link from a DM."],
        [],
      ]);
      expect(within(section).getByRole("link", { name: "Verify official contracts" })).toHaveAttribute("href", "/token");
      expect(within(section).getByRole("link", { name: "Read the Hivra Litepaper" })).toHaveAttribute("href", "/docs/litepaper");
    });
  });

  describe("pack placeholders are data, and a line or link with no data is left out", () => {
    it("shows no placeholder, editor note, sample value or bracketed text, even with every optional value missing", async () => {
      mockAirdrop.current = airdrop({ snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: NO_CLAIM_CONFIG });
      mockAirdropHref = null;
      mockMigration.current = published({
        announcedAt: null,
        fee: null,
        treasurySafe: null,
        founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, saleStart: null, saleDay: null, burnDate: null },
        receipts: [],
      });
      const { container } = await renderPage();
      const text = container.textContent ?? "";
      expect(text).not.toMatch(/\[[^\]]*\]/);
      expect(text).not.toMatch(/CONFIRM|VERIFIED|RECONFIRM|LINK COMPLETED|Editor|Editorial|launch checks/);
    });

    it("hides the snapshot facts until the block and the published list are both valid, and the time on its own", async () => {
      mockAirdrop.current = airdrop({ snapshotUrl: null });
      const missingList = await renderPage();
      expect(screen.queryByTestId("migration-snapshot-facts")).not.toBeInTheDocument();
      expect(screen.queryByText("View the published snapshot")).not.toBeInTheDocument();
      expect(screen.queryByText("Published eligibility snapshot")).not.toBeInTheDocument();
      missingList.unmount();

      mockAirdrop.current = airdrop({ snapshotTakenAt: null });
      await renderPage();
      expect(lines(screen.getByTestId("migration-snapshot-facts"))).toEqual(["Snapshot block: 36000000", "View the published snapshot"]);
      expect(screen.queryByText(/Snapshot taken/)).not.toBeInTheDocument();
    });

    it("drops a snapshot time in the future", async () => {
      mockAirdrop.current = airdrop({ snapshotTakenAt: "2026-12-02T00:00:00Z" });
      await renderPage();
      expect(screen.queryByText(/Snapshot taken/)).not.toBeInTheDocument();
      expect(screen.getByText("Snapshot block:")).toBeInTheDocument();
    });

    it("shows Check a wallet only when /token/airdrop is served, and hides the sentence about the checker with it", async () => {
      mockAirdropHref = null;
      const { container } = await renderPage();
      expect(screen.queryByRole("link", { name: "Check a wallet" })).not.toBeInTheDocument();
      expect(container.textContent).not.toContain("snapshot checker");
      // The rest of the section stays.
      expect(screen.getByRole("link", { name: "Claim through Sablier" })).toBeInTheDocument();
      block(container, "If you're eligible, follow the official Sablier claim link published by Hivra. Check the claim amount and any fees in your wallet before approving a transaction.");
    });

    it("shows Claim through Sablier only while the claim is open, in a new tab", async () => {
      const open = await renderPage();
      const link = screen.getByRole("link", { name: "Claim through Sablier" });
      expect(link).toHaveAttribute("href", CAMPAIGN);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      open.unmount();

      const phases: [string, HivraAirdropConfig["claim"]][] = [
        ["not open yet", { ...OPEN_CLAIM, opensAt: "2026-12-05T00:00:00Z" }],
        ["closed", { ...OPEN_CLAIM, closesAt: "2026-11-30T00:00:00Z" }],
        ["unpublished", NO_CLAIM_CONFIG],
        ["invalid campaign link", { ...OPEN_CLAIM, campaignUrl: "https://evil.example/claim" }],
        ["invalid window", { ...OPEN_CLAIM, opensAt: "2027-02-01T00:00:00Z" }],
      ];
      for (const [, claim] of phases) {
        mockAirdrop.current = airdrop({ claim });
        const { unmount } = await renderPage();
        expect(screen.queryByRole("link", { name: "Claim through Sablier" })).not.toBeInTheDocument();
        unmount();
      }
    });

    it("lists the official campaign under Snapshot and claims only while the claim is open, like Claim through Sablier", async () => {
      const open = await renderPage();
      expect(screen.getByRole("link", { name: "Official Sablier claim campaign / contract" })).toHaveAttribute("href", CAMPAIGN);
      open.unmount();
      // Before the window opens and after it closes the Sablier link has no home on this page.
      for (const claim of [{ ...OPEN_CLAIM, opensAt: "2026-12-05T00:00:00Z" }, { ...OPEN_CLAIM, closesAt: "2026-11-30T00:00:00Z" }, NO_CLAIM_CONFIG]) {
        mockAirdrop.current = airdrop({ claim });
        const { container, unmount } = await renderPage();
        expect(screen.queryByRole("link", { name: "Official Sablier claim campaign / contract" })).not.toBeInTheDocument();
        expect(container.querySelector('a[href*="sablier"]')).toBeNull();
        unmount();
      }
      mockAirdrop.current = airdrop({ claim: { ...OPEN_CLAIM, campaignUrl: "https://evil.example/claim" } });
      const { container } = await renderPage();
      expect(screen.queryByRole("link", { name: "Official Sablier claim campaign / contract" })).not.toBeInTheDocument();
      expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
    });

    it("lists Verified claim transactions or claim dashboard once claims have started, from a reviewed link, and never before", async () => {
      const RECORDS = "https://basescan.org/address/0x3333333333333333333333333333333333333333";
      mockMigration.current = published({ claimRecordsUrl: RECORDS });
      const open = await renderPage();
      const snapshot = screen.getByTestId("migration-records-snapshot");
      expect(within(snapshot).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")]).slice(0, 3)).toEqual([
        ["Published eligibility snapshot", SNAPSHOT_URL],
        ["Official Sablier claim campaign / contract", CAMPAIGN],
        ["Verified claim transactions or claim dashboard", RECORDS],
      ]);
      expect(screen.getByRole("link", { name: "Verified claim transactions or claim dashboard" })).toHaveAttribute("rel", "noopener noreferrer");
      open.unmount();

      // Closed: the campaign link is gone, the records link stays.
      mockAirdrop.current = airdrop({ claim: { ...OPEN_CLAIM, closesAt: "2026-11-30T00:00:00Z" } });
      const closed = await renderPage();
      expect(screen.queryByRole("link", { name: "Official Sablier claim campaign / contract" })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Verified claim transactions or claim dashboard" })).toHaveAttribute("href", RECORDS);
      closed.unmount();

      // Not open yet, or no claim at all: no claim transactions exist, so no link.
      for (const claim of [{ ...OPEN_CLAIM, opensAt: "2026-12-05T00:00:00Z" }, NO_CLAIM_CONFIG]) {
        mockAirdrop.current = airdrop({ claim });
        const { unmount } = await renderPage();
        expect(screen.queryByRole("link", { name: "Verified claim transactions or claim dashboard" })).not.toBeInTheDocument();
        unmount();
      }
    });

    it("leaves the claim transactions link out when none is configured, or the configured one is not a Sablier or BaseScan page", async () => {
      for (const claimRecordsUrl of [null, "https://evil.example/claims", "http://basescan.org/address/0x3333333333333333333333333333333333333333"]) {
        mockMigration.current = published({ claimRecordsUrl });
        const { container, unmount } = await renderPage();
        expect(screen.queryByRole("link", { name: "Verified claim transactions or claim dashboard" })).not.toBeInTheDocument();
        expect(container.querySelector('a[href*="evil.example"]')).toBeNull();
        unmount();
      }
    });

    it("prints nothing for a record group with no data, not even its heading", async () => {
      mockAirdrop.current = airdrop({ snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: NO_CLAIM_CONFIG });
      mockMigration.current = published({ receipts: [] });
      const { container } = await renderPage();
      for (const name of ["Snapshot and claims", "Liquidity added and locked", "Founder sales and burn"]) {
        expect(screen.queryByRole("heading", { name })).not.toBeInTheDocument();
      }
      // The section keeps its intro and its closing sentence.
      expect(screen.getByRole("heading", { level: 2, name: "On-chain records" })).toBeInTheDocument();
      block(container, "The point of publishing addresses and transactions is straightforward: anyone should be able to check what has actually happened.");
      block(container, "We won't present example transactions as completed activity.");
      expect(container.querySelectorAll("#records li")).toHaveLength(0);
    });

    it("shows a group when only it has data", async () => {
      mockAirdrop.current = airdrop({ snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: NO_CLAIM_CONFIG });
      mockMigration.current = published({ receipts: [{ date: "2026-11-12", kind: "liquidity", txHash: HASH(1), note: null }] });
      await renderPage();
      expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Liquidity added and locked"]);
    });

    it("lists each group's transactions newest first, as BaseScan links", async () => {
      mockMigration.current = published({
        receipts: [
          { date: "2026-11-12", kind: "liquidity", txHash: HASH(1), note: null },
          { date: "2026-11-19", kind: "liquidity", txHash: HASH(4), note: "Week 2 fees" },
        ],
      });
      await renderPage();
      const items = within(screen.getByTestId("migration-records-liquidity")).getAllByRole("listitem");
      expect(items.map((item) => item.textContent)).toEqual(["19 November 2026: Week 2 fees. View on BaseScan", "12 November 2026. View on BaseScan"]);
    });

    it("keeps a receipt kind the page no longer has (airdrop-batch, burn) out of the page", async () => {
      mockMigration.current = published({
        receipts: [
          { date: "2026-11-12", kind: "airdrop-batch" as never, txHash: HASH(5), note: "Batch 1" },
          { date: "2026-11-12", kind: "burn" as never, txHash: HASH(6), note: "Burn" },
        ],
      });
      const { container } = await renderPage();
      expect(container.querySelector(`a[href$="${HASH(5)}"], a[href$="${HASH(6)}"]`)).toBeNull();
      expect(container.textContent).not.toMatch(/Batch 1/);
    });

    it("hides fee lines, the Safe, wallets and dates that are missing or invalid, and keeps the rest", async () => {
      mockMigration.current = published({
        treasurySafe: "0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c", // bad checksum: dropped
        fee: null,
        founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, wallet: null, burnAddress: null, saleStart: null, saleDay: null, burnDate: null },
        receipts: [{ date: "2026-11-09", kind: "liquidity", txHash: "0xnot-a-hash", note: null }],
      });
      const { container } = await renderPage();
      expect(screen.queryByRole("heading", { name: "How trading fees are handled" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("migration-fee")).not.toBeInTheDocument();
      expect(screen.queryByTestId("migration-safe")).not.toBeInTheDocument();
      expect(screen.queryByTestId("migration-founder-wallet")).not.toBeInTheDocument();
      expect(screen.queryByTestId("migration-burn-address")).not.toBeInTheDocument();
      expect(screen.queryByTestId("migration-founder-dates")).not.toBeInTheDocument();
      // With no burn address there is no stated burn address to send the rest to.
      expect(within(screen.getByTestId("migration-founder-plan")).getAllByRole("listitem")).toHaveLength(4);
      expect(container.textContent).not.toMatch(/0x4aCDa6e26929acd34b45beDaEE2f7b8a418ce10c|not-a-hash/i);
      expect(screen.getByRole("heading", { level: 2, name: "What happens to the founder's $HermesOS?" })).toBeInTheDocument();
    });

    it("keeps the founder plan to the bullets it has data for, and drops the figure when the holding is missing", async () => {
      mockMigration.current = published({
        founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, heldTokens: null, weeklyCapTokens: null, maxPriceImpactPct: null, headStartDays: null },
      });
      const { container } = await renderPage();
      block(container, "There is no separate team allocation of $HIVRA in the current migration plan. The founder's $HermesOS are excluded from the eligible snapshot allocation, so those holdings do not receive $HIVRA through the migration.");
      expect(within(screen.getByTestId("migration-founder-plan")).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        "Run the sales over 13 weeks, starting on the final published date.",
        "Send any remaining founder-held $HermesOS to the stated burn address on the final published date.",
      ]);
    });

    it("hides the whole founder section when the founder facts are unusable", async () => {
      mockMigration.current = published({ founder: null });
      await renderPage();
      expect(screen.queryByRole("heading", { name: "What happens to the founder's $HermesOS?" })).not.toBeInTheDocument();
    });

    it("shows only the sale start when there is no burn date, and only the burn date when there is no sale start", async () => {
      mockMigration.current = published({ founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, saleStart: "2026-11-05", saleDay: null, burnDate: null } });
      const startOnly = await renderPage();
      expect(lines(screen.getByTestId("migration-founder-dates"))).toEqual(["Sale start: 5 November 2026"]);
      startOnly.unmount();
      mockMigration.current = published({ founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, saleStart: null, saleDay: null, burnDate: "2027-02-04" } });
      await renderPage();
      expect(lines(screen.getByTestId("migration-founder-dates"))).toEqual(["Final burn date: 4 February 2027"]);
    });

    it("drops a burn date that is not after the claim window closes, with no replacement copy", async () => {
      // With no sale start there is no last sale to check, so only the burn date is held to the window.
      mockMigration.current = published({ founder: { ...HIVRA_MIGRATION.founder!, weeks: 13, saleStart: null, saleDay: null, burnDate: "2027-02-04" } });
      mockAirdrop.current = airdrop({ claim: { ...OPEN_CLAIM, closesAt: "2027-02-04T12:00:00Z" } });
      const { container } = await renderPage();
      expect(screen.queryByText("Final burn date:")).not.toBeInTheDocument();
      expect(container.textContent).not.toContain("burn date");
      expect(screen.queryByTestId("migration-founder-dates")).not.toBeInTheDocument();
    });

    it("drops the sale start when the last sale is not the day after the claim window's last day, and keeps the burn date", async () => {
      // 13 weekly sales from 5 Nov 2026 end on 28 Jan 2027; a window that ends on 30 Jan does not match.
      mockAirdrop.current = airdrop({ claim: { ...OPEN_CLAIM, closesAt: "2027-01-30T12:00:00Z" } });
      await renderPage();
      expect(screen.queryByText("Sale start:")).not.toBeInTheDocument();
      expect(lines(screen.getByTestId("migration-founder-dates"))).toEqual(["Final burn date: 4 February 2027"]);
    });
  });

  describe("the claim window", () => {
    it("is printed under Check your eligibility and claim when both ends are set, whatever the phase", async () => {
      for (const claim of [OPEN_CLAIM, { ...OPEN_CLAIM, opensAt: "2026-12-05T00:00:00Z" }, { ...OPEN_CLAIM, closesAt: "2026-11-30T00:00:00Z" }]) {
        mockAirdrop.current = airdrop({ claim });
        const { unmount } = await renderPage();
        const section = screen.getByRole("heading", { level: 2, name: "Check your eligibility and claim" }).closest("section")!;
        const line = within(section).getByTestId("migration-claim-window");
        expect(line.querySelector("strong")).toHaveTextContent("Claim window:");
        unmount();
      }
      mockAirdrop.current = airdrop();
      await renderPage();
      expect(screen.getByTestId("migration-claim-window")).toHaveTextContent("Claim window: 1 November 2026 at 16:00 UTC to 27 January 2027 at 23:59 UTC");
    });

    it("is left out when either end is missing, or the claim is not published", async () => {
      for (const claim of [{ ...OPEN_CLAIM, opensAt: null }, { ...OPEN_CLAIM, closesAt: null }, NO_CLAIM_CONFIG, { ...OPEN_CLAIM, campaignUrl: "https://evil.example/x" }]) {
        mockAirdrop.current = airdrop({ claim });
        const { unmount } = await renderPage();
        expect(screen.queryByTestId("migration-claim-window")).not.toBeInTheDocument();
        unmount();
      }
    });
  });

  describe("the founder's wallet against the published list", () => {
    it("leaves out the founder section, and prints no claim about his tokens, when the list does not exclude his wallet", async () => {
      const founder = HIVRA_MIGRATION.founder!.wallet as string;
      const airdropList = {
        data: {}, holdersByAddress: new Map([[founder, { address: founder, amountWei: "5" }]]), excludedByAddress: new Map(),
      };
      mockOpenList = { airdrop: airdropList, snapshot: { block: 36000000, url: SNAPSHOT_URL, takenAt: null }, senderAddress: null, claim: {} };
      try {
        const { container } = await renderPage();
        expect(screen.queryByRole("heading", { name: "What happens to the founder's $HermesOS?" })).not.toBeInTheDocument();
        expect(container.textContent).not.toMatch(/excluded from the eligible snapshot allocation|no separate team allocation|Founder wallet|Intended burn address/);
        expect(container.querySelector(`a[href*="${founder}"]`)).toBeNull();
        // The rest of the page is served.
        expect(screen.getByRole("heading", { level: 2, name: "How trading fees are handled" })).toBeInTheDocument();
      } finally {
        mockOpenList = null;
      }
    });

    it("keeps the founder section when the list excludes his wallet", async () => {
      const founder = HIVRA_MIGRATION.founder!.wallet as string;
      mockOpenList = {
        airdrop: { data: {}, holdersByAddress: new Map(), excludedByAddress: new Map([[founder, "Founder wallet (not migrated)"]]) },
        snapshot: { block: 36000000, url: SNAPSHOT_URL, takenAt: null }, senderAddress: null, claim: {},
      };
      try {
        await renderPage();
        expect(screen.getByRole("heading", { name: "What happens to the founder's $HermesOS?" })).toBeInTheDocument();
      } finally {
        mockOpenList = null;
      }
    });
  });

  it("gives a geo-blocked viewer the notice and no token details", async () => {
    mockGeo = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };
    const { container } = await renderPage();
    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent("Token features aren't available to people in the United Kingdom.");
    expect(screen.getByRole("link", { name: "token page" })).toHaveAttribute("href", "/token");
    expect(container.textContent).not.toMatch(/\$HIVRA|Safe|founder|Sablier|36000000|1\.58|airdrop|0x/i);
    expect(container.querySelector('a[href^="https://basescan.org"], a[href*="sablier"]')).toBeNull();
    const metadata = await generateMetadata();
    expect(metadata.title).toBe("Hivra token contracts");
  });

  it("renders the geo-blocked notice byte for byte as it did before the pack was applied", async () => {
    mockGeo = { blocked: true, country: "GB", signal: "ip_country", message: "Token features aren't available to people in the United Kingdom." };
    const { container } = await renderPage();
    expect(container.innerHTML).toBe(
      '<main id="main-content" style="max-width: 1000px; margin: 0px auto; line-height: 1.7;"><a href="/token">Token</a>'
      + '<header style="margin: 2rem 0px 3rem; max-width: 760px;"><p class="mono" style="font-size: 11px;">CONTRACT ADDRESSES</p>'
      + '<h1 style="line-height: 1.05; margin: 1rem 0px;">Hivra token contracts</h1></header>'
      + '<p role="note" data-testid="token-geo-notice" style="margin: 0px 0px 1.5rem; padding: 0.85rem 1rem; font-size: 14px; line-height: 1.6;">'
      + "Token features aren't available to people in the United Kingdom.</p>"
      + '<p>The official contract addresses are on the <a href="/token">token page</a>.</p></main>',
    );
  });

  it("copy follows the token copy rules", async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/[–—]/);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/licen[cs]e/i);
    expect(text).not.toMatch(/public domain/i);
    // The old automatic-airdrop wording must not come back next to the Sablier claim.
    expect(text).not.toMatch(/nothing to claim|sent automatically|never connect a wallet/i);
  });
});
