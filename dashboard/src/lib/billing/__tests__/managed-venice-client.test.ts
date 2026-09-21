import {
  readManagedVeniceSummary,
  type ManagedVeniceWalletSummaryPayload,
} from "../managed-venice-client";

describe("managed Venice billing client", () => {
  it("preserves wallet, discount, kill-switch, and proxy-key readiness from the summary endpoint", () => {
    const summary = readManagedVeniceSummary({
      wallets: {
        hermesos: {
          tokenDisplay: "1,039,502 Hivra",
          lockedValueMicroUsd: 12_000_000,
          availableMicroUsd: 11_000_000,
          reservedMicroUsd: 1_000_000,
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
    });

    expect(summary).toMatchObject<ManagedVeniceWalletSummaryPayload>({
      wallets: {
        hermesos: {
          tokenDisplay: "1,039,502 Hivra",
          lockedValueMicroUsd: 12_000_000,
          availableMicroUsd: 11_000_000,
          reservedMicroUsd: 1_000_000,
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
        expect.objectContaining({
          id: "key_1",
          status: "active",
          defaultWalletType: "hermesos",
        }),
      ],
    });
  });
});
