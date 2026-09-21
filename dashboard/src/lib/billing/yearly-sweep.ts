/**
 * Yearly token-payment sweep + activation.
 *
 * Two responsibilities:
 *
 *   1. Detect deposits — for each active yearly_token_quote, read the
 *      yearly_subscription wallet's on-chain balance. If balance ≥
 *      tokens_required, mark the quote `consumed` and insert a
 *      `yearly_token_subscriptions` row with paid_at=now,
 *      expires_at=paid_at+365d, sweep_status='pending'. Subscription
 *      activation succeeds even if the sweep later fails — we'd rather
 *      a stuck sweep than a user who paid and didn't get their tier.
 *
 *   2. Sweep — for each yearly sub with sweep_status='pending', mint a
 *      Bankr API key scoped to HERMES_TREASURY_ADDRESS only, transfer
 *      the wallet's full balance there, mark sweep_status='swept' with
 *      the resulting tx hash. On failure flip to 'failed' with an
 *      error message; the cron retries automatically next tick.
 *
 * Wallet purpose: yearly_subscription. Distinct from credit_deposit
 * (USDC top-ups → platform credits) and hermesos_lock (held tokens for
 * tier eligibility). Keeping subscription revenue in its own wallet
 * means clean treasury accounting and no risk of cross-flow mix-ups.
 *
 * Sweep destination: HERMES_TREASURY_ADDRESS (env var), the operator's
 * Bankr trading wallet — same place creator fees land.
 *
 * Anti-misuse: the scoped API key is restricted to ONE recipient
 * (the treasury). Even if the key leaked, the only place tokens could
 * flow is the treasury address — there's no way to redirect funds to
 * an attacker.
 */

import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  fetchHermesTokenBalance,
  formatRawTokenBalance,
  normalizeNumericToBigIntString,
} from "./token-holdings";
import { getBankrDepositWalletCredentialForUser } from "./bankr-deposit-wallets";
import { getBankrPartnerConfig } from "./bankr-wallets";
import { mintScopedTransferApiKey, submitBankrTransfer } from "./bankr-withdraw";
import {
  consumeYearlyTokenQuote,
  type YearlyTokenQuote,
} from "./yearly-token-quotes";
import { ensureWalletHasGas } from "./treasury-gas";

const YEARLY_SUBSCRIPTION_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

type DetectionOutcome =
  | "no_balance"
  | "insufficient_balance"
  | "activated"
  | "already_active"
  | "error";

type SweepOutcome =
  | "swept"
  | "no_balance"
  | "no_treasury_configured"
  | "no_credentials"
  | "transfer_failed"
  | "gas_topup_failed";

export interface DetectionResult {
  quoteId: string;
  userId: string;
  tier: "pro" | "power";
  outcome: DetectionOutcome;
  subscriptionId?: string;
  amountReceivedRaw?: string;
  error?: string;
}

export interface SweepResult {
  subscriptionId: string;
  userId: string;
  outcome: SweepOutcome;
  txHash?: string | null;
  amountSweptDisplay?: string;
  error?: string;
}

/** Resolve the operator's treasury address from env. */
function getTreasuryAddress(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.HERMES_TREASURY_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

/**
 * Per-quote: read the on-chain balance, and if it meets the locked
 * tokens_required, consume the quote + activate the yearly sub.
 */
export async function detectAndActivateYearlyDeposit(
  quote: YearlyTokenQuote,
  options: { now?: Date; rpcUrl?: string } = {}
): Promise<DetectionResult> {
  if (!supabaseAdmin) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "error",
      error: "supabase admin not configured",
    };
  }
  const now = options.now ?? new Date();

  // Idempotency guard: if an active/grace yearly sub already exists for
  // this user/tier, skip — the prior cron run already handled this user.
  const { data: existingSub } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .select("id")
    .eq("user_id", quote.userId)
    .eq("tier", quote.tier)
    .in("status", ["active", "grace"])
    .maybeSingle();
  if (existingSub) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "already_active",
    };
  }

  const balance = await fetchHermesTokenBalance({
    walletAddress: quote.depositAddress,
    rpcUrl: options.rpcUrl,
  }).catch((err) => {
    return { error: err instanceof Error ? err.message : String(err) } as const;
  });
  if ("error" in balance) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "error",
      error: `balance read failed: ${balance.error}`,
    };
  }

  const balanceRaw = BigInt(normalizeNumericToBigIntString(balance.balanceRaw));
  if (balanceRaw === 0n) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "no_balance",
    };
  }
  if (balanceRaw < quote.tokensRequiredRaw) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "insufficient_balance",
    };
  }

  // ORDER MATTERS: insert the subscription row FIRST, then consume the
  // quote. The previous order (consume → insert) had a partial-failure
  // BLOCKER: if the insert failed, the quote was already 'consumed' and
  // the user got nothing — the Pass 1 cron query only loads
  // `status='active'` quotes, so they were never re-examined and the
  // user's deposit sat in their wallet forever. By inserting first:
  //   - on insert success + consume failure → next cron tick sees the
  //     active quote AND the existing active subscription, hits the
  //     `existingSub` idempotency guard above, and re-tries the consume.
  //   - the unique partial index on (user_id, tier) WHERE status IN
  //     ('active','grace') prevents duplicate activations on re-run.
  const expiresAt = new Date(now.getTime() + YEARLY_SUBSCRIPTION_DURATION_MS);
  const { data: insertedSub, error: insertError } = await supabaseAdmin
    .from("yearly_token_subscriptions")
    .insert({
      user_id: quote.userId,
      tier: quote.tier,
      yearly_quote_id: quote.id,
      paid_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      amount_received_raw: balanceRaw.toString(),
      sweep_status: "pending",
      status: "active",
      metadata: {
        priceUsdAtQuote: quote.priceUsdAtQuote,
        usdTargetCents: quote.usdTargetCents,
        depositAddress: quote.depositAddress,
      },
    })
    .select("id")
    .single<{ id: string }>();

  if (insertError || !insertedSub) {
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "error",
      error: `subscription insert failed: ${insertError?.message ?? "unknown"}`,
    };
  }

  // Conversion stamp (write-once): a yearly token payment flips the user's
  // entitlement without ever touching hermes_subscriptions.plan, so the
  // funnel's upgraded_at must be stamped here. `.is("upgraded_at", null)`
  // makes it write-once — an already-converted user (card or earlier token
  // payment) keeps their original timestamp. Best-effort: a failed stamp
  // never blocks the activation the user paid for.
  try {
    await supabaseAdmin
      .from("hermes_subscriptions")
      .update({
        upgraded_at: now.toISOString(),
        upgrade_source: "token_payment",
      })
      .eq("user_id", quote.userId)
      .is("upgraded_at", null);
  } catch {
    // Analytics stamp only — activation already succeeded.
  }

  // Best-effort: mark the quote consumed. If this throws, the
  // subscription row is already live for the user — next tick will see
  // the active sub via the idempotency guard, treat it as
  // 'already_active', and re-attempt the consume on the still-active
  // quote on a later tick. Either way the user keeps their tier.
  try {
    await consumeYearlyTokenQuote({
      quoteId: quote.id,
      consumedBalanceRaw: balanceRaw,
      now,
    });
  } catch (consumeErr) {
    // Don't fail the activation result — the user has their tier. Log
    // the inconsistency for the operator; the next tick will retry
    // because the subscription's `existingSub` guard fires before this
    // path runs again.
    return {
      quoteId: quote.id,
      userId: quote.userId,
      tier: quote.tier,
      outcome: "activated",
      subscriptionId: insertedSub.id,
      amountReceivedRaw: balanceRaw.toString(),
      // Surface the soft failure so callers can log without treating
      // the result as an error. Missing field on success path; an
      // optional addition below.
      error: `quote_consume_post_insert_failed: ${consumeErr instanceof Error ? consumeErr.message : String(consumeErr)}`,
    };
  }

  return {
    quoteId: quote.id,
    userId: quote.userId,
    tier: quote.tier,
    outcome: "activated",
    subscriptionId: insertedSub.id,
    amountReceivedRaw: balanceRaw.toString(),
  };
}

interface PendingSweepRow {
  id: string;
  user_id: string;
  amount_received_raw: string;
}

/**
 * Per-subscription: sweep the credit_deposit wallet's balance to the
 * treasury. Idempotent — re-running with sweep_status='swept' is a no-op.
 */
export async function sweepActivatedSubscription(
  sub: PendingSweepRow,
  options: { now?: Date; rpcUrl?: string; env?: Record<string, string | undefined> } = {}
): Promise<SweepResult> {
  if (!supabaseAdmin) {
    return { subscriptionId: sub.id, userId: sub.user_id, outcome: "transfer_failed", error: "supabase not configured" };
  }
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;

  const treasury = getTreasuryAddress(env);
  if (!treasury) {
    await markSweepFailed(sub.id, "HERMES_TREASURY_ADDRESS not configured", now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "no_treasury_configured",
      error: "HERMES_TREASURY_ADDRESS missing or invalid",
    };
  }

  const credential = await getBankrDepositWalletCredentialForUser({
    userId: sub.user_id,
    purpose: "yearly_subscription",
  });
  if (!credential?.bankrWalletId) {
    await markSweepFailed(sub.id, "yearly_subscription credential missing", now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "no_credentials",
      error: "no Bankr yearly_subscription credential",
    };
  }

  const walletAddress = credential.evmAddress;
  const liveBalance = await fetchHermesTokenBalance({
    walletAddress,
    rpcUrl: options.rpcUrl,
  }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) } as const));
  if ("error" in liveBalance) {
    await markSweepFailed(sub.id, `balance read failed: ${liveBalance.error}`, now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "transfer_failed",
      error: liveBalance.error,
    };
  }

  if (BigInt(normalizeNumericToBigIntString(liveBalance.balanceRaw)) === 0n) {
    // Nothing to sweep — mark as swept with no tx (already drained).
    await supabaseAdmin
      .from("yearly_token_subscriptions")
      .update({
        sweep_status: "skipped",
        sweep_attempted_at: now.toISOString(),
        sweep_error: "wallet drained before sweep",
        updated_at: now.toISOString(),
      })
      .eq("id", sub.id);
    return { subscriptionId: sub.id, userId: sub.user_id, outcome: "no_balance" };
  }

  // Top up gas if the wallet has none. Same primitive as the user-side
  // withdraw flow — works on any Bankr wallet.
  try {
    await ensureWalletHasGas({ walletAddress, env });
  } catch (gasErr) {
    const message = gasErr instanceof Error ? gasErr.message : String(gasErr);
    await markSweepFailed(sub.id, `gas top-up failed: ${message}`, now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "gas_topup_failed",
      error: message,
    };
  }

  const apiKey = await mintScopedTransferApiKey({
    bankrWalletId: credential.bankrWalletId,
    recipientAddress: treasury,
    env,
  });
  if (!apiKey) {
    // mintScopedTransferApiKey returns null in two distinct cases.
    // Check which one so the recorded sweep_error is actually useful
    // when ops debugs this later — "Bankr partner key not configured"
    // sent us hunting for a missing env var that was actually set; the
    // real culprit was Bankr's per-wallet 20-key cap.
    const partnerConfigured = Boolean(getBankrPartnerConfig(env).partnerKey);
    const reason = partnerConfigured
      ? "Bankr API key mint returned null (likely per-wallet 20-key cap — revoke stale keys on Bankr)"
      : "Bankr partner key not configured (BANKR_PARTNER_KEY env var missing)";
    await markSweepFailed(sub.id, reason, now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "no_credentials",
      error: reason,
    };
  }

  const amountDisplay = formatRawTokenBalance(liveBalance.balanceRaw, HERMESOS_TOKEN_DECIMALS);
  let txHash: string | null = null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: treasury,
      amountDisplay,
      env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSweepFailed(sub.id, `transfer failed: ${message}`, now);
    return {
      subscriptionId: sub.id,
      userId: sub.user_id,
      outcome: "transfer_failed",
      error: message,
    };
  }

  await supabaseAdmin
    .from("yearly_token_subscriptions")
    .update({
      sweep_status: "swept",
      sweep_tx_hash: txHash,
      sweep_attempted_at: now.toISOString(),
      sweep_error: null,
      updated_at: now.toISOString(),
    })
    .eq("id", sub.id);

  return {
    subscriptionId: sub.id,
    userId: sub.user_id,
    outcome: "swept",
    txHash,
    amountSweptDisplay: amountDisplay,
  };
}

async function markSweepFailed(subId: string, error: string, now: Date) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("yearly_token_subscriptions")
    .update({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
      sweep_error: error,
      updated_at: now.toISOString(),
    })
    .eq("id", subId);
}
