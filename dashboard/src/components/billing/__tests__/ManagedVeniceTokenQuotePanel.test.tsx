/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, render, screen, within } from "@testing-library/react";

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

const HERMESOS_CONTRACT = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";

function mockViewport(compact: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: jest.fn((query: string) => ({
      matches: compact,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    })),
  });
}

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
    // Back to jsdom's default (no matchMedia → desktop layout).
    delete (window as { matchMedia?: unknown }).matchMedia;
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

  it("offers an Open in wallet link with the exact raw amount for a live quote", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "active")) as unknown as typeof fetch;
    render(<ManagedVeniceTokenQuotePanel quote={quote()} />);

    const link = screen.getByRole("link", { name: /open in wallet/i });
    expect(link).toHaveAttribute(
      "href",
      `ethereum:${HERMESOS_CONTRACT}@8453/transfer?address=0x000000000000000000000000000000000000feed&uint256=1000000000000000000000`
    );
    expect(screen.getByRole("button", { name: /copy amount/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
    // The full address is visible text, not only a QR or a tooltip.
    expect(screen.getByText("0x000000000000000000000000000000000000feed")).toBeInTheDocument();
  });

  it("never offers the wallet link once the rate window has ended or the transfer is under review", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "expired")) as unknown as typeof fetch;
    const { unmount } = render(
      <ManagedVeniceTokenQuotePanel quote={quote({ status: "expired", expiresAt: new Date(Date.now() - 1000).toISOString() })} />
    );
    expect(screen.getByText("Rate window ended")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    unmount();

    render(<ManagedVeniceTokenQuotePanel quote={quote({ status: "manual_review_required" })} />);
    expect(screen.getByText("Review needed")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
  });

  it("says a $HermesOS top-up is final before the user sends it", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "active")) as unknown as typeof fetch;
    render(<ManagedVeniceTokenQuotePanel quote={quote()} />);
    expect(screen.getByText("Token payments are final, except where the law gives you a right to cancel.")).toBeInTheDocument();
    expect(screen.getByText(/Send one Base transfer\./)).toBeInTheDocument();
  });

  it("gives no wallet link for a quote in another token", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "active")) as unknown as typeof fetch;
    render(<ManagedVeniceTokenQuotePanel quote={quote({ tokenSymbol: "USDC", tokenDecimals: 6 })} />);
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
  });

  it("shows the QR beside the address on desktop", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "active")) as unknown as typeof fetch;
    mockViewport(false);
    render(<ManagedVeniceTokenQuotePanel quote={quote()} />);
    expect(screen.getByTestId("address-qr").closest("details")).toBeNull();
    expect(screen.queryByText("Show QR code")).not.toBeInTheDocument();
  });

  it("moves the QR after the address and copy button, inside a closed disclosure, on phones", () => {
    global.fetch = jest.fn(() => checkResponse("no_match", "active")) as unknown as typeof fetch;
    mockViewport(true);
    render(<ManagedVeniceTokenQuotePanel quote={quote()} />);

    const summary = screen.getByText("Show QR code");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByTestId("address-qr")).toBeInTheDocument();
    // Copy address comes before the QR disclosure in reading order.
    const copyAddress = screen.getByRole("button", { name: /copy address/i });
    expect(copyAddress.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
