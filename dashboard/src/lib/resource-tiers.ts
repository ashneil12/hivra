export const LEGACY_FREE_RESOURCE_TIER = "credit_base" as const;
export const FREE_PLAN_KEY = "free" as const;
const TOKEN_BASE_RESOURCE_TIER = "token_base" as const;

const FREE_RESOURCE_TIER_ALIASES = new Set<string>([
  FREE_PLAN_KEY,
  LEGACY_FREE_RESOURCE_TIER,
]);

const FREE_RESOURCE_TIER_VALUES = [
  FREE_PLAN_KEY,
  LEGACY_FREE_RESOURCE_TIER,
] as const;

export const SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES = [
  ...FREE_RESOURCE_TIER_VALUES,
  TOKEN_BASE_RESOURCE_TIER,
] as const;

function normalizeResourceTier(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

/**
 * `credit_base` is a legacy persisted alias for the Free compute tier. It is
 * not a credit-balance tier and should not be used to infer top-up access.
 */
export function isFreeResourceTier(value: string | null | undefined): boolean {
  const tier = normalizeResourceTier(value);
  return tier !== null && FREE_RESOURCE_TIER_ALIASES.has(tier);
}

export function isBaseResourceTierForUpgradePrompt(value: string | null | undefined): boolean {
  const tier = normalizeResourceTier(value);
  return !tier || isFreeResourceTier(tier) || tier === TOKEN_BASE_RESOURCE_TIER;
}

export function isSingleInstanceBaseResourceTier(value: string | null | undefined): boolean {
  const tier = normalizeResourceTier(value);
  return tier !== null && SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES.includes(
    tier as (typeof SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES)[number]
  );
}

export function freeResourceTierForStorage(): typeof LEGACY_FREE_RESOURCE_TIER {
  return LEGACY_FREE_RESOURCE_TIER;
}
