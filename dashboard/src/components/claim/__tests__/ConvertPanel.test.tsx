/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { resolveConversionState, type ConversionInputs } from "@/lib/claim/conversion-state";
import type { HivraAirdropConfig } from "@/lib/claim/hivra-airdrop-config";

import {
  CLAIM_LABEL,
  CLAIM_LEAD,
  CLAIM_SAFETY_DM,
  CLAIM_SAFETY_LOOKALIKE,
  CLAIM_SAFETY_WALLET,
  ConvertPanel,
  DORMANT_MESSAGE,
  LAUNCHED_TITLE,
  PROPOSED_LABEL,
  SNAPSHOT_PENDING_MESSAGE,
  SWITCH_AFTER_CLAIM_MESSAGE,
} from "../ConvertPanel";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TEST_SENDER = "0x3333333333333333333333333333333333333333";
const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";
const CAMPAIGN_URL = "https://app.sablier.com/airdrops/campaign/0xabc123/";
const NOW = new Date("2026-10-03T12:00:00Z");
const NO_CLAIM_CONFIG = { campaignUrl: null, opensAt: null, closesAt: null };
const NOT_PUBLISHED: HivraAirdropConfig = { senderAddress: TEST_SENDER, snapshotBlock: null, snapshotTakenAt: null, snapshotUrl: null, claim: NO_CLAIM_CONFIG };
const PUBLISHED: HivraAirdropConfig = { ...NOT_PUBLISHED, snapshotBlock: 36_000_000, snapshotUrl: SNAPSHOT_URL };
// The claim window opened on 1 October and is still open at NOW; it closes on 31 October.
const OPEN: HivraAirdropConfig = { ...PUBLISHED, claim: { campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-31T18:00:00Z" } };
// The claim window closed on 2 October, before NOW.
const CLOSED: HivraAirdropConfig = { ...PUBLISHED, claim: { campaignUrl: CAMPAIGN_URL, opensAt: "2026-10-01T00:00:00Z", closesAt: "2026-10-02T18:00:00Z" } };
const GRANDFATHERED = { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null };

const validation = validateHivraLaunchConfig({
  contractAddress: TEST_HIVRA,
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
});
const testHivra = validation.status === "configured" ? validation.token : null;

const DORMANT: ConversionInputs = { hivra: null, phase: "dormant", airdrop: CLOSED, access: null, now: NOW };
const LIVE: Partial<ConversionInputs> = { hivra: testHivra, phase: "active" };

function renderState(overrides: Partial<ConversionInputs> = {}) {
  return render(<ConvertPanel state={resolveConversionState({ ...DORMANT, ...overrides })} />);
}

function hrefs(): string[] {
  return screen.getAllByRole("link").map((link) => link.getAttribute("href") ?? "");
}

describe("ConvertPanel while $HIVRA is dormant", () => {
  it("keeps the pre-launch copy: exact message, proposed label, no airdrop or sender", () => {
    renderState();

    expect(screen.getByTestId("convert-closed")).toHaveTextContent(
      "Conversion opens after $HIVRA launches; terms are published first.",
    );
    expect(DORMANT_MESSAGE).toBe("Conversion opens after $HIVRA launches; terms are published first.");
    expect(screen.getByTestId("convert-proposed-label")).toHaveTextContent(PROPOSED_LABEL);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Convert $HermesOS to $HIVRA");
    expect(screen.getByText(/There is no official \$HIVRA contract yet/)).toBeInTheDocument();
    // Nothing about the airdrop or the claim leaks before the launch block is filled in.
    expect(document.body.textContent).not.toMatch(/airdrop|snapshot|sablier|claim window/i);
    expect(screen.queryByText(TEST_SENDER)).not.toBeInTheDocument();
  });

  it("frames optional conversion and kept access as proposals, and says how access works today", () => {
    renderState();

    expect(screen.getByText(/As proposed, converting is optional/)).toBeInTheDocument();
    expect(screen.getByText(/Today, platform access counts the \$HermesOS in your verified wallet/)).toBeInTheDocument();
    expect(screen.getByText(/The proposal is that existing holders keep their access/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Wallet" })).toHaveAttribute("href", "/dashboard/wallet");
  });

  it("checks a pasted address against the official contracts only", () => {
    renderState();

    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: TEST_HIVRA } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("status")).toHaveTextContent(/This is not a Hivra token\. \$HIVRA has not launched/);
    // The pasted value never becomes a link.
    expect(hrefs().some((href) => href.includes(TEST_HIVRA))).toBe(false);
  });
});

describe("ConvertPanel once $HIVRA is launched", () => {
  it("explains the claim in the pack's sentences: a claim through Sablier, not an automatic transfer, no burn", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LAUNCHED_TITLE);
    expect(screen.getByTestId("convert-proposed-label")).toHaveTextContent(CLAIM_LABEL);
    expect(CLAIM_LABEL).toBe("Claims are not automatic.");
    expect(screen.getByText(CLAIM_LEAD)).toBeInTheDocument();
    expect(CLAIM_LEAD).toBe("Eligible holders can claim $HIVRA through Sablier based on the snapshot already taken.");
    expect(screen.getByRole("heading", { name: "Claim your allocation" })).toBeInTheDocument();
    expect(screen.getByText(/The allocation is one \$HIVRA for each \$HermesOS held in an eligible wallet at the snapshot block\. You don't\s+need to burn or surrender your original \$HermesOS tokens\./)).toBeInTheDocument();
    expect(screen.getByText(/This is a claim, not an automatic transfer\. Claiming requires a wallet transaction, and you pay the applicable\s+claim and network fees\. You'll be shown the relevant costs before confirming\./)).toBeInTheDocument();
    expect(screen.queryByText(DORMANT_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(/As proposed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch my access/i })).not.toBeInTheDocument();
  });

  it("carries no obsolete push-airdrop wording and no Sablier link of its own", () => {
    renderState({ ...LIVE, airdrop: OPEN, access: GRANDFATHERED });

    expect(document.body.textContent).not.toMatch(
      /nothing to claim|sent automatically|never connect a wallet|never asks you to connect|nothing to swap|transfers come from|has not been sent|is sent one|airdrop is sent/i,
    );
    // Only BaseScan, the published snapshot, Wallet and nothing that could be a claim or swap site.
    for (const href of hrefs()) expect(href).toMatch(/^(https:\/\/basescan\.org\/|https:\/\/hivra\.cloud\/token\/airdrop-snapshot$|\/dashboard\/wallet$)/);
    expect(hrefs().some((href) => href.includes("sablier"))).toBe(false);
  });

  it("says a legitimate claim connects a wallet, and never to follow a claim link from a DM", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByRole("heading", { name: "Claim safely" })).toBeInTheDocument();
    const safety = screen.getByTestId("convert-claim-safety");
    expect(safety).toHaveTextContent(CLAIM_SAFETY_WALLET);
    expect(safety).toHaveTextContent(CLAIM_SAFETY_DM);
    expect(safety).toHaveTextContent(CLAIM_SAFETY_LOOKALIKE);
    expect(CLAIM_SAFETY_DM).toBe("Never follow a claim link from a DM. Start from Hivra's official site and check the contract and transaction details before signing.");
  });

  it("says the snapshot is not published yet, and lists the official contracts with $HermesOS as legacy", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByTestId("convert-snapshot-pending")).toHaveTextContent(SNAPSHOT_PENDING_MESSAGE);
    expect(screen.getByText("$HIVRA on Base")).toBeInTheDocument();
    expect(screen.getByText("$HermesOS on Base (legacy)")).toBeInTheDocument();
    expect(screen.getByText(TEST_HIVRA)).toBeInTheDocument();
  });

  it("shows the Airdrop wallet with a BaseScan address link", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByText("Airdrop wallet:")).toBeInTheDocument();
    expect(screen.getByText(TEST_SENDER)).toBeInTheDocument();
    expect(hrefs()).toContain(`https://basescan.org/address/${TEST_SENDER}`);
  });

  it("shows the published snapshot block and list, and no claim window until the claim is published", () => {
    renderState({ ...LIVE, airdrop: PUBLISHED, access: null });

    expect(screen.getByTestId("convert-snapshot-block")).toHaveTextContent("Snapshot block: 36000000");
    expect(screen.getByRole("link", { name: "36000000" })).toHaveAttribute("href", "https://basescan.org/block/36000000");
    expect(screen.getByRole("link", { name: "View the published snapshot" })).toHaveAttribute("href", SNAPSHOT_URL);
    expect(screen.queryByTestId("convert-claim-window")).not.toBeInTheDocument();
  });

  it("shows the claim window once both ends are published", () => {
    renderState({ ...LIVE, airdrop: OPEN, access: null });

    expect(screen.getByTestId("convert-claim-window")).toHaveTextContent(/^Claim window: 1 October 2026.*00:00 UTC to 31 October 2026.*18:00 UTC$/);
  });

  it("links to the check-and-claim page only when the server says it is served, never for a blocked viewer", () => {
    const state = resolveConversionState({ ...DORMANT, ...LIVE, airdrop: PUBLISHED, access: null });
    const { rerender } = render(<ConvertPanel state={state} airdropLookupHref="/token/airdrop" />);
    expect(screen.getByRole("link", { name: "Check eligibility and claim through the official Sablier flow" })).toHaveAttribute("href", "/token/airdrop");

    rerender(<ConvertPanel state={state} />);
    expect(screen.queryByTestId("convert-airdrop-lookup")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "airdrop page" })).not.toBeInTheDocument();

    rerender(<ConvertPanel state={state} geoNotice="Token features aren't available to you." airdropLookupHref="/token/airdrop" />);
    expect(hrefs()).not.toContain("/token/airdrop");
  });

  it("links to the migration details only when the server says it is served", () => {
    const state = resolveConversionState({ ...DORMANT, ...LIVE, airdrop: PUBLISHED, access: null });
    const { rerender } = render(<ConvertPanel state={state} migrationHref="/token/migration" />);
    expect(screen.getByRole("link", { name: "Read the migration details" })).toHaveAttribute("href", "/token/migration");
    rerender(<ConvertPanel state={state} />);
    expect(screen.queryByTestId("convert-migration-link")).not.toBeInTheDocument();
  });

  it("points Hivra-managed wallets at the airdrop page only when it is served", () => {
    const state = resolveConversionState({ ...DORMANT, ...LIVE, airdrop: PUBLISHED, access: null });
    const { rerender } = render(<ConvertPanel state={state} airdropLookupHref="/token/airdrop" />);
    expect(screen.getByText(/Hivra-managed wallets are handled separately as explained on the/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "airdrop page" })).toHaveAttribute("href", "/token/airdrop");
    rerender(<ConvertPanel state={state} />);
    expect(screen.queryByText(/handled separately/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Wallet" })).toHaveAttribute("href", "/dashboard/wallet");
  });

  it("gives no lookup link while $HIVRA is dormant", () => {
    render(<ConvertPanel state={resolveConversionState(DORMANT)} airdropLookupHref="/token/airdrop" />);
    expect(hrefs()).not.toContain("/token/airdrop");
  });

  describe("the optional switch for a grandfathered holder", () => {
    it("stays hidden while the claim window is open, and says it comes after the window closes", () => {
      renderState({ ...LIVE, airdrop: OPEN, access: GRANDFATHERED });

      expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
      expect(screen.getByText(/Your tier counts the legacy \$HermesOS in your verified wallet, and that continues/)).toBeInTheDocument();
      expect(screen.getByTestId("convert-switch-later")).toHaveTextContent(SWITCH_AFTER_CLAIM_MESSAGE);
    });

    it("stays hidden, with no promise of a later switch, while there is no claim window or no closing time", () => {
      for (const airdrop of [PUBLISHED, { ...OPEN, claim: { ...OPEN.claim, closesAt: null } }]) {
        const { unmount } = renderState({ ...LIVE, airdrop, access: GRANDFATHERED });
        expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
        expect(screen.queryByTestId("convert-switch-later")).not.toBeInTheDocument();
        unmount();
      }
    });

    it("stays hidden before the claim opens", () => {
      renderState({ ...LIVE, airdrop: { ...OPEN, claim: { ...OPEN.claim, opensAt: "2026-10-10T00:00:00Z" } }, access: GRANDFATHERED });

      expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
      expect(screen.getByTestId("convert-switch-later")).toBeInTheDocument();
    });

    it("is offered once the claim window has closed", () => {
      renderState({ ...LIVE, airdrop: CLOSED, access: GRANDFATHERED });

      expect(screen.getByTestId("convert-switch-access")).toHaveTextContent("Optional: switch your access to $HIVRA.");
      expect(screen.getByTestId("convert-switch-access")).toHaveTextContent(/If you keep your \$HermesOS where it is, you don't need to switch/);
      expect(screen.queryByTestId("convert-switch-later")).not.toBeInTheDocument();
    });
  });

  it("tells a holder whose tier counts $HIVRA, and one who switched when their grace ends", () => {
    renderState({
      ...LIVE,
      access: { grandfathered: true, convertedAt: "2026-10-02T00:00:00.000Z", conversionGraceEndsAt: "2026-10-05T00:00:00.000Z" },
    });

    expect(screen.getByText(/Until 5 October 2026 at 00:00 UTC, holding either token keeps your tier\. After that, only \$HIVRA counts\./)).toBeInTheDocument();
    expect(screen.getByText("Your tier counts the $HIVRA in your verified wallet. Billing shows your tier.")).toBeInTheDocument();
  });

  it("uses neutral access copy when the user's access can't be read", () => {
    renderState({ ...LIVE, access: null });

    expect(screen.getByText(/Receiving \$HIVRA does not change your access\. Billing shows which token your tier counts\./)).toBeInTheDocument();
  });

  it("recognises the airdrop wallet in the address checker without calling it a sender of tokens", () => {
    renderState({ ...LIVE, access: null });

    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: TEST_SENDER } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("status")).toHaveTextContent("This is Hivra's airdrop wallet, not a token contract. $HIVRA is only the token whose contract matches the official $HIVRA contract.");
    expect(screen.getByRole("status")).not.toHaveTextContent(/sends/);
  });

  it("writes no promotional wording", () => {
    renderState({ ...LIVE, airdrop: CLOSED, access: GRANDFATHERED });

    expect(document.body.textContent).not.toMatch(/\b(buy|price|discount|profit|returns?|invest\w*|free)\b/i);
  });
});

describe("ConvertPanel for a viewer the token geo-policy blocks", () => {
  const BLOCKED = "Token features aren't available to people in the United Kingdom.";

  it("shows the notice, the contracts and the claim-safety lines, and no claim details or link", () => {
    const state = resolveConversionState({ ...DORMANT, ...LIVE, airdrop: OPEN, access: GRANDFATHERED });
    render(<ConvertPanel state={state} geoNotice={BLOCKED} airdropLookupHref="/token/airdrop" migrationHref="/token/migration" />);

    expect(screen.getByTestId("token-geo-notice")).toHaveTextContent(BLOCKED);
    expect(screen.getByTestId("convert-proposed-label")).toHaveTextContent("Token details are limited for you.");
    expect(screen.queryByText(CLAIM_LEAD)).not.toBeInTheDocument();
    expect(screen.queryByTestId("convert-snapshot-block")).not.toBeInTheDocument();
    expect(screen.queryByTestId("convert-claim-window")).not.toBeInTheDocument();
    expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
    expect(screen.queryByTestId("convert-switch-later")).not.toBeInTheDocument();
    expect(screen.getByTestId("convert-claim-safety")).toHaveTextContent(CLAIM_SAFETY_DM);
    expect(screen.getByTestId("convert-claim-safety")).not.toHaveTextContent(CLAIM_SAFETY_WALLET);
    expect(screen.getByRole("heading", { name: "Official contracts" })).toBeInTheDocument();
    for (const href of hrefs()) expect(href).toMatch(/^(https:\/\/basescan\.org\/|\/dashboard\/wallet$)/);
  });
});
