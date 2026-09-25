import type { AgentWalletBalance, AgentWalletCardData } from "@/app/dashboard/wallet/agent-wallet-data";

/**
 * Pure formatters, validators and payload readers for the wallet dashboard.
 *
 * Extracted verbatim from wallet/page.tsx so the page focuses on rendering and
 * these can be unit-tested without a DOM. No React, no side effects.
 */
export function interpolateCopy(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}
export interface EligibilityTierState {
  currentlyEligible: boolean;
  qualifyingQuantity: string | null;
  qualifyingQuantityDisplay: string | null;
  thresholdAtQualification: string | null;
  qualifiedAt: string | null;
  lastBreachAt: string | null;
  currentThreshold: string | null;
  currentThresholdDisplay: string | null;
}
export interface EligibilityPayload {
  tokenSymbol: string;
  tokenDecimals: number;
  balance: {
    balanceRaw: string;
    balanceDisplay: string;
    capturedAt: string;
    walletAddress?: string | null;
    normalizedWalletAddress?: string | null;
  } | null;
  thresholds: {
    configured: boolean;
    proRaw: string | null;
    proDisplay: string | null;
    powerRaw: string | null;
    powerDisplay: string | null;
    /** $HERMESOS USD price used to derive the threshold. */
    priceUsd?: string;
    /** ISO timestamp of when `priceUsd` was sampled. */
    priceFetchedAt?: string;
    /** Active threshold epoch — "launch" while the launch promo runs, then "standard". */
    epoch?: "launch" | "standard";
  };
  tiers: { pro: EligibilityTierState; power: EligibilityTierState };
  /**
   * Venice compute boost: hold ≥ thresholdUsd of VVV to add cpuBonus vCPU /
   * ramBonusMb RAM per instance on top of a PAID tier. Optional so older API
   * responses (pre-boost) still parse.
   */
  veniceBoost?: {
    thresholdUsd: number;
    cpuBonus: number;
    ramBonusMb: number;
    currentlyEligible: boolean;
    lastUsdValue: string | null;
    lastEvaluatedAt: string | null;
    lastBreachAt: string | null;
    vvvBalanceRaw: string | null;
    vvvBalanceDisplay: string | null;
    requiredVvvDisplay?: string | null;
    vvvPriceUsd?: string | null;
    /** True when staked VVV is folded into the counted balance (vvvBalance* already includes it). */
    countsStakedVvv?: boolean;
  };
}
export function shorten(address: string | null | undefined): string {
  if (!address) return '—';
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
export function isEvmAddressInput(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}
export function isNonZeroAmountDisplay(value: string | null | undefined): boolean {
  const normalized = (value ?? '').replace(/,/g, '').trim();
  return Boolean(normalized && normalized !== '—' && !/^0+(\.0+)?$/.test(normalized));
}
export function tokenBalanceKey(balance: AgentWalletBalance): string {
  return balance.tokenAddress ?? `native:${balance.tokenSymbol}`;
}
export function tokenDecimalsFor(balance: AgentWalletBalance): number {
  if (typeof balance.tokenDecimals === 'number') return balance.tokenDecimals;
  return balance.tokenSymbol === 'USDC' ? 6 : 18;
}
export function defaultWithdrawAmountForBalance(balance: AgentWalletBalance): string {
  return balance.balanceDisplay;
}
export function agentWalletWithdrawableBalances(card: AgentWalletCardData): AgentWalletBalance[] {
  return card.balances.filter((balance) => (
    balance.chain === 'Base' &&
    isNonZeroAmountDisplay(balance.balanceDisplay) &&
    (balance.tokenAddress === null || isEvmAddressInput(balance.tokenAddress ?? ''))
  ));
}
/**
 * The local unlock time of a withdrawal destination still in its cooldown
 * (`availableAt` from the server), or null once it can receive withdrawals.
 */
export function heldUntilLabel(availableAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!availableAt) return null;
  const time = Date.parse(availableAt);
  if (!Number.isFinite(time) || time <= now) return null;
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * The agent wallet's saved withdrawal destination: the only address its
 * withdrawals can go to (the server refuses any other).
 */
export function primaryAgentWalletRecipient(card: AgentWalletCardData): string | null {
  return card.wallet?.withdrawalDestinationEvm ?? null;
}
export function agentBaseEthBalance(card: AgentWalletCardData): AgentWalletBalance | null {
  return card.balances.find((balance) => balance.tokenSymbol === 'ETH') ?? (
    card.balance?.tokenSymbol === 'ETH' ? card.balance : null
  );
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function apiPayloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === 'string' ? payload.error : fallback;
}
export function apiSuccessData(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload?.success !== true || !isRecord(payload.data)) return null;
  return payload.data;
}
export function readWalletAccounts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}
export function readChallengeData(value: Record<string, unknown> | null) {
  if (!value || typeof value.challengeId !== 'string' || typeof value.message !== 'string') {
    return null;
  }

  return {
    challengeId: value.challengeId,
    message: value.message,
  };
}
export interface DepositQuotePayload {
  id: string;
  tier: 'pro' | 'power';
  thresholdTierCode: 'PRO_LAUNCH' | 'PRO_STANDARD' | 'POWER_LAUNCH' | 'POWER_STANDARD';
  epoch: 'launch' | 'standard';
  usdTargetCents: number;
  priceUsdAtQuote: string;
  tokensRequiredRaw: string;
  tokensRequiredDisplay: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Contract of the token to hold for this quote. */
  tokenAddress?: string;
  tokenKey?: string;
  quotedAt: string;
  expiresAt: string;
  status: 'active' | 'consumed' | 'expired' | 'cancelled';
  source: string;
}
export interface QuotesResponse {
  pro: DepositQuotePayload | null;
  power: DepositQuotePayload | null;
}
export function isDepositQuotePayload(value: unknown): value is DepositQuotePayload {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    (value.tier === 'pro' || value.tier === 'power') &&
    typeof value.thresholdTierCode === 'string' &&
    (value.epoch === 'launch' || value.epoch === 'standard') &&
    typeof value.usdTargetCents === 'number' &&
    typeof value.priceUsdAtQuote === 'string' &&
    typeof value.tokensRequiredRaw === 'string' &&
    typeof value.tokensRequiredDisplay === 'string' &&
    typeof value.tokenSymbol === 'string' &&
    typeof value.tokenDecimals === 'number' &&
    typeof value.quotedAt === 'string' &&
    typeof value.expiresAt === 'string' &&
    value.status === 'active' &&
    typeof value.source === 'string'
  );
}
export function formatUsdFromCents(cents: number): string {
  // Always show 2 decimal places for consistent USD presentation: whole-dollar
  // values previously dropped the cents ("$1", "$149") and rendered alongside
  // "$1.50"-style values, which read inconsistently.
  return `$${(cents / 100).toFixed(2)}`;
}
/**
 * Format an integer-valued numeric STRING (no fraction) with US-locale
 * commas: "38022814" → "38,022,814". The quote API returns whole
 * tokens as a digit string, so a regex split is enough — no
 * BigInt → Number lossy round-trip.
 */
export function formatTokensWithCommas(digitString: string): string {
  return digitString.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
/**
 * If the user has an active (non-expired) deposit-quote lock, return its
 * comma-formatted token amount so the eligibility row can display the
 * locked number instead of the live threshold. Returns null when no lock
 * exists or the lock has expired — the live threshold then takes over.
 */
export function lockedThresholdFor(quote: DepositQuotePayload | null): string | null {
  if (!quote) return null;
  if (Date.parse(quote.expiresAt) <= Date.now()) return null;
  return formatTokensWithCommas(quote.tokensRequiredDisplay);
}
export function walletAddressFromEligibility(eligibility: EligibilityPayload | null): string | null {
  return eligibility?.balance?.normalizedWalletAddress ?? eligibility?.balance?.walletAddress ?? null;
}
export function highestEligibleTier(eligibility: EligibilityPayload | null): 'pro' | 'power' | null {
  if (eligibility?.tiers.power.currentlyEligible) return 'power';
  if (eligibility?.tiers.pro.currentlyEligible) return 'pro';
  return null;
}
export function tierName(tier: 'pro' | 'power' | null): string | null {
  if (tier === 'power') return 'Power';
  if (tier === 'pro') return 'Pro';
  return null;
}
export function nextSelfCustodyLockTier(eligibility: EligibilityPayload | null): 'pro' | 'power' | null {
  if (eligibility && !eligibility.thresholds.configured) return null;
  if (!eligibility?.tiers.pro.currentlyEligible) return 'pro';
  if (!eligibility.tiers.power.currentlyEligible) return 'power';
  return null;
}
export function lockedQuantityForTier(
  eligibility: EligibilityPayload | null,
  tier: 'pro' | 'power' | null
): string | null {
  if (!tier || !eligibility) return null;
  return eligibility.tiers[tier].qualifyingQuantityDisplay;
}
export function activeQuoteForTier(
  quotes: QuotesResponse,
  tier: 'pro' | 'power' | null
): DepositQuotePayload | null {
  if (!tier) return null;
  const quote = quotes[tier];
  if (!quote) return null;
  if (Date.parse(quote.expiresAt) <= Date.now()) return null;
  return quote;
}
export const LAUNCH_PROMO_END = new Date('2026-05-30T23:59:59Z');
export function formatDaysRemaining(target: Date, fromMs: number): string {
  const diffMs = target.getTime() - fromMs;
  if (diffMs <= 0) return 'expired';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  if (days >= 1) return `${days}d ${hours}h`;
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m`;
}
/**
 * USD targets for the standard rate, used to compute "save $X vs
 * standard" badges when the active epoch is launch.
 */
export const STANDARD_USD_CENTS: Record<'pro' | 'power', number> = {
  pro: 14900,
  power: 29900,
};
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '0:00';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
export function tierLabel(tier: 'pro' | 'power'): string {
  return tier === 'pro' ? 'Pro' : 'Power';
}
