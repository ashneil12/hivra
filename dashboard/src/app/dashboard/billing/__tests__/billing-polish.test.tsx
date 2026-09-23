/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { BillingActivityPanel, type BillingActivityData } from "@/components/billing/BillingActivityPanel";
import { SlotMeter } from "../_components/RatingPlate";

const variants = { hidden: { opacity: 0 }, visible: { opacity: 1 } };

function veniceEvent(index: number) {
  return {
    id: `venice-${index}`,
    walletType: "card",
    endpoint: "chat/completions",
    model: "deepseek-v4-pro",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    actualCostMicroUsd: 2000,
    chargedMicroUsd: 2600,
    discountMicroUsd: 0,
    status: "settled",
    referenceId: `ref-${index}`,
    createdAt: "2026-08-28T23:41:00.000Z",
  };
}

const activityWithOverflow: BillingActivityData = {
  creditLedgerEntries: [],
  paymentTransactions: [],
  computeUsageEvents: [],
  llmUsageEvents: [],
  managedVeniceUsageEvents: Array.from({ length: 8 }, (_, index) => veniceEvent(index)),
  managedVeniceFinancialEvents: [],
};

describe("SlotMeter", () => {
  it("shows only the count for an unlimited pool, with no empty bar", () => {
    const { container } = render(<SlotMeter label="Agents & computers" used={10} total={999} />);

    expect(screen.getByText("10 in use")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("keeps the slot meter for a finite pool", () => {
    render(<SlotMeter label="Agents & computers" used={2} total={3} />);

    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuetext", "2 of 3 slots in use");
  });
});

describe("BillingActivityPanel overflow link", () => {
  it("links to the full activity view when shown on its own", () => {
    render(<BillingActivityPanel activity={activityWithOverflow} loading={false} error={null} variants={variants} managedVeniceBriefLimit={5} />);

    expect(screen.getByRole("link", { name: /view all activity \(3 more\)/i })).toHaveAttribute("href", "/dashboard/billing/activity");
  });

  it("leaves the full-activity link to the page when told to", () => {
    render(
      <BillingActivityPanel
        activity={activityWithOverflow}
        loading={false}
        error={null}
        variants={variants}
        managedVeniceBriefLimit={5}
        showOverflowLink={false}
      />
    );

    expect(screen.queryByRole("link", { name: /view all activity/i })).not.toBeInTheDocument();
  });
});
