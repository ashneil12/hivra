/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { ManagedVeniceCreditsPocket } from "../ManagedVeniceCreditsPocket";
import type { ManagedVeniceWalletSummaryPayload } from "@/lib/billing/managed-venice-client";

const summary: ManagedVeniceWalletSummaryPayload = {
  wallets: {
    hermesos: {
      tokenDisplay: "1,039,502 Hivra",
      lockedValueMicroUsd: 12_000_000,
      availableMicroUsd: 12_000_000,
      reservedMicroUsd: 0,
    },
    card: {
      balanceMicroUsd: 5_000_000,
      availableMicroUsd: 5_000_000,
      reservedMicroUsd: 0,
    },
  },
  discount: {
    rate: "launch_20",
    discountBps: 2000,
    launchSubsidyUsedMicroUsd: 187_000_000,
    launchSubsidyCapMicroUsd: 250_000_000,
  },
  killSwitch: {
    active: false,
    weeklySubsidyUsedMicroUsd: 780_000_000,
    thresholdMicroUsd: 1_000_000_000,
  },
  keys: [
    {
      id: "key_1",
      name: "Atlas managed Venice",
      keyPrefix: "hven_live_abc",
      status: "active",
      createdAt: "2026-05-16T10:00:00.000Z",
      updatedAt: "2026-05-16T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
      pausedReason: null,
      defaultWalletType: "hermesos",
    },
  ],
};

describe("ManagedVeniceCreditsPocket", () => {
  it("renders a quiet credits summary without proxy-key implementation detail", () => {
    render(<ManagedVeniceCreditsPocket summary={summary} />);

    expect(screen.getByText("Credits")).toBeInTheDocument();
    expect(screen.getByText("LLM Credits")).toBeInTheDocument();
    expect(screen.getByText("$17.0000 available")).toBeInTheDocument();
    expect(screen.getByText("General Credits")).toBeInTheDocument();
    expect(screen.getByText(/Coming soon/i)).toBeInTheDocument();
    expect(screen.queryByText("$12.0000 $HermesOS")).not.toBeInTheDocument();
    expect(screen.queryByText("$5.0000 card")).not.toBeInTheDocument();
    expect(screen.getByText(/One dollar balance for managed Venice usage/i)).toBeInTheDocument();
    expect(screen.getByText(/No Venice markup/i)).toBeInTheDocument();
    expect(screen.getByText(/Launch bonus/i)).toBeInTheDocument();
    expect(screen.getByText(/\$187\.00 of \$250\.00 used/i)).toBeInTheDocument();
    expect(screen.getByText(/78% of weekly launch allocation used/i)).toBeInTheDocument();
    expect(screen.queryByText(/proxy key/i)).not.toBeInTheDocument();
  });

  it("makes an empty wallet feel actionable instead of silently ready", () => {
    render(
      <ManagedVeniceCreditsPocket
        summary={{
          ...summary,
          wallets: {
            hermesos: { ...summary.wallets.hermesos, availableMicroUsd: 0 },
            card: { ...summary.wallets.card, availableMicroUsd: 0 },
          },
          keys: [],
        }}
      />
    );

    expect(screen.getByText(/Top up LLM credits before your next managed Venice request/i)).toBeInTheDocument();
    expect(screen.queryByText(/proxy/i)).not.toBeInTheDocument();
  });

  it("keeps refresh and missing-summary states quiet", () => {
    const { rerender } = render(<ManagedVeniceCreditsPocket summary={null} loading />);

    expect(screen.getByText("$0.0000 available")).toBeInTheDocument();
    expect(screen.queryByText(/checking/i)).not.toBeInTheDocument();

    rerender(<ManagedVeniceCreditsPocket summary={null} error="Not found" />);

    expect(screen.getByText("$0.0000 available")).toBeInTheDocument();
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument();
  });

  it("offers direct top-up and full management actions", () => {
    const onTopUp = jest.fn();
    const onManage = jest.fn();
    render(
      <ManagedVeniceCreditsPocket
        summary={summary}
        onTopUp={onTopUp}
        onManage={onManage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /top up llm credits/i }));
    fireEvent.click(screen.getByRole("button", { name: /manage/i }));

    expect(onTopUp).toHaveBeenCalledTimes(1);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it("puts the hide control in its own header row only when hiding is offered", () => {
    const { rerender } = render(<ManagedVeniceCreditsPocket summary={summary} />);
    expect(screen.queryByRole("button", { name: "Hide credits" })).not.toBeInTheDocument();

    const onHide = jest.fn();
    rerender(<ManagedVeniceCreditsPocket summary={summary} onHide={onHide} />);
    const hide = screen.getByRole("button", { name: "Hide credits" });
    expect(hide).toHaveStyle({ width: "44px", height: "44px" });
    fireEvent.click(hide);
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});
