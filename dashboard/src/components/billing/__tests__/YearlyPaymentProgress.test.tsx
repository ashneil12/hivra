/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { YearlyPaymentProgress, YearlyTokenPaymentModal } from "../YearlyTokenPanels";
import type { YearlyTokenQuotePayload, YearlyTokenSubscriptionPayload } from "@/lib/billing/format";

const inTenMinutes = () => new Date(Date.now() + 10 * 60_000).toISOString();

function quote(): YearlyTokenQuotePayload {
  return {
    id: "yq_renewal",
    tier: "pro",
    usdTargetCents: 4900,
    priceUsdAtQuote: "0.0000025",
    tokensRequiredDisplay: "19600000",
    tokenSymbol: "Hivra",
    depositAddress: "0x000000000000000000000000000000000000ba5e",
    expiresAt: inTenMinutes(),
    status: "active",
  };
}

function subscription(overrides: Partial<YearlyTokenSubscriptionPayload> = {}): YearlyTokenSubscriptionPayload {
  return {
    id: "ys_1",
    tier: "pro",
    yearlyQuoteId: "yq_first_year",
    paidAt: "2025-10-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    status: "active",
    sweepStatus: "swept",
    sweepTxHash: null,
    amountReceivedRaw: "1",
    ...overrides,
  };
}

function renderProgress(props: {
  quote: YearlyTokenQuotePayload | null;
  subscription: YearlyTokenSubscriptionPayload | null;
}) {
  return render(
    <YearlyPaymentProgress
      tier="pro"
      quote={props.quote}
      subscription={props.subscription}
      onResume={() => {}}
      onCheckNow={() => {}}
      checkingNow={false}
    />
  );
}

it("shows a renewal payment as still waiting while the current year belongs to an earlier payment", () => {
  renderProgress({ quote: quote(), subscription: subscription() });

  expect(screen.getByText("Waiting…")).toBeInTheDocument();
  expect(screen.getByText("Activating…")).toBeInTheDocument();
  expect(screen.queryByText(/Pro tier active/)).not.toBeInTheDocument();
});

it("shows the year as live once the subscription this payment created arrives", () => {
  renderProgress({ quote: null, subscription: subscription({ yearlyQuoteId: "yq_renewal", expiresAt: "2027-10-01T00:00:00.000Z" }) });

  expect(screen.getByText(/Pro tier active/)).toBeInTheDocument();
  expect(screen.getByText("Detected on chain")).toBeInTheDocument();
});

it("tells the user not to pay again while a payment is under review", () => {
  renderProgress({
    quote: { ...quote(), status: "manual_review", expiresAt: new Date(Date.now() - 60 * 60_000).toISOString() },
    subscription: null,
  });

  expect(screen.getByText("Payment under review")).toBeInTheDocument();
  expect(screen.getByText(/Please don't send another payment/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Check now/ })).not.toBeInTheDocument();
});

it("keeps the live region off the 1-second countdown and gives screen readers a fixed expiry time", () => {
  const q = quote();
  renderProgress({ quote: q, subscription: null });

  const live = screen.getByRole("status");
  expect(live).toHaveAttribute("aria-live", "polite");
  expect(live).toHaveTextContent(/Send tokens to your deposit address/);
  // The ticking MM:SS lives outside the live region and is hidden from AT.
  const countdown = screen.getByTestId("yearly-countdown");
  expect(countdown).toHaveTextContent(/^\d\d:\d\d$/);
  expect(countdown).toHaveAttribute("aria-hidden", "true");
  expect(live).not.toContainElement(countdown);
  const clock = new Date(q.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  expect(screen.getByText(`Quote expires at ${clock}`)).toBeInTheDocument();
});

it("never calls the yearly deposit address non-custodial", () => {
  const { unmount } = renderProgress({ quote: quote(), subscription: null });
  expect(screen.queryByText(/non-custodial/i)).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(/non-custodial/i);
  expect(screen.getByText(/payment address on Base/)).toBeInTheDocument();
  unmount();

  render(<YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={quote()} onClose={() => {}} />);
  expect(document.body).not.toHaveTextContent(/non-custodial/i);
});

it("keeps checking for a late payment after the countdown ends instead of prompting a new quote", () => {
  renderProgress({
    quote: { ...quote(), status: "expired", expiresAt: new Date(Date.now() - 5 * 60_000).toISOString() },
    subscription: null,
  });

  expect(screen.getByText("Watching for a late payment")).toBeInTheDocument();
  expect(screen.getByText(/If you already sent the tokens, don't send them again/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Check now/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Open quote/ })).not.toBeInTheDocument();
});

it("tells a user whose quote expired in the payment modal not to send the tokens again", () => {
  render(
    <YearlyTokenPaymentModal
      isOpen
      tier="pro"
      loading={false}
      error={null}
      quote={{ ...quote(), expiresAt: new Date(Date.now() - 60_000).toISOString() }}
      onClose={() => {}}
    />
  );

  expect(screen.getByText(/If you already sent the tokens, don't send them again/)).toBeInTheDocument();
  expect(screen.getByText(/up to 2 hours late/)).toBeInTheDocument();
  expect(screen.getByText(/start a fresh quote/)).toBeInTheDocument();
  // An expired quote must not keep inviting a payment.
  expect(screen.queryByText(/Step 1 · Send exactly/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Step 2 · To this address/)).not.toBeInTheDocument();
  expect(screen.queryByText(/activates within ~5 minutes/)).not.toBeInTheDocument();
});

it("warns in the payment modal when a payment for the tier is already under review", () => {
  render(
    <YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={quote()} onClose={() => {}} reviewPending />
  );

  expect(screen.getByRole("note")).toHaveTextContent(/already under review/);
  expect(screen.getByText(/Step 1 · Send exactly/)).toBeInTheDocument();
});

it("offers no one-tap wallet link while a payment for the tier is under review", () => {
  const liveQuote = { ...quote(), tokensRequiredRaw: "19600000000000000000000000", tokenDecimals: 18 };
  const { unmount } = render(
    <YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={liveQuote} onClose={() => {}} />
  );
  expect(screen.getByRole("link", { name: /open in wallet/i })).toBeInTheDocument();
  unmount();

  render(
    <YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={liveQuote} onClose={() => {}} reviewPending />
  );
  expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
  // The details stay available if support asks the user to pay again.
  expect(screen.getByRole("button", { name: /copy amount/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
});

it("says in the payment modal that a $HermesOS payment is final", () => {
  render(<YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={quote()} onClose={() => {}} />);
  expect(screen.getByText("Token payments are final, except where the law gives you a right to cancel.")).toBeInTheDocument();
});

describe("YearlyTokenPaymentModal", () => {
  const HERMESOS_CONTRACT = "0x95ccfD2B81A9667b0Cc979992632F98fc853EBa3";
  const liveQuote = () => ({
    ...quote(),
    tokensRequiredRaw: "19600000000000000000000000",
    tokenDecimals: 18,
  });

  function renderModal(props: Partial<Parameters<typeof YearlyTokenPaymentModal>[0]> = {}) {
    const onClose = jest.fn();
    const utils = render(
      <YearlyTokenPaymentModal isOpen tier="pro" loading={false} error={null} quote={liveQuote()} onClose={onClose} {...props} />
    );
    return { ...utils, onClose };
  }

  it("renders through a body portal with a 44px Close button named exactly 'Close'", () => {
    const { container, onClose } = renderModal();
    const dialog = screen.getByRole("dialog", { name: "Pay Pro yearly with $HermesOS" });
    expect(container).not.toContainElement(dialog);
    expect(screen.getByRole("heading", { name: "Pro · $49/yr" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("puts Copy amount and Copy address under their values and keeps the countdown pinned", () => {
    renderModal();
    expect(screen.getByRole("button", { name: /copy amount/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy address/i })).toBeInTheDocument();
    expect(screen.getByText("0x000000000000000000000000000000000000ba5e")).toBeInTheDocument();
    expect(screen.getByText(/^Expires in \d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.getByText("Quote locked")).toBeInTheDocument();
  });

  it("offers Open in wallet with the exact raw amount on Base", () => {
    renderModal();
    expect(screen.getByRole("link", { name: /open in wallet/i })).toHaveAttribute(
      "href",
      `ethereum:${HERMESOS_CONTRACT}@8453/transfer?address=0x000000000000000000000000000000000000ba5e&uint256=19600000000000000000000000`
    );
  });

  it("offers no wallet link unless the raw amount is known and matches the amount shown", () => {
    const { unmount } = renderModal({ quote: quote() });
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    unmount();

    // Raw that does not equal display × 10^decimals: the link is dropped.
    renderModal({ quote: { ...liveQuote(), tokensRequiredRaw: "19600000000000000000000001" } });
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
  });

  it("offers no wallet link for an expired quote", () => {
    renderModal({ quote: { ...liveQuote(), expiresAt: new Date(Date.now() - 1000).toISOString() } });
    expect(screen.queryByRole("link", { name: /open in wallet/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Quote locked")).not.toBeInTheDocument();
  });

  it("renders nothing while closed", () => {
    renderModal({ isOpen: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
