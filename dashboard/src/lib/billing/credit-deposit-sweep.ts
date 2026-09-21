/**
 * Sweep credit_deposit USDC top-ups to the treasury.
 *
 * Each successful USDC top-up creates a `crypto_deposit_receipts` row
 * (status='settled' once credits are granted). This module handles the
 * follow-up sweep: move the deposited USDC out of the user's
 * credit_deposit Bankr wallet into HERMES_TREASURY_ADDRESS so revenue
 * isn't diffused across hundreds of per-user wallets.
 *
 * Mirrors the yearly-sweep pattern intentionally:
 *   - Sweep status lives on the receipt row (`sweep_status`,
 *     `sweep_tx_hash`, `sweep_attempted_at`, `sweep_error`).
 *   - Failures don't undo the credit grant; the cron retries `pending`
 *     and `failed` rows on its next tick.
 *   - The Bankr API key minted for each sweep is scoped to the treasury
 *     address only — even if the key leaked it can't be redirected.
 *
 * Per-receipt sweep semantics: we transfer the receipt's exact
 * `amount_minor` (not the live balance). If multiple top-ups landed in
 * the same wallet between cron ticks, each receipt produces its own
 * sweep tx — preserving 1:1 receipt↔treasury-inbound accounting.
 *
 * Idempotency: the wallet's live balance is checked first. If the
 * balance is below the receipt's amount (e.g. a previous successful
 * sweep already drained it but we lost the tx hash), we mark the row
 * as 'skipped' rather than re-attempting.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  formatRawTokenBalance,
  normalizeEvmAddress,
} from "./token-holdings";
import { getBankrDepositWalletCredentialForUser } from "./bankr-deposit-wallets";
import { getBankrPartnerConfig } from "./bankr-wallets";
import { mintScopedTransferApiKey, submitBankrTransfer } from "./bankr-withdraw";
import { ensureWalletHasGas } from "./treasury-gas";
import { USDC_BASE_TOKEN_ADDRESS, CRYPTO_TOPUP_ASSETS } from "./crypto-topups";

const USDC_DECIMALS = CRYPTO_TOPUP_ASSETS.usdc_base.tokenDecimals;
const ERC20_BALANCE_OF_SELECTOR = "70a08231";
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

type JsonRpcFetch = (
  input: string,
  init: {
    method: "POST";
    headers: { "Content-Type": "application/json" };
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

type CreditDepositSweepOutcome =
  | "swept"
  | "no_balance"
  | "no_treasury_configured"
  | "no_credentials"
  | "transfer_failed"
  | "gas_topup_failed";

export interface CreditDepositSweepResult {
  receiptId: string;
  userId: string;
  outcome: CreditDepositSweepOutcome;
  txHash?: string | null;
  amountSweptDisplay?: string;
  error?: string;
}

interface SweepableReceipt {
  id: string;
  user_id: string;
  amount_minor: number;
  normalized_deposit_address: string;
  token_address: string;
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

function getTreasuryAddress(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.HERMES_TREASURY_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null;
  return raw.toLowerCase();
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: JsonRpcFetch
): Promise<T> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Base RPC request failed with status ${response.status}`);
  }
  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    throw new Error(payload.error.message || "Base RPC returned an error");
  }
  return payload.result as T;
}

async function fetchUsdcBalance(params: {
  walletAddress: string;
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
}): Promise<bigint> {
  const normalized = normalizeEvmAddress(params.walletAddress);
  const data = `0x${ERC20_BALANCE_OF_SELECTOR}${normalized.slice(2).padStart(64, "0")}`;
  const result = await rpcCall<string>(
    params.rpcUrl,
    "eth_call",
    [{ to: USDC_BASE_TOKEN_ADDRESS, data }, "latest"],
    params.fetchImpl
  );
  if (typeof result !== "string" || !/^0x[a-fA-F0-9]+$/.test(result)) {
    throw new Error("Invalid USDC balance RPC result");
  }
  return BigInt(result);
}

async function markSweepFailed(receiptId: string, error: string, now: Date) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("crypto_deposit_receipts")
    .update({
      sweep_status: "failed",
      sweep_attempted_at: now.toISOString(),
      sweep_error: error,
      updated_at: now.toISOString(),
    })
    .eq("id", receiptId);
}

async function markSweepSkipped(receiptId: string, reason: string, now: Date) {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from("crypto_deposit_receipts")
    .update({
      sweep_status: "skipped",
      sweep_attempted_at: now.toISOString(),
      sweep_error: reason,
      updated_at: now.toISOString(),
    })
    .eq("id", receiptId);
}

/**
 * Sweep a single settled credit_deposit USDC receipt to the treasury.
 * Idempotent — re-running with sweep_status='swept' is a no-op (caller
 * filters those out before invoking).
 */
export async function sweepCreditDepositReceipt(
  receipt: SweepableReceipt,
  options: {
    now?: Date;
    rpcUrl?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: JsonRpcFetch;
  } = {}
): Promise<CreditDepositSweepResult> {
  if (!supabaseAdmin) {
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "transfer_failed",
      error: "supabase admin not configured",
    };
  }
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const rpcUrl = options.rpcUrl || getBaseRpcUrl(env);

  const treasury = getTreasuryAddress(env);
  if (!treasury) {
    await markSweepFailed(receipt.id, "HERMES_TREASURY_ADDRESS not configured", now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "no_treasury_configured",
      error: "HERMES_TREASURY_ADDRESS missing or invalid",
    };
  }

  const credential = await getBankrDepositWalletCredentialForUser({
    userId: receipt.user_id,
    purpose: "credit_deposit",
  });
  if (!credential?.bankrWalletId) {
    await markSweepFailed(receipt.id, "credit_deposit credential missing", now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "no_credentials",
      error: "no Bankr credit_deposit credential",
    };
  }

  const walletAddress = credential.evmAddress;
  let liveBalance: bigint;
  try {
    liveBalance = await fetchUsdcBalance({ walletAddress, rpcUrl, fetchImpl });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSweepFailed(receipt.id, `balance read failed: ${message}`, now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "transfer_failed",
      error: message,
    };
  }

  const required = BigInt(receipt.amount_minor);
  if (liveBalance < required) {
    // Wallet was drained or never received the expected amount —
    // treat as already-handled rather than retrying forever.
    await markSweepSkipped(
      receipt.id,
      `live balance ${liveBalance} < expected ${required}`,
      now
    );
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "no_balance",
    };
  }

  try {
    await ensureWalletHasGas({ walletAddress, env, rpcUrl });
  } catch (gasErr) {
    const message = gasErr instanceof Error ? gasErr.message : String(gasErr);
    await markSweepFailed(receipt.id, `gas top-up failed: ${message}`, now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
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
    // mintScopedTransferApiKey returns null for partner-key-missing AND
    // for Bankr's per-wallet 20-key cap. Distinguish the two so the
    // recorded sweep_error tells ops which problem to fix.
    const partnerConfigured = Boolean(getBankrPartnerConfig(env).partnerKey);
    const reason = partnerConfigured
      ? "Bankr API key mint returned null (likely per-wallet 20-key cap — revoke stale keys on Bankr)"
      : "Bankr partner key not configured (BANKR_PARTNER_KEY env var missing)";
    await markSweepFailed(receipt.id, reason, now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "no_credentials",
      error: reason,
    };
  }

  const amountDisplay = formatRawTokenBalance(required.toString(), USDC_DECIMALS);
  let txHash: string | null = null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: USDC_BASE_TOKEN_ADDRESS,
      recipientAddress: treasury,
      amountDisplay,
      env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markSweepFailed(receipt.id, `transfer failed: ${message}`, now);
    return {
      receiptId: receipt.id,
      userId: receipt.user_id,
      outcome: "transfer_failed",
      error: message,
    };
  }

  const { error: markSweptError } = await supabaseAdmin
    .from("crypto_deposit_receipts")
    .update({
      sweep_status: "swept",
      sweep_tx_hash: txHash,
      sweep_attempted_at: now.toISOString(),
      sweep_error: null,
      updated_at: now.toISOString(),
    })
    .eq("id", receipt.id);

  if (markSweptError) {
    // The on-chain sweep ALREADY happened (txHash above), but recording it
    // failed. Previously this error was discarded, leaving the receipt
    // sweep_status='pending'/'failed' so the next run would re-attempt the
    // sweep. Surface it loudly with the tx hash so the receipt can be
    // reconciled to 'swept' by hand rather than silently re-swept. (A
    // claim-before-transfer 'sweeping' state + reconciler is the recommended
    // follow-up to make this self-heal.)
    log.error(
      "credit-deposit sweep transfer succeeded but marking the receipt swept failed",
      markSweptError,
      {
        source: "credit-deposit-sweep",
        failureType: "credit_deposit_sweep_mark_swept_failed",
        receiptId: receipt.id,
        userId: receipt.user_id,
        sweepTxHash: txHash,
      }
    );
  }

  return {
    receiptId: receipt.id,
    userId: receipt.user_id,
    outcome: "swept",
    txHash,
    amountSweptDisplay: amountDisplay,
  };
}

/**
 * Find settled receipts whose sweep is pending or previously failed,
 * and attempt them. Caller is the cron route — runs after the regular
 * reconciliation pass.
 */
export async function sweepPendingCreditDepositReceipts(options: {
  limit?: number;
  now?: Date;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonRpcFetch;
} = {}): Promise<{
  checked: number;
  swept: number;
  failed: number;
  skipped: number;
  noTreasury: number;
  results: CreditDepositSweepResult[];
}> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  if (!supabaseAdmin) {
    return { checked: 0, swept: 0, failed: 0, skipped: 0, noTreasury: 0, results: [] };
  }

  const { data, error } = await supabaseAdmin
    .from("crypto_deposit_receipts")
    .select("id, user_id, amount_minor, normalized_deposit_address, token_address, sweep_status")
    .eq("status", "settled")
    .in("sweep_status", ["pending", "failed"])
    // Hard-allowlist payment-flow deposit modes. Belt-and-braces against
    // a future code change accidentally creating a settled receipt with
    // deposit_mode='hermesos_lock_deposit' — those represent compute-tier
    // eligibility holds and must never be swept to treasury.
    .in("deposit_mode", ["checkout", "open_credit"])
    .order("settled_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(error.message || "Failed to load pending credit_deposit sweeps");
  }

  const rows = Array.isArray(data) ? (data as SweepableReceipt[]) : [];
  const results: CreditDepositSweepResult[] = [];
  let swept = 0;
  let failed = 0;
  let skipped = 0;
  let noTreasury = 0;

  for (const row of rows) {
    const result = await sweepCreditDepositReceipt(row, options);
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
