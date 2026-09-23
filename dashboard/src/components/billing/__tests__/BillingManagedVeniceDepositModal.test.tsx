/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ManagedVeniceDepositModal } from "../YearlyTokenPanels";

jest.mock("@/lib/client/logger", () => ({
  clientLog: { error: jest.fn(), warn: jest.fn() },
}));

// The billing page's controlled top-up dialog (YearlyTokenPanels), not the
// self-contained welcome-flow one.
function renderModal(overrides: Partial<Parameters<typeof ManagedVeniceDepositModal>[0]> = {}) {
  const props = {
    isOpen: true,
    walletType: "card" as const,
    amountUsd: 50,
    loading: false,
    error: null,
    quote: null,
    onClose: jest.fn(),
    onWalletTypeChange: jest.fn(),
    onAmountChange: jest.fn(),
    onStartHermesTopUp: jest.fn(),
    onStartCardTopUp: jest.fn(),
    onQuoteUpdate: jest.fn(),
    onRefreshSummary: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
  const utils = render(<ManagedVeniceDepositModal {...props} />);
  return { ...utils, props };
}

describe("billing ManagedVeniceDepositModal", () => {
  it("offers card only unless a token top-up is already selected and token payments are on", () => {
    const { unmount } = renderModal();
    expect(screen.getByRole("button", { name: /pay by card/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /pay with \$HermesOS/i })).not.toBeInTheDocument();
    unmount();

    renderModal({ walletType: "hermesos", tokenPaymentsEnabled: false });
    expect(screen.queryByRole("button", { name: /pay with \$HermesOS/i })).not.toBeInTheDocument();
  });

  it("shows the $HermesOS option for a token top-up when token payments are on", () => {
    renderModal({ walletType: "hermesos", tokenPaymentsEnabled: true });
    expect(screen.getByRole("button", { name: /pay with \$HermesOS/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /start \$HermesOS top-up/i })).toBeInTheDocument();
  });

  it("starts card checkout and closes from the 44px Close button", () => {
    const { props, container } = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Top up managed Venice credits" });
    expect(container).not.toContainElement(dialog);
    expect(screen.getByRole("heading", { name: "Top up managed Venice credits" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /start card checkout/i }));
    expect(props.onStartCardTopUp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("reports a refresh that resolves false as a failure", async () => {
    renderModal({ onRefreshSummary: jest.fn().mockResolvedValue(false) });
    fireEvent.click(screen.getByRole("button", { name: /refresh wallet/i }));
    await waitFor(() => expect(screen.getByText(/refresh failed/i)).toBeInTheDocument());
  });

  it("renders nothing while closed", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
