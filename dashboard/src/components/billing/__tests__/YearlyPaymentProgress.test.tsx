/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

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
