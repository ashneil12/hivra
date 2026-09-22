import { supabaseAdmin } from "@/lib/supabase";
import { metadataRecord, requireDb } from "@/lib/billing/db-utils";
import { BASE_CHAIN_ID, normalizeEvmAddress } from "@/lib/billing/token-holdings";
import {
  CRYPTO_TOPUP_ASSETS,
  USDC_BASE_TOKEN_ADDRESS,
  settleCryptoTopUpIntent,
} from "@/lib/billing/crypto-topups";
import { getLogsInBlockChunks, type BaseRpcCall } from "@/lib/billing/base-rpc-logs";
import {
  normalizeRpcRetryConfig,
  RpcHttpError,
  withRpcRetry,
  type RpcCallOptions,
  type RpcRetryConfig,
} from "@/lib/billing/base-rpc-retry";

type QueryError = { code?: string; message?: string } | null;

type DbSelectFilter = {
  select: (...args: unknown[]) => DbSelectFilter;
  eq: (...args: unknown[]) => DbSelectFilter;
  order: (...args: unknown[]) => DbSelectFilter;
  limit: (...args: unknown[]) => Promise<{ data: unknown; error: QueryError }>;
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbSelectFilter;
  upsert: (...args: unknown[]) => Promise<{ error: QueryError }>;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

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
  error?: {
    code?: number;
    message?: string;
  };
}

interface EvmLog {
  address?: string;
  topics?: unknown[];
  data?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
  blockNumber?: unknown;
  blockHash?: unknown;
}

interface PendingCryptoTopUpRow {
  id: string;
  user_id: string;
  provider: "bankr";
  provider_reference_id: string;
  status: "pending" | "succeeded" | "failed" | "refunded";
  asset: string;
  amount_minor: number;
  package_credits: number | null;
  metadata: unknown;
  created_at?: string;
}

interface PendingCryptoTopUp {
  id: string;
  userId: string;
  referenceId: string;
  amountMinor: number;
  depositAddress: string;
}

type SettleCryptoTopUp = typeof settleCryptoTopUpIntent;

export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const DEFAULT_LOOKBACK_BLOCKS = 5_000;
const MAX_LOOKBACK_BLOCKS = 50_000;
const DEFAULT_MIN_CONFIRMATIONS = 3;

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

function normalizeLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(100, Math.floor(limit ?? 50)));
}

function normalizeLookbackBlocks(lookbackBlocks: number | undefined) {
  if (!Number.isFinite(lookbackBlocks)) return DEFAULT_LOOKBACK_BLOCKS;
  return Math.max(1, Math.min(MAX_LOOKBACK_BLOCKS, Math.floor(lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS)));
}

function normalizeMinConfirmations(confirmations: number | undefined) {
  if (!Number.isFinite(confirmations)) return DEFAULT_MIN_CONFIRMATIONS;
  return Math.max(1, Math.min(100, Math.floor(confirmations ?? DEFAULT_MIN_CONFIRMATIONS)));
}

function parseRpcQuantity(value: unknown, label: string) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]+$/.test(value)) {
    throw new Error(`Invalid ${label} RPC quantity`);
  }

  const parsed = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} RPC quantity`);
  }

  return parsed;
}

function decodeUint256LogData(data: unknown) {
  if (typeof data !== "string" || !/^0x[a-fA-F0-9]+$/.test(data)) {
    throw new Error("Invalid ERC-20 transfer amount data");
  }

  return BigInt(data);
}

async function rpcCallOnce<T>(
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
    // Typed so the shared retry layer retries 429/5xx and fails fast on the
    // rest (e.g. the public endpoint's 413 for an over-wide log range).
    throw new RpcHttpError(response.status);
  }

  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    throw new Error(payload.error.message || "Base RPC returned an error");
  }

  return payload.result as T;
}

function createRpcCall(params: {
  rpcUrl: string;
  fetchImpl: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}): BaseRpcCall {
  return <T>(method: string, args: unknown[]) =>
    withRpcRetry<T>(
      () => rpcCallOnce<T>(params.rpcUrl, method, args, params.fetchImpl),
      params.rpcOptions
    );
}

export function encodeErc20TransferToTopic(walletAddress: string) {
  const normalized = normalizeEvmAddress(walletAddress);
  return `0x${normalized.slice(2).padStart(64, "0")}`;
}

async function getLatestBaseBlockNumber(call: BaseRpcCall) {
  const latestBlockHex = await call<string>("eth_blockNumber", []);
  return parseRpcQuantity(latestBlockHex, "block number");
}

async function fetchUsdcTransfersToAddress(params: {
  depositAddress: string;
  call: BaseRpcCall;
  lookbackBlocks: number;
}) {
  const latestBlock = await getLatestBaseBlockNumber(params.call);
  const fromBlock = Math.max(0, latestBlock - params.lookbackBlocks + 1);
  const logs = await getLogsInBlockChunks<EvmLog>({
    call: params.call,
    filter: {
      address: USDC_BASE_TOKEN_ADDRESS,
      topics: [
        ERC20_TRANSFER_TOPIC,
        null,
        encodeErc20TransferToTopic(params.depositAddress),
      ],
    },
    fromBlock,
    toBlock: latestBlock,
  });

  return {
    latestBlock,
    logs,
  };
}

function parsePendingPayment(row: PendingCryptoTopUpRow): PendingCryptoTopUp | null {
  if (row.provider !== "bankr" || row.status !== "pending" || row.asset !== CRYPTO_TOPUP_ASSETS.usdc_base.key) {
    return null;
  }

  if (!row.id || !row.user_id?.trim() || !row.provider_reference_id?.trim()) {
    return null;
  }

  if (!Number.isInteger(row.amount_minor) || row.amount_minor <= 0) {
    return null;
  }

  const metadata = metadataRecord(row.metadata);
  const depositAddress = typeof metadata.depositAddress === "string" ? metadata.depositAddress : "";
  if (!depositAddress) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    referenceId: row.provider_reference_id,
    amountMinor: row.amount_minor,
    depositAddress: normalizeEvmAddress(depositAddress),
  };
}

function findMatchingTransfer(params: {
  logs: EvmLog[];
  latestBlock: number;
  amountMinor: number;
}) {
  const requiredAmount = BigInt(params.amountMinor);
  // Per-log try/catch: a single malformed entry from the RPC (rare but
  // happens with eth_getLogs via flaky proxies — null blockNumber on a
  // reorg'd log, etc.) used to throw out of the whole map() and stall
  // reconciliation for the entire user. Now we drop the bad log and
  // keep evaluating the rest. If the bug persists, the user simply
  // doesn't get auto-credited on this tick; the next tick re-fetches.
  const matches: Array<{
    amount: bigint;
    blockNumber: number;
    logIndex: number;
    confirmations: number;
    transactionHash: string;
    blockHash: string | null;
  }> = [];
  for (const log of params.logs) {
    try {
      const amount = decodeUint256LogData(log.data);
      const blockNumber = parseRpcQuantity(log.blockNumber, "log block number");
      const logIndex = parseRpcQuantity(log.logIndex, "log index");
      const confirmations = Math.max(0, params.latestBlock - blockNumber + 1);
      const transactionHash = typeof log.transactionHash === "string" ? log.transactionHash : "";
      if (amount === requiredAmount && transactionHash) {
        matches.push({
          amount,
          blockNumber,
          logIndex,
          confirmations,
          transactionHash,
          blockHash: typeof log.blockHash === "string" ? log.blockHash : null,
        });
      }
    } catch {
      // Best-effort: a malformed log doesn't block reconciliation.
      // Intentionally not logging the bad log payload — it can carry
      // RPC-internal data we'd rather not echo into ops_events.
      continue;
    }
  }

  return matches.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });
}

async function listPendingCryptoTopUps(params: {
  db: SupabaseLike;
  limit: number;
}) {
  const { data, error } = await table(params.db, "payment_transactions")
    .select("id, user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata, created_at")
    .eq("provider", "bankr")
    .eq("status", "pending")
    .eq("asset", CRYPTO_TOPUP_ASSETS.usdc_base.key)
    .order("created_at", { ascending: true })
    .limit(params.limit);

  if (error) {
    throw new Error(error.message || "Failed to load pending crypto top-ups");
  }

  return Array.isArray(data) ? (data as PendingCryptoTopUpRow[]) : [];
}

async function upsertCryptoDepositReceipt(params: {
  db: SupabaseLike;
  payment: PendingCryptoTopUp;
  transfer: {
    transactionHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string | null;
    confirmations: number;
  };
  status: "confirmed" | "settled";
  now: Date;
}) {
  const nowIso = params.now.toISOString();
  const result = await table(params.db, "crypto_deposit_receipts").upsert(
    {
      user_id: params.payment.userId,
      payment_transaction_id: params.payment.id,
      provider: "bankr",
      reference_id: params.payment.referenceId,
      chain_id: BASE_CHAIN_ID,
      token_address: USDC_BASE_TOKEN_ADDRESS,
      token_symbol: CRYPTO_TOPUP_ASSETS.usdc_base.symbol,
      token_decimals: CRYPTO_TOPUP_ASSETS.usdc_base.tokenDecimals,
      deposit_address: params.payment.depositAddress,
      normalized_deposit_address: params.payment.depositAddress,
      amount_minor: params.payment.amountMinor,
      tx_hash: params.transfer.transactionHash,
      log_index: params.transfer.logIndex,
      block_number: params.transfer.blockNumber,
      block_hash: params.transfer.blockHash,
      confirmations: params.transfer.confirmations,
      status: params.status,
      metadata: {
        source: "base_rpc",
        creditGrantReference: params.payment.referenceId,
      },
      detected_at: nowIso,
      confirmed_at: nowIso,
      settled_at: params.status === "settled" ? nowIso : null,
      updated_at: nowIso,
    },
    { onConflict: "provider,reference_id" }
  );

  if (result.error) {
    throw new Error(result.error.message || "Failed to store crypto deposit receipt");
  }
}

async function markCryptoDepositReceiptSettled(params: {
  db: SupabaseLike;
  referenceId: string;
  now: Date;
}) {
  const nowIso = params.now.toISOString();
  const result = await table(params.db, "crypto_deposit_receipts")
    .update({
      status: "settled",
      settled_at: nowIso,
      updated_at: nowIso,
    })
    .eq("provider", "bankr")
    .eq("reference_id", params.referenceId);

  if (result.error) {
    throw new Error(result.error.message || "Failed to update crypto deposit receipt");
  }
}

/**
 * The set of on-chain transfers already consumed by OTHER top-up intents on
 * this deposit address, keyed `${tx_hash}:${log_index}`. The deposit wallet is
 * reused per user, so two same-amount top-ups land at the same address with the
 * same required amount; without this, the oldest (already-credited) transfer is
 * re-matched and the receipt insert collides on the (chain_id, tx_hash,
 * log_index) unique constraint, permanently blocking the new credit. We scope
 * OUT this intent's own reference_id so re-reconciling the same intent (e.g. a
 * confirmed-but-not-settled retry) can still re-pick its own transfer.
 */
async function loadConsumedTransferKeys(params: {
  db: SupabaseLike;
  depositAddress: string;
  excludeReferenceId: string;
}): Promise<Set<string>> {
  // DbSelectFilter has no `.neq`, so fetch this address's receipts and exclude
  // this intent's own reference_id in JS. A deposit address only accumulates a
  // single user's top-up receipts, so the row count is small.
  const { data, error } = await table(params.db, "crypto_deposit_receipts")
    .select("tx_hash, log_index, reference_id")
    .eq("chain_id", BASE_CHAIN_ID)
    .eq("normalized_deposit_address", params.depositAddress)
    .limit(1000);

  if (error) {
    throw new Error(error.message || "Failed to load consumed crypto deposit receipts");
  }

  const consumed = new Set<string>();
  for (const row of (Array.isArray(data) ? data : []) as Array<{
    tx_hash?: string | null;
    log_index?: number | null;
    reference_id?: string | null;
  }>) {
    if (row.reference_id === params.excludeReferenceId) continue;
    if (typeof row.tx_hash === "string" && typeof row.log_index === "number") {
      consumed.add(`${row.tx_hash.toLowerCase()}:${row.log_index}`);
    }
  }
  return consumed;
}

async function reconcileCryptoTopUpIntent(params: {
  payment: PendingCryptoTopUpRow;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  lookbackBlocks?: number;
  minConfirmations?: number;
  settleIntent?: SettleCryptoTopUp;
  now?: Date;
  rpcOptions?: RpcCallOptions;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const parsedPayment = parsePendingPayment(params.payment);

  if (!parsedPayment) {
    return {
      status: "invalid_intent" as const,
      referenceId: params.payment.provider_reference_id,
    };
  }

  const rpcUrl = params.rpcUrl || getBaseRpcUrl();
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const lookbackBlocks = normalizeLookbackBlocks(params.lookbackBlocks);
  const minConfirmations = normalizeMinConfirmations(params.minConfirmations);
  const now = params.now ?? new Date();
  const scan = await fetchUsdcTransfersToAddress({
    depositAddress: parsedPayment.depositAddress,
    call: createRpcCall({ rpcUrl, fetchImpl, rpcOptions: params.rpcOptions }),
    lookbackBlocks,
  });
  const matches = findMatchingTransfer({
    logs: scan.logs,
    latestBlock: scan.latestBlock,
    amountMinor: parsedPayment.amountMinor,
  });
  // Drop transfers already consumed by other intents so a repeat same-amount
  // top-up matches its OWN (newer) transfer rather than re-picking a stale one.
  const consumed = await loadConsumedTransferKeys({
    db: admin,
    depositAddress: parsedPayment.depositAddress,
    excludeReferenceId: parsedPayment.referenceId,
  });
  const freshMatches = matches.filter(
    (match) => !consumed.has(`${match.transactionHash.toLowerCase()}:${match.logIndex}`)
  );
  const confirmed = freshMatches.find((match) => match.confirmations >= minConfirmations);

  if (!confirmed) {
    if (freshMatches.length > 0) {
      return {
        status: "underconfirmed" as const,
        referenceId: parsedPayment.referenceId,
        confirmations: Math.max(...freshMatches.map((match) => match.confirmations)),
      };
    }

    return {
      status: "no_match" as const,
      referenceId: parsedPayment.referenceId,
    };
  }

  await upsertCryptoDepositReceipt({
    db: admin,
    payment: parsedPayment,
    transfer: confirmed,
    status: "confirmed",
    now,
  });

  const settle = params.settleIntent ?? settleCryptoTopUpIntent;
  const settlement = await settle({
    referenceId: parsedPayment.referenceId,
    actor: "bankr_reconciler",
    transactionHash: confirmed.transactionHash,
    detectedAt: now.toISOString(),
    db: admin,
    now,
  });

  if (settlement.status !== "settled") {
    return {
      status: "settlement_skipped" as const,
      referenceId: parsedPayment.referenceId,
      settlementStatus: settlement.status,
    };
  }

  await markCryptoDepositReceiptSettled({
    db: admin,
    referenceId: parsedPayment.referenceId,
    now,
  });

  return {
    status: "settled" as const,
    referenceId: parsedPayment.referenceId,
    transactionHash: confirmed.transactionHash,
    inserted: settlement.inserted,
    balance: settlement.balance,
  };
}

export async function reconcilePendingCryptoTopUps(params: {
  db?: SupabaseLike | null;
  limit?: number;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  lookbackBlocks?: number;
  minConfirmations?: number;
  settleIntent?: SettleCryptoTopUp;
  now?: Date;
  // Retry knobs for 429/5xx from Base RPC (optional; exposed mainly so tests
  // can inject a fake sleep/random and tighten the retry budget).
  rpcRetryConfig?: Partial<RpcRetryConfig>;
  rpcSleepImpl?: (ms: number) => Promise<void>;
  rpcRandom?: () => number;
} = {}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const limit = normalizeLimit(params.limit);
  const payments = await listPendingCryptoTopUps({ db: admin, limit });
  const rpcOptions: RpcCallOptions = {
    retryConfig: normalizeRpcRetryConfig(params.rpcRetryConfig),
    sleepImpl: params.rpcSleepImpl,
    random: params.rpcRandom,
  };
  const results: Array<
    | Awaited<ReturnType<typeof reconcileCryptoTopUpIntent>>
    | { status: "failed"; referenceId: string; errorName: string }
  > = [];

  let settled = 0;
  let noMatch = 0;
  let underconfirmed = 0;
  let invalidIntent = 0;
  let failed = 0;

  for (const payment of payments) {
    try {
      const result = await reconcileCryptoTopUpIntent({
        payment,
        db: admin,
        rpcUrl: params.rpcUrl,
        fetchImpl: params.fetchImpl,
        lookbackBlocks: params.lookbackBlocks,
        minConfirmations: params.minConfirmations,
        settleIntent: params.settleIntent,
        now: params.now,
        rpcOptions,
      });
      results.push(result);

      if (result.status === "settled") settled += 1;
      if (result.status === "no_match") noMatch += 1;
      if (result.status === "underconfirmed") underconfirmed += 1;
      if (result.status === "invalid_intent") invalidIntent += 1;
      if (result.status === "settlement_skipped") failed += 1;
    } catch (error) {
      failed += 1;
      results.push({
        status: "failed",
        referenceId: payment.provider_reference_id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  return {
    checked: payments.length,
    settled,
    noMatch,
    underconfirmed,
    invalidIntent,
    failed,
    results,
  };
}
