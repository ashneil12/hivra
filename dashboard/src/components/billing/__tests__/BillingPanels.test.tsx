/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { CryptoTopUpPanel, TokenHoldingPanel } from "../BillingPanels";
import { copyTextToClipboard } from "@/lib/client/clipboard";
import type { TokenHoldingData } from "@/lib/billing/format";

jest.mock("@/lib/client/clipboard", () => ({
  copyTextToClipboard: jest.fn(),
}));

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));

const copyMock = copyTextToClipboard as jest.MockedFunction<typeof copyTextToClipboard>;
const DEPOSIT = "0x000000000000000000000000000000000000fEeD";

function mockViewport(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: compact,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
    })),
  });
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  copyMock.mockReset();
});

const intent = {
  referenceId: "crypto_topup:test",
  packageCredits: 1000,
  amountDisplay: "10",
  depositAddress: DEPOSIT,
  asset: { symbol: "USDC", network: "Base" },
};

describe("CryptoTopUpPanel", () => {
  it("gives the exact amount and the address copy buttons, with the QR code behind a disclosure on phones", async () => {
    mockViewport(true);
    copyMock.mockResolvedValue(true);
    render(<CryptoTopUpPanel intent={intent} error={null} toppingUp={null} onTopUp={jest.fn()} />);

    const panel = screen.getByRole("region", { name: "USDC on Base" });
    expect(panel).not.toHaveTextContent(/bankr|reconciliation/i);

    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Copy amount" }));
    });
    expect(copyMock).toHaveBeenLastCalledWith("10");
    await act(async () => {
      fireEvent.click(within(panel).getByRole("button", { name: "Copy address" }));
    });
    expect(copyMock).toHaveBeenLastCalledWith(DEPOSIT);

    const qr = within(panel).getByTestId("qr");
    const details = qr.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText("Show QR code")).toBeInTheDocument();
  });

  it("shows the QR code beside the address on a desktop", () => {
    mockViewport(false);
    render(<CryptoTopUpPanel intent={intent} error={null} toppingUp={null} onTopUp={jest.fn()} />);

    expect(screen.getByTestId("qr").closest("details")).toBeNull();
    expect(screen.getByText(DEPOSIT)).toBeInTheDocument();
  });
});

describe("TokenHoldingPanel", () => {
  const holding: TokenHoldingData = {
    token: {
      chainId: 8453,
      tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
      tokenSymbol: "Hivra",
      minimumBalanceDisplay: "1",
    },
    wallet: {
      id: "wallet_1",
      address: "0x000000000000000000000000000000000000dEaD",
      normalizedAddress: "0x000000000000000000000000000000000000dead",
      chainId: 8453,
      verifiedAt: "2026-04-24T12:00:00.000Z",
    },
    snapshot: { id: "s1", balanceDisplay: "0.75", qualifiesBaseTier: false, checkedAt: "2026-04-24T12:01:00.000Z" },
    entitlement: { verified: true, qualifiesBaseTier: false },
  };

  function renderPanel(data: TokenHoldingData | null) {
    return render(
      <TokenHoldingPanel
        embedded
        tokenHolding={data}
        loading={false}
        refreshing={false}
        connectingWallet={false}
        error={null}
        onRefresh={jest.fn()}
        onConnectWallet={jest.fn()}
      />
    );
  }

  it("shows the wallet once: its full address with a copy button and its balance", async () => {
    copyMock.mockResolvedValue(true);
    renderPanel(holding);

    expect(screen.getAllByText("0x000000000000000000000000000000000000dEaD")).toHaveLength(1);
    expect(screen.getAllByText("0.75 $HermesOS")).toHaveLength(1);
    expect(screen.getByText("Wallet verified")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    });
    expect(copyMock).toHaveBeenLastCalledWith("0x000000000000000000000000000000000000dEaD");
  });

  it("never presents the 1-token base-tier minimum or its verdict (they are not plan requirements)", () => {
    for (const qualifies of [false, true]) {
      const { container, unmount } = renderPanel({
        ...holding,
        snapshot: { ...holding.snapshot!, qualifiesBaseTier: qualifies },
        entitlement: { verified: true, qualifiesBaseTier: qualifies },
      });
      expect(container).not.toHaveTextContent(/minimum|qualified|base tier|(^|[^\d.])1 \$HermesOS/i);
      unmount();
    }
  });

  it("shows a wallet that isn't verified without a balance or copy button", () => {
    renderPanel({ ...holding, wallet: null, snapshot: null, entitlement: { verified: false, qualifiesBaseTier: false } });

    expect(screen.getByText("No verified wallet")).toBeInTheDocument();
    expect(screen.getByText("Not verified")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Hivra$/)).not.toBeInTheDocument();
  });
});
