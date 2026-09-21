import { SUPPORT_EMAIL } from "@/lib/support-channels";

export type ManagedVeniceWalletType = "hermesos" | "card";

// Read an env-var integer with a default + min/max guards. Falls back to
// the default whenever the env var is missing, blank, non-numeric, or
// outside bounds. Read once at module load — to change a value at runtime
// you bump the Vercel env var and redeploy (no code edit required).
function envInt(
  name: string,
  defaultValue: number,
  opts: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (opts.min !== undefined && parsed < opts.min) return defaultValue;
  if (opts.max !== undefined && parsed > opts.max) return defaultValue;
  return parsed;
}

export const MANAGED_VENICE_DEFAULT_TOP_UP_USD = 50;
export const MANAGED_VENICE_MIN_TOP_UP_USD = 10;
export const MANAGED_VENICE_MAX_SLIDER_TOP_UP_USD = 500;
// Env-tunable so you can dial subsidy up/down via Vercel env without a deploy.
// Defaults preserve the historical values the system shipped with.
export const MANAGED_VENICE_LAUNCH_BONUS_BPS = envInt(
  "MANAGED_VENICE_LAUNCH_BONUS_BPS",
  2000,
  { min: 0, max: 10_000 },
);
export const MANAGED_VENICE_STANDARD_BONUS_BPS = envInt(
  "MANAGED_VENICE_STANDARD_BONUS_BPS",
  1000,
  { min: 0, max: 10_000 },
);
export const MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD = envInt(
  "MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD",
  250_000_000,
  { min: 0 },
);
export const MANAGED_VENICE_WEEKLY_LAUNCH_BONUS_LIMIT_MICRO_USD = envInt(
  "MANAGED_VENICE_WEEKLY_LAUNCH_BONUS_LIMIT_MICRO_USD",
  1_000_000_000,
  { min: 0 },
);
// Hidden per-user lifetime bonus cap. When a user's accumulated deposit
// bonuses (launch + standard combined) plus the bonus their NEW top-up
// would earn would push them over this number, the quote creation is
// rejected with a "contact support" message. Default $5,000 of lifetime
// bonus per user (equivalent to ~$25k deposited at 20% bonus). Not
// announced anywhere — operators tell individual users via email when
// they hit it.
export const MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD = envInt(
  "MANAGED_VENICE_HIDDEN_USER_BONUS_CAP_MICRO_USD",
  5_000_000_000,
  { min: 0 },
);
// Derived rates for UI display (read the bps source-of-truth above).
const MANAGED_VENICE_LAUNCH_BONUS_RATE =
  MANAGED_VENICE_LAUNCH_BONUS_BPS / 10_000;
const MANAGED_VENICE_LAUNCH_BONUS_CAP_USD =
  MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD / 1_000_000;

export function getManagedVeniceSupportEmail(): string {
  const raw = process.env.MANAGED_VENICE_SUPPORT_EMAIL?.trim();
  return raw || SUPPORT_EMAIL;
}

export interface ManagedVeniceTopUpQuote {
  paidUsd: number;
  launchBonusUsd: number;
  standardBonusUsd: number;
  bonusUsd: number;
  totalCreditsUsd: number;
}

export interface ManagedVeniceTopUpQuoteMicroUsd {
  paidMicroUsd: number;
  launchPaidMicroUsd: number;
  standardPaidMicroUsd: number;
  launchBonusMicroUsd: number;
  standardBonusMicroUsd: number;
  bonusMicroUsd: number;
  totalCreditsMicroUsd: number;
  reason: string;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

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

function microUsdByBps(amountMicroUsd: number, bps: number) {
  return Number((BigInt(amountMicroUsd) * BigInt(bps)) / 10_000n);
}

function paidMicroUsdForBonusCap(bonusMicroUsd: number, bps: number) {
  return Number((BigInt(bonusMicroUsd) * 10_000n) / BigInt(bps));
}

export function normalizeManagedVeniceTopUpAmount(amountUsd: number): number {
  if (!Number.isFinite(amountUsd)) {
    return MANAGED_VENICE_DEFAULT_TOP_UP_USD;
  }

  return Math.max(MANAGED_VENICE_MIN_TOP_UP_USD, roundUsd(amountUsd));
}

export function getManagedVeniceTopUpQuoteMicroUsd(params: {
  paidMicroUsd: number;
  walletType: ManagedVeniceWalletType;
  userLaunchBonusUsedMicroUsd?: number;
  weeklyLaunchBonusUsedMicroUsd?: number;
  killSwitchActive?: boolean;
}): ManagedVeniceTopUpQuoteMicroUsd {
  requirePositiveMicroUsd(params.paidMicroUsd, "managed Venice top-up amount");
  requireNonNegativeMicroUsd(
    params.userLaunchBonusUsedMicroUsd ?? 0,
    "user launch bonus used"
  );
  requireNonNegativeMicroUsd(
    params.weeklyLaunchBonusUsedMicroUsd ?? 0,
    "weekly launch bonus used"
  );

  if (params.walletType === "card") {
    return {
      paidMicroUsd: params.paidMicroUsd,
      launchPaidMicroUsd: 0,
      standardPaidMicroUsd: 0,
      launchBonusMicroUsd: 0,
      standardBonusMicroUsd: 0,
      bonusMicroUsd: 0,
      totalCreditsMicroUsd: params.paidMicroUsd,
      reason: "card_wallet_pass_through",
    };
  }

  const userLaunchRemainingMicroUsd = Math.max(
    0,
    MANAGED_VENICE_USER_LAUNCH_BONUS_CAP_MICRO_USD -
      (params.userLaunchBonusUsedMicroUsd ?? 0)
  );
  const weeklyLaunchRemainingMicroUsd = Math.max(
    0,
    MANAGED_VENICE_WEEKLY_LAUNCH_BONUS_LIMIT_MICRO_USD -
      (params.weeklyLaunchBonusUsedMicroUsd ?? 0)
  );
  const launchBonusRemainingMicroUsd = params.killSwitchActive
    ? 0
    : Math.min(userLaunchRemainingMicroUsd, weeklyLaunchRemainingMicroUsd);
  const launchPaidMicroUsd = Math.min(
    params.paidMicroUsd,
    paidMicroUsdForBonusCap(
      launchBonusRemainingMicroUsd,
      MANAGED_VENICE_LAUNCH_BONUS_BPS
    )
  );
  const standardPaidMicroUsd = params.paidMicroUsd - launchPaidMicroUsd;
  const launchBonusMicroUsd = microUsdByBps(
    launchPaidMicroUsd,
    MANAGED_VENICE_LAUNCH_BONUS_BPS
  );
  const standardBonusMicroUsd = microUsdByBps(
    standardPaidMicroUsd,
    MANAGED_VENICE_STANDARD_BONUS_BPS
  );
  const bonusMicroUsd = launchBonusMicroUsd + standardBonusMicroUsd;

  let reason = "launch_wave_available";
  if (params.killSwitchActive) {
    reason = "weekly_kill_switch_active";
  } else if (weeklyLaunchRemainingMicroUsd <= 0) {
    reason = "weekly_kill_switch_reached";
  } else if (userLaunchRemainingMicroUsd <= 0) {
    reason = "user_launch_cap_reached";
  } else if (standardPaidMicroUsd > 0) {
    reason =
      userLaunchRemainingMicroUsd <= weeklyLaunchRemainingMicroUsd
        ? "user_launch_cap_partially_reached"
        : "weekly_kill_switch_partially_reached";
  }

  return {
    paidMicroUsd: params.paidMicroUsd,
    launchPaidMicroUsd,
    standardPaidMicroUsd,
    launchBonusMicroUsd,
    standardBonusMicroUsd,
    bonusMicroUsd,
    totalCreditsMicroUsd: params.paidMicroUsd + bonusMicroUsd,
    reason,
  };
}

export function getManagedVeniceTopUpQuote(
  amountUsd: number,
  walletType: ManagedVeniceWalletType,
): ManagedVeniceTopUpQuote {
  const paidUsd = normalizeManagedVeniceTopUpAmount(amountUsd);
  const quote = getManagedVeniceTopUpQuoteMicroUsd({
    paidMicroUsd: Math.round(paidUsd * 1_000_000),
    walletType,
  });

  return {
    paidUsd,
    launchBonusUsd: roundUsd(quote.launchBonusMicroUsd / 1_000_000),
    standardBonusUsd: roundUsd(quote.standardBonusMicroUsd / 1_000_000),
    bonusUsd: roundUsd(quote.bonusMicroUsd / 1_000_000),
    totalCreditsUsd: roundUsd(quote.totalCreditsMicroUsd / 1_000_000),
  };
}

export function formatManagedVeniceUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function buildManagedVeniceDepositHref(
  walletType: ManagedVeniceWalletType,
  amountUsd: number,
): string {
  const params = new URLSearchParams({
    managedVenice: "deposit",
    wallet: walletType,
    amountUsd: String(normalizeManagedVeniceTopUpAmount(amountUsd)),
  });

  return `/dashboard/billing?${params.toString()}`;
}
