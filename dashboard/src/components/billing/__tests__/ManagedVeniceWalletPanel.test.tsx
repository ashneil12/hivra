/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { ManagedVeniceWalletPanel } from "../ManagedVeniceWalletPanel";

const summary = {
  wallets: {
    hermesos: {
      tokenDisplay: "1,000 Hivra",
      lockedValueMicroUsd: 50_000_000,
      availableMicroUsd: 40_000_000,
      reservedMicroUsd: 10_000_000,
      lots: [],
    },
    card: {
      balanceMicroUsd: 25_000_000,
      availableMicroUsd: 25_000_000,
      reservedMicroUsd: 0,
    },
  },
  discount: {
    rate: "launch_20" as const,
    discountBps: 2000,
    launchSubsidyUsedMicroUsd: 187_000_000,
    launchSubsidyCapMicroUsd: 250_000_000,
  },
  killSwitch: {
    active: false,
    weeklySubsidyUsedMicroUsd: 500_000_000,
    thresholdMicroUsd: 1_000_000_000,
  },
};

describe("ManagedVeniceWalletPanel", () => {
  it("keeps card payment primary and token actions behind intentional disclosure", () => {
    render(<ManagedVeniceWalletPanel summary={summary} tokenPaymentsEnabled onDeposit={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Top up by card" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Top up with $HermesOS" })).not.toBeVisible();
    expect(screen.getByText("1,000 Hivra")).toBeVisible();
    expect(screen.getByText("Launch bonus cap: $187 of $250 used")).not.toBeVisible();
    fireEvent.click(screen.getByText("Optional token top-ups"));
    expect(screen.getByRole("button", { name: "Top up with $HermesOS" })).toBeVisible();
  });
  it("keeps existing balances visible but offers no disabled token payment flow", () => {
    render(<ManagedVeniceWalletPanel summary={summary} onDeposit={jest.fn()} />);
    expect(screen.getByText("1,000 Hivra")).toBeVisible();
    expect(screen.queryByText("Optional token top-ups")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Top up by card" })).toBeVisible();
  });
  it("renders Hivra and card balances side by side", () => {
    render(<ManagedVeniceWalletPanel summary={summary} tokenPaymentsEnabled />);

    expect(screen.getByText("$HermesOS wallet")).toBeInTheDocument();
    expect(screen.getByText("1,000 Hivra")).toBeInTheDocument();
    expect(screen.getByText("$50.0000 Venice credit")).toBeInTheDocument();
    expect(screen.getByText("Card credits")).toBeInTheDocument();
    expect(screen.getByText("$25.0000 available")).toBeInTheDocument();
  });

  it("shows launch cap usage and the 20% bonus nudge while eligible", () => {
    render(<ManagedVeniceWalletPanel summary={summary} tokenPaymentsEnabled />);

    expect(screen.getByText("Launch bonus cap: $187 of $250 used")).toBeInTheDocument();
    expect(screen.getByText("Pay with $HermesOS for up to 20% more credits")).toBeInTheDocument();
  });

  it("shows the 10% standard rate after cap or kill-switch step-down", () => {
    render(
      <ManagedVeniceWalletPanel
        tokenPaymentsEnabled
        summary={{
          ...summary,
          discount: {
            ...summary.discount,
            rate: "standard_10",
            discountBps: 1000,
          },
        }}
      />
    );

    expect(screen.getByText("Standard $HermesOS bonus: 10% more credits")).toBeInTheDocument();
  });

  it("opens managed Venice wallet-specific deposit actions", () => {
    const onDeposit = jest.fn();
    render(<ManagedVeniceWalletPanel summary={summary} tokenPaymentsEnabled onDeposit={onDeposit} />);

    fireEvent.click(screen.getByText("Optional token top-ups"));
    fireEvent.click(screen.getByRole("button", { name: /top up with \$hermesos/i }));
    fireEvent.click(screen.getByRole("button", { name: /top up by card/i }));

    expect(onDeposit).toHaveBeenNthCalledWith(1, "hermesos");
    expect(onDeposit).toHaveBeenNthCalledWith(2, "card");
  });
});
