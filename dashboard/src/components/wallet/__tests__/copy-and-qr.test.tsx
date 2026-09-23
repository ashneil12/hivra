/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AgentDepositModal, AgentWalletCopyButton } from "../AgentWalletCards";
import { CopyAmountButton, InlineCopyAddress } from "../QuoteSection";
import type { AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: ({ label }: { label: string }) => <div data-testid="qr" aria-label={label} />,
}));

jest.mock("@/components/i18n/LocaleProvider", () => ({
  useLocale: () => ({ copy: { dashboard: { wallet: {} } }, locale: "en" }),
}));

const ADDRESS = "0x000000000000000000000000000000000000dEaD";

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
});

function card(): AgentWalletCardData {
  return {
    instance: { id: "inst_1", name: "Scout", status: "running", provider: "proxmox", lane: "hermes" },
    wallet: {
      evmAddress: ADDRESS,
      bankrWalletId: "bw_1",
      status: "active",
      withdrawalDestinationEvm: null,
      apiKeyStatus: "active",
    },
    balance: null,
    balances: [],
    withdrawalRecipients: [],
    balanceFailed: false,
    balanceError: null,
  };
}

describe("wallet copy buttons", () => {
  it("labels the amount copy button with what it copies", () => {
    render(<CopyAmountButton amount="46046512" />);
    const button = screen.getByRole("button", { name: "Copy amount" });
    expect(button).toHaveAttribute("title", "Copy raw amount (no commas) for pasting into your wallet");
  });

  it("keeps the agent wallet copy label and disables it without an address", () => {
    const { rerender } = render(<AgentWalletCopyButton text={ADDRESS} label="Copy Base address" />);
    expect(screen.getByRole("button", { name: "Copy Base address" })).toBeEnabled();
    rerender(<AgentWalletCopyButton text={null} />);
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
  });
});

describe("InlineCopyAddress", () => {
  it("shows the full address with a named copy button and the QR beside it on desktop", () => {
    mockViewport(false);
    render(<InlineCopyAddress label="Step 2 · To this address (Base network)" address={ADDRESS} />);
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Step 2 · To this address (Base network)" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("qr").closest("details")).toBeNull();
  });

  it("moves the QR behind 'Show QR code' after the copy button on phones", () => {
    mockViewport(true);
    render(<InlineCopyAddress label="Step 2 · To this address (Base network)" address={ADDRESS} />);
    const details = screen.getByText("Show QR code").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByTestId("qr")).toHaveAttribute(
      "aria-label",
      "Step 2 · To this address (Base network) QR code"
    );
  });
});

describe("AgentDepositModal", () => {
  it("leads with the address and copy button, and folds the QR away on phones", () => {
    mockViewport(true);
    const onClose = jest.fn();
    render(<AgentDepositModal card={card()} onClose={onClose} />);

    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy Base address" });
    const details = screen.getByText("Show QR code").closest("details") as HTMLDetailsElement;
    expect(copy.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(details.open).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
