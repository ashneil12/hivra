import {
  buildManagedVeniceDepositHref,
  getManagedVeniceTopUpQuoteMicroUsd,
  getManagedVeniceTopUpQuote,
} from "../managed-credit-topup";

describe("managed Venice top-up quote", () => {
  it("adds the launch bonus for $HermesOS top-ups", () => {
    expect(getManagedVeniceTopUpQuote(50, "hermesos")).toEqual({
      paidUsd: 50,
      launchBonusUsd: 10,
      standardBonusUsd: 0,
      bonusUsd: 10,
      totalCreditsUsd: 60,
    });
  });

  it("caps the 20% launch bonus and applies the 10% standard bonus afterward", () => {
    expect(getManagedVeniceTopUpQuote(1500, "hermesos")).toEqual({
      paidUsd: 1500,
      launchBonusUsd: 250,
      standardBonusUsd: 25,
      bonusUsd: 275,
      totalCreditsUsd: 1775,
    });
  });

  it("uses already-burned launch bonus when calculating a server-side top-up", () => {
    expect(
      getManagedVeniceTopUpQuoteMicroUsd({
        paidMicroUsd: 50_000_000,
        walletType: "hermesos",
        userLaunchBonusUsedMicroUsd: 245_000_000,
        weeklyLaunchBonusUsedMicroUsd: 0,
      })
    ).toMatchObject({
      launchPaidMicroUsd: 25_000_000,
      standardPaidMicroUsd: 25_000_000,
      launchBonusMicroUsd: 5_000_000,
      standardBonusMicroUsd: 2_500_000,
      bonusMicroUsd: 7_500_000,
      totalCreditsMicroUsd: 57_500_000,
      reason: "user_launch_cap_partially_reached",
    });
  });

  it("moves $HermesOS top-ups to the standard bonus when the kill switch is active", () => {
    expect(
      getManagedVeniceTopUpQuoteMicroUsd({
        paidMicroUsd: 50_000_000,
        walletType: "hermesos",
        killSwitchActive: true,
      })
    ).toMatchObject({
      launchBonusMicroUsd: 0,
      standardBonusMicroUsd: 5_000_000,
      totalCreditsMicroUsd: 55_000_000,
      reason: "weekly_kill_switch_active",
    });
  });

  it("keeps card credits pass-through with no Venice markup or bonus", () => {
    expect(getManagedVeniceTopUpQuote(50, "card")).toEqual({
      paidUsd: 50,
      launchBonusUsd: 0,
      standardBonusUsd: 0,
      bonusUsd: 0,
      totalCreditsUsd: 50,
    });
  });

  it("builds a deposit URL that preserves the selected wallet and amount", () => {
    expect(buildManagedVeniceDepositHref("hermesos", 50)).toBe(
      "/dashboard/billing?managedVenice=deposit&wallet=hermesos&amountUsd=50",
    );
  });
});
