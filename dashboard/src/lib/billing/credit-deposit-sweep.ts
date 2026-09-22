/**
 * Sweep settled USDC credit top-ups to the treasury.
 *
 * A USDC top-up lands in the user's credit_deposit Bankr wallet and is
 * credited from its `crypto_deposit_receipts` row. Once that receipt is
 * settled, this module moves exactly the receipt's `amount_minor` from the
 * wallet to HERMES_TREASURY_ADDRESS, once, and records the on-chain proof, so
 * revenue isn't diffused across hundreds of per-user wallets. A failed or
 * stuck sweep never undoes the credit grant.
 *
 * Sweep state lives on the receipt row (migration
 * 20260922190000_credit_deposit_sweep_state.sql):
 *
 *   not_required  Not owed. A trigger moves a settled checkout/open_credit
 *                 Base-USDC receipt to 'pending', whichever code settles it.
 *   pending       Owed, never attempted.
 *   submitted     Claimed by attempt number `sweep_attempts`:
 *                   - no `sweep_transfer_requested_at`: preparing. Bankr has
 *                     not been asked to transfer, so a claim abandoned for
 *                     longer than CLAIM_LEASE_MS is released to 'failed'.
 *                   - transfer requested, no `sweep_tx_hash`: in doubt. Bankr
 *                     may have moved the funds; only a matching Transfer log
 *                     on chain resolves it. Never re-sent automatically.
 *                   - `sweep_tx_hash` set: broadcast. Confirmed once the tx
 *                     carries the exact Transfer log at SWEEP_MIN_CONFIRMATIONS.
 *   confirmed     The treasury holds the funds. Terminal.
 *   failed        The attempt provably moved nothing (it failed before the
 *                 transfer request, Bankr refused it, or the tx reverted).
 *                 Retried on the next run.
 *   skipped       Held for a human: the deposit address is not the receipt
 *                 owner's credit_deposit wallet, or the funds are missing.
 *
 * Exactly once: a receipt is claimed with a compare-and-set before anything is
 * transferred, every later write compares against that claim's attempt number,
 * and an attempt that asked Bankr to transfer is resolved only by evidence
 * (a tx hash, a refusal, a revert, or the transfer found on chain). That is
 * what keeps a receipt whose outcome is unknown from sweeping funds that
 * belong to a later receipt in the same wallet.
 *
 * Each attempt mints a single-use Bankr API key scoped to the treasury address
 * only — even if the key leaked it can't be redirected.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { requireDb } from "./db-utils";
import {
  BASE_CHAIN_ID,
  formatRawTokenBalance,
  normalizeEvmAddress,
} from "./token-holdings";
import { getBankrDepositWalletCredentialForAddress } from "./bankr-deposit-wallets";
import { getBankrPartnerConfig } from "./bankr-wallets";
import {
  BankrTransferHttpError,
  mintScopedTransferApiKey,
  submitBankrTransfer,
} from "./bankr-withdraw";
import { ensureWalletHasGas } from "./treasury-gas";
import { USDC_BASE_TOKEN_ADDRESS, CRYPTO_TOPUP_ASSETS } from "./crypto-topups";

const USDC_DECIMALS = CRYPTO_TOPUP_ASSETS.usdc_base.tokenDecimals;
const ERC20_BALANCE_OF_SELECTOR = "70a08231";
// keccak256("Transfer(address,address,uint256)")
const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const SWEEPABLE_DEPOSIT_MODES = ["checkout", "open_credit"];
const SWEEP_MIN_CONFIRMATIONS = 3;
// Longer than any cron invocation runs, so a live claim is never released.
const CLAIM_LEASE_MS = 15 * 60_000;
// A requested transfer is broadcast within seconds; look for it this many
// blocks (~1 h on Base) past the claim. One eth_getLogs call: the public Base
// RPC rejects ranges over 2,000 blocks.
const EVIDENCE_WINDOW_BLOCKS = 1_800;
// A broadcast sweep still unmined after this long is reported for review.
const UNMINED_ALERT_MS = 60 * 60_000;
const OPS_ROUTE = "/api/cron/reconcile-crypto-topups";

const RECEIPT_COLUMNS = [
  "id",
  "user_id",
  "amount_minor",
  "chain_id",
  "token_address",
  "normalized_deposit_address",
  "sweep_status",
  "sweep_attempts",
  "sweep_attempted_at",
  "sweep_claim_block",
  "sweep_destination_address",
  "sweep_transfer_requested_at",
  "sweep_submitted_at",
  "sweep_tx_hash",
].join(", ");

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

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

interface RpcTransactionReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
}

type QueryError = { message?: string; code?: string } | null;

interface ReceiptQuery extends PromiseLike<{ data: unknown; error: QueryError }> {
  select: (columns: string) => ReceiptQuery;
  eq: (column: string, value: unknown) => ReceiptQuery;
  in: (column: string, values: readonly unknown[]) => ReceiptQuery;
  is: (column: string, value: null) => ReceiptQuery;
  order: (column: string, options: { ascending: boolean }) => ReceiptQuery;
  limit: (count: number) => ReceiptQuery;
}

interface ReceiptTable {
  select: (columns: string) => ReceiptQuery;
  update: (values: Record<string, unknown>) => ReceiptQuery;
}

type SupabaseLike = { from: (table: string) => unknown };

type SweepStatus = "pending" | "submitted" | "confirmed" | "failed" | "skipped";

interface SweepReceipt {
  id: string;
  user_id: string;
  amount_minor: number | string;
  chain_id: number;
  token_address: string;
  normalized_deposit_address: string;
  sweep_status: SweepStatus;
  sweep_attempts: number;
  sweep_attempted_at: string | null;
  sweep_claim_block: number | string | null;
  sweep_destination_address: string | null;
  sweep_transfer_requested_at: string | null;
  sweep_submitted_at: string | null;
  sweep_tx_hash: string | null;
}

type CreditDepositSweepOutcome =
  | "submitted"
  | "confirmed"
  | "awaiting_confirmation"
  | "in_doubt"
  | "claimed_elsewhere"
  | "released"
  | "held_for_review"
  | "no_treasury_configured"
  | "no_credentials"
  | "gas_topup_failed"
  | "transfer_failed"
  | "error";

export interface CreditDepositSweepResult {
  receiptId: string;
  userId: string;
  outcome: CreditDepositSweepOutcome;
  txHash?: string | null;
  amountSweptDisplay?: string;
  error?: string;
}

interface SweepOptions {
  now?: Date;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonRpcFetch;
}

interface SweepContext {
  db: SupabaseLike;
  now: Date;
  nowIso: string;
  env: Record<string, string | undefined>;
  rpcUrl: string;
  rpc: ReturnType<typeof createBaseRpc>;
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`Invalid ${label} from Base RPC`);
  }
  return BigInt(value);
}

function addressTopic(address: string) {
  return `0x${normalizeEvmAddress(address).slice(2).padStart(64, "0")}`;
}

function createBaseRpc(rpcUrl: string, fetchImpl: JsonRpcFetch) {
  async function call(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) {
      throw new Error(`Base RPC ${method} failed with status ${response.status}`);
    }
    const payload = (await response.json()) as JsonRpcResponse;
    if (payload.error) {
      throw new Error(payload.error.message || `Base RPC ${method} returned an error`);
    }
    return payload.result;
  }

  return {
    async blockNumber(): Promise<number> {
      return Number(parseQuantity(await call("eth_blockNumber", []), "block number"));
    },

    async usdcBalance(walletAddress: string): Promise<bigint> {
      const data = `0x${ERC20_BALANCE_OF_SELECTOR}${normalizeEvmAddress(walletAddress).slice(2).padStart(64, "0")}`;
      const result = await call("eth_call", [{ to: USDC_BASE_TOKEN_ADDRESS, data }, "latest"]);
      return parseQuantity(result, "USDC balance");
    },

    async transactionReceipt(txHash: string): Promise<RpcTransactionReceipt | null> {
      const result = await call("eth_getTransactionReceipt", [txHash]);
      return (result as RpcTransactionReceipt | null) ?? null;
    },

    async usdcTransfers(params: {
      from: string;
      to: string;
      fromBlock: number;
      toBlock: number;
    }): Promise<RpcLog[]> {
      const result = await call("eth_getLogs", [
        {
          address: USDC_BASE_TOKEN_ADDRESS,
          fromBlock: `0x${params.fromBlock.toString(16)}`,
          toBlock: `0x${params.toBlock.toString(16)}`,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(params.from), addressTopic(params.to)],
        },
      ]);
      if (!Array.isArray(result)) throw new Error("Invalid eth_getLogs result from Base RPC");
      return result as RpcLog[];
    },
  };
}

// The exact USDC transfer this receipt's sweep makes: wallet -> destination,
// for the receipt's amount.
function isSweepTransferLog(entry: RpcLog, receipt: SweepReceipt) {
  if (entry.removed || !receipt.sweep_destination_address) return false;
  const topics = (entry.topics ?? []).map((topic) => topic.toLowerCase());
  let value: bigint;
  try {
    value = parseQuantity(entry.data, "transfer amount");
  } catch {
    return false;
  }
  return (
    entry.address?.toLowerCase() === USDC_BASE_TOKEN_ADDRESS &&
    topics.length === 3 &&
    topics[0] === ERC20_TRANSFER_TOPIC &&
    topics[1] === addressTopic(receipt.normalized_deposit_address) &&
    topics[2] === addressTopic(receipt.sweep_destination_address) &&
    value === BigInt(receipt.amount_minor)
  );
}

// A 4xx means Bankr refused the request and broadcast nothing. 408 and 409 can
// mean the request is still being processed, and a 5xx, a network error or a
// timeout can follow a broadcast: those leave the outcome unknown.
function isTransferRefusal(error: unknown) {
  return (
    error instanceof BankrTransferHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 409
  );
}

function receiptsTable(db: SupabaseLike) {
  return db.from("crypto_deposit_receipts") as ReceiptTable;
}

interface TransitionGuard {
  statuses: SweepStatus[];
  attempts: number;
  // false: only while Bankr has not been asked to transfer.
  transferRequested?: false;
  // The sweep tx hash the row must hold (null: none recorded).
  txHash?: string | null;
}

/**
 * Compare-and-set on one receipt's sweep state. Returns false when another run
 * changed the row first; a database error throws, so it is never mistaken for
 * losing the race.
 */
async function transition(
  db: SupabaseLike,
  receiptId: string,
  guard: TransitionGuard,
  values: Record<string, unknown>
): Promise<boolean> {
  let query = receiptsTable(db)
    .update(values)
    .eq("id", receiptId)
    .in("sweep_status", guard.statuses)
    .eq("sweep_attempts", guard.attempts);
  if (guard.transferRequested === false) query = query.is("sweep_transfer_requested_at", null);
  if (guard.txHash === null) query = query.is("sweep_tx_hash", null);
  else if (guard.txHash !== undefined) query = query.eq("sweep_tx_hash", guard.txHash);

  const { data, error } = await query.select("id");
  if (error) {
    throw new Error(`Failed to update credit-deposit sweep state: ${error.message || "unknown error"}`);
  }
  return Array.isArray(data) && data.length > 0;
}

async function reportForReview(
  receipt: SweepReceipt,
  failureType: string,
  message: string,
  metadata: Record<string, unknown> = {}
) {
  await reportOpsEvent({
    source: "credit-deposit-sweep",
    severity: "error",
    title: "Credit-deposit treasury sweep needs review",
    message: `${message} Receipt ${receipt.id}.`,
    route: OPS_ROUTE,
    userId: receipt.user_id,
    metadata: {
      failureType,
      receiptId: receipt.id,
      depositAddress: receipt.normalized_deposit_address,
      amountMinor: String(receipt.amount_minor),
      ...metadata,
    },
  });
}

/**
 * Find this attempt's transfer on chain: the earliest exact sweep transfer
 * from the wallet to the attempt's destination since the claim that no other
 * receipt has recorded as its sweep.
 */
async function findSweepTransfer(
  receipt: SweepReceipt,
  ctx: SweepContext,
  head: number
): Promise<{ txHash: string; blockNumber: number } | null> {
  const fromBlock = Number(receipt.sweep_claim_block);
  const toBlock = Math.min(head, fromBlock + EVIDENCE_WINDOW_BLOCKS - 1);
  if (!receipt.sweep_destination_address || !Number.isFinite(fromBlock) || toBlock < fromBlock) {
    return null;
  }

  const matches = (
    await ctx.rpc.usdcTransfers({
      from: receipt.normalized_deposit_address,
      to: receipt.sweep_destination_address,
      fromBlock,
      toBlock,
    })
  )
    .filter((entry) => isSweepTransferLog(entry, receipt))
    .map((entry) => ({
      txHash: entry.transactionHash.toLowerCase(),
      blockNumber: Number(parseQuantity(entry.blockNumber, "log block number")),
      logIndex: Number(parseQuantity(entry.logIndex, "log index")),
    }))
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (matches.length === 0) return null;

  const { data, error } = await receiptsTable(ctx.db)
    .select("sweep_tx_hash")
    .in("sweep_tx_hash", Array.from(new Set(matches.map((match) => match.txHash))));
  if (error) {
    throw new Error(error.message || "Failed to load recorded credit-deposit sweep transfers");
  }
  const recorded = new Set(
    ((Array.isArray(data) ? data : []) as Array<{ sweep_tx_hash: string | null }>).map((row) =>
      String(row.sweep_tx_hash).toLowerCase()
    )
  );
  const match = matches.find((candidate) => !recorded.has(candidate.txHash));
  return match ? { txHash: match.txHash, blockNumber: match.blockNumber } : null;
}

/** Move a claimed receipt toward 'confirmed' (or back to 'failed') on the evidence available. */
async function settleSubmittedSweep(
  receipt: SweepReceipt,
  ctx: SweepContext
): Promise<CreditDepositSweepResult> {
  const result = (outcome: CreditDepositSweepOutcome, extra: Partial<CreditDepositSweepResult> = {}) => ({
    receiptId: receipt.id,
    userId: receipt.user_id,
    outcome,
    ...extra,
  });
  const claim = { statuses: ["submitted" as const], attempts: receipt.sweep_attempts };

  if (!receipt.sweep_transfer_requested_at) {
    const claimedAt = Date.parse(receipt.sweep_attempted_at ?? "");
    if (Number.isFinite(claimedAt) && ctx.now.getTime() - claimedAt < CLAIM_LEASE_MS) {
      return result("claimed_elsewhere");
    }
    const released = await transition(ctx.db, receipt.id, { ...claim, transferRequested: false }, {
      sweep_status: "failed",
      sweep_error: "claim abandoned before a transfer was requested; released for retry",
    });
    return result(released ? "released" : "claimed_elsewhere");
  }

  const head = await ctx.rpc.blockNumber();
  let txHash = receipt.sweep_tx_hash;
  let minedAt: number | null = null;
  let revertedTxHash: string | null = null;

  if (txHash) {
    const tx = await ctx.rpc.transactionReceipt(txHash);
    if (!tx) {
      const submittedAt = Date.parse(receipt.sweep_submitted_at ?? "");
      if (Number.isFinite(submittedAt) && ctx.now.getTime() - submittedAt > UNMINED_ALERT_MS) {
        await reportForReview(
          receipt,
          "credit_deposit_sweep_unmined",
          `Sweep tx ${txHash} is still not mined.`,
          { sweepTxHash: txHash }
        );
      }
      return result("awaiting_confirmation", { txHash });
    }
    if (tx.status === "0x1") {
      if (!(tx.logs ?? []).some((entry) => isSweepTransferLog(entry, receipt))) {
        const error = `sweep tx ${txHash} was mined without the expected USDC transfer`;
        await reportForReview(receipt, "credit_deposit_sweep_transfer_mismatch", `${error}.`, {
          sweepTxHash: txHash,
        });
        return result("in_doubt", { txHash, error });
      }
      minedAt = Number(parseQuantity(tx.blockNumber, "receipt block number"));
    } else {
      revertedTxHash = txHash;
    }
  }

  if (minedAt === null) {
    // No usable hash (never recorded, or its tx reverted): the chain decides.
    const proof = await findSweepTransfer(receipt, ctx, head);
    if (!proof) {
      if (revertedTxHash) {
        const error = `sweep tx ${revertedTxHash} reverted; nothing moved`;
        await transition(ctx.db, receipt.id, { ...claim, txHash: revertedTxHash }, {
          sweep_status: "failed",
          sweep_error: error,
        });
        return result("transfer_failed", { txHash: revertedTxHash, error });
      }
      if (head >= Number(receipt.sweep_claim_block) + EVIDENCE_WINDOW_BLOCKS) {
        await reportForReview(
          receipt,
          "credit_deposit_sweep_unresolved",
          "No sweep transfer reached the chain within the evidence window. Set the receipt's " +
            "sweep_status to 'failed' to retry it, or record the sweep tx hash if it was swept another way.",
          { claimBlock: String(receipt.sweep_claim_block) }
        );
      }
      return result("in_doubt");
    }
    const adopted = await transition(ctx.db, receipt.id, { ...claim, txHash: revertedTxHash }, {
      sweep_tx_hash: proof.txHash,
      sweep_submitted_at: receipt.sweep_submitted_at ?? ctx.nowIso,
      sweep_error: null,
    });
    if (!adopted) return result("claimed_elsewhere");
    txHash = proof.txHash;
    minedAt = proof.blockNumber;
  }

  if (head - minedAt + 1 < SWEEP_MIN_CONFIRMATIONS) {
    return result("awaiting_confirmation", { txHash });
  }
  const confirmed = await transition(ctx.db, receipt.id, { ...claim, txHash }, {
    sweep_status: "confirmed",
    sweep_confirmed_at: ctx.nowIso,
    sweep_error: null,
  });
  return result(confirmed ? "confirmed" : "claimed_elsewhere", { txHash });
}

/** Claim a pending/failed receipt and ask Bankr to sweep it. */
async function sweepReceipt(
  receipt: SweepReceipt,
  ctx: SweepContext
): Promise<CreditDepositSweepResult> {
  const result = (outcome: CreditDepositSweepOutcome, extra: Partial<CreditDepositSweepResult> = {}) => ({
    receiptId: receipt.id,
    userId: receipt.user_id,
    outcome,
    ...extra,
  });
  const unclaimed = { statuses: ["pending" as const, "failed" as const], attempts: receipt.sweep_attempts };
  const recordUnclaimed = (status: "failed" | "skipped", error: string) =>
    transition(ctx.db, receipt.id, unclaimed, {
      sweep_status: status,
      sweep_error: error,
      sweep_attempted_at: ctx.nowIso,
    });

  const treasury = getTreasuryAddress(ctx.env);
  if (!treasury) {
    const error = "HERMES_TREASURY_ADDRESS missing or invalid";
    await recordUnclaimed("failed", error);
    return result("no_treasury_configured", { error });
  }

  if (receipt.chain_id !== BASE_CHAIN_ID || receipt.token_address.toLowerCase() !== USDC_BASE_TOKEN_ADDRESS) {
    const error = "not a Base USDC receipt";
    await recordUnclaimed("skipped", error);
    await reportForReview(receipt, "credit_deposit_sweep_not_usdc", "A non-USDC receipt was queued for the USDC sweep.");
    return result("held_for_review", { error });
  }

  // The wallet that received this deposit, which must be the receipt owner's
  // credit_deposit wallet — never another user's, never a lock wallet.
  const credential = await getBankrDepositWalletCredentialForAddress({
    address: receipt.normalized_deposit_address,
    db: ctx.db,
  });
  if (!credential?.bankrWalletId) {
    const error = "no Bankr credential for the receipt's deposit address";
    await recordUnclaimed("failed", error);
    return result("no_credentials", { error });
  }
  if (credential.userId !== receipt.user_id || credential.purpose !== "credit_deposit") {
    const error =
      credential.userId !== receipt.user_id
        ? "deposit address belongs to another user's wallet"
        : `deposit address is a ${credential.purpose} wallet, not credit_deposit`;
    await recordUnclaimed("skipped", error);
    await reportForReview(receipt, "credit_deposit_sweep_wallet_mismatch", `Refused to sweep: ${error}.`);
    return result("held_for_review", { error });
  }

  let claimBlock: number;
  try {
    claimBlock = await ctx.rpc.blockNumber();
  } catch (err) {
    const error = `Base RPC unavailable: ${errorMessage(err)}`;
    await recordUnclaimed("failed", error);
    return result("transfer_failed", { error });
  }

  const attempt = receipt.sweep_attempts + 1;
  const claimed = await transition(ctx.db, receipt.id, unclaimed, {
    sweep_status: "submitted",
    sweep_attempts: attempt,
    sweep_attempted_at: ctx.nowIso,
    sweep_claim_block: claimBlock,
    sweep_destination_address: treasury,
    sweep_transfer_requested_at: null,
    sweep_submitted_at: null,
    sweep_confirmed_at: null,
    sweep_tx_hash: null,
    sweep_error: null,
  });
  if (!claimed) return result("claimed_elsewhere");

  const claim = { statuses: ["submitted" as const], attempts: attempt };
  // Nothing has been asked of Bankr yet, so every failure until the transfer
  // request provably moved nothing and releases the claim.
  const release = async (
    status: "failed" | "skipped",
    outcome: CreditDepositSweepOutcome,
    error: string
  ) => {
    await transition(ctx.db, receipt.id, { ...claim, transferRequested: false }, {
      sweep_status: status,
      sweep_error: error,
    });
    return result(outcome, { error });
  };

  const walletAddress = credential.normalizedEvmAddress;
  const amount = BigInt(receipt.amount_minor);
  let balance: bigint;
  try {
    balance = await ctx.rpc.usdcBalance(walletAddress);
  } catch (err) {
    return release("failed", "transfer_failed", `balance read failed: ${errorMessage(err)}`);
  }
  if (balance < amount) {
    // Credited funds are missing from custody. Retrying can't fix that.
    const error = `wallet holds ${balance} USDC minor units, receipt needs ${amount}`;
    await reportForReview(
      receipt,
      "credit_deposit_sweep_funds_missing",
      "The deposit wallet holds less USDC than the settled receipt; nothing was swept.",
      { balanceMinor: balance.toString() }
    );
    return release("skipped", "held_for_review", error);
  }

  try {
    const gas = await ensureWalletHasGas({ walletAddress, env: ctx.env, rpcUrl: ctx.rpcUrl });
    // "not_configured" leaves gas to Bankr's sponsorship; the transfer surfaces
    // the real error if there is none. A drained treasury hot wallet is final.
    if (gas.status === "treasury_drained") {
      return release("failed", "gas_topup_failed", `gas top-up failed: ${gas.reason || "treasury drained"}`);
    }
  } catch (err) {
    return release("failed", "gas_topup_failed", `gas top-up failed: ${errorMessage(err)}`);
  }

  let apiKey: string | null;
  try {
    apiKey = await mintScopedTransferApiKey({
      bankrWalletId: credential.bankrWalletId,
      recipientAddress: treasury,
      env: ctx.env,
    });
  } catch (err) {
    return release("failed", "no_credentials", `Bankr API key mint failed: ${errorMessage(err)}`);
  }
  if (!apiKey) {
    // mintScopedTransferApiKey returns null for partner-key-missing AND for
    // Bankr's per-wallet 20-key cap; name the one ops has to fix.
    const reason = getBankrPartnerConfig(ctx.env).partnerKey
      ? "Bankr API key mint returned null (likely per-wallet 20-key cap — revoke stale keys on Bankr)"
      : "Bankr partner key not configured (BANKR_PARTNER_KEY env var missing)";
    return release("failed", "no_credentials", reason);
  }

  // From here the attempt may move funds, so it is resolved only by evidence.
  let requested: boolean;
  try {
    requested = await transition(ctx.db, receipt.id, { ...claim, transferRequested: false }, {
      sweep_transfer_requested_at: ctx.nowIso,
    });
  } catch (err) {
    return release("failed", "error", `could not record the transfer request: ${errorMessage(err)}`);
  }
  if (!requested) return result("claimed_elsewhere");

  const amountDisplay = formatRawTokenBalance(amount, USDC_DECIMALS);
  let txHash: string | null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: USDC_BASE_TOKEN_ADDRESS,
      recipientAddress: treasury,
      amountDisplay,
      env: ctx.env,
    });
  } catch (err) {
    const error = `transfer failed: ${errorMessage(err)}`;
    if (isTransferRefusal(err)) {
      await transition(ctx.db, receipt.id, { ...claim, txHash: null }, {
        sweep_status: "failed",
        sweep_error: error,
      });
      return result("transfer_failed", { error });
    }
    await reportForReview(
      receipt,
      "credit_deposit_sweep_outcome_unknown",
      "Bankr's transfer response failed after the request, so the sweep may have moved; it will not be " +
        "re-sent, and the next runs look for the transfer on chain.",
      { error }
    );
    await transition(ctx.db, receipt.id, { ...claim, txHash: null }, {
      sweep_error: `${error} (outcome unknown; awaiting on-chain evidence)`,
    });
    return result("in_doubt", { error });
  }

  if (!txHash) {
    const error = "Bankr accepted the transfer without a tx hash; awaiting on-chain evidence";
    await reportForReview(receipt, "credit_deposit_sweep_outcome_unknown", `${error}.`);
    await transition(ctx.db, receipt.id, { ...claim, txHash: null }, { sweep_error: error });
    return result("in_doubt", { error });
  }

  const sweepTxHash = txHash.toLowerCase();
  try {
    const recorded = await transition(ctx.db, receipt.id, { ...claim, txHash: null }, {
      sweep_tx_hash: sweepTxHash,
      sweep_submitted_at: ctx.nowIso,
      sweep_error: null,
    });
    if (!recorded) throw new Error("the claim changed before the sweep tx hash was recorded");
  } catch (err) {
    // The transfer went out. The receipt stays in doubt until a later run
    // finds this tx on chain; it is never re-sent.
    log.error("credit-deposit sweep transfer sent but its tx hash was not recorded", err, {
      source: "credit-deposit-sweep",
      failureType: "credit_deposit_sweep_hash_unrecorded",
      receiptId: receipt.id,
      userId: receipt.user_id,
      sweepTxHash,
    });
    await reportForReview(
      receipt,
      "credit_deposit_sweep_hash_unrecorded",
      `Sweep tx ${sweepTxHash} was sent but not recorded; the next runs confirm it from the chain.`,
      { sweepTxHash }
    );
  }

  return result("submitted", { txHash: sweepTxHash, amountSweptDisplay: amountDisplay });
}

async function guarded(
  receipt: SweepReceipt,
  phase: "verify" | "sweep",
  run: () => Promise<CreditDepositSweepResult>
): Promise<CreditDepositSweepResult> {
  try {
    return await run();
  } catch (err) {
    log.error("credit-deposit treasury sweep failed for a receipt; continuing", err, {
      source: "credit-deposit-sweep",
      failureType: "credit_deposit_sweep_receipt_error",
      receiptId: receipt.id,
      userId: receipt.user_id,
      phase,
    });
    return { receiptId: receipt.id, userId: receipt.user_id, outcome: "error", error: errorMessage(err) };
  }
}

async function loadReceipts(ctx: SweepContext, statuses: SweepStatus[], limit: number) {
  let query = receiptsTable(ctx.db).select(RECEIPT_COLUMNS).in("sweep_status", statuses);
  query =
    statuses.includes("submitted")
      ? query.order("sweep_attempted_at", { ascending: true })
      : query
          .eq("status", "settled")
          // Belt-and-braces with the enqueue trigger: only payment-flow
          // deposits are revenue; lock deposits must never be swept.
          .in("deposit_mode", SWEEPABLE_DEPOSIT_MODES)
          .order("settled_at", { ascending: true });
  const { data, error } = await query.limit(limit);
  if (error) {
    throw new Error(error.message || "Failed to load credit-deposit sweeps");
  }
  return (Array.isArray(data) ? data : []) as SweepReceipt[];
}

/**
 * One sweep pass, run by the reconcile-crypto-topups cron after
 * reconciliation: first settle attempts already claimed (confirm, release or
 * resolve from chain evidence), then claim and sweep pending/failed receipts.
 */
export async function sweepPendingCreditDepositReceipts(
  options: SweepOptions & { limit?: number } = {}
): Promise<{
  checked: number;
  swept: number;
  confirmed: number;
  awaitingConfirmation: number;
  inDoubt: number;
  failed: number;
  skipped: number;
  noTreasury: number;
  results: CreditDepositSweepResult[];
}> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const env = options.env ?? process.env;
  const rpcUrl = options.rpcUrl || getBaseRpcUrl(env);
  const now = options.now ?? new Date();
  const ctx: SweepContext = {
    db: requireDb(supabaseAdmin as SupabaseLike | null),
    now,
    nowIso: now.toISOString(),
    env,
    rpcUrl,
    rpc: createBaseRpc(rpcUrl, options.fetchImpl ?? ((input, init) => fetch(input, init))),
  };

  const results: CreditDepositSweepResult[] = [];
  for (const receipt of await loadReceipts(ctx, ["submitted"], limit)) {
    results.push(await guarded(receipt, "verify", () => settleSubmittedSweep(receipt, ctx)));
  }
  for (const receipt of await loadReceipts(ctx, ["pending", "failed"], limit)) {
    results.push(await guarded(receipt, "sweep", () => sweepReceipt(receipt, ctx)));
  }

  const count = (...outcomes: CreditDepositSweepOutcome[]) =>
    results.filter((entry) => outcomes.includes(entry.outcome)).length;
  return {
    checked: results.length,
    swept: count("submitted"),
    confirmed: count("confirmed"),
    awaitingConfirmation: count("awaiting_confirmation"),
    inDoubt: count("in_doubt"),
    failed: count("released", "no_credentials", "gas_topup_failed", "transfer_failed", "error"),
    skipped: count("held_for_review"),
    noTreasury: count("no_treasury_configured"),
    results,
  };
}
