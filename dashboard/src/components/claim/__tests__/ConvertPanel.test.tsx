/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { validateHivraLaunchConfig } from "@/lib/billing/token-registry";
import { resolveConversionState, type ConversionInputs } from "@/lib/claim/conversion-state";
import type { HivraAirdropConfig } from "@/lib/claim/hivra-airdrop-config";

import {
  AIRDROP_LABEL,
  ConvertPanel,
  DORMANT_MESSAGE,
  LAUNCHED_TITLE,
  NO_CLAIM_WARNING,
  PROPOSED_LABEL,
  SNAPSHOT_PENDING_MESSAGE,
} from "../ConvertPanel";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

const TEST_HIVRA = "0x1111111111111111111111111111111111111111";
const TEST_SENDER = "0x3333333333333333333333333333333333333333";
const SNAPSHOT_URL = "https://hivra.cloud/token/airdrop-snapshot";
const NOW = new Date("2026-10-03T12:00:00Z");
const NOT_PUBLISHED: HivraAirdropConfig = { senderAddress: TEST_SENDER, snapshotBlock: null, snapshotUrl: null, sentAt: null };
const PUBLISHED: HivraAirdropConfig = { ...NOT_PUBLISHED, snapshotBlock: 36_000_000, snapshotUrl: SNAPSHOT_URL };
const SENT: HivraAirdropConfig = { ...PUBLISHED, sentAt: "2026-10-02T18:00:00Z" };

const validation = validateHivraLaunchConfig({
  contractAddress: TEST_HIVRA,
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
});
const testHivra = validation.status === "configured" ? validation.token : null;

const DORMANT: ConversionInputs = { hivra: null, phase: "dormant", airdrop: SENT, access: null, now: NOW };
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
    // Nothing about the airdrop leaks before the launch block is filled in.
    expect(document.body.textContent).not.toMatch(/airdrop|snapshot/i);
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
  it("explains the push airdrop: nothing to claim or swap, no swap link, never connect a wallet", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(LAUNCHED_TITLE);
    expect(screen.getByTestId("convert-proposed-label")).toHaveTextContent(AIRDROP_LABEL);
    expect(screen.getByText(/one \$HIVRA for each\s+\$HermesOS it held/)).toBeInTheDocument();
    expect(screen.getByTestId("convert-no-claim")).toHaveTextContent(NO_CLAIM_WARNING);
    expect(screen.queryByText(DORMANT_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByText(/As proposed/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch my access/i })).not.toBeInTheDocument();
    // Only BaseScan, Wallet and nothing that could be a claim or swap site.
    for (const href of hrefs()) expect(href).toMatch(/^(https:\/\/basescan\.org\/|\/dashboard\/wallet$)/);
  });

  it("says the snapshot is not published yet, and lists the official contracts with $HermesOS as legacy", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByTestId("convert-snapshot-pending")).toHaveTextContent(SNAPSHOT_PENDING_MESSAGE);
    expect(screen.getByText("$HIVRA on Base")).toBeInTheDocument();
    expect(screen.getByText("$HermesOS on Base (legacy)")).toBeInTheDocument();
    expect(screen.getByText(TEST_HIVRA)).toBeInTheDocument();
  });

  it("shows the airdrop wallet with a BaseScan address link", () => {
    renderState({ ...LIVE, airdrop: NOT_PUBLISHED, access: null });

    expect(screen.getByText(TEST_SENDER)).toBeInTheDocument();
    expect(hrefs()).toContain(`https://basescan.org/address/${TEST_SENDER}`);
  });

  it("shows the published snapshot block and list, and that the airdrop is not sent yet", () => {
    renderState({ ...LIVE, airdrop: PUBLISHED, access: null });

    expect(screen.getByTestId("convert-snapshot-block")).toHaveTextContent("Snapshot block: 36000000");
    expect(screen.getByRole("link", { name: "36000000" })).toHaveAttribute("href", "https://basescan.org/block/36000000");
    expect(screen.getByRole("link", { name: "Open the published snapshot" })).toHaveAttribute("href", SNAPSHOT_URL);
    expect(screen.getByTestId("convert-airdrop-pending")).toBeInTheDocument();
    expect(screen.queryByTestId("convert-airdrop-sent")).not.toBeInTheDocument();
  });

  it("says when every transfer was confirmed", () => {
    renderState({ ...LIVE, airdrop: SENT, access: null });

    expect(screen.getByTestId("convert-airdrop-sent")).toHaveTextContent(/confirmed on Base by 2 October 2026 at 18:00 UTC/);
  });

  it("keeps a grandfathered holder on $HermesOS and offers no switch until the airdrop is sent", () => {
    renderState({ ...LIVE, airdrop: PUBLISHED, access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } });

    expect(screen.queryByTestId("convert-switch-access")).not.toBeInTheDocument();
    expect(screen.getByText(/Your tier counts the legacy \$HermesOS in your verified wallet, and that continues/)).toBeInTheDocument();
    expect(screen.getByText(/Once the airdrop is sent, you can choose to switch/)).toBeInTheDocument();
  });

  it("offers a grandfathered holder the optional switch once the airdrop is sent", () => {
    renderState({ ...LIVE, airdrop: SENT, access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } });

    expect(screen.getByTestId("convert-switch-access")).toHaveTextContent("Optional: switch your access to $HIVRA.");
    expect(screen.getByTestId("convert-switch-access")).toHaveTextContent(/If you keep your \$HermesOS where it is, you don't need to switch/);
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

  it("recognises the airdrop wallet in the address checker", () => {
    renderState({ ...LIVE, access: null });

    fireEvent.change(screen.getByLabelText("Contract address"), { target: { value: TEST_SENDER } });
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(screen.getByRole("status")).toHaveTextContent(/This is Hivra's airdrop wallet, not a token contract/);
  });

  it("writes no promotional wording", () => {
    renderState({ ...LIVE, airdrop: SENT, access: { grandfathered: true, convertedAt: null, conversionGraceEndsAt: null } });

    expect(document.body.textContent).not.toMatch(/\b(buy|price|discount|profit|returns?|invest\w*|free)\b/i);
  });
});
