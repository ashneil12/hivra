import { supabaseAdmin } from "@/lib/supabase";
import {
  decryptInstanceBankrApiKey,
  getBankrWalletForInstance,
  getBankrWalletForOwner,
  instanceBankrWalletPublicSummary,
  setWithdrawalDestinationForOwner,
  upsertWithdrawalRecipient,
  type BankrWalletOwner,
  type InstanceBankrWalletPublicSummary,
  type InstanceBankrWalletRecord,
  type SupabaseLike,
} from "@/lib/billing/bankr-instance-wallets";
import {
  BASE_CHAIN_ID,
  fetchTokenBalance,
  fetchHermesTokenBalance,
  formatRawTokenBalance,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  normalizeEvmAddress,
  parseTokenAmountToRaw,
} from "@/lib/billing/token-holdings";
import { submitBankrTransfer } from "@/lib/billing/bankr-withdraw";
import { log } from "@/lib/logger";

type JsonRpcFetch = typeof fetch;

type QueryError = { code?: string; message?: string; details?: string; hint?: string } | null;

export type InstanceBankrWithdrawAsset = "HERMESOS" | "ETH";

const BASE_ETH_DECIMALS = 18;
const BANKR_NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const MAX_TOKEN_DECIMALS = 36;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

type ClaimTable = {
  insert: (...args: unknown[]) => {
    select: (...args: unknown[]) => {
      single: () => Promise<{ data: unknown; error: QueryError }>;
    };
  };
  update: (...args: unknown[]) => {
    eq: (...args: unknown[]) => Promise<{ error: QueryError }>;
  };
};

export interface InstanceBankrWithdrawResult {
  status:
    | "submitted"
    | "invalid_token"
    | "invalid_amount"
    | "insufficient_balance"
    | "no_wallet"
    | "no_balance"
    | "no_withdrawal_destination"
    | "not_configured"
    | "transfer_failed"
    | "already_in_flight";
  txHash?: string | null;
  amountRaw?: string;
  amountDisplay?: string;
  recipientAddress?: string;
  wallet?: InstanceBankrWalletPublicSummary | null;
  errorMessage?: string;
}

export interface BaseWithdrawalToken {
  symbol: string;
  tokenAddress: string | null;
  decimals: number;
}

function claimTable(db: SupabaseLike): ClaimTable {
  return db.from("bankr_withdrawals") as ClaimTable;
}

function withdrawalClaimPayload(
  params: {
    userId: string;
    amountRaw: string;
    recipient: string;
    chain: "base";
    tokenSymbol: string;
    tokenAddress: string | null;
    tokenDecimals: number;
  },
  includeTokenMetadata: boolean
) {
  return {
    user_id: params.userId,
    status: "in_flight",
    amount_raw: params.amountRaw,
    recipient: params.recipient,
    ...(includeTokenMetadata
      ? {
          chain: params.chain,
          token_symbol: params.tokenSymbol,
          token_address: params.tokenAddress,
          token_decimals: params.tokenDecimals,
        }
      : {}),
  };
}

function isWithdrawalClaimTokenSchemaDrift(error: QueryError): boolean {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return (
    text.includes("bankr_withdrawals") &&
    text.includes("schema cache") &&
    ["chain", "token_symbol", "token_address", "token_decimals"].some((column) => text.includes(column))
  );
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
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
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
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

function decodeBaseEthBalanceResult(result: unknown) {
  if (typeof result !== "string" || !/^0x[a-fA-F0-9]+$/.test(result)) {
    throw new Error("Invalid Base ETH balance RPC result");
  }

  return BigInt(result).toString();
}

async function fetchBaseEthBalance(params: {
  walletAddress: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
}) {
  const normalizedAddress = normalizeEvmAddress(params.walletAddress);
  const rpcUrl = params.rpcUrl || getBaseRpcUrl(params.env);
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const balanceRaw = decodeBaseEthBalanceResult(
    await rpcCall<string>(rpcUrl, "eth_getBalance", [normalizedAddress, "latest"], fetchImpl)
  );

  return {
    balanceRaw,
    balanceDisplay: formatRawTokenBalance(balanceRaw, BASE_ETH_DECIMALS),
  };
}

async function createWithdrawalClaim(params: {
  userId: string;
  amountRaw: string;
  recipient: string;
  chain: "base";
  tokenSymbol: string;
  tokenAddress: string | null;
  tokenDecimals: number;
  db: SupabaseLike | null | undefined;
}): Promise<{ claimId: string | null; result?: InstanceBankrWithdrawResult }> {
  // Fail closed if there's no DB client. The `bankr_withdrawals` in-flight
  // claim row is the only cross-process double-withdraw guard (the in-memory
  // lock in the route is per-container and useless across serverless
  // instances). Returning `{ claimId: null }` here would let the caller fall
  // through to submitBankrTransfer with NO lock — refuse instead, mirroring
  // the user-wallet withdraw path (bankr-withdraw.ts).
  if (!params.db) {
    return {
      claimId: null,
      result: {
        status: "transfer_failed",
        errorMessage:
          "Agent wallet withdraw is temporarily unavailable (database not configured).",
      },
    };
  }

  const { data, error } = await claimTable(params.db)
    .insert(withdrawalClaimPayload(params, true))
    .select("id")
    .single();

  if (!error) {
    return { claimId: typeof (data as { id?: unknown } | null)?.id === "string" ? (data as { id: string }).id : null };
  }

  if (isWithdrawalClaimTokenSchemaDrift(error)) {
    log.warn("withdrawal claim schema cache missing token columns; retrying legacy claim insert", {
      source: "agent-wallet-withdraw",
      failureType: "agent_wallet_withdraw_claim_schema_drift",
      userId: params.userId,
      tokenSymbol: params.tokenSymbol,
      missingColumnError: error.message ?? null,
    });

    const legacy = await claimTable(params.db)
      .insert(withdrawalClaimPayload(params, false))
      .select("id")
      .single();

    if (!legacy.error) {
      return {
        claimId: typeof (legacy.data as { id?: unknown } | null)?.id === "string"
          ? (legacy.data as { id: string }).id
          : null,
      };
    }

    if (legacy.error.code === "23505") {
      return {
        claimId: null,
        result: {
          status: "already_in_flight",
          errorMessage: "A withdraw is already in flight for this account. Wait for it to settle before retrying.",
        },
      };
    }

    return {
      claimId: null,
      result: {
        status: "transfer_failed",
        errorMessage: `Failed to record withdrawal claim: ${legacy.error.message ?? "unknown error"}`,
      },
    };
  }

  if (error.code === "23505") {
    return {
      claimId: null,
      result: {
        status: "already_in_flight",
        errorMessage: "A withdraw is already in flight for this account. Wait for it to settle before retrying.",
      },
    };
  }

  return {
    claimId: null,
    result: {
      status: "transfer_failed",
      errorMessage: `Failed to record withdrawal claim: ${error.message ?? "unknown error"}`,
    },
  };
}

async function finalizeWithdrawalClaim(params: {
  claimId: string | null;
  db: SupabaseLike | null | undefined;
  status: "submitted" | "failed" | "cancelled";
  txHash?: string | null;
  errorMessage?: string | null;
}) {
  if (!params.db || !params.claimId) return;

  const { error } = await claimTable(params.db)
    .update({
      status: params.status,
      tx_hash: params.txHash ?? null,
      error_message: params.errorMessage ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.claimId);

  if (error) {
    // This update is the ONLY thing that frees the durable per-user in_flight
    // lock (partial unique index uq_bankr_withdrawals_one_in_flight_per_user).
    // supabase-js resolves (does not throw) on a query error, so a failed
    // release was previously swallowed — silently wedging the user's withdraw
    // lock forever (every later attempt 409s "already in progress"). Surface
    // it loudly so ops can clear the stale claim. Do NOT throw: on the
    // 'submitted' path the on-chain transfer already succeeded, and throwing
    // would turn a completed withdrawal into a 500 (prompting a retry that
    // then 409s). A TTL/on-chain reconciler to auto-clear stale in_flight rows
    // is the recommended follow-up.
    log.error(
      "withdrawal claim release failed; in_flight lock may be stuck",
      error,
      {
        source: "bankr-instance-withdraw",
        failureType: "withdrawal_claim_release_failed",
        claimId: params.claimId,
        finalStatus: params.status,
        txHash: params.txHash ?? null,
      }
    );
  }
}

type WithdrawForInstanceParams = {
  instanceId: string;
  userId: string;
  expectedRecipient?: string;
  amountDisplay: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  db?: SupabaseLike | null;
};

interface WithdrawAssetConfig {
  displayName: string;
  decimals: number;
  bankrTokenAddress: string;
  isNativeToken: boolean;
  readBalance: (params: {
    walletAddress: string;
    rpcUrl?: string;
    fetchImpl?: JsonRpcFetch;
    env?: Record<string, string | undefined>;
  }) => Promise<{ balanceRaw: string; balanceDisplay: string }>;
}

const WITHDRAW_ASSETS: Record<InstanceBankrWithdrawAsset, WithdrawAssetConfig> = {
  HERMESOS: {
    displayName: "HERMESOS",
    decimals: HERMESOS_TOKEN_DECIMALS,
    bankrTokenAddress: HERMESOS_TOKEN_ADDRESS,
    isNativeToken: false,
    readBalance: fetchHermesTokenBalance,
  },
  ETH: {
    displayName: "Base ETH",
    decimals: BASE_ETH_DECIMALS,
    bankrTokenAddress: BANKR_NATIVE_TOKEN_ADDRESS,
    isNativeToken: true,
    readBalance: fetchBaseEthBalance,
  },
};

function normalizeWithdrawalToken(token: BaseWithdrawalToken): BaseWithdrawalToken & {
  bankrTokenAddress: string;
  isNativeToken: boolean;
} {
  const symbol = token.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9._-]{1,24}$/.test(symbol)) {
    throw new Error("Invalid Base token symbol");
  }
  if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > MAX_TOKEN_DECIMALS) {
    throw new Error("Invalid Base token decimals");
  }

  const rawTokenAddress = token.tokenAddress?.trim() || null;
  const normalizedTokenAddress = rawTokenAddress ? normalizeEvmAddress(rawTokenAddress) : null;
  const isNativeToken =
    !normalizedTokenAddress ||
    normalizedTokenAddress === BANKR_NATIVE_TOKEN_ADDRESS;

  if (isNativeToken) {
    if (symbol !== "ETH") {
      throw new Error("Native Base withdrawals must use ETH as the token symbol");
    }
    return {
      symbol: "ETH",
      tokenAddress: null,
      decimals: BASE_ETH_DECIMALS,
      bankrTokenAddress: BANKR_NATIVE_TOKEN_ADDRESS,
      isNativeToken: true,
    };
  }

  return {
    symbol,
    tokenAddress: normalizedTokenAddress,
    decimals: token.decimals,
    bankrTokenAddress: normalizedTokenAddress,
    isNativeToken: false,
  };
}

async function readBaseTokenBalance(params: {
  walletAddress: string;
  token: BaseWithdrawalToken & { isNativeToken: boolean };
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
}) {
  if (params.token.isNativeToken) {
    return fetchBaseEthBalance({
      walletAddress: params.walletAddress,
      rpcUrl: params.rpcUrl,
      fetchImpl: params.fetchImpl,
      env: params.env,
    });
  }

  if (!params.token.tokenAddress) {
    throw new Error("ERC-20 withdrawals require a token address");
  }

  return fetchTokenBalance({
    walletAddress: params.walletAddress,
    token: {
      chainId: BASE_CHAIN_ID,
      tokenAddress: params.token.tokenAddress,
      tokenSymbol: params.token.symbol,
      tokenDecimals: params.token.decimals,
    },
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
  });
}

// ────────────────────────────────────────────────────────────────────
// Shared withdraw cores
//
// The Hermes-instance lane and the owner-agnostic Hivra lane run the EXACT
// same claim→transfer→finalize sequence. Only two things vary: which wallet
// resolver loads the record (instance_id vs owner) and, for token
// withdrawals, how the destination is persisted afterwards. Everything else
// — the expected-recipient confirmation, amount parsing, live balance read,
// the fail-closed in-flight claim, the transfer, the finalize, and the status
// results — lives in these cores so a money-path fix can never land in one
// lane and miss the other.
//
// MONEY-SAFETY: wallet resolution stays strictly per-lane. The Hivra lane
// passes a `loadRecord` bound to `getBankrWalletForOwner` — NEVER the
// instance-locked helper, which would drain the wrong wallet. The per-user
// in-flight claim (`uq_bankr_withdrawals_one_in_flight_per_user`) is shared
// across both lanes, so a Hivra withdraw correctly 409s against a concurrent
// Hermes withdraw for the same user.

type WithdrawCoreParams = {
  userId: string;
  amountDisplay: string;
  expectedRecipient?: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  db?: SupabaseLike | null;
};

/** Per-lane wallet resolver, bound to the instance OR owner lookup. */
type LoadWalletRecord = (
  db: SupabaseLike | null | undefined
) => Promise<InstanceBankrWalletRecord | null>;

async function withdrawAssetCore(
  params: WithdrawCoreParams & {
    asset: InstanceBankrWithdrawAsset;
    loadRecord: LoadWalletRecord;
  }
): Promise<InstanceBankrWithdrawResult> {
  const asset = WITHDRAW_ASSETS[params.asset];
  const db = params.db ?? supabaseAdmin;
  const record = await params.loadRecord(db);

  if (!record || record.userId !== params.userId || record.status !== "active") {
    return { status: "no_wallet" };
  }

  if (!record.withdrawalDestinationEvm) {
    return { status: "no_withdrawal_destination" };
  }

  const recipient = normalizeEvmAddress(record.withdrawalDestinationEvm);
  if (params.expectedRecipient) {
    let expected: string;
    try {
      expected = normalizeEvmAddress(params.expectedRecipient);
    } catch {
      return {
        status: "no_withdrawal_destination",
        errorMessage: "Confirmation address is not a valid EVM address. Refresh the page and try again.",
      };
    }
    if (expected !== recipient) {
      return {
        status: "no_withdrawal_destination",
        errorMessage: "Confirmation address does not match the saved withdrawal destination. Refresh the page and try again.",
      };
    }
  }

  const requestedAmountInput = params.amountDisplay.trim().replace(/,/g, "");
  let requestedAmountRaw: bigint;
  try {
    requestedAmountRaw = parseTokenAmountToRaw(requestedAmountInput, asset.decimals);
  } catch {
    return {
      status: "invalid_amount",
      errorMessage: `Enter a valid ${asset.displayName} amount to withdraw.`,
    };
  }

  if (requestedAmountRaw <= 0n) {
    return {
      status: "invalid_amount",
      errorMessage: "Withdrawal amount must be greater than zero.",
    };
  }

  const apiKey = await decryptInstanceBankrApiKey(record);
  if (!apiKey) {
    return {
      status: "not_configured",
      errorMessage: "Agent wallet API key is missing or inactive.",
    };
  }

  const balance = await asset.readBalance({
    walletAddress: record.evmAddress,
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
  });
  const liveBalanceRaw = BigInt(balance.balanceRaw);
  if (liveBalanceRaw === 0n) {
    return { status: "no_balance" };
  }
  const amountRaw = requestedAmountRaw.toString();
  const amountDisplay = formatRawTokenBalance(requestedAmountRaw, asset.decimals);
  // Bankr gas sponsorship covers Base transfer fees for these provisioned
  // wallets, so native ETH withdrawals are limited by transfer value only.
  if (requestedAmountRaw > liveBalanceRaw) {
    return {
      status: "insufficient_balance",
      errorMessage: `Requested withdrawal amount exceeds the live ${asset.displayName} balance (${balance.balanceDisplay}).`,
      amountRaw,
      amountDisplay,
      recipientAddress: recipient,
    };
  }
  const claim = await createWithdrawalClaim({
    userId: params.userId,
    amountRaw,
    recipient,
    chain: "base",
    tokenSymbol: params.asset,
    tokenAddress: asset.isNativeToken ? null : asset.bankrTokenAddress,
    tokenDecimals: asset.decimals,
    db,
  });
  if (claim.result) return claim.result;

  let txHash: string | null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: asset.bankrTokenAddress,
      recipientAddress: recipient,
      amountDisplay,
      ...(asset.isNativeToken ? { isNativeToken: true } : {}),
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await finalizeWithdrawalClaim({
      claimId: claim.claimId,
      db,
      status: "failed",
      errorMessage,
    });
    return {
      status: "transfer_failed",
      errorMessage,
      amountRaw,
      amountDisplay,
      recipientAddress: recipient,
    };
  }

  await finalizeWithdrawalClaim({
    claimId: claim.claimId,
    db,
    status: "submitted",
    txHash,
  });

  return {
    status: "submitted",
    txHash,
    amountRaw,
    amountDisplay,
    recipientAddress: recipient,
    wallet: instanceBankrWalletPublicSummary(record),
  };
}

async function withdrawBaseTokenCore(
  params: WithdrawCoreParams & {
    recipientAddress: string | undefined;
    token: BaseWithdrawalToken;
    setPrimaryRecipient?: boolean;
    loadRecord: LoadWalletRecord;
    /** Persist the withdrawal destination. Owner lane makes this a no-op
     *  unless `shouldSetPrimary` (it writes the wallet row directly); the
     *  instance lane always records recipient history. */
    persistDestination: (args: {
      recipient: string;
      shouldSetPrimary: boolean;
      db: SupabaseLike | null | undefined;
    }) => Promise<void>;
    persistenceWarning: string;
    persistenceFailureType: string;
    persistenceLogContext?: Record<string, unknown>;
  }
): Promise<InstanceBankrWithdrawResult> {
  let token: ReturnType<typeof normalizeWithdrawalToken>;
  let recipient: string;
  try {
    token = normalizeWithdrawalToken(params.token);
    recipient = normalizeEvmAddress(params.recipientAddress ?? "");
  } catch (err) {
    return {
      status: "invalid_token",
      errorMessage: err instanceof Error ? err.message : "Invalid Base withdrawal token or recipient.",
    };
  }

  const db = params.db ?? supabaseAdmin;
  const record = await params.loadRecord(db);

  if (!record || record.userId !== params.userId || record.status !== "active") {
    return { status: "no_wallet" };
  }

  const requestedAmountInput = params.amountDisplay.trim().replace(/,/g, "");
  let requestedAmountRaw: bigint;
  try {
    requestedAmountRaw = parseTokenAmountToRaw(requestedAmountInput, token.decimals);
  } catch {
    return {
      status: "invalid_amount",
      errorMessage: `Enter a valid ${token.symbol} amount to withdraw.`,
    };
  }

  if (requestedAmountRaw <= 0n) {
    return {
      status: "invalid_amount",
      errorMessage: "Withdrawal amount must be greater than zero.",
    };
  }

  const apiKey = await decryptInstanceBankrApiKey(record);
  if (!apiKey) {
    return {
      status: "not_configured",
      errorMessage: "Agent wallet API key is missing or inactive.",
    };
  }

  const balance = await readBaseTokenBalance({
    walletAddress: record.evmAddress,
    token,
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
  });
  const liveBalanceRaw = BigInt(balance.balanceRaw);
  if (liveBalanceRaw === 0n) {
    return { status: "no_balance" };
  }

  const amountRaw = requestedAmountRaw.toString();
  const amountDisplay = formatRawTokenBalance(requestedAmountRaw, token.decimals);
  // Bankr gas sponsorship covers Base transfer fees for these provisioned
  // wallets, so native ETH withdrawals are limited by transfer value only.
  if (requestedAmountRaw > liveBalanceRaw) {
    return {
      status: "insufficient_balance",
      errorMessage: `Requested withdrawal amount exceeds the live Base ${token.symbol} balance (${balance.balanceDisplay}).`,
      amountRaw,
      amountDisplay,
      recipientAddress: recipient,
    };
  }
  const claim = await createWithdrawalClaim({
    userId: params.userId,
    amountRaw,
    recipient,
    chain: "base",
    tokenSymbol: token.symbol,
    tokenAddress: token.tokenAddress,
    tokenDecimals: token.decimals,
    db,
  });
  if (claim.result) return claim.result;

  let txHash: string | null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: token.bankrTokenAddress,
      recipientAddress: recipient,
      amountDisplay,
      ...(token.isNativeToken ? { isNativeToken: true } : {}),
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await finalizeWithdrawalClaim({
      claimId: claim.claimId,
      db,
      status: "failed",
      errorMessage,
    });
    return {
      status: "transfer_failed",
      errorMessage,
      amountRaw,
      amountDisplay,
      recipientAddress: recipient,
    };
  }

  await finalizeWithdrawalClaim({
    claimId: claim.claimId,
    db,
    status: "submitted",
    txHash,
  });

  let wallet = instanceBankrWalletPublicSummary(record);
  try {
    const shouldSetPrimary = params.setPrimaryRecipient === true || !record.withdrawalDestinationEvm;
    await params.persistDestination({ recipient, shouldSetPrimary, db });
    if (shouldSetPrimary) {
      const updatedRecord = await params.loadRecord(db);
      wallet = instanceBankrWalletPublicSummary(updatedRecord ?? record);
    }
  } catch (err) {
    log.warn(params.persistenceWarning, {
      source: "agent-wallet-withdraw",
      ...(params.persistenceLogContext || {}),
      userId: params.userId,
      failureType: params.persistenceFailureType,
      tokenSymbol: token.symbol,
      tokenAddress: token.tokenAddress,
      recipientAddress: recipient,
      errorName: err instanceof Error ? err.name : null,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    status: "submitted",
    txHash,
    amountRaw,
    amountDisplay,
    recipientAddress: recipient,
    wallet,
  };
}

// ────────────────────────────────────────────────────────────────────
// Instance-lane wrappers (Hermes instances)
// ────────────────────────────────────────────────────────────────────

export async function withdrawBaseTokenForInstance(params: {
  instanceId: string;
  userId: string;
  recipientAddress: string;
  amountDisplay: string;
  token: BaseWithdrawalToken;
  setPrimaryRecipient?: boolean;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWithdrawResult> {
  return withdrawBaseTokenCore({
    userId: params.userId,
    amountDisplay: params.amountDisplay,
    recipientAddress: params.recipientAddress,
    token: params.token,
    setPrimaryRecipient: params.setPrimaryRecipient,
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
    db: params.db,
    loadRecord: (db) => getBankrWalletForInstance({ instanceId: params.instanceId, db }),
    persistDestination: async ({ recipient, shouldSetPrimary, db }) => {
      // The instance lane ALWAYS records recipient history, even when the
      // withdraw did not flip the saved destination.
      await upsertWithdrawalRecipient({
        instanceId: params.instanceId,
        userId: params.userId,
        address: recipient,
        setPrimary: shouldSetPrimary,
        db,
      });
    },
    persistenceWarning: "agent wallet withdrawal submitted but recipient history update failed",
    persistenceFailureType: "agent_wallet_withdraw_recipient_history_failed",
    persistenceLogContext: { instanceId: params.instanceId },
  });
}

// ────────────────────────────────────────────────────────────────────
// Owner-agnostic lane (Hermes instance OR Hivra-catalog box).
//
// MONEY-SAFETY: this path resolves the wallet via `getBankrWalletForOwner`
// (NOT `getBankrWalletForInstance`). Using the instance-locked resolver for a
// Hivra agent would drain the WRONG wallet. The instance wrappers above and
// these owner wrappers share the same cores; the ONLY behavioural differences
// are (1) wallet resolution is owner-keyed, and (2) post-transfer destination
// persistence goes to the owner-agnostic
// `instance_bankr_wallets.withdrawal_destination_evm` column via
// `setWithdrawalDestinationForOwner` instead of the instance-only
// `instance_bankr_wallet_recipients` table (whose FK would reject a Hivra box).

type WithdrawForOwnerParams = {
  owner: BankrWalletOwner;
  userId: string;
  /** Optional client echo of the saved destination, checked before transfer. */
  expectedRecipient?: string;
  /** Required when `token` is supplied; the explicit Base recipient. */
  recipientAddress?: string;
  amountDisplay: string;
  /** Convenience asset selector (HERMESOS / ETH) when no explicit token. */
  asset?: InstanceBankrWithdrawAsset;
  /** Explicit Base token (symbol + address + decimals) for arbitrary ERC-20s. */
  token?: BaseWithdrawalToken;
  /** Persist `recipientAddress` as the saved destination (token shape only). */
  setPrimaryRecipient?: boolean;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  db?: SupabaseLike | null;
};

/**
 * Owner-agnostic withdraw entrypoint. Routes to the explicit-token core when a
 * `token` is supplied (arbitrary Base ERC-20 / native ETH to a caller-supplied
 * recipient), otherwise to the asset core (HERMESOS / ETH to the saved
 * destination). Behaviourally identical to the instance withdraw route's two
 * branches, but wallet resolution + destination persistence are owner-keyed.
 */
export async function withdrawForOwner(
  params: WithdrawForOwnerParams
): Promise<InstanceBankrWithdrawResult> {
  const loadRecord: LoadWalletRecord = (db) =>
    getBankrWalletForOwner({ owner: params.owner, db });

  if (params.token) {
    return withdrawBaseTokenCore({
      userId: params.userId,
      amountDisplay: params.amountDisplay,
      recipientAddress: params.recipientAddress,
      token: params.token,
      setPrimaryRecipient: params.setPrimaryRecipient,
      rpcUrl: params.rpcUrl,
      fetchImpl: params.fetchImpl,
      env: params.env,
      db: params.db,
      loadRecord,
      persistDestination: async ({ recipient, shouldSetPrimary, db }) => {
        // Owner-agnostic destination persistence. Hivra boxes CANNOT use the
        // instance-only `instance_bankr_wallet_recipients` table (FK to
        // hermes_instances), so persist straight onto the wallet row — and
        // only when the caller asked for a new primary destination.
        if (!shouldSetPrimary) return;
        await setWithdrawalDestinationForOwner({
          owner: params.owner,
          userId: params.userId,
          destinationEvm: recipient,
          db,
        });
      },
      persistenceWarning: "agent wallet withdrawal submitted but destination persistence failed",
      persistenceFailureType: "agent_wallet_withdraw_destination_persist_failed",
    });
  }

  return withdrawAssetCore({
    userId: params.userId,
    amountDisplay: params.amountDisplay,
    expectedRecipient: params.expectedRecipient,
    asset: params.asset ?? "HERMESOS",
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
    db: params.db,
    loadRecord,
  });
}

export async function withdrawHermesTokensForInstance(
  params: WithdrawForInstanceParams
): Promise<InstanceBankrWithdrawResult> {
  return withdrawAssetCore({
    userId: params.userId,
    amountDisplay: params.amountDisplay,
    expectedRecipient: params.expectedRecipient,
    asset: "HERMESOS",
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
    db: params.db,
    loadRecord: (db) => getBankrWalletForInstance({ instanceId: params.instanceId, db }),
  });
}

export async function withdrawBaseEthForInstance(
  params: WithdrawForInstanceParams
): Promise<InstanceBankrWithdrawResult> {
  return withdrawAssetCore({
    userId: params.userId,
    amountDisplay: params.amountDisplay,
    expectedRecipient: params.expectedRecipient,
    asset: "ETH",
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
    db: params.db,
    loadRecord: (db) => getBankrWalletForInstance({ instanceId: params.instanceId, db }),
  });
}
