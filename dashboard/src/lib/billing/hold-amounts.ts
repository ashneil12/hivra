/**
 * How much $HermesOS (and VVV) a user must hold for each plan, read from
 * /api/billing/wallet/eligibility. The server resolves the amounts for the
 * user's pricing epoch and founders status, so the billing page shows these
 * numbers instead of hardcoding any. Client-safe: no server imports.
 */

export interface HoldTier {
  /** Whole-token amount to hold, as the server formatted it (e.g. "134,476,535"). */
  amountDisplay: string;
  /** Rough USD value at the price the server last read, or null when unknown. */
  usdApprox: number | null;
  eligible: boolean;
}

export interface HoldAmounts {
  pro: HoldTier;
  power: HoldTier;
  /** The user's verified $HermesOS balance, or null when no wallet is verified. */
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

function tier(tiers: Record<string, unknown> | null, thresholds: Record<string, unknown>, key: "pro" | "power", priceUsd: string | null): HoldTier | null {
  const row = record(tiers?.[key]);
  const amountDisplay = text(row?.currentThresholdDisplay) ?? text(thresholds[`${key}Display`]);
  if (!amountDisplay) return null;
  return {
    amountDisplay,
    usdApprox: wholeUsd(amountDisplay, priceUsd),
    eligible: row?.currentlyEligible === true,
  };
}

/** Parses the eligibility payload's `data`; null when thresholds aren't configured. */
export function readHoldAmounts(data: unknown): HoldAmounts | null {
  const root = record(data);
  const thresholds = record(root?.thresholds);
  if (!root || !thresholds || thresholds.configured !== true) return null;
  const priceUsd = text(thresholds.priceUsd);
  const tiers = record(root.tiers);
  const pro = tier(tiers, thresholds, "pro", priceUsd);
  const power = tier(tiers, thresholds, "power", priceUsd);
  if (!pro || !power) return null;

  const balance = record(root.balance);
  const boost = record(root.veniceBoost);
  const requiredDisplay = text(boost?.requiredVvvDisplay);
  const usdThreshold = typeof boost?.thresholdUsd === "number" ? boost.thresholdUsd : null;
  const cpuBonus = typeof boost?.cpuBonus === "number" ? boost.cpuBonus : null;
  const ramBonusMb = typeof boost?.ramBonusMb === "number" ? boost.ramBonusMb : null;

  return {
    pro,
    power,
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
