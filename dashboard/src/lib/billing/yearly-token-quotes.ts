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
import {
  platformTokenForRow,
  requirePlatformToken,
  type PlatformTokenKey,
} from "./token-registry";
import { TokenNotAllowedError, resolveUserTokenAccess, type UserTokenAccess } from "./token-access";
import type { TierKey } from "./tier-thresholds";
import {
  computeTokensRequiredForUsdTarget,
  fetchPlatformTokenPriceUsd,
  type HermesPriceQuote,
} from "./price-feed";
import { assertNoActiveCryptoPaymentSession } from "./crypto-payment-sessions";
import { YEARLY_TOKEN_USD } from "./token-plan-prices";

const YEARLY_QUOTE_LIFETIME_MS = 20 * 60 * 1000; // 20 minutes
// At most one active quote per (user, tier); see the yearly_token_subscriptions migration.
const ACTIVE_QUOTE_UNIQUE_INDEX = "yearly_token_quotes_user_tier_active_idx";
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
 * cents — float math out of the financial path. The whole-dollar prices
 * live in token-plan-prices.ts so the billing UI shows the same numbers.
 */
const YEARLY_USD_TARGET_CENTS: Record<TierKey, number> = {
  pro: YEARLY_TOKEN_USD.pro * 100, // $49/yr
  power: YEARLY_TOKEN_USD.power * 100, // $99/yr
};

export interface YearlyQuoteRow {
  id: string;
  user_id: string;
  tier: TierKey;
  token_key?: PlatformTokenKey | null;
  token_address?: string | null;
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
  consumed_log_index?: number | null;
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
  /** The platform token this quote must be paid in. Settlement credits only this token. */
  tokenKey: PlatformTokenKey;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  depositAddress: string;
  quotedAt: string;
  expiresAt: string;
  status: YearlyQuoteStatus;
  consumedBalanceRaw: bigint | null;
  consumedAt: string | null;
  consumedTxHash: string | null;
  /** Log index of the consumed Transfer (null for pre-attribution quotes). */
  consumedLogIndex: number | null;
  source: string;
}

export function asYearlyTokenQuote(row: YearlyQuoteRow): YearlyTokenQuote {
  const token = platformTokenForRow(row);
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    usdTargetCents: row.usd_target_cents,
    priceUsdAtQuote: row.price_usd_at_quote,
    tokensRequiredRaw: BigInt(row.tokens_required_raw),
    tokensRequiredDisplay: row.tokens_required_display,
    tokenKey: token.key,
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    depositAddress: row.deposit_address,
    quotedAt: row.quoted_at,
    expiresAt: row.expires_at,
    status: row.status,
    consumedBalanceRaw: row.consumed_balance_raw ? BigInt(row.consumed_balance_raw) : null,
    consumedAt: row.consumed_at,
    consumedTxHash: row.consumed_tx_hash,
    consumedLogIndex: typeof row.consumed_log_index === "number" ? row.consumed_log_index : null,
    source: row.source,
  };
}

export const YEARLY_QUOTE_SELECT_COLUMNS =
  "id, user_id, tier, token_key, token_address, usd_target_cents, price_usd_at_quote, " +
  "tokens_required_raw::text, tokens_required_display, deposit_address, " +
  "quoted_at, expires_at, status, consumed_balance_raw::text, consumed_at, " +
  "consumed_tx_hash, consumed_log_index, source, metadata, created_at, updated_at";

/** An active quote for this tier is locked in a different token. */
export class ActiveYearlyQuoteTokenMismatchError extends Error {
  constructor(readonly quote: YearlyTokenQuote) {
    super(
      `Your open ${quote.tier} quote is in ${quote.tokenSymbol}. Pay it or wait for it to expire before paying in another token.`
    );
    this.name = "ActiveYearlyQuoteTokenMismatchError";
  }
}

interface CreateYearlyQuoteParams {
  userId: string;
  tier: TierKey;
  /** Snapshot of the user's credit_deposit wallet address at quote time. */
  depositAddress: string;
  /**
   * Token to pay in. Defaults to the user's payment token ($HermesOS before
   * $HIVRA is active and for the grandfather cohort, else $HIVRA). A token
   * the user may not pay in is refused.
   */
  token?: PlatformTokenKey;
  access?: UserTokenAccess;
  now?: Date;
  /** Test seam — bypass the network call. */
  priceQuote?: HermesPriceQuote;
}

/**
 * Mint a yearly token quote — but only if no active one exists for the
 * (user, tier) pair. The unique partial index in the migration enforces
 * this at the DB layer too. Locked-quote semantics: if one already
 * exists, return it verbatim (no re-quote at a new price for 20 min),
 * including when a concurrent mint inserted it after our check.
 */
export async function createYearlyTokenQuote(
  params: CreateYearlyQuoteParams
): Promise<YearlyTokenQuote> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  // Server-side token rule: new users pay in $HIVRA once it is active.
  const access = params.access ?? (await resolveUserTokenAccess(params.userId, { now }));
  const tokenKey = params.token ?? access.paymentToken;
  if (!access.allowedTokens.includes(tokenKey)) {
    throw new TokenNotAllowedError(tokenKey, access.allowedTokens);
  }
  const token = requirePlatformToken(tokenKey);

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
  if (existingActive) {
    // A locked quote in another token must not be handed back as if it were
    // the one asked for: paying it in the requested token would be a
    // wrong-token transfer that is never credited.
    if (params.token && existingActive.tokenKey !== params.token) {
      throw new ActiveYearlyQuoteTokenMismatchError(existingActive);
    }
    return existingActive;
  }

  await assertNoActiveCryptoPaymentSession({
    userId: params.userId,
    now,
  });

  const usdTargetCents = YEARLY_USD_TARGET_CENTS[params.tier];
  // The same USD target in either token: the yearly token discount carries over.
  const priceQuote = params.priceQuote ?? (await fetchPlatformTokenPriceUsd(token));

  const tokensRequired = computeTokensRequiredForUsdTarget({
    usdTargetCents,
    priceUsdPerToken: priceQuote.priceUsd,
    tokenDecimals: token.decimals,
    rounding: "up",
  });

  const expiresAt = new Date(now.getTime() + YEARLY_QUOTE_LIFETIME_MS);

  const { data, error } = await supabaseAdmin
    .from("yearly_token_quotes")
    .insert({
      user_id: params.userId,
      tier: params.tier,
      token_key: token.key,
      token_address: token.address,
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

  if (error?.code === "23505" && error.message.includes(ACTIVE_QUOTE_UNIQUE_INDEX)) {
    // A concurrent mint for this (user, tier) inserted first (double-click,
    // retry). Return its quote, exactly as the pre-check above would have.
    const winner = await getActiveYearlyTokenQuote({
      userId: params.userId,
      tier: params.tier,
      now,
    });
    if (winner) {
      if (params.token && winner.tokenKey !== params.token) throw new ActiveYearlyQuoteTokenMismatchError(winner);
      return winner;
    }
  }
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
 * paid, one per tier. Only each tier's newest RELEVANT quote counts — one that
 * was paid, is under review, or can still receive a payment; a newer quote
 * that was abandoned (cancelled, or past its late-payment grace) supersedes
 * nothing:
 *   - past its expiry but inside the late-payment grace: a payment already on
 *     its way is still picked up. An 'active' row past expiry counts too, so
 *     the answer does not depend on whether a concurrent read has flipped it
 *     to 'expired' yet (the status is reported as 'expired');
 *   - in manual_review while the review still has an open reconciliation
 *     item: a payment arrived and an operator will resolve it.
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
    .gt("quoted_at", new Date(now.getTime() - REVIEW_VISIBLE_MS).toISOString())
    .order("quoted_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`Failed to load pending yearly quotes: ${error.message}`);

  const stillRelevant = (quote: YearlyTokenQuote) => {
    if (quote.status === "cancelled") return false;
    const expiresAtMs = Date.parse(quote.expiresAt);
    const pastExpiry = expiresAtMs <= now.getTime();
    if (quote.status === "expired" || (quote.status === "active" && pastExpiry)) {
      return expiresAtMs + YEARLY_LATE_PAYMENT_GRACE_MS > now.getTime();
    }
    return true; // payable, paid, or under review
  };
  const newestPerTier: YearlyTokenQuote[] = [];
  for (const quote of ((data as unknown) as YearlyQuoteRow[] | null)?.map(asYearlyTokenQuote) ?? []) {
    if (!stillRelevant(quote)) continue;
    if (!newestPerTier.some((existing) => existing.tier === quote.tier)) newestPerTier.push(quote);
  }

  const pending: YearlyTokenQuote[] = [];
  const underReview: YearlyTokenQuote[] = [];
  for (const quote of newestPerTier) {
    const expiresAtMs = Date.parse(quote.expiresAt);
    const pastExpiry = expiresAtMs <= now.getTime();
    if ((quote.status === "expired" || (quote.status === "active" && pastExpiry)) &&
        expiresAtMs + YEARLY_LATE_PAYMENT_GRACE_MS > now.getTime()) {
      pending.push({ ...quote, status: "expired" });
    } else if (quote.status === "manual_review") {
      underReview.push(quote);
    }
  }

  if (underReview.length > 0) {
    const { data: items, error: itemsError } = await supabaseAdmin
      .from("yearly_token_reconciliation_items")
      .select("quote_id")
      .in("quote_id", underReview.map((quote) => quote.id))
      .eq("status", "open");
    if (itemsError) throw new Error(`Failed to load yearly review items: ${itemsError.message}`);
    const open = new Set(((items as Array<{ quote_id?: string }> | null) ?? []).map((item) => item.quote_id));
    pending.push(...underReview.filter((quote) => open.has(quote.id)));
  }
  return pending;
}
