/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";

import { ManagedVeniceTokenQuotePanel } from "../ManagedVeniceTokenQuotePanel";

jest.mock("@/lib/client/logger", () => ({
  clientLog: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("@/components/billing/LocalAddressQr", () => ({
  LocalAddressQr: () => <div data-testid="address-qr" />,
}));

const CLOSED_MESSAGE = "This quote closed without a matching payment. Request a new quote to top up.";

function quote(overrides: Record<string, unknown> = {}) {
  return {
    id: "mvq_1",
    tokenAmountRaw: "1000000000000000000000",
    tokenSymbol: "Hivra",
    tokenDecimals: 18,
    snapshotPriceUsd: "0.05",
    paidValueMicroUsd: 50_000_000,
    creditValueMicroUsd: 60_000_000,
    bonusValueMicroUsd: 10_000_000,
    depositAddress: "0x000000000000000000000000000000000000feed",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    status: "active",
    ...overrides,
  };
}

function checkResponse(status: string, quoteStatus = status) {
  return Promise.resolve({
    ok: true,
    json: async () => ({ success: true, data: { status, quote: quote({ status: quoteStatus }) } }),
  } as Response);
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  // Let the check's fetch/json promises settle inside act.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ManagedVeniceTokenQuotePanel", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows a clear closed message for a cancelled quote and never polls", async () => {
    const fetchMock = jest.fn(() => checkResponse("cancelled"));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ManagedVeniceTokenQuotePanel quote={quote({ status: "cancelled" })} />);
    await advance(60_000);

    expect(screen.getByRole("status")).toHaveTextContent(CLOSED_MESSAGE);
    expect(screen.getByText("Quote closed")).toBeInTheDocument();
    expect(screen.queryByText("Verify payment")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops polling once a background check reports the quote cancelled", async () => {
    const fetchMock = jest.fn(() => checkResponse("cancelled"));
    global.fetch = fetchMock as unknown as typeof fetch;

    // No onQuoteUpdate: the panel must stop polling on its own.
    render(<ManagedVeniceTokenQuotePanel quote={quote({ status: "expired" })} />);
    await advance(15_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(CLOSED_MESSAGE);

    await advance(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing active-quote copy and polling", async () => {
    const fetchMock = jest.fn(() => checkResponse("no_match", "active"));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ManagedVeniceTokenQuotePanel quote={quote()} />);

    expect(screen.getByText("Rate locked")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Send the exact Base transfer, then keep this page open or press Verify payment."
    );

    await advance(15_000);
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(CLOSED_MESSAGE)).not.toBeInTheDocument();
  });
});
