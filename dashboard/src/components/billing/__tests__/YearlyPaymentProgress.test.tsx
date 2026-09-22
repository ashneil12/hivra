/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import { YearlyPaymentProgress } from "../YearlyTokenPanels";
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
