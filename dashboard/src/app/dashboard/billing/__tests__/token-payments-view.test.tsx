/** @jest-environment jsdom */
/**
 * What Billing offers in tokens when /api/billing/token-payments answers,
 * is still pending, or fails; and the token labels on the remaining surfaces.
 */
import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({}), useSearchParams: () => ({ get: () => null }) }));

import { resolveTokenPaymentsView } from "../useBillingController";
import { cardStatus } from "../_components/PaymentMethodsTab";
import { activePlanPriceLine } from "@/lib/billing/plan-display";
import { YearlyPaymentProgress } from "@/components/billing/YearlyTokenPanels";
import { ManagedVeniceWalletPanel } from "@/components/billing/ManagedVeniceWalletPanel";
import { SelfCustodyVerificationPanel } from "@/components/wallet/QuoteSection";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";

const grandfathered = { phase: "active", grandfathered: true, paymentToken: "hermesos" };
const gated = { phase: "active", grandfathered: false, paymentToken: "hivra" };

describe("resolveTokenPaymentsView", () => {
  it("uses the server's answer when it has one", () => {
    expect(
      resolveTokenPaymentsView({
        hivraPhaseActive: true,
        answer: { available: false, displayUnit: "$HIVRA" },
        eligibilityAccess: null,
        eligibilitySettled: false,
      })
    ).toEqual({ available: false, displayUnit: "$HIVRA", pending: false });
  });

  it("changes nothing and waits for nothing before activation", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: false, answer: null, eligibilityAccess: null, eligibilitySettled: false })
    ).toEqual({ available: true, displayUnit: "$HermesOS", pending: false });
  });

  it("is pending after activation until the answer arrives, so nothing flashes", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: null, eligibilityAccess: grandfathered, eligibilitySettled: true })
        .pending
    ).toBe(true);
  });

  it("keeps a grandfathered account's token options when the request fails", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: "failed", eligibilityAccess: grandfathered, eligibilitySettled: true })
    ).toEqual({ available: true, displayUnit: "$HermesOS", pending: false });
  });

  it("waits for the eligibility answer before deciding a failed request", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: "failed", eligibilityAccess: null, eligibilitySettled: false })
        .pending
    ).toBe(true);
  });

  it("hides them from a gated account when the request fails, unless eligibility says new tiers are on", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: "failed", eligibilityAccess: gated, eligibilitySettled: true })
    ).toEqual({ available: false, displayUnit: "$HIVRA", pending: false });
    expect(
      resolveTokenPaymentsView({
        hivraPhaseActive: true,
        answer: "failed",
        eligibilityAccess: { ...gated, newTiersAvailable: true },
        eligibilitySettled: true,
      }).available
    ).toBe(true);
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: "failed", eligibilityAccess: "not_ready", eligibilitySettled: true })
        .available
    ).toBe(false);
  });

  it("fails closed when nothing says the account is grandfathered", () => {
    expect(
      resolveTokenPaymentsView({ hivraPhaseActive: true, answer: "failed", eligibilityAccess: null, eligibilitySettled: true })
    ).toEqual({ available: false, displayUnit: "$HermesOS", pending: false });
  });
});

describe("token labels follow the account's token", () => {
  it("names the token a plan is paid with", () => {
    expect(cardStatus({ key: "operator", source: "token_yearly" }, "$HIVRA").text).toBe(
      "Your plan is paid with $HIVRA, not a card."
    );
    expect(cardStatus({ key: "operator", source: "token_yearly" }).text).toBe("Your plan is paid with $HermesOS, not a card.");
    expect(activePlanPriceLine({ planKey: "operator", source: "token_holding", currentPeriodEnd: null, tokenUnit: "$HIVRA" })).toBe(
      "Unlocked by holding $HIVRA · active while you hold"
    );
    expect(activePlanPriceLine({ planKey: "operator", source: "token_yearly", currentPeriodEnd: null, tokenUnit: "$HIVRA" })).toBe(
      "Paid with $HIVRA · doesn't renew automatically"
    );
  });

  it("names the account's token on a yearly banner with no quote", () => {
    render(
      <YearlyPaymentProgress
        tier="pro"
        quote={null}
        subscription={null}
        onResume={() => {}}
        onCheckNow={() => {}}
        checkingNow={false}
        tokenUnit="$HIVRA"
      />
    );
    expect(screen.getByText("Yearly $HIVRA · Pro")).toBeInTheDocument();
  });

  it("names the token wallet in model credits", () => {
    render(
      <ManagedVeniceWalletPanel
        tokenUnit="$HIVRA"
        summary={{
          wallets: {
            hermesos: { tokenDisplay: "10 HIVRA", lockedValueMicroUsd: 1, availableMicroUsd: 1, reservedMicroUsd: 0, lots: [] },
            card: { balanceMicroUsd: 0, availableMicroUsd: 0, reservedMicroUsd: 0 },
          },
          discount: { rate: "standard_10", discountBps: 1000, launchSubsidyUsedMicroUsd: 0, launchSubsidyCapMicroUsd: 0 },
          killSwitch: { active: false, weeklySubsidyUsedMicroUsd: 0, thresholdMicroUsd: 1 },
        } as unknown as Parameters<typeof ManagedVeniceWalletPanel>[0]["summary"]}
      />
    );
    expect(screen.getByText("$HIVRA wallet")).toBeInTheDocument();
  });
});

describe("wallet price lock", () => {
  function renderPanel(onLockPrice?: () => void) {
    return render(
      <LocaleProvider initialLocale="en">
        <SelfCustodyVerificationPanel
          connecting={false}
          locking={false}
          connectedAddress="0x000000000000000000000000000000000000dEaD"
          balanceDisplay="1"
          checkedAt={null}
          eligibleTier={null}
          lockTier="pro"
          lockQuote={null}
          lockedAmountDisplay={null}
          tokenSymbol="HIVRA"
          veniceBoostEligible={false}
          error={null}
          success={null}
          onConnect={() => {}}
          onLockPrice={onLockPrice}
        />
      </LocaleProvider>
    );
  }

  it("is offered when a new price lock can be made", () => {
    renderPanel(() => {});
    expect(screen.getByRole("button", { name: /Lock Pro price/ })).toBeInTheDocument();
  });

  it("is hidden while new $HIVRA tiers are off", () => {
    renderPanel(undefined);
    expect(screen.queryByRole("button", { name: /Lock Pro price/ })).not.toBeInTheDocument();
  });
});
