/**
 * Deposit quote service.
 *
 * One active quote per user per tier. Mints a fresh row that locks:
 *   - usd_target_cents     (the tier's USD price, e.g. 10000 = $100)
 *   - price_usd_at_quote   (live $HERMESOS/USD at mint time)
 *   - tokens_required_raw  (computed base-units: usd / price)
 *   - expires_at           (now + 20 min)
 *
 * On a new quote for a tier that already has an active row, we
 * cancel the old one in the same statement (the unique partial index
 * on `status='active'` enforces the invariant).
 *
 * On consume (called by the eligibility evaluator when balance reaches
 * tokens_required): status flips to 'consumed', consumed_balance_raw
 * + consumed_at filled in. The qualification row's qualifying_quantity
 * is set to the quote's tokens_required — that's what makes the
 * "rate locked at deposit time" promise stick across price moves.
 */

import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
} from "./token-holdings";
import {
  isFoundersRateUser,
  resolveActiveThresholdForTier,
  USD_TARGET_CENTS,
  type ThresholdTierCode,
  type TierKey,
  type ThresholdEpoch,
} from "./tier-thresholds";
import {
  computeTokensRequiredForUsdTarget,
  fetchHermesPriceUsd,
  type HermesPriceQuote,
} from "./price-feed";
import { assertNoActiveCryptoPaymentSession } from "./crypto-payment-sessions";

const DEPOSIT_QUOTE_LIFETIME_MS = 20 * 60 * 1000; // 20 minutes
type DepositQuoteStatus = "active" | "consumed" | "expired" | "cancelled";
export type { ThresholdTierCode } from "./tier-thresholds";

interface DepositQuoteRow {
  id: string;
  user_id: string;
  tier: TierKey;
  threshold_tier_code: ThresholdTierCode;
  usd_target_cents: number;
  price_usd_at_quote: string;
  tokens_required_raw: string;
  tokens_required_display: string;
  quoted_at: string;
  expires_at: string;
  status: DepositQuoteStatus;
  consumed_balance_raw: string | null;
  consumed_at: string | null;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DepositQuote {
  id: string;
  userId: string;
  tier: TierKey;
  thresholdTierCode: ThresholdTierCode;
  epoch: ThresholdEpoch;
  usdTargetCents: number;
  priceUsdAtQuote: string;
  tokensRequiredRaw: bigint;
  tokensRequiredDisplay: string;
  tokenSymbol: string;
  tokenDecimals: number;
  quotedAt: string;
  expiresAt: string;
  status: DepositQuoteStatus;
  consumedBalanceRaw: bigint | null;
  consumedAt: string | null;
  source: string;
}

function asQuote(row: DepositQuoteRow): DepositQuote {
  return {
    id: row.id,
    userId: row.user_id,
    tier: row.tier,
    thresholdTierCode: row.threshold_tier_code,
    epoch: row.threshold_tier_code.endsWith("LAUNCH") ? "launch" : "standard",
    usdTargetCents: row.usd_target_cents,
    priceUsdAtQuote: row.price_usd_at_quote,
    tokensRequiredRaw: BigInt(row.tokens_required_raw),
    tokensRequiredDisplay: row.tokens_required_display,
    tokenSymbol: HERMESOS_TOKEN_SYMBOL,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    quotedAt: row.quoted_at,
    expiresAt: row.expires_at,
    status: row.status,
    consumedBalanceRaw: row.consumed_balance_raw ? BigInt(row.consumed_balance_raw) : null,
    consumedAt: row.consumed_at,
    source: row.source,
  };
}

interface CreateDepositQuoteParams {
  userId: string;
  tier: TierKey;
  now?: Date;
  // Test seam: caller can inject a price quote and bypass the network
  // call. Production calls leave undefined.
  priceQuote?: HermesPriceQuote;
}

/**
 * Mints a quote for the user/tier — but ONLY if no active quote
 * already exists. Quote is a price COMMITMENT: once minted, it locks
 * for the full 20 minutes, full stop. Re-mint and cancel are
 * intentionally forbidden so users can't shop for better rates by
 * spamming the button.
 *
 * If an active (non-expired) quote already exists for the same
 * (user, tier), this returns that existing quote unchanged. Auto-
 * expires stale rows along the way so the unique partial index
 * doesn't conflict.
 */
export async function createDepositQuote(
  params: CreateDepositQuoteParams
): Promise<DepositQuote> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  // Opportunistic sweep: any quotes for this user/tier whose
  // expires_at has passed get marked 'expired'. Without this,
  // a stale active row blocks a new legitimate mint.
  await supabaseAdmin
    .from("deposit_quotes")
    .update({
      status: "expired" satisfies DepositQuoteStatus,
      updated_at: now.toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("tier", params.tier)
    .eq("status", "active")
    .lt("expires_at", now.toISOString());

  // Locked-quote rule: if an active quote still exists, return it
  // verbatim — no replacement, no re-quote at the new price. The
  // user must wait for natural expiry (or send the locked tokens) to
  // mint a fresh one.
  const existingActive = await getActiveDepositQuotes({
    userId: params.userId,
    tier: params.tier,
    now,
  });
  if (existingActive.length > 0) {
    return existingActive[0];
  }

  await assertNoActiveCryptoPaymentSession({
    userId: params.userId,
    now,
  });

  // Resolve the active threshold tier (launch vs standard) — that's
  // what determines the USD target locked in this quote. Allowlisted
  // founders lock the launch USD target past the global promo window.
  const active = resolveActiveThresholdForTier(params.tier, now, {
    forceLaunchEpoch: isFoundersRateUser(params.userId),
  });
  const thresholdTierCode = active.code;
  const usdTargetCents = USD_TARGET_CENTS[thresholdTierCode];

  const priceQuote =
    params.priceQuote ?? (await fetchHermesPriceUsd());

  const tokensRequired = computeTokensRequiredForUsdTarget({
    usdTargetCents,
    priceUsdPerToken: priceQuote.priceUsd,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    rounding: "up",
  });

  const expiresAt = new Date(now.getTime() + DEPOSIT_QUOTE_LIFETIME_MS);

  const { data, error } = await supabaseAdmin
    .from("deposit_quotes")
    .insert({
      user_id: params.userId,
      tier: params.tier,
      threshold_tier_code: thresholdTierCode,
      usd_target_cents: usdTargetCents,
      price_usd_at_quote: priceQuote.priceUsd,
      tokens_required_raw: tokensRequired.raw.toString(),
      tokens_required_display: tokensRequired.display,
      quoted_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active" satisfies DepositQuoteStatus,
      source: priceQuote.source,
      metadata: {
        priceLastUpdatedAt: priceQuote.lastUpdatedAt,
      },
    })
    .select(
      "id, user_id, tier, threshold_tier_code, usd_target_cents, price_usd_at_quote, tokens_required_raw::text, tokens_required_display, quoted_at, expires_at, status, consumed_balance_raw::text, consumed_at, source, metadata, created_at, updated_at"
    )
    .single<DepositQuoteRow>();

  if (error || !data) {
    throw new Error(`Failed to create deposit quote: ${error?.message ?? "unknown"}`);
  }
  return asQuote(data);
}

interface GetActiveQuoteParams {
  userId: string;
  tier?: TierKey;
  now?: Date;
}

/**
 * Returns active (non-expired) quotes for a user. Filters by tier if
 * supplied. Quotes whose `expires_at` has passed are auto-expired
 * via a side-effect UPDATE before being filtered out — this keeps
 * the table self-cleaning without a separate cron.
 */
export async function getActiveDepositQuotes(
  params: GetActiveQuoteParams
): Promise<DepositQuote[]> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();

  // Self-expire stale rows. This is a best-effort opportunistic sweep
  // bounded to this user; a true bulk sweep can run from the cron
  // separately.
  await supabaseAdmin
    .from("deposit_quotes")
    .update({
      status: "expired" satisfies DepositQuoteStatus,
      updated_at: now.toISOString(),
    })
    .eq("user_id", params.userId)
    .eq("status", "active")
    .lt("expires_at", now.toISOString());

  let query = supabaseAdmin
    .from("deposit_quotes")
    .select(
      "id, user_id, tier, threshold_tier_code, usd_target_cents, price_usd_at_quote, tokens_required_raw::text, tokens_required_display, quoted_at, expires_at, status, consumed_balance_raw::text, consumed_at, source, metadata, created_at, updated_at"
    )
    .eq("user_id", params.userId)
    .eq("status", "active");

  if (params.tier) {
    query = query.eq("tier", params.tier);
  }

  const { data, error } = await query.order("quoted_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to load deposit quotes: ${error.message}`);
  }
  return (data as DepositQuoteRow[] | null)?.map(asQuote) ?? [];
}

interface ConsumeQuoteParams {
  quoteId: string;
  consumedBalanceRaw: bigint;
  now?: Date;
}

/**
 * Marks a quote as consumed at the cron's current balance read.
 * Caller is responsible for verifying balance >= tokens_required
 * before calling.
 */
export async function consumeDepositQuote(
  params: ConsumeQuoteParams
): Promise<void> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const now = params.now ?? new Date();
  const { error } = await supabaseAdmin
    .from("deposit_quotes")
    .update({
      status: "consumed" satisfies DepositQuoteStatus,
      consumed_balance_raw: params.consumedBalanceRaw.toString(),
      consumed_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", params.quoteId)
    .eq("status", "active"); // idempotency: only flip if still active

  if (error) {
    throw new Error(`Failed to consume deposit quote: ${error.message}`);
  }
}
