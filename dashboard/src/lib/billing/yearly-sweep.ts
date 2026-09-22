/**
 * Yearly $HermesOS treasury sweep.
 *
 * Settlement (yearly-token-settlement) grants the tier as soon as a transfer
 * is bound to a quote. This module is the custody follow-up: move THAT
 * transfer's amount (subscription.amount_received_raw) out of the wallet the
 * quote pointed the user at (subscription.deposit_address) to
 * HERMES_TREASURY_ADDRESS.
 *
 * The wallet is usually the user's shared credit_deposit wallet, which may
 * also hold managed-Venice deposits awaiting their own sweep, so a sweep never
 * moves "the balance" — only the subscription's own amount.
 *
 * Every transition is compare-and-set:
 *   pending|failed --claim--> sweeping --> swept
 *                                      --> failed          (definitely nothing
 *                                                           sent; retried after
 *                                                           a backoff)
 *                                      --> needs_operator  (terminal: outcome
 *                                                           unknown, or the
 *                                                           sweep cannot be
 *                                                           automated)
 * A cron tick and a user's check-now can race; only the claimant moves money.
 * sweep_submitted_at is stamped (under the claim) right before the Bankr
 * transfer is submitted, so a claim that goes stale is retried only when no
 * transfer was sent.
 *
 * The scoped Bankr API key can only pay HERMES_TREASURY_ADDRESS, so even a
 * leaked key cannot redirect funds.
 */

import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  fetchHermesTokenBalance,
  formatRawTokenBalance,
  normalizeNumericToBigIntString,
} from "./token-holdings";
import { getBankrDepositWalletCredentialForAddress } from "./bankr-deposit-wallets";
import { getBankrPartnerConfig } from "./bankr-wallets";
import { BankrTransferHttpError, mintScopedTransferApiKey, submitBankrTransfer } from "./bankr-withdraw";
import { ensureWalletHasGas, type EnsureWalletGasResult } from "./treasury-gas";

/** A failed sweep attempted within this window is left alone this tick. */
export const YEARLY_SWEEP_RETRY_BACKOFF_MS = 30 * 60 * 1000;
/**
 * A 'sweeping' claim older than this belongs to a sweeper that died (function
 * timeout, crash). Serverless functions here run for minutes at most.
 */
export const YEARLY_SWEEP_CLAIM_STALE_MS = 15 * 60 * 1000;
/** A subscription still unswept this long after activation is worth an alert. */
export const YEARLY_SWEEP_STUCK_ALERT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_SWEEP_BATCH_LIMIT = 50;
const MAX_SWEEP_BATCH_LIMIT = 200;

type SweepOutcome =
  | "swept"
  | "claimed_elsewhere"
  | "needs_operator"
  | "no_treasury_configured"
  | "no_credentials"
  | "transfer_failed"
  | "gas_topup_failed";

export interface SweepResult {
  subscriptionId: string;
  userId: string;
  outcome: SweepOutcome;
  txHash?: string | null;
  amountSweptDisplay?: string;
  error?: string;
}

type QueryError = { code?: string; message?: string } | null;

type DbQuery = {
  select: (...args: unknown[]) => DbQuery;
  eq: (...args: unknown[]) => DbQuery;
  in: (...args: unknown[]) => DbQuery;
  is: (...args: unknown[]) => DbQuery;
  lt: (...args: unknown[]) => DbQuery;
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbQuery;
  update: (patch: unknown) => DbQuery;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

type JsonFetch = typeof fetch;

export interface YearlySweepOptions {
  db?: SupabaseLike | null;
  now?: Date;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
  readHermesBalance?: (params: {
    walletAddress: string;
    rpcUrl?: string;
    env?: Record<string, string | undefined>;
  }) => Promise<{ balanceRaw: unknown }>;
  ensureGas?: (params: {
    walletAddress: string;
    rpcUrl?: string;
    env?: Record<string, string | undefined>;
  }) => Promise<EnsureWalletGasResult>;
  mintApiKey?: typeof mintScopedTransferApiKey;
  submitTransfer?: typeof submitBankrTransfer;
}

interface ClaimedRow {
  id: string;
  user_id: string;
  amount_received_raw: string | number;
  deposit_address: string | null;
  deposit_tx_hash: string | null;
  deposit_log_index: number | null;
  metadata: Record<string, unknown> | null;
}

const SWEEP_ROW_COLUMNS =
  "id, user_id, amount_received_raw::text, deposit_address, deposit_tx_hash, deposit_log_index, metadata, " +
  "sweep_status, sweep_attempted_at, sweep_submitted_at, paid_at";

function table(db: SupabaseLike, name: string) {
  return db.from(name) as DbTable;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve the operator's treasury address from env. */
function getTreasuryAddress(env: Record<string, string | undefined>): string | null {
  const raw = env.HERMES_TREASURY_ADDRESS?.trim();
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

function depositAddressOf(row: ClaimedRow) {
  const recorded = row.deposit_address || (typeof row.metadata?.depositAddress === "string" ? row.metadata.depositAddress : "");
  return recorded.trim().toLowerCase() || null;
}

// A Bankr 4xx means it refused the request and broadcast nothing, so the sweep
// can be retried. 408 and 409 can mean the request is still being processed,
// and a 5xx, a network error or a timeout can follow a broadcast: those leave
// the outcome unknown. Same rule as the USDC credit-deposit sweep.
function isDefiniteTransferRejection(error: unknown) {
  return (
    error instanceof BankrTransferHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409
  );
}

/**
 * The state a transition requires. `attemptedAt` identifies a claim: every
 * write after a claim is conditioned on the claim's own sweep_attempted_at,
 * so a sweeper whose claim was recovered as stale can never overwrite the
 * claim that replaced it.
 */
interface SweepGuard {
  from: "pending" | "failed" | "sweeping";
  attemptedAt?: string | null;
  submittedIsNull?: boolean;
}

async function transition(
  db: SupabaseLike,
  subscriptionId: string,
  guard: SweepGuard,
  patch: Record<string, unknown>
) {
  let query = table(db, "yearly_token_subscriptions")
    .update(patch)
    .eq("id", subscriptionId)
    .eq("sweep_status", guard.from);
  if (guard.attemptedAt !== undefined) {
    query = guard.attemptedAt === null ? query.is("sweep_attempted_at", null) : query.eq("sweep_attempted_at", guard.attemptedAt);
  }
  if (guard.submittedIsNull) query = query.is("sweep_submitted_at", null);
  const { data, error } = await query.select("id");
  if (error) throw new Error(`Failed to update yearly sweep ${subscriptionId}: ${error.message || "unknown error"}`);
  return Array.isArray(data) && data.length > 0;
}

async function releaseAsFailed(db: SupabaseLike, subscriptionId: string, message: string, now: Date, guard: SweepGuard) {
  await transition(db, subscriptionId, guard, {
    sweep_status: "failed",
    sweep_error: message,
    sweep_submitted_at: null,
    sweep_attempted_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
}

async function parkForOperator(
  db: SupabaseLike,
  row: { id: string; user_id: string },
  reason: string,
  now: Date,
  guard: SweepGuard
) {
  const parked = await transition(db, row.id, guard, {
    sweep_status: "needs_operator",
    sweep_error: reason,
    updated_at: now.toISOString(),
  });
  if (parked) {
    await reportOpsEvent({
      source: "cron.yearly-token-sweep",
      severity: "warn",
      title: "Yearly $HermesOS sweep needs an operator",
      message:
        `A yearly subscription's treasury sweep was parked (${reason}). The user's tier is unaffected; ` +
        `verify the deposit wallet and the treasury on chain, then sweep or resolve it by hand.`,
      route: "/api/cron/yearly-token-sweep",
      userId: row.user_id,
      metadata: { failureType: "yearly_token_sweep_needs_operator", subscriptionId: row.id, reason },
    });
  }
  return parked;
}

/**
 * Claim one subscription's sweep and, if the claim is won, move its amount to
 * the treasury. Safe to call concurrently for the same row.
 */
export async function sweepYearlyTokenSubscription(
  subscription: { id: string; user_id: string },
  options: YearlySweepOptions = {}
): Promise<SweepResult> {
  const db = requireDb(options.db ?? supabaseAdmin) as SupabaseLike;
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const base = { subscriptionId: subscription.id, userId: subscription.user_id };

  // Claim (CAS). Only 'pending' or 'failed' rows with no submitted transfer
  // can be claimed, by one caller; sweep_attempted_at is the claim's token.
  const claimedAt = now.toISOString();
  const { data: claimed, error: claimError } = await table(db, "yearly_token_subscriptions")
    .update({
      sweep_status: "sweeping",
      sweep_attempted_at: claimedAt,
      sweep_error: null,
      updated_at: claimedAt,
    })
    .eq("id", subscription.id)
    .in("sweep_status", ["pending", "failed"])
    .is("sweep_submitted_at", null)
    .select(SWEEP_ROW_COLUMNS)
    .maybeSingle();
  if (claimError) throw new Error(`Failed to claim yearly sweep ${subscription.id}: ${claimError.message || "unknown error"}`);
  if (!claimed) return { ...base, outcome: "claimed_elsewhere" };
  const row = claimed as ClaimedRow;
  const claim: SweepGuard = { from: "sweeping", attemptedAt: claimedAt };

  const treasury = getTreasuryAddress(env);
  if (!treasury) {
    const message = "HERMES_TREASURY_ADDRESS missing or invalid";
    await releaseAsFailed(db, row.id, message, now, claim);
    return { ...base, outcome: "no_treasury_configured", error: message };
  }

  const amountRaw = BigInt(normalizeNumericToBigIntString(String(row.amount_received_raw ?? "0")));
  const depositAddress = depositAddressOf(row);
  // Only settle_yearly_token_payment writes an attributed $HermesOS transfer,
  // and it always records the log index. Pre-attribution rows recorded the
  // wallet's whole balance, and manual grants may carry another asset's tx
  // (e.g. a USDC payment): sweeping their amount could take another flow's
  // tokens from the shared wallet.
  if (!row.deposit_tx_hash || row.deposit_log_index == null || !depositAddress || amountRaw <= 0n) {
    const reason = "no attributed $HermesOS deposit transfer recorded for this subscription";
    await parkForOperator(db, row, reason, now, claim);
    return { ...base, outcome: "needs_operator", error: reason };
  }

  const credential = await getBankrDepositWalletCredentialForAddress({ address: depositAddress, db });
  if (!credential?.bankrWalletId) {
    const reason = `no Bankr credential for deposit wallet ${depositAddress}`;
    await parkForOperator(db, row, reason, now, claim);
    return { ...base, outcome: "needs_operator", error: reason };
  }
  // Address lookups are purpose-agnostic; a hermesos_lock wallet holds the
  // user's own tier-eligibility tokens and must never be swept.
  if (credential.purpose === "hermesos_lock") {
    const reason = "refused to sweep a hermesos_lock wallet";
    await parkForOperator(db, row, reason, now, claim);
    return { ...base, outcome: "needs_operator", error: reason };
  }
  const walletAddress = credential.evmAddress;

  const readBalance = options.readHermesBalance ?? fetchHermesTokenBalance;
  let liveBalanceRaw: bigint;
  try {
    const liveBalance = await readBalance({ walletAddress, rpcUrl: options.rpcUrl, env });
    liveBalanceRaw = BigInt(normalizeNumericToBigIntString(String(liveBalance.balanceRaw)));
  } catch (error) {
    const message = `balance read failed: ${safeErrorMessage(error)}`;
    await releaseAsFailed(db, row.id, message, now, claim);
    return { ...base, outcome: "transfer_failed", error: message };
  }
  if (liveBalanceRaw < amountRaw) {
    // The subscription's tokens are no longer all there (moved by hand, or
    // another sweep took them). Retrying cannot fix that.
    const reason = `live balance ${liveBalanceRaw.toString()} < subscription amount ${amountRaw.toString()}`;
    await parkForOperator(db, row, reason, now, claim);
    return { ...base, outcome: "needs_operator", error: reason };
  }

  const ensureGas = options.ensureGas ?? ensureWalletHasGas;
  try {
    const gas = await ensureGas({ walletAddress, rpcUrl: options.rpcUrl, env });
    // not_configured still lets Bankr's own gas sponsorship cover the
    // transfer; only a drained treasury hot wallet is a hard failure.
    if (gas.status === "treasury_drained") {
      const message = `gas top-up ${gas.status}: ${gas.reason || "treasury hot wallet drained"}`;
      await releaseAsFailed(db, row.id, message, now, claim);
      return { ...base, outcome: "gas_topup_failed", error: message };
    }
  } catch (error) {
    const message = `gas top-up failed: ${safeErrorMessage(error)}`;
    await releaseAsFailed(db, row.id, message, now, claim);
    return { ...base, outcome: "gas_topup_failed", error: message };
  }

  const mintApiKey = options.mintApiKey ?? mintScopedTransferApiKey;
  const apiKey = await mintApiKey({
    bankrWalletId: credential.bankrWalletId,
    recipientAddress: treasury,
    env,
    fetchImpl: options.fetchImpl,
  });
  if (!apiKey) {
    // Two distinct causes; say which so ops isn't sent hunting for an env var.
    const reason = getBankrPartnerConfig(env).partnerKey
      ? "Bankr API key mint returned null (likely per-wallet 20-key cap — revoke stale keys on Bankr)"
      : "Bankr partner key not configured (BANKR_PARTNER_KEY env var missing)";
    await releaseAsFailed(db, row.id, reason, now, claim);
    return { ...base, outcome: "no_credentials", error: reason };
  }

  // Mark the submit under the claim. Losing the claim here means another
  // sweeper recovered this row; nothing has been sent by us.
  const stillClaimed = await transition(db, row.id, claim, { sweep_submitted_at: now.toISOString() });
  if (!stillClaimed) return { ...base, outcome: "claimed_elsewhere" };

  const amountDisplay = formatRawTokenBalance(amountRaw, HERMESOS_TOKEN_DECIMALS);
  const submitTransfer = options.submitTransfer ?? submitBankrTransfer;
  let txHash: string | null;
  try {
    txHash = await submitTransfer({
      apiKey,
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: treasury,
      amountDisplay,
      env,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const message = `transfer failed: ${safeErrorMessage(error)}`;
    if (isDefiniteTransferRejection(error)) {
      // Nothing was sent: clear the submit marker so the row can be retried.
      await releaseAsFailed(db, row.id, message, now, claim);
      return { ...base, outcome: "transfer_failed", error: message };
    }
    const reason = `treasury transfer outcome unknown (${message})`;
    await parkForOperator(db, row, reason, now, claim);
    return { ...base, outcome: "needs_operator", error: reason };
  }

  await transition(db, row.id, claim, {
    sweep_status: "swept",
    sweep_tx_hash: txHash,
    sweep_error: null,
    updated_at: now.toISOString(),
  });
  return { ...base, outcome: "swept", txHash, amountSweptDisplay: amountDisplay };
}

interface QueueRow {
  id: string;
  user_id: string;
  sweep_status: string;
  sweep_attempted_at: string | null;
  sweep_submitted_at: string | null;
  paid_at: string | null;
}

async function loadQueue(db: SupabaseLike, build: (query: DbQuery) => DbQuery) {
  const { data, error } = await build(table(db, "yearly_token_subscriptions").select(SWEEP_ROW_COLUMNS));
  if (error) throw new Error(`Failed to load yearly sweep queue: ${error.message || "unknown error"}`);
  return (Array.isArray(data) ? data : []) as QueueRow[];
}

/**
 * A 'sweeping' claim whose sweeper died: retry it if no transfer was
 * submitted under it, otherwise hand it to an operator (the transfer may have
 * gone through).
 */
async function recoverStaleClaims(db: SupabaseLike, now: Date, limit: number) {
  const staleBefore = new Date(now.getTime() - YEARLY_SWEEP_CLAIM_STALE_MS).toISOString();
  const rows = await loadQueue(db, (query) =>
    query.eq("sweep_status", "sweeping").lt("sweep_attempted_at", staleBefore).order("sweep_attempted_at", { ascending: true }).limit(limit)
  );
  let released = 0;
  let parked = 0;
  for (const row of rows) {
    const stale: SweepGuard = { from: "sweeping", attemptedAt: row.sweep_attempted_at };
    if (row.sweep_submitted_at) {
      if (await parkForOperator(db, row, "sweep claim went stale after a treasury transfer was submitted", now, stale)) {
        parked += 1;
      }
    } else if (
      await transition(db, row.id, { ...stale, submittedIsNull: true }, {
        sweep_status: "failed",
        sweep_error: "sweep claim went stale before a transfer was submitted",
        updated_at: now.toISOString(),
      })
    ) {
      released += 1;
    }
  }
  return { released, parked };
}

export interface YearlySweepBatchResult {
  examined: number;
  swept: number;
  failed: number;
  needsOperator: number;
  claimedElsewhere: number;
  treasuryNotConfigured: number;
  backoffSkipped: number;
  staleClaimsReleased: number;
  staleClaimsParked: number;
  stuck: number;
  results: SweepResult[];
}

/**
 * One sweep pass. Fresh 'pending' rows go first (oldest activation first),
 * then 'failed' rows by least recently attempted, skipping those still inside
 * the retry backoff. Attempting a row moves it to the back of the failed
 * queue, so no set of persistently failing rows can starve the rest.
 */
export async function sweepPendingYearlyTokenSubscriptions(
  options: YearlySweepOptions & { limit?: number; userId?: string } = {}
): Promise<YearlySweepBatchResult> {
  const db = requireDb(options.db ?? supabaseAdmin) as SupabaseLike;
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(MAX_SWEEP_BATCH_LIMIT, Math.floor(options.limit ?? DEFAULT_SWEEP_BATCH_LIMIT)));
  const forUser = (query: DbQuery) => (options.userId ? query.eq("user_id", options.userId) : query);

  const stale = await recoverStaleClaims(db, now, limit);

  const pending = await loadQueue(db, (query) =>
    forUser(query.eq("sweep_status", "pending")).order("paid_at", { ascending: true }).limit(limit)
  );
  const failedQueue =
    pending.length < limit
      ? await loadQueue(db, (query) =>
          forUser(query.eq("sweep_status", "failed"))
            .order("sweep_attempted_at", { ascending: true, nullsFirst: true })
            .limit(limit - pending.length)
        )
      : [];
  const backoffCutoff = now.getTime() - YEARLY_SWEEP_RETRY_BACKOFF_MS;
  const retryable = failedQueue.filter(
    (row) => !row.sweep_attempted_at || Date.parse(row.sweep_attempted_at) < backoffCutoff
  );
  // A failed row that still carries a submit marker may already have moved
  // its tokens; it is never retried automatically.
  let submittedFailedParked = 0;
  for (const row of retryable.filter((candidate) => candidate.sweep_submitted_at)) {
    const guard: SweepGuard = { from: "failed", attemptedAt: row.sweep_attempted_at };
    if (await parkForOperator(db, row, "failed sweep carries a submitted treasury transfer", now, guard)) {
      submittedFailedParked += 1;
    }
  }
  const retryNow = retryable.filter((candidate) => !candidate.sweep_submitted_at);

  const summary: YearlySweepBatchResult = {
    examined: 0,
    swept: 0,
    failed: 0,
    needsOperator: stale.parked + submittedFailedParked,
    claimedElsewhere: 0,
    treasuryNotConfigured: 0,
    backoffSkipped: failedQueue.length - retryable.length,
    staleClaimsReleased: stale.released,
    staleClaimsParked: stale.parked,
    stuck: 0,
    results: [],
  };

  const stuckBefore = now.getTime() - YEARLY_SWEEP_STUCK_ALERT_MS;
  const stuck: Array<{ subscriptionId: string; userId: string }> = [];
  for (const row of [...pending, ...retryNow]) {
    summary.examined += 1;
    let result: SweepResult;
    try {
      result = await sweepYearlyTokenSubscription(row, { ...options, db, now });
    } catch (error) {
      // One bad sweep must not take out the pass; a claim it left behind is
      // recovered as stale.
      log.error("yearly token sweep crashed unexpectedly; continuing", error, {
        source: "yearly-token-sweep",
        subscriptionId: row.id,
        userId: row.user_id,
        failureType: "sweep_uncaught_error",
      });
      result = { subscriptionId: row.id, userId: row.user_id, outcome: "transfer_failed", error: safeErrorMessage(error) };
    }
    summary.results.push(result);
    if (result.outcome === "swept") summary.swept += 1;
    else if (result.outcome === "claimed_elsewhere") summary.claimedElsewhere += 1;
    else if (result.outcome === "needs_operator") summary.needsOperator += 1;
    else if (result.outcome === "no_treasury_configured") summary.treasuryNotConfigured += 1;
    else summary.failed += 1;

    const paidAtMs = row.paid_at ? Date.parse(row.paid_at) : Number.NaN;
    if (
      result.outcome !== "swept" &&
      result.outcome !== "claimed_elsewhere" &&
      result.outcome !== "needs_operator" &&
      Number.isFinite(paidAtMs) &&
      paidAtMs < stuckBefore
    ) {
      stuck.push({ subscriptionId: row.id, userId: row.user_id });
    }
  }

  summary.stuck = stuck.length;
  if (stuck.length > 0) {
    // A sweep still failing hours after activation is a real funds-movement
    // problem (usually config): surface it instead of retrying silently.
    await reportOpsEvent({
      source: "cron.yearly-token-sweep",
      severity: "warn",
      title: `${stuck.length} yearly-token sweep(s) stuck failing`,
      message:
        `${stuck.length} yearly-token subscription sweep(s) are still failing more than ` +
        `${Math.round(YEARLY_SWEEP_STUCK_ALERT_MS / 3_600_000)}h after activation. Their $HermesOS is not ` +
        `reaching the treasury. This usually means a misconfig (e.g. HERMES_TREASURY_ADDRESS, Bankr keys).`,
      route: "/api/cron/yearly-token-sweep",
      metadata: {
        failureType: "yearly_token_sweep_stuck",
        stuckCount: stuck.length,
        sample: stuck.slice(0, 25),
      },
    });
  }

  return summary;
}
