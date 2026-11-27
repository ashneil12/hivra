/**
 * Current public terms for hold-to-qualify access. Client-safe and shared by
 * pricing copy, wallet copy and server-side quote/threshold code so the surfaces
 * cannot drift. Token quantities are never in this file: they are computed from
 * the live market price at quote/evaluation time.
 */
export const HOLDER_TIER_TERMS = {
  pro: {
    tier: "pro",
    name: "Pro",
    usd: 299,
    usdCents: 29_900,
    cpu: 2,
    ramGb: 4,
  },
  power: {
    tier: "power",
    name: "Power",
    usd: 599,
    usdCents: 59_900,
    cpu: 4,
    ramGb: 8,
  },
} as const;

export type HolderTierKey = keyof typeof HOLDER_TIER_TERMS;

export function holderTierUsdCents(tier: HolderTierKey): number {
  return HOLDER_TIER_TERMS[tier].usdCents;
}

/** "Pro: 2 vCPU / 4 GB for $299" style facts without a sales claim. */
export function holderTierSummary(tier: HolderTierKey): string {
  const terms = HOLDER_TIER_TERMS[tier];
  return `${terms.name}: ${terms.cpu} vCPU / ${terms.ramGb} GB for $${terms.usd}`;
}
