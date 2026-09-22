/**
 * Yearly token-payment quotes — the one-time payment alternative to
 * Stripe yearly. User clicks "Pay yearly with $HermesOS" on
 * /dashboard/billing, a 20-min quote is minted at live USD-target ÷
 * live $HERMESOS price, and the deposit address is shown.
 *
 *   Pro yearly   = $49 in $HermesOS
 *   Power yearly = $99 in $HermesOS
 *
 * Distinct from `deposit-quotes.ts` (the tier-eligibility hold lock):
 *   - Different USD targets (cheaper because user gives up the tokens)
 *   - Sweeps to treasury after activation (the eligibility lock holds forever)
 *   - One-time payment grants 365 days, not perpetual hold
 *
 * Lifecycle: active → expired (20 min passed; still reconciled through the
 * late-payment grace) → consumed (a specific on-chain transfer was bound to it
 * by settle_yearly_token_payment) | manual_review (a payment was seen but needs
 * an operator) | cancelled (window + grace scanned, nothing paid). The
 * activated subscription row lives in `yearly_token_subscriptions`.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { HERMESOS_TOKEN_DECIMALS, HERMESOS_TOKEN_SYMBOL } from "./token-holdings";
import type { TierKey } from "./tier-thresholds";
import {
  computeTokensRequiredForUsdTarget,
  fetchHermesPriceUsd,
  type HermesPriceQuote,
} from "./price-feed";
import { assertNoActiveCryptoPaymentSession } from "./crypto-payment-sessions";

const YEARLY_QUOTE_LIFETIME_MS = 20 * 60 * 1000; // 20 minutes
/**
 * A payment mined after the quote window but within this grace is still
 * attributed to the quote (and goes to manual review).
 */
export const YEARLY_LATE_PAYMENT_GRACE_MS = 2 * 60 * 60_000;
// How long a quote under manual review stays visible to the user.
const REVIEW_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;
export type YearlyQuoteStatus = "active" | "consumed" | "expired" | "cancelled" | "manual_review";

/**
 * USD targets per BUILD_PLAN.md (yearly token-pay). Locked as integer
 * cents — float math out of the financial path.
 */
const YEARLY_USD_TARGET_CENTS: Record<TierKey, number> = {
  pro: 4900, // $49/yr
  power: 9900, // $99/yr
};

export interface YearlyQuoteRow {
  id: string;
  user_id: string;
  tier: TierKey;
  usd_target_cents: number;
  price_usd_at_quote: string;
  tokens_required_raw: string;
  tokens_required_display: string;
  deposit_address: string;
  quoted_at: string;
  expires_at: string;
  status: YearlyQuoteStatus;
  consumed_balance_raw: string | null;
  consumed_at: string | null;
  consumed_tx_hash: string | null;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface YearlyTokenQuote {
  id: string;
  userId: string;
  tier: TierKey;
  usdTargetCents: number;
  priceUsdAtQuote: string;
  tokensRequiredRaw: bigint;
  tokensRequiredDisplay: string;
  tokenSymbol: string;
  tokenDecimals: number;
  depositAddress: string;
  quotedAt: string;
  expiresAt: string;
  status: YearlyQuoteStatus;
  consumedBalanceRaw: bigint | null;
  consumedAt: string | null;
  consumedTxHash: string | null;
  source: string;
}

export function asYearlyTokenQuote(row: YearlyQuoteRow): YearlyTokenQuote {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    usdTargetCents: row.usd_target_cents,
    priceUsdAtQuote: row.price_usd_at_quote,
    tokensRequiredRaw: BigInt(row.tokens_required_raw),
    tokensRequiredDisplay: row.tokens_required_display,
    tokenSymbol: HERMESOS_TOKEN_SYMBOL,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    depositAddress: row.deposit_address,
    quotedAt: row.quoted_at,
    expiresAt: row.expires_at,
    status: row.status,
    consumedBalanceRaw: row.consumed_balance_raw ? BigInt(row.consumed_balance_raw) : null,
    consumedAt: row.consumed_at,
    consumedTxHash: row.consumed_tx_hash,
    source: row.source,
  };
}

export const YEARLY_QUOTE_SELECT_COLUMNS =
  "id, user_id, tier, usd_target_cents, price_usd_at_quote, " +
  "tokens_required_raw::text, tokens_required_display, deposit_address, " +
  "quoted_at, expires_at, status, consumed_balance_raw::text, consumed_at, " +
  "consumed_tx_hash, source, metadata, created_at, updated_at";

interface CreateYearlyQuoteParams {
  userId: string;
  tier: TierKey;
  /** Snapshot of the user's credit_deposit wallet address at quote time. */
  depositAddress: string;
  now?: Date;
  /** Test seam — bypass the network call. */
  priceQuote?: HermesPriceQuote;
}

/**
 * Mint a yearly token quote — but only if no active one exists for the
 * (user, tier) pair. The unique partial index in the migration enforces
 * this at the DB layer too. Locked-quote semantics: if one already
 * exists, return it verbatim (no re-quote at a new price for 20 min).
 */
export async function createYearlyTokenQuote(
  params: CreateYearlyQuoteParams
): Promise<YearlyTokenQuote> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  // Opportunistic auto-expire of stale rows so the unique partial
  // index doesn't conflict with a never-consumed past quote.
  await supabaseAdmin
    .from("yearly_token_quotes")
    .update({
      status: "expired" satisfies YearlyQuoteStatus,
      updated_at: now.toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("tier", params.tier)
    .eq("status", "active")
    .lt("expires_at", now.toISOString());

  const existingActive = await getActiveYearlyTokenQuote({
    userId: params.userId,
    tier: params.tier,
    now,
  });
  if (existingActive) return existingActive;

  await assertNoActiveCryptoPaymentSession({
    userId: params.userId,
    now,
  });

  const usdTargetCents = YEARLY_USD_TARGET_CENTS[params.tier];
  const priceQuote = params.priceQuote ?? (await fetchHermesPriceUsd());

  const tokensRequired = computeTokensRequiredForUsdTarget({
    usdTargetCents,
    priceUsdPerToken: priceQuote.priceUsd,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    rounding: "up",
  });

  const expiresAt = new Date(now.getTime() + YEARLY_QUOTE_LIFETIME_MS);

  const { data, error } = await supabaseAdmin
    .from("yearly_token_quotes")
    .insert({
      user_id: params.userId,
      tier: params.tier,
      usd_target_cents: usdTargetCents,
      price_usd_at_quote: priceQuote.priceUsd,
      tokens_required_raw: tokensRequired.raw.toString(),
      tokens_required_display: tokensRequired.display,
      deposit_address: params.depositAddress,
      quoted_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active" satisfies YearlyQuoteStatus,
      source: priceQuote.source,
      metadata: { priceLastUpdatedAt: priceQuote.lastUpdatedAt },
    })
    .select(YEARLY_QUOTE_SELECT_COLUMNS)
    .single<YearlyQuoteRow>();

  if (error || !data) {
    throw new Error(`Failed to create yearly token quote: ${error?.message ?? "unknown"}`);
  }
  return asYearlyTokenQuote(data);
}

interface GetActiveYearlyQuoteParams {
  userId: string;
  tier: TierKey;
  now?: Date;
}

export async function getActiveYearlyTokenQuote(
  params: GetActiveYearlyQuoteParams
): Promise<YearlyTokenQuote | null> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  // Self-clean stale rows.
  await supabaseAdmin
    .from("yearly_token_quotes")
    .update({
      status: "expired" satisfies YearlyQuoteStatus,
      updated_at: now.toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("tier", params.tier)
    .eq("status", "active")
    .lt("expires_at", now.toISOString());

  const { data, error } = await supabaseAdmin
    .from("yearly_token_quotes")
    .select(YEARLY_QUOTE_SELECT_COLUMNS)
    .eq("user_id", params.userId)
    .eq("tier", params.tier)
    .eq("status", "active")
    .order("quoted_at", { ascending: false })
    .limit(1)
    .maybeSingle<YearlyQuoteRow>();

  if (error) {
    throw new Error(`Failed to load yearly quotes: ${error.message}`);
  }
  return data ? asYearlyTokenQuote(data) : null;
}

/** Get all active yearly quotes for a user (both tiers). */
export async function getActiveYearlyTokenQuotes(
  userId: string,
  now: Date = new Date()
): Promise<YearlyTokenQuote[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  await supabaseAdmin
    .from("yearly_token_quotes")
    .update({
      status: "expired" satisfies YearlyQuoteStatus,
      updated_at: now.toISOString(),
    })
    .eq("user_id", userId)
    .eq("status", "active")
    .lt("expires_at", now.toISOString());

  const { data, error } = await supabaseAdmin
    .from("yearly_token_quotes")
    .select(YEARLY_QUOTE_SELECT_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("quoted_at", { ascending: false });

  if (error) throw new Error(`Failed to load yearly quotes: ${error.message}`);
  return ((data as unknown) as YearlyQuoteRow[] | null)?.map(asYearlyTokenQuote) ?? [];
}

/**
 * The user's quotes that still matter to them although they can no longer be
 * paid, newest first, one per tier: 'expired' quotes inside the late-payment
 * grace (a payment on its way is still picked up) and recent quotes under
 * manual review (a payment arrived and an operator will resolve it).
 */
export async function getPendingYearlyTokenQuotes(
  userId: string,
  now: Date = new Date()
): Promise<YearlyTokenQuote[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("yearly_token_quotes")
    .select(YEARLY_QUOTE_SELECT_COLUMNS)
    .eq("user_id", userId)
    .in("status", ["expired", "manual_review"])
    .gt("quoted_at", new Date(now.getTime() - REVIEW_VISIBLE_MS).toISOString())
    .order("quoted_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`Failed to load pending yearly quotes: ${error.message}`);
  const pending: YearlyTokenQuote[] = [];
  for (const quote of ((data as unknown) as YearlyQuoteRow[] | null)?.map(asYearlyTokenQuote) ?? []) {
    if (pending.some((existing) => existing.tier === quote.tier)) continue;
    const stillWatched =
      quote.status === "manual_review" ||
      Date.parse(quote.expiresAt) + YEARLY_LATE_PAYMENT_GRACE_MS > now.getTime();
    if (stillWatched) pending.push(quote);
  }
  return pending;
}
