/**
 * How much of the platform token (and VVV) a user must hold for each plan,
 * read from /api/billing/wallet/eligibility. The server resolves current
 * amounts from the live token price and existing locked qualification rows,
 * so the billing page shows these numbers instead of hardcoding any.
 * Client-safe: no server imports.
 */
import { isPlatformTokenKey } from "./token-registry";
import { displayTokenUnit, tokenUnitForKey } from "./token-plan-prices";

export interface HoldTier {
  /** Whole-token amount to hold, as the server formatted it (e.g. "134,476,535"). */
  amountDisplay: string | null;
  tokenUnit: string;
  /** Rough USD value at the price the server last read, or null when unknown. */
  usdApprox: number | null;
  eligible: boolean;
}

export interface HoldAmounts {
  pro: HoldTier;
  power: HoldTier;
  /** The token the verified balance is in, e.g. "$HermesOS" or "$HIVRA". */
  tokenUnit: string;
  /** The user's verified balance in that token, or null when no wallet is verified. */
  balanceDisplay: string | null;
  priceFetchedAt: string | null;
  vvvBoost: {
    requiredDisplay: string;
    usdThreshold: number;
    cpuBonus: number;
    ramBonusGb: number;
    eligible: boolean;
    countsStaked: boolean;
  } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function wholeUsd(amountDisplay: string, priceUsd: string | null): number | null {
  if (!priceUsd) return null;
  const amount = Number(amountDisplay.replace(/,/g, ""));
  const price = Number(priceUsd);
  if (!Number.isFinite(amount) || !Number.isFinite(price) || amount <= 0 || price <= 0) return null;
  return Math.round(amount * price);
}

/** Parses the eligibility payload's `data`; null when thresholds aren't configured. */
export function readHoldAmounts(data: unknown): HoldAmounts | null {
  const root = record(data);
  const thresholds = record(root?.thresholds);
  if (!root || !thresholds || thresholds.configured !== true) return null;
  const priceUsd = text(thresholds.priceUsd);
  const tiers = record(root.tiers);
  const balanceUnit = displayTokenUnit(text(root.tokenSymbol), text(root.tokenAddress));
  const paymentToken = record(root.tokenAccess)?.paymentToken;
  const quoteUnit = isPlatformTokenKey(paymentToken) ? tokenUnitForKey(paymentToken) : balanceUnit;

  function tier(key: "pro" | "power"): HoldTier {
    const row = record(tiers?.[key]);
    const eligible = row?.currentlyEligible === true;
    // Current API payloads mark whether the historical row is still the active
    // recovery lock. The qualifying-quantity fallback keeps older test/fixture
    // payloads compatible; a present null lock means requalification is live-priced.
    const lockedAmountDisplay = text(row?.lockedQualificationDisplay)
      ?? (row && Object.prototype.hasOwnProperty.call(row, "lockedQualificationDisplay") ? null : text(row?.qualifyingQuantityDisplay));
    const usesLockedQualification = lockedAmountDisplay !== null;
    const heldUnit = isPlatformTokenKey(row?.tokenKey) ? tokenUnitForKey(row.tokenKey) : balanceUnit;
    const tokenUnit = usesLockedQualification ? heldUnit : quoteUnit;
    // Live thresholds and their USD price belong to the balance readout asset.
    const liveAmount = tokenUnit === balanceUnit
      ? text(row?.currentThresholdDisplay) ?? text(thresholds?.[`${key}Display`])
      : null;
    const amountDisplay = lockedAmountDisplay ?? liveAmount;
    return {
      amountDisplay,
      tokenUnit,
      usdApprox: amountDisplay && tokenUnit === balanceUnit ? wholeUsd(amountDisplay, priceUsd) : null,
      eligible,
    };
  }

  const balance = record(root.balance);
  const boost = record(root.veniceBoost);
  const requiredDisplay = text(boost?.requiredVvvDisplay);
  const usdThreshold = typeof boost?.thresholdUsd === "number" ? boost.thresholdUsd : null;
  const cpuBonus = typeof boost?.cpuBonus === "number" ? boost.cpuBonus : null;
  const ramBonusMb = typeof boost?.ramBonusMb === "number" ? boost.ramBonusMb : null;

  return {
    pro: tier("pro"),
    power: tier("power"),
    tokenUnit: balanceUnit,
    balanceDisplay: text(balance?.balanceDisplay),
    priceFetchedAt: text(thresholds.priceFetchedAt),
    vvvBoost:
      requiredDisplay && usdThreshold !== null && cpuBonus !== null && ramBonusMb !== null
        ? {
            requiredDisplay,
            usdThreshold,
            cpuBonus,
            ramBonusGb: ramBonusMb / 1024,
            eligible: boost?.currentlyEligible === true,
            countsStaked: boost?.countsStakedVvv === true,
          }
        : null,
  };
}
