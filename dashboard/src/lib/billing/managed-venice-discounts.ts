import { multiplyMicrodollarsByRatio } from "./microdollars";
import type { ManagedVeniceWalletType } from "./managed-venice-wallets";
import {
  MANAGED_VENICE_LAUNCH_BONUS_BPS,
  MANAGED_VENICE_STANDARD_BONUS_BPS,
  MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD,
  MANAGED_VENICE_WEEKLY_LAUNCH_BONUS_LIMIT_MICRO_USD,
} from "@/lib/venice/managed-credit-topup";

export type ManagedVeniceDiscountRate =
  | "launch_20"
  | "standard_10"
  | "mixed_launch_standard"
  | "none";

// Re-export under the historical "discount" names. The single
// source-of-truth lives in managed-credit-topup.ts so the deposit-bonus
// and chat-discount surfaces never drift from each other.
export const MANAGED_VENICE_LAUNCH_DISCOUNT_BPS = MANAGED_VENICE_LAUNCH_BONUS_BPS;
export const MANAGED_VENICE_STANDARD_DISCOUNT_BPS = MANAGED_VENICE_STANDARD_BONUS_BPS;
export const MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD =
  MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD;
export const MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD =
  MANAGED_VENICE_WEEKLY_LAUNCH_BONUS_LIMIT_MICRO_USD;

function requireNonNegativeMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer microdollar amount`);
  }
}

function requirePositiveMicroUsd(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer microdollar amount`);
  }
}

function discountForBps(amountMicroUsd: number, discountBps: number) {
  return multiplyMicrodollarsByRatio(amountMicroUsd, discountBps, 10_000);
}

export function resolveManagedVeniceDiscount(params: {
  walletType: ManagedVeniceWalletType;
  userLaunchSubsidyUsedMicroUsd: number;
  weeklySubsidyUsedMicroUsd: number;
  killSwitchActive?: boolean;
}): {
  rate: Exclude<ManagedVeniceDiscountRate, "mixed_launch_standard">;
  discountBps: number;
  reason: string;
} {
  requireNonNegativeMicroUsd(
    params.userLaunchSubsidyUsedMicroUsd,
    "user launch subsidy used"
  );
  requireNonNegativeMicroUsd(
    params.weeklySubsidyUsedMicroUsd,
    "weekly subsidy used"
  );

  if (params.walletType === "card") {
    return {
      rate: "none",
      discountBps: 0,
      reason: "card_wallet_unsubsidized",
    };
  }

  if (params.killSwitchActive) {
    return {
      rate: "standard_10",
      discountBps: MANAGED_VENICE_STANDARD_DISCOUNT_BPS,
      reason: "weekly_kill_switch_active",
    };
  }

  if (
    params.weeklySubsidyUsedMicroUsd >=
    MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD
  ) {
    return {
      rate: "standard_10",
      discountBps: MANAGED_VENICE_STANDARD_DISCOUNT_BPS,
      reason: "weekly_kill_switch_reached",
    };
  }

  if (
    params.userLaunchSubsidyUsedMicroUsd >=
    MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD
  ) {
    return {
      rate: "standard_10",
      discountBps: MANAGED_VENICE_STANDARD_DISCOUNT_BPS,
      reason: "user_launch_cap_reached",
    };
  }

  return {
    rate: "launch_20",
    discountBps: MANAGED_VENICE_LAUNCH_DISCOUNT_BPS,
    reason: "launch_wave_available",
  };
}

export function calculateManagedVeniceDiscount(params: {
  walletType: ManagedVeniceWalletType;
  costMicroUsd: number;
  userLaunchSubsidyUsedMicroUsd: number;
  weeklySubsidyUsedMicroUsd: number;
  killSwitchActive?: boolean;
}) {
  requirePositiveMicroUsd(params.costMicroUsd, "Venice cost");
  const resolved = resolveManagedVeniceDiscount(params);

  if (resolved.rate === "none") {
    return {
      ...resolved,
      costMicroUsd: params.costMicroUsd,
      chargeMicroUsd: params.costMicroUsd,
      discountMicroUsd: 0,
      launchSubsidyMicroUsd: 0,
      standardSubsidyMicroUsd: 0,
    };
  }

  if (resolved.rate === "standard_10") {
    const discountMicroUsd = discountForBps(
      params.costMicroUsd,
      MANAGED_VENICE_STANDARD_DISCOUNT_BPS
    );
    return {
      ...resolved,
      costMicroUsd: params.costMicroUsd,
      chargeMicroUsd: params.costMicroUsd - discountMicroUsd,
      discountMicroUsd,
      launchSubsidyMicroUsd: 0,
      standardSubsidyMicroUsd: discountMicroUsd,
    };
  }

  const rawLaunchDiscountMicroUsd = discountForBps(
    params.costMicroUsd,
    MANAGED_VENICE_LAUNCH_DISCOUNT_BPS
  );
  const userLaunchRemainingMicroUsd = Math.max(
    0,
    MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD -
      params.userLaunchSubsidyUsedMicroUsd
  );
  const weeklyLaunchRemainingMicroUsd = Math.max(
    0,
    MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD -
      params.weeklySubsidyUsedMicroUsd
  );
  const launchSubsidyRemainingMicroUsd = Math.min(
    userLaunchRemainingMicroUsd,
    weeklyLaunchRemainingMicroUsd
  );

  if (rawLaunchDiscountMicroUsd <= launchSubsidyRemainingMicroUsd) {
    return {
      ...resolved,
      costMicroUsd: params.costMicroUsd,
      chargeMicroUsd: params.costMicroUsd - rawLaunchDiscountMicroUsd,
      discountMicroUsd: rawLaunchDiscountMicroUsd,
      launchSubsidyMicroUsd: rawLaunchDiscountMicroUsd,
      standardSubsidyMicroUsd: 0,
    };
  }

  const launchPricedCostMicroUsd = Math.floor(
    (launchSubsidyRemainingMicroUsd * 10_000) /
      MANAGED_VENICE_LAUNCH_DISCOUNT_BPS
  );
  const standardPricedCostMicroUsd = params.costMicroUsd - launchPricedCostMicroUsd;
  const standardSubsidyMicroUsd = discountForBps(
    standardPricedCostMicroUsd,
    MANAGED_VENICE_STANDARD_DISCOUNT_BPS
  );
  const discountMicroUsd =
    launchSubsidyRemainingMicroUsd + standardSubsidyMicroUsd;

  return {
    rate: "mixed_launch_standard" as const,
    discountBps: MANAGED_VENICE_STANDARD_DISCOUNT_BPS,
    reason:
      userLaunchRemainingMicroUsd <= weeklyLaunchRemainingMicroUsd
        ? "user_launch_cap_partially_reached"
        : "weekly_kill_switch_partially_reached",
    costMicroUsd: params.costMicroUsd,
    chargeMicroUsd: params.costMicroUsd - discountMicroUsd,
    discountMicroUsd,
    launchSubsidyMicroUsd: launchSubsidyRemainingMicroUsd,
    standardSubsidyMicroUsd,
  };
}
