/**
 * Managed Venice $HermesOS treasury sweep.
 *
 * Settlement credits the user's managed Venice wallet immediately after a
 * quote-matched token deposit. This module performs the custody follow-up:
 * move the $HERMESOS amount the quote's deposit lot actually RECEIVED (an
 * accepted over-send credits, and so sweeps, more than the quote asked for)
 * from the user's Bankr deposit wallet into the managed Venice treasury.
 *
 * The sweep is deliberately separate from quote settlement. A stuck sweep
 * must not take away user credit, but it must be visible, retryable, and
 * recorded with enough detail for treasury reconciliation.
 *
 * The deposit wallet is usually the user's SHARED credit_deposit wallet, which
 * may also hold a yearly payment or a later deposit awaiting its own sweep, so
 * a second transfer of the same amount takes someone else's funds. Every
 * transition is therefore compare-and-set (the yearly sweep's state machine):
 *
 *   pending|failed --claim--> sweeping --> swept
 *                                      --> failed          nothing was sent;
 *                                                          retried next run
 *                                      --> skipped         the wallet no longer
 *                                                          holds the amount
 *                                      --> needs_operator  terminal: the
 *                                                          transfer's outcome
 *                                                          is unknown
 *
 * Overlapping runs cannot both claim a quote. sweep_attempted_at is the
 * claim's token, so a sweeper whose claim was recovered as stale cannot
 * overwrite the claim that replaced it. sweep_submitted_at is stamped under the
 * claim right before Bankr is asked to transfer, so a claim that goes stale is
 * retried only when nothing was sent (migration
 * 20260925193100_managed_venice_token_sweep_claim.sql).
 */

import { platformTokenForRow, type PlatformToken } from "./token-registry";
import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  fetchTokenBalance,
  formatRawTokenBalance,
  platformTokenBalanceConfig,
  normalizeEvmAddress,
  normalizeNumericToBigIntString,
} from "./token-holdings";
import {
  getBankrDepositWalletCredentialForAddress,
  getBankrDepositWalletCredentialForUser,
} from "./bankr-deposit-wallets";
import { BankrTransferHttpError, mintScopedTransferApiKey, submitBankrTransfer } from "./bankr-withdraw";
import { loadManagedVeniceTokenDepositLot } from "./managed-venice-token-quotes";
import {
  ensureWalletHasGas,
  type EnsureWalletGasResult,
} from "./treasury-gas";

type QueryError = { message?: string } | null;

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
  update: (patch: Record<string, unknown>) => DbQuery;
  insert: (...args: unknown[]) => Promise<{ error: QueryError; data?: unknown }>;
};

/**
 * A 'sweeping' claim older than this belongs to a sweeper that died (function
 * timeout, crash). The cron route runs for at most five minutes.
 */
export const MANAGED_VENICE_SWEEP_CLAIM_STALE_MS = 15 * 60 * 1000;

const QUOTES = "managed_venice_token_quotes";
const SWEEP_ROW_COLUMNS =
  "id, account_id, user_id, token_address, token_amount_raw::text, locked_value_micro_usd, deposit_address, " +
  "settled_at, sweep_status, sweep_attempted_at, sweep_submitted_at";

type SupabaseLike = {
  from: (table: string) => unknown;
};

type JsonFetch = typeof fetch;

interface ManagedVeniceSweepQuoteRow {
  id: string;
  account_id?: string | null;
  user_id: string;
  token_amount_raw: string | number | bigint;
  locked_value_micro_usd?: number | string | null;
  deposit_address?: string | null;
  /** Token the quote was paid in (legacy rows: $HermesOS). */
  token_address?: string | null;
  settled_at?: string | null;
  sweep_status?: string | null;
  sweep_attempted_at?: string | null;
  sweep_submitted_at?: string | null;
}

type BalanceReader = (params: {
  walletAddress: string;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
}) => Promise<{ balanceRaw: unknown }>;

type GasEnsurer = (params: {
  walletAddress: string;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
}) => Promise<EnsureWalletGasResult>;

type ApiKeyMinter = (params: {
  bankrWalletId: string;
  recipientAddress: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
}) => Promise<string | null>;

type TransferSubmitter = (params: {
  apiKey: string;
  tokenAddress: string;
  recipientAddress: string;
  amountDisplay: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
}) => Promise<string | null>;

type ManagedVeniceTokenSweepOutcome =
  | "swept"
  | "claimed_elsewhere"
  | "needs_operator"
  | "no_balance"
  | "no_treasury_configured"
  | "no_credentials"
  | "transfer_failed"
  | "gas_topup_failed";

export interface ManagedVeniceTokenSweepResult {
  quoteId: string;
  userId: string;
  outcome: ManagedVeniceTokenSweepOutcome;
  txHash?: string | null;
  amountSweptDisplay?: string;
  destinationAddress?: string;
  error?: string;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function readEnvAddress(
  env: Record<string, string | undefined>,
  name: string
): string | null {
  const value = env[name]?.trim();
  return value ? normalizeEvmAddress(value) : null;
}

export function getManagedVeniceTreasuryAddress(
  env: Record<string, string | undefined> = process.env
): string | null {
  return (
    readEnvAddress(env, "MANAGED_VENICE_TREASURY_BASE_ADDRESS") ||
    readEnvAddress(env, "HERMES_TREASURY_ADDRESS") ||
    readEnvAddress(env, "HERMES_TREASURY_BASE_ADDRESS")
  );
}

function sweepConfigError() {
  return (
    "MANAGED_VENICE_TREASURY_BASE_ADDRESS not configured; " +
    "fallback HERMES_TREASURY_ADDRESS/HERMES_TREASURY_BASE_ADDRESS also unavailable"
  );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readLockedValueMicroUsd(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }
  return 0;
}

// The quote's locked value is for the QUOTED tokens; the swept (received)
// amount is valued at the same snapshot price.
function sweptValueMicroUsd(quote: ManagedVeniceSweepQuoteRow, amountRaw: bigint): number {
  const locked = readLockedValueMicroUsd(quote.locked_value_micro_usd);
  const quotedRaw = BigInt(normalizeNumericToBigIntString(quote.token_amount_raw));
  if (quotedRaw <= 0n || amountRaw === quotedRaw) return locked;
  return Number((BigInt(locked) * amountRaw) / quotedRaw);
}

// Sweep what the deposit actually delivered: the quote's deposit lot holds the
// received token amount (an accepted over-send is larger than the quote), so
// the excess never stays stranded in the shared credit_deposit wallet. Legacy
// settled quotes without a lot row fall back to the quoted amount.
async function resolveSweepAmountRaw(quote: ManagedVeniceSweepQuoteRow, db: SupabaseLike) {
  const lot = await loadManagedVeniceTokenDepositLot(quote.id, db);
  return BigInt(normalizeNumericToBigIntString(lot ? lot.tokenAmountRaw : quote.token_amount_raw));
}

/** A Bankr 4xx refusal broadcast nothing; 408/409, a 5xx, a network error or a timeout leave the outcome unknown. */
function isDefiniteTransferRejection(error: unknown) {
  return (
    error instanceof BankrTransferHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409
  );
}

/** The state a write requires: the claim (or stale claim) it acts under. */
interface SweepGuard {
  from: "pending" | "failed" | "sweeping";
  /** The claim's token; null matches a row never attempted. */
  attemptedAt?: string | null;
  submittedIsNull?: boolean;
}

/**
 * Compare-and-set on one quote's sweep state. False when another run changed
 * the row first; a database error throws, so it is never mistaken for losing
 * the race.
 */
async function transition(
  db: SupabaseLike,
  quoteId: string,
  guard: SweepGuard,
  patch: Record<string, unknown>
): Promise<boolean> {
  let query = table(db, QUOTES).update(patch).eq("id", quoteId).eq("sweep_status", guard.from);
  if (guard.attemptedAt !== undefined) {
    query = guard.attemptedAt === null ? query.is("sweep_attempted_at", null) : query.eq("sweep_attempted_at", guard.attemptedAt);
  }
  if (guard.submittedIsNull) query = query.is("sweep_submitted_at", null);
  const { data, error } = await query.select("id");
  if (error) {
    throw new Error(`Failed to update managed Venice token sweep ${quoteId}: ${error.message || "unknown error"}`);
  }
  return Array.isArray(data) && data.length > 0;
}

/** Nothing was sent under this claim: release it to 'failed' for the next run. */
async function releaseAsFailed(params: {
  db: SupabaseLike;
  quoteId: string;
  guard: SweepGuard;
  error: string;
  now: Date;
  destinationAddress?: string | null;
}) {
  await transition(params.db, params.quoteId, params.guard, {
    sweep_status: "failed",
    sweep_attempted_at: params.now.toISOString(),
    sweep_submitted_at: null,
    sweep_error: params.error,
    sweep_destination_address: params.destinationAddress ?? null,
    updated_at: params.now.toISOString(),
  });
}

async function markSweepSkipped(params: {
  db: SupabaseLike;
  quoteId: string;
  guard: SweepGuard;
  reason: string;
  now: Date;
  destinationAddress: string;
}) {
  await transition(params.db, params.quoteId, params.guard, {
    sweep_status: "skipped",
    sweep_attempted_at: params.now.toISOString(),
    sweep_submitted_at: null,
    sweep_error: params.reason,
    sweep_destination_address: params.destinationAddress,
    updated_at: params.now.toISOString(),
  });
}

/**
 * Terminal: the quote's tokens may already have moved (or the sweep cannot be
 * automated). Never retried; an operator checks the chain and resolves it.
 */
async function parkForOperator(params: {
  db: SupabaseLike;
  quote: Pick<ManagedVeniceSweepQuoteRow, "id" | "user_id">;
  guard: SweepGuard;
  reason: string;
  now: Date;
  txHash?: string | null;
}) {
  const parked = await transition(params.db, params.quote.id, params.guard, {
    sweep_status: "needs_operator",
    sweep_error: params.reason,
    updated_at: params.now.toISOString(),
  });
  if (parked) {
    await reportOpsEvent({
      source: "managed-venice-token-sweep",
      severity: "warn",
      title: "Managed-Venice token sweep needs an operator",
      message:
        `A managed-Venice token quote's treasury sweep was parked (${params.reason}). The user's credit is ` +
        "unaffected. Check the deposit wallet and the treasury on chain, then record the sweep or retry it by hand.",
      route: "/api/cron/reconcile-crypto-topups",
      userId: params.quote.user_id,
      metadata: {
        failureType: "managed_venice_sweep_needs_operator",
        quoteId: params.quote.id,
        reason: params.reason,
        txHash: params.txHash ?? null,
      },
    });
  }
  return parked;
}

async function markSweepSucceeded(params: {
  db: SupabaseLike;
  quote: ManagedVeniceSweepQuoteRow;
  guard: SweepGuard;
  token: PlatformToken;
  txHash: string | null;
  amountRaw: bigint;
  amountDisplay: string;
  destinationAddress: string;
  now: Date;
}): Promise<boolean> {
  const recorded = await transition(params.db, params.quote.id, params.guard, {
    sweep_status: "swept",
    sweep_tx_hash: params.txHash,
    sweep_error: null,
    sweep_destination_address: params.destinationAddress,
    updated_at: params.now.toISOString(),
  });

  // The transfer happened whether or not the claim still held: record it for
  // treasury reconciliation either way (the key is idempotent per tx).
  const { error: eventError } = await table(
    params.db,
    "managed_venice_financial_events"
  ).insert({
    user_id: params.quote.user_id,
    account_id: params.quote.account_id ?? null,
    wallet_type: params.token.key,
    event_type: "treasury_sweep",
    reference_id: params.quote.id,
    idempotency_key: `managed_venice_treasury_sweep:${params.quote.id}:${params.txHash || "no_tx_hash"}`,
    token_amount_raw: params.amountRaw.toString(),
    amount_micro_usd: sweptValueMicroUsd(params.quote, params.amountRaw),
    metadata: {
      tokenAddress: params.token.address,
      tokenDecimals: params.token.decimals,
      amountDisplay: params.amountDisplay,
      destinationAddress: params.destinationAddress,
      txHash: params.txHash,
    },
  });

  if (eventError) {
    log.error("managed Venice treasury sweep event write failed after transfer", new Error(eventError.message || "event insert failed"), {
      source: "managed-venice-token-sweep",
      userId: params.quote.user_id,
      quoteId: params.quote.id,
      txHash: params.txHash,
      failureType: "managed_venice_sweep_financial_event_failed",
    });
  }
  return recorded;
}

interface SweepOptions {
  db?: SupabaseLike | null;
  now?: Date;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
  readHermesBalance?: BalanceReader;
  ensureGas?: GasEnsurer;
  mintApiKey?: ApiKeyMinter;
  submitTransfer?: TransferSubmitter;
}

/**
 * Claim one settled quote's sweep and, if this caller wins the claim, move its
 * received amount to the managed Venice treasury. Safe to call concurrently
 * for the same quote: only one caller claims it, and only the claimant
 * transfers.
 */
export async function sweepManagedVeniceTokenQuote(
  // Only the id and owner are read from the caller; the claim re-reads the row.
  quote: Pick<ManagedVeniceSweepQuoteRow, "id" | "user_id"> & Partial<ManagedVeniceSweepQuoteRow>,
  options: SweepOptions = {}
): Promise<ManagedVeniceTokenSweepResult> {
  const db = requireDb(options.db ?? supabaseAdmin);
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const quoteId = quote.id;
  const userId = quote.user_id;

  // Claim (compare-and-set): only a settled quote in 'pending' or 'failed'
  // with no submitted transfer, by one caller.
  const claimedAt = now.toISOString();
  const { data: claimedRow, error: claimError } = await table(db, QUOTES)
    .update({ sweep_status: "sweeping", sweep_attempted_at: claimedAt, sweep_error: null, updated_at: claimedAt })
    .eq("id", quoteId)
    .eq("status", "settled")
    .in("sweep_status", ["pending", "failed"])
    .is("sweep_submitted_at", null)
    .select(SWEEP_ROW_COLUMNS)
    .maybeSingle();
  if (claimError) {
    throw new Error(`Failed to claim managed Venice token sweep ${quoteId}: ${claimError.message || "unknown error"}`);
  }
  if (!claimedRow) return { quoteId, userId, outcome: "claimed_elsewhere" };
  const row = claimedRow as ManagedVeniceSweepQuoteRow;
  const claim: SweepGuard = { from: "sweeping", attemptedAt: claimedAt };
  const release = (error: string, destinationAddress?: string | null) =>
    releaseAsFailed({ db, quoteId, guard: claim, error, now, destinationAddress });

  const token = platformTokenForRow(row);
  let treasury: string | null;
  try {
    treasury = getManagedVeniceTreasuryAddress(env);
  } catch (error) {
    const message = `invalid managed Venice treasury address: ${safeErrorMessage(error)}`;
    await release(message);
    return {
      quoteId,
      userId,
      outcome: "no_treasury_configured",
      error: message,
    };
  }

  if (!treasury) {
    const error = sweepConfigError();
    await release(error);
    return {
      quoteId,
      userId,
      outcome: "no_treasury_configured",
      error,
    };
  }

  const credential =
    (row.deposit_address
      ? await getBankrDepositWalletCredentialForAddress({
          address: row.deposit_address,
          db,
        })
      : null) ||
    (await getBankrDepositWalletCredentialForUser({
      userId,
      purpose: "credit_deposit",
      db,
    })) ||
    (await getBankrDepositWalletCredentialForUser({
      userId,
      purpose: "managed_venice_inference",
      db,
    }));

  // Address-based lookup is purpose-agnostic. Hard-refuse if it lands on
  // a hermesos_lock credential — those wallets hold compute-tier
  // eligibility deposits that belong to the user, not the treasury. The
  // explicit per-purpose lookups below this can never resolve to a lock
  // wallet, so the guard only matters for the deposit_address branch.
  if (credential?.purpose === "hermesos_lock") {
    const error = "refused to sweep hermesos_lock wallet for managed Venice quote";
    await release(error, treasury);
    return {
      quoteId,
      userId,
      outcome: "no_credentials",
      destinationAddress: treasury,
      error,
    };
  }

  if (!credential?.bankrWalletId) {
    const error = "Bankr deposit wallet credential missing for managed Venice sweep";
    await release(error, treasury);
    return {
      quoteId,
      userId,
      outcome: "no_credentials",
      destinationAddress: treasury,
      error,
    };
  }

  const walletAddress = credential.evmAddress;
  let expectedRaw: bigint;
  try {
    expectedRaw = await resolveSweepAmountRaw(row, db);
  } catch (error) {
    const message = `deposit lot read failed: ${safeErrorMessage(error)}`;
    await release(message, treasury);
    return {
      quoteId,
      userId,
      outcome: "transfer_failed",
      destinationAddress: treasury,
      error: message,
    };
  }
  // Sweep only the token the quote was paid in.
  const readBalance: BalanceReader =
    options.readHermesBalance ??
    ((balanceParams) => fetchTokenBalance({ ...balanceParams, token: platformTokenBalanceConfig(token) }));

  let liveBalanceRaw: bigint;
  try {
    const liveBalance = await readBalance({
      walletAddress,
      rpcUrl: options.rpcUrl,
      env,
      fetchImpl: options.fetchImpl,
    });
    liveBalanceRaw = BigInt(normalizeNumericToBigIntString(liveBalance.balanceRaw));
  } catch (error) {
    const message = `balance read failed: ${safeErrorMessage(error)}`;
    await release(message, treasury);
    return {
      quoteId,
      userId,
      outcome: "transfer_failed",
      destinationAddress: treasury,
      error: message,
    };
  }

  if (liveBalanceRaw < expectedRaw) {
    const reason = `live balance ${liveBalanceRaw.toString()} < expected ${expectedRaw.toString()}`;
    await markSweepSkipped({
      db,
      quoteId,
      guard: claim,
      reason,
      now,
      destinationAddress: treasury,
    });
    return {
      quoteId,
      userId,
      outcome: "no_balance",
      destinationAddress: treasury,
      error: reason,
    };
  }

  const ensureGasForWallet = options.ensureGas ?? ensureWalletHasGas;
  try {
    const gas = await ensureGasForWallet({
      walletAddress,
      rpcUrl: options.rpcUrl,
      env,
    });
    // "not_configured" means HERMES_TREASURY_BASE_PRIVATE_KEY isn't set
    // — but Bankr's own Gas Sponsorship may still cover the transfer
    // from the partner Org Wallet. Mirror yearly-sweep's looser handling
    // and let the downstream /wallet/transfer call surface the real
    // error if gas isn't actually available. Only treasury_drained is a
    // hard failure: we tried to sponsor gas ourselves and our hot
    // wallet was empty — Bankr won't retroactively cover that, and the
    // transfer will fail with insufficient_funds_for_gas.
    if (gas.status === "treasury_drained") {
      const message = `gas top-up ${gas.status}: ${gas.reason || "treasury hot wallet drained"}`;
      await release(message, treasury);
      return {
        quoteId,
        userId,
        outcome: "gas_topup_failed",
        destinationAddress: treasury,
        error: message,
      };
    }
  } catch (error) {
    const message = `gas top-up failed: ${safeErrorMessage(error)}`;
    await release(message, treasury);
    return {
      quoteId,
      userId,
      outcome: "gas_topup_failed",
      destinationAddress: treasury,
      error: message,
    };
  }

  const mintApiKey = options.mintApiKey ?? mintScopedTransferApiKey;
  const apiKey = await mintApiKey({
    bankrWalletId: credential.bankrWalletId,
    recipientAddress: treasury,
    env,
    fetchImpl: options.fetchImpl,
  });

  if (!apiKey) {
    const error = "Bankr scoped transfer API key unavailable";
    await release(error, treasury);
    return {
      quoteId,
      userId,
      outcome: "no_credentials",
      destinationAddress: treasury,
      error,
    };
  }

  // Mark the submit under the claim. Losing the claim here means another
  // sweeper recovered this quote; nothing has been sent by this one.
  const stillClaimed = await transition(db, quoteId, { ...claim, submittedIsNull: true }, {
    sweep_submitted_at: now.toISOString(),
    sweep_destination_address: treasury,
  });
  if (!stillClaimed) return { quoteId, userId, outcome: "claimed_elsewhere", destinationAddress: treasury };

  const amountDisplay = formatRawTokenBalance(expectedRaw, token.decimals);
  const submitTransferForWallet = options.submitTransfer ?? submitBankrTransfer;
  let txHash: string | null = null;

  try {
    txHash = await submitTransferForWallet({
      apiKey,
      tokenAddress: token.address,
      recipientAddress: treasury,
      amountDisplay,
      env,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const message = `transfer failed: ${safeErrorMessage(error)}`;
    if (isDefiniteTransferRejection(error)) {
      // Bankr refused it: nothing moved, so the quote is retried next run.
      await release(message, treasury);
      return {
        quoteId,
        userId,
        outcome: "transfer_failed",
        destinationAddress: treasury,
        error: message,
      };
    }
    // The transfer may have gone through. Sending it again would take the
    // same amount from whatever else the shared wallet holds.
    const reason = `treasury transfer outcome unknown (${message})`;
    await parkForOperator({ db, quote: row, guard: claim, reason, now });
    return {
      quoteId,
      userId,
      outcome: "needs_operator",
      destinationAddress: treasury,
      error: reason,
    };
  }

  const recorded = await markSweepSucceeded({
    db,
    quote: row,
    guard: claim,
    token,
    txHash,
    amountRaw: expectedRaw,
    amountDisplay,
    destinationAddress: treasury,
    now,
  });
  if (!recorded) {
    // The claim went stale while the transfer was in flight and was parked
    // for an operator: hand them the transaction that did go out.
    log.error("managed Venice treasury sweep sent a transfer after its claim was recovered", new Error("sweep claim lost after transfer"), {
      source: "managed-venice-token-sweep",
      userId,
      quoteId,
      txHash,
      failureType: "managed_venice_sweep_claim_lost_after_transfer",
    });
    await reportOpsEvent({
      source: "managed-venice-token-sweep",
      severity: "warn",
      title: "Managed-Venice token sweep needs an operator",
      message:
        "A managed-Venice token sweep transfer went out after its claim was recovered as stale. " +
        "Record the transaction on the quote once it is confirmed on chain.",
      route: "/api/cron/reconcile-crypto-topups",
      userId,
      metadata: { failureType: "managed_venice_sweep_claim_lost_after_transfer", quoteId, txHash },
    });
    return {
      quoteId,
      userId,
      outcome: "needs_operator",
      txHash,
      amountSweptDisplay: amountDisplay,
      destinationAddress: treasury,
      error: "transfer sent after the claim was recovered as stale",
    };
  }

  return {
    quoteId,
    userId,
    outcome: "swept",
    txHash,
    amountSweptDisplay: amountDisplay,
    destinationAddress: treasury,
  };
}

async function loadQueue(db: SupabaseLike, build: (query: DbQuery) => DbQuery) {
  const { data, error } = await build(table(db, QUOTES).select(SWEEP_ROW_COLUMNS));
  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token sweeps");
  }
  return (Array.isArray(data) ? data : []) as ManagedVeniceSweepQuoteRow[];
}

/**
 * A 'sweeping' claim whose sweeper died: retry it if no transfer was
 * submitted under it, otherwise hand it to an operator (the transfer may
 * have gone through).
 */
async function recoverStaleClaims(db: SupabaseLike, now: Date, limit: number) {
  const staleBefore = new Date(now.getTime() - MANAGED_VENICE_SWEEP_CLAIM_STALE_MS).toISOString();
  const rows = await loadQueue(db, (query) =>
    query.eq("sweep_status", "sweeping").lt("sweep_attempted_at", staleBefore).order("sweep_attempted_at", { ascending: true }).limit(limit)
  );
  let released = 0;
  let parked = 0;
  for (const row of rows) {
    const stale: SweepGuard = { from: "sweeping", attemptedAt: row.sweep_attempted_at ?? null };
    if (row.sweep_submitted_at) {
      const reason = "sweep claim went stale after a treasury transfer was submitted";
      if (await parkForOperator({ db, quote: row, guard: stale, reason, now })) parked += 1;
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

/**
 * One sweep pass: recover stale claims, then fresh 'pending' quotes (oldest
 * settlement first), then 'failed' ones by least recently attempted, so a set
 * of persistently failing quotes cannot starve the rest. Each quote is
 * claimed before anything is transferred.
 */
export async function sweepPendingManagedVeniceTokenQuotes(options: SweepOptions & { limit?: number } = {}): Promise<{
  checked: number;
  swept: number;
  failed: number;
  skipped: number;
  noTreasury: number;
  needsOperator: number;
  claimedElsewhere: number;
  staleClaimsReleased: number;
  staleClaimsParked: number;
  results: ManagedVeniceTokenSweepResult[];
}> {
  const db = requireDb(options.db ?? supabaseAdmin);
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));

  const stale = await recoverStaleClaims(db, now, limit);
  const pending = await loadQueue(db, (query) =>
    query.eq("status", "settled").eq("sweep_status", "pending").order("settled_at", { ascending: true }).limit(limit)
  );
  const failedQueue =
    pending.length < limit
      ? await loadQueue(db, (query) =>
          query
            .eq("status", "settled")
            .eq("sweep_status", "failed")
            .order("sweep_attempted_at", { ascending: true, nullsFirst: true })
            .limit(limit - pending.length)
        )
      : [];

  // A failed quote that still carries a submit marker may already have moved
  // its tokens; it is never retried automatically.
  let submittedFailedParked = 0;
  for (const row of failedQueue.filter((candidate) => candidate.sweep_submitted_at)) {
    const guard: SweepGuard = { from: "failed", attemptedAt: row.sweep_attempted_at ?? null };
    const reason = "failed sweep carries a submitted treasury transfer";
    if (await parkForOperator({ db, quote: row, guard, reason, now })) submittedFailedParked += 1;
  }
  const rows = [...pending, ...failedQueue.filter((candidate) => !candidate.sweep_submitted_at)];

  const results: ManagedVeniceTokenSweepResult[] = [];
  let swept = 0;
  let failed = 0;
  let skipped = 0;
  let noTreasury = 0;
  let needsOperator = stale.parked + submittedFailedParked;
  let claimedElsewhere = 0;

  for (const row of rows) {
    let result: ManagedVeniceTokenSweepResult;
    try {
      result = await sweepManagedVeniceTokenQuote(row, { ...options, db, now });
    } catch (error) {
      // A claim this left behind is recovered as stale on a later run.
      log.error("managed Venice treasury sweep crashed unexpectedly; continuing", error, {
        source: "managed-venice-token-sweep",
        userId: row.user_id,
        quoteId: row.id,
        failureType: "managed_venice_sweep_uncaught_error",
      });
      result = {
        quoteId: row.id,
        userId: row.user_id,
        outcome: "transfer_failed",
        error: safeErrorMessage(error),
      };
    }

    results.push(result);
    if (result.outcome === "swept") swept += 1;
    else if (result.outcome === "no_balance") skipped += 1;
    else if (result.outcome === "no_treasury_configured") noTreasury += 1;
    else if (result.outcome === "needs_operator") needsOperator += 1;
    else if (result.outcome === "claimed_elsewhere") claimedElsewhere += 1;
    else failed += 1;
  }

  return {
    checked: rows.length,
    swept,
    failed,
    skipped,
    noTreasury,
    needsOperator,
    claimedElsewhere,
    staleClaimsReleased: stale.released,
    staleClaimsParked: stale.parked,
    results,
  };
}
