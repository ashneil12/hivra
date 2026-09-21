/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ManagedVeniceDepositModal } from "../ManagedVeniceDepositModal";
import { redirectToCheckoutUrl } from "@/lib/billing/client";

jest.mock("@/lib/billing/client", () => ({
  redirectToCheckoutUrl: jest.fn(),
}));

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe("ManagedVeniceDepositModal", () => {
  const activeQuote = {
    id: "mvq_1",
    tokenAmountRaw: "1000000000000000000000",
    tokenSymbol: "Hivra",
    tokenDecimals: 18,
    snapshotPriceUsd: "0.05",
    paidValueMicroUsd: 50_000_000,
    creditValueMicroUsd: 60_000_000,
    bonusValueMicroUsd: 10_000_000,
    depositAddress: "0x000000000000000000000000000000000000feed",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "active",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    let checkCount = 0;
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/billing/managed-venice/hermesos/quote")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: activeQuote,
          }),
        } as Response);
      }
      if (url.includes("/api/billing/managed-venice/hermesos/check")) {
        checkCount += 1;
        const settled = checkCount >= 1;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              status: settled ? "settled" : "no_match",
              quote: settled
                ? {
                    ...activeQuote,
                    status: "settled",
                    transactionHash: "0xsettled",
                    settledAt: "2026-05-19T08:20:34.000Z",
                  }
                : activeQuote,
            },
          }),
        } as Response);
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({
          success: true,
          data: { url: "https://checkout.stripe.test/managed-venice-card" },
        }),
      } as Response);
    }) as typeof fetch;
  });

  it("creates a $HermesOS quote without leaving the current page", async () => {
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="hermesos"
        initialAmountUsd={50}
        onClose={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /start \$HermesOS top-up/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/billing/managed-venice/hermesos/quote",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ targetPaidMicroUsd: 50_000_000 }),
        })
      );
    });
    expect(await screen.findByText(/rate locked/i)).toBeInTheDocument();
    expect(screen.getByText(/we credit \$60\.00 including \$10\.00 bonus/i)).toBeInTheDocument();
  });

  it("lets users manually verify a sent $HermesOS top-up", async () => {
    const onRefreshSummary = jest.fn();
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="hermesos"
        initialAmountUsd={50}
        onClose={jest.fn()}
        onRefreshSummary={onRefreshSummary}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /start \$HermesOS top-up/i }));

    const verifyButton = await screen.findByRole("button", { name: /verify payment/i });
    fireEvent.click(verifyButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/billing/managed-venice/hermesos/check",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ quoteId: "mvq_1" }),
        })
      );
    });
    expect(await screen.findByText(/payment confirmed/i)).toBeInTheDocument();
    expect(onRefreshSummary).toHaveBeenCalled();
  });

  it("starts card checkout for managed Venice card credits", async () => {
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="card"
        initialAmountUsd={50}
        onClose={jest.fn()}
      />
    );

    expect(screen.queryByText(/^Bonus$/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("$50.00", { selector: "strong" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /start card checkout/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/billing/managed-venice/card/top-up",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ amountMicroUsd: 50_000_000 }),
        })
      );
    });
    expect(redirectToCheckoutUrl).toHaveBeenCalledWith(
      "https://checkout.stripe.test/managed-venice-card"
    );
  });

  it("disables Refresh wallet while a refresh is in flight, ignores duplicate clicks, and reports success", async () => {
    let resolveRefresh: () => void = () => {};
    const onRefreshSummary = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="card"
        initialAmountUsd={50}
        onClose={jest.fn()}
        onRefreshSummary={onRefreshSummary}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh wallet/i }));

    const refreshingButton = await screen.findByRole("button", { name: /refreshing/i });
    expect(refreshingButton).toBeDisabled();

    fireEvent.click(refreshingButton);
    fireEvent.click(refreshingButton);
    expect(onRefreshSummary).toHaveBeenCalledTimes(1);

    resolveRefresh();

    expect(await screen.findByText(/wallet refreshed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh wallet/i })).toBeEnabled();
  });

  it("surfaces an inline error and re-enables Refresh wallet when the refresh fails", async () => {
    const onRefreshSummary = jest.fn().mockRejectedValue(new Error("summary fetch failed"));
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="card"
        initialAmountUsd={50}
        onClose={jest.fn()}
        onRefreshSummary={onRefreshSummary}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh wallet/i }));

    expect(await screen.findByText(/refresh failed/i)).toBeInTheDocument();
    expect(onRefreshSummary).toHaveBeenCalledTimes(1);
    const refreshButton = screen.getByRole("button", { name: /refresh wallet/i });
    expect(refreshButton).toBeEnabled();

    fireEvent.click(refreshButton);
    await waitFor(() => {
      expect(onRefreshSummary).toHaveBeenCalledTimes(2);
    });
  });

  it("treats a refresh that resolves false as a failure (handlers that swallow errors)", async () => {
    // The live billing page's fetchManagedVeniceSummary never rejects — it
    // resolves false when the refresh failed. The modal must not flash
    // "Wallet refreshed" over an emptied wallet panel in that case.
    const onRefreshSummary = jest.fn().mockResolvedValue(false);
    render(
      <ManagedVeniceDepositModal
        isOpen
        initialWalletType="card"
        initialAmountUsd={50}
        onClose={jest.fn()}
        onRefreshSummary={onRefreshSummary}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /refresh wallet/i }));

    expect(await screen.findByText(/refresh failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/wallet refreshed/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh wallet/i })).toBeEnabled();
  });
});
