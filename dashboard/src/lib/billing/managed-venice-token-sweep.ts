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
 */

import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import {
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  fetchHermesTokenBalance,
  formatRawTokenBalance,
  normalizeEvmAddress,
  normalizeNumericToBigIntString,
} from "./token-holdings";
import {
  getBankrDepositWalletCredentialForAddress,
  getBankrDepositWalletCredentialForUser,
} from "./bankr-deposit-wallets";
import { mintScopedTransferApiKey, submitBankrTransfer } from "./bankr-withdraw";
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
  order: (...args: unknown[]) => DbQuery;
  limit: (...args: unknown[]) => DbQuery;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbMutation = {
  eq: (...args: unknown[]) => DbMutation;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbQuery;
  update: (...args: unknown[]) => DbMutation;
  insert: (...args: unknown[]) => Promise<{ error: QueryError; data?: unknown }>;
};

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

async function markSweepFailed(params: {
  db: SupabaseLike;
  quoteId: string;
  error: string;
  now: Date;
  destinationAddress?: string | null;
}) {
  const { error } = await table(params.db, "managed_venice_token_quotes")
    .update({
      sweep_status: "failed",
      sweep_attempted_at: params.now.toISOString(),
      sweep_error: params.error,
      sweep_destination_address: params.destinationAddress ?? null,
      updated_at: params.now.toISOString(),
    })
    .eq("id", params.quoteId);

  if (error) {
    throw new Error(error.message || "Failed to mark managed Venice token sweep failed");
  }
}

async function markSweepSkipped(params: {
  db: SupabaseLike;
  quoteId: string;
  reason: string;
  now: Date;
  destinationAddress: string;
}) {
  const { error } = await table(params.db, "managed_venice_token_quotes")
    .update({
      sweep_status: "skipped",
      sweep_attempted_at: params.now.toISOString(),
      sweep_error: params.reason,
      sweep_destination_address: params.destinationAddress,
      updated_at: params.now.toISOString(),
    })
    .eq("id", params.quoteId);

  if (error) {
    throw new Error(error.message || "Failed to mark managed Venice token sweep skipped");
  }
}

async function markSweepSucceeded(params: {
  db: SupabaseLike;
  quote: ManagedVeniceSweepQuoteRow;
  txHash: string | null;
  amountRaw: bigint;
  amountDisplay: string;
  destinationAddress: string;
  now: Date;
}) {
  const { error: updateError } = await table(params.db, "managed_venice_token_quotes")
    .update({
      sweep_status: "swept",
      sweep_tx_hash: params.txHash,
      sweep_attempted_at: params.now.toISOString(),
      sweep_error: null,
      sweep_destination_address: params.destinationAddress,
      updated_at: params.now.toISOString(),
    })
    .eq("id", params.quote.id);

  if (updateError) {
    throw new Error(updateError.message || "Failed to mark managed Venice token sweep swept");
  }

  const { error: eventError } = await table(
    params.db,
    "managed_venice_financial_events"
  ).insert({
    user_id: params.quote.user_id,
    account_id: params.quote.account_id ?? null,
    wallet_type: "hermesos",
    event_type: "treasury_sweep",
    reference_id: params.quote.id,
    idempotency_key: `managed_venice_treasury_sweep:${params.quote.id}:${params.txHash || "no_tx_hash"}`,
    token_amount_raw: params.amountRaw.toString(),
    amount_micro_usd: sweptValueMicroUsd(params.quote, params.amountRaw),
    metadata: {
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      tokenDecimals: HERMESOS_TOKEN_DECIMALS,
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
}

export async function sweepManagedVeniceTokenQuote(
  quote: ManagedVeniceSweepQuoteRow,
  options: {
    db?: SupabaseLike | null;
    now?: Date;
    rpcUrl?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: JsonFetch;
    readHermesBalance?: BalanceReader;
    ensureGas?: GasEnsurer;
    mintApiKey?: ApiKeyMinter;
    submitTransfer?: TransferSubmitter;
  } = {}
): Promise<ManagedVeniceTokenSweepResult> {
  const db = requireDb(options.db ?? supabaseAdmin);
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const quoteId = quote.id;
  const userId = quote.user_id;
  let treasury: string | null;
  try {
    treasury = getManagedVeniceTreasuryAddress(env);
  } catch (error) {
    const message = `invalid managed Venice treasury address: ${safeErrorMessage(error)}`;
    await markSweepFailed({ db, quoteId, error: message, now });
    return {
      quoteId,
      userId,
      outcome: "no_treasury_configured",
      error: message,
    };
  }

  if (!treasury) {
    const error = sweepConfigError();
    await markSweepFailed({ db, quoteId, error, now });
    return {
      quoteId,
      userId,
      outcome: "no_treasury_configured",
      error,
    };
  }

  const credential =
    (quote.deposit_address
      ? await getBankrDepositWalletCredentialForAddress({
          address: quote.deposit_address,
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
    await markSweepFailed({ db, quoteId, error, now, destinationAddress: treasury });
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
    await markSweepFailed({ db, quoteId, error, now, destinationAddress: treasury });
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
    expectedRaw = await resolveSweepAmountRaw(quote, db);
  } catch (error) {
    const message = `deposit lot read failed: ${safeErrorMessage(error)}`;
    await markSweepFailed({ db, quoteId, error: message, now, destinationAddress: treasury });
    return {
      quoteId,
      userId,
      outcome: "transfer_failed",
      destinationAddress: treasury,
      error: message,
    };
  }
  const readBalance = options.readHermesBalance ?? fetchHermesTokenBalance;

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
    await markSweepFailed({ db, quoteId, error: message, now, destinationAddress: treasury });
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
      await markSweepFailed({ db, quoteId, error: message, now, destinationAddress: treasury });
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
    await markSweepFailed({ db, quoteId, error: message, now, destinationAddress: treasury });
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
    await markSweepFailed({ db, quoteId, error, now, destinationAddress: treasury });
    return {
      quoteId,
      userId,
      outcome: "no_credentials",
      destinationAddress: treasury,
      error,
    };
  }

  const amountDisplay = formatRawTokenBalance(expectedRaw, HERMESOS_TOKEN_DECIMALS);
  const submitTransferForWallet = options.submitTransfer ?? submitBankrTransfer;
  let txHash: string | null = null;

  try {
    txHash = await submitTransferForWallet({
      apiKey,
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: treasury,
      amountDisplay,
      env,
      fetchImpl: options.fetchImpl,
    });
  } catch (error) {
    const message = `transfer failed: ${safeErrorMessage(error)}`;
    await markSweepFailed({ db, quoteId, error: message, now, destinationAddress: treasury });
    return {
      quoteId,
      userId,
      outcome: "transfer_failed",
      destinationAddress: treasury,
      error: message,
    };
  }

  await markSweepSucceeded({
    db,
    quote,
    txHash,
    amountRaw: expectedRaw,
    amountDisplay,
    destinationAddress: treasury,
    now,
  });

  return {
    quoteId,
    userId,
    outcome: "swept",
    txHash,
    amountSweptDisplay: amountDisplay,
    destinationAddress: treasury,
  };
}

export async function sweepPendingManagedVeniceTokenQuotes(options: {
  db?: SupabaseLike | null;
  limit?: number;
  now?: Date;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonFetch;
  readHermesBalance?: BalanceReader;
  ensureGas?: GasEnsurer;
  mintApiKey?: ApiKeyMinter;
  submitTransfer?: TransferSubmitter;
} = {}): Promise<{
  checked: number;
  swept: number;
  failed: number;
  skipped: number;
  noTreasury: number;
  results: ManagedVeniceTokenSweepResult[];
}> {
  const db = requireDb(options.db ?? supabaseAdmin);
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const { data, error } = await table(db, "managed_venice_token_quotes")
    .select(
      "id, account_id, user_id, token_amount_raw::text, locked_value_micro_usd, deposit_address, settled_at, sweep_status"
    )
    .eq("status", "settled")
    .in("sweep_status", ["pending", "failed"])
    .order("settled_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load managed Venice token sweeps");
  }

  const rows = Array.isArray(data) ? (data as ManagedVeniceSweepQuoteRow[]) : [];
  const results: ManagedVeniceTokenSweepResult[] = [];
  let swept = 0;
  let failed = 0;
  let skipped = 0;
  let noTreasury = 0;

  for (const row of rows) {
    let result: ManagedVeniceTokenSweepResult;
    try {
      result = await sweepManagedVeniceTokenQuote(row, options);
    } catch (error) {
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
    else failed += 1;
  }

  return {
    checked: rows.length,
    swept,
    failed,
    skipped,
    noTreasury,
    results,
  };
}
