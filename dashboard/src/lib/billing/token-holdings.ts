import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import { BASE_CHAIN_ID, HERMESOS_TOKEN } from "@/lib/billing/token-registry";
import {
  normalizeRpcRetryConfig,
  RpcHttpError,
  sleep,
  withRpcRetry,
  type RpcCallOptions,
  type RpcRetryConfig,
} from "@/lib/billing/base-rpc-retry";

// SCRIPTURE_ANCHOR: token-store | Matthew 6:20 | Verse: Lay up for yourselves treasures in heaven, where neither moth nor rust consume.
type DbTable = {
  select: (...args: unknown[]) => DbTable;
  eq: (...args: unknown[]) => DbTable;
  not: (...args: unknown[]) => DbTable;
  order: (...args: unknown[]) => DbTable;
  limit: (...args: unknown[]) => DbTable;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  insert: (...args: unknown[]) => {
    select: (...selectArgs: unknown[]) => {
      single: () => Promise<{ data: unknown; error: unknown }>;
    };
  };
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

interface TokenHoldingSnapshotRow {
  id: string;
  user_id: string;
  wallet_id: string | null;
  wallet_address: string;
  normalized_wallet_address: string;
  chain_id: number;
  token_address: string;
  token_symbol: string;
  token_decimals: number;
  balance_raw: string | number;
  balance_display: string;
  qualifies_base_tier: boolean;
  block_number: number | null;
  source: "base_rpc" | "bankr" | "admin";
  checked_at: string;
  created_at?: string;
}

interface UserWalletRow {
  id: string;
  user_id: string;
  address: string;
  normalized_address: string;
  chain_type: "evm";
  chain_id: number | null;
  is_primary: boolean;
  verified_at: string | null;
  verification_method?: "signature" | "bankr" | "admin" | null;
  metadata?: unknown;
}

type RefreshUserHoldingResult =
  | {
      status: "refreshed";
      snapshot: HermesTokenHoldingSnapshot | null;
      snapshots?: HermesTokenHoldingSnapshot[];
    }
  | {
      status: "no_verified_wallet";
      snapshot: null;
      snapshots?: [];
    };

type RefreshUserHolding = (userId: string) => Promise<RefreshUserHoldingResult>;

export interface HermesTokenHoldingSnapshot {
  id: string;
  userId: string;
  walletId: string | null;
  walletAddress: string;
  normalizedWalletAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  balanceRaw: string;
  balanceDisplay: string;
  balance: number;
  qualifiesBaseTier: boolean;
  blockNumber: number | null;
  source: "base_rpc" | "bankr" | "admin";
  checkedAt: string;
}

export interface HermesTokenBalanceCheck {
  walletAddress: string;
  normalizedWalletAddress: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  balanceRaw: string;
  balanceDisplay: string;
  qualifiesBaseTier: boolean;
  blockNumber: number | null;
}

export { BASE_CHAIN_ID };
// The legacy $HermesOS token, from the platform token registry. The stored
// symbol is "HermesOS": rows written before the registry say "Hivra", which
// displayTokenUnit still maps to $HermesOS.
export const HERMESOS_TOKEN_SYMBOL = HERMESOS_TOKEN.symbol;
export const HERMESOS_TOKEN_DECIMALS = HERMESOS_TOKEN.decimals;
export const HERMESOS_TOKEN_ADDRESS = HERMESOS_TOKEN.address;
export const HERMESOS_BASE_TIER_MIN_RAW = parseTokenAmountToRaw(
  "1",
  HERMESOS_TOKEN_DECIMALS
).toString();
const VVV_TOKEN_SYMBOL = "VVV";
export const VVV_TOKEN_DECIMALS = 18;
export const VVV_TOKEN_ADDRESS = normalizeEvmAddress(
  "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf"
);

const ERC20_BALANCE_OF_SELECTOR = "70a08231";
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
// Short gap between per-user balance refreshes so a fleet-wide sweep spreads its
// Base RPC reads across time instead of bursting them all at once — keeping the
// per-tick request rate under the public endpoint's rate-limit threshold.
const DEFAULT_INTER_USER_REFRESH_DELAY_MS = 75;
const USER_WALLET_SELECT =
  "id, user_id, address, normalized_address, chain_type, chain_id, is_primary, verified_at, verification_method, metadata";

export interface TokenBalanceConfig {
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  baseTierMinimumRaw?: string;
}

const HERMESOS_TOKEN_BALANCE_CONFIG: TokenBalanceConfig = {
  chainId: BASE_CHAIN_ID,
  tokenAddress: HERMESOS_TOKEN_ADDRESS,
  tokenSymbol: HERMESOS_TOKEN_SYMBOL,
  tokenDecimals: HERMESOS_TOKEN_DECIMALS,
  baseTierMinimumRaw: HERMESOS_BASE_TIER_MIN_RAW,
};

const VVV_TOKEN_BALANCE_CONFIG: TokenBalanceConfig = {
  chainId: BASE_CHAIN_ID,
  tokenAddress: VVV_TOKEN_ADDRESS,
  tokenSymbol: VVV_TOKEN_SYMBOL,
  tokenDecimals: VVV_TOKEN_DECIMALS,
};

const VERIFIED_TOKEN_BALANCE_CONFIGS = [
  HERMESOS_TOKEN_BALANCE_CONFIG,
  VVV_TOKEN_BALANCE_CONFIG,
] as const;

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function normalizeRefreshLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(100, Math.floor(limit ?? 100)));
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return (
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

// ── Staked VVV (Venice compute boost) ──────────────────────────────────────
// "Stake VVV for DIEM" locks VVV inside Venice's sVVV staking contract, so it
// leaves the wallet's plain ERC-20 balanceOf and would otherwise stop counting
// toward the Venice boost threshold. To keep eligibility fair, we ALSO read the
// wallet's staked VVV and add it to the counted VVV.
//
// sVVV is yield-bearing (not 1:1 with VVV and not ERC-4626), so balanceOf(user)
// returns *shares*; fetchStakedVvvBalanceRaw converts them to VVV via the
// on-chain share price (see below).
//
// Defaults ON against the official Venice sVVV contract on Base. Override the
// address with VVV_STAKING_CONTRACT_ADDRESS, or set that to the zero address as
// a kill switch. The share read is balanceOf(user); override the 4-byte getter
// with VVV_STAKING_BALANCE_SELECTOR, or set VVV_STAKING_RAW_BALANCE=true if a
// contract's balanceOf already returns VVV (no share conversion).
const VENICE_SVVV_STAKING_CONTRACT = "0x321b7ff75154472B18EDb199033fF4D116F340Ff";

export function getVvvStakingContractAddress(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = (
    env.VVV_STAKING_CONTRACT_ADDRESS ||
    env.HERMES_VVV_STAKING_CONTRACT_ADDRESS ||
    VENICE_SVVV_STAKING_CONTRACT
  ).trim();
  if (!raw) return null;
  const normalized = normalizeEvmAddress(raw);
  // An explicit zero address disables staked-VVV crediting.
  if (!normalized || /^0x0{40}$/i.test(normalized)) return null;
  return normalized;
}

function getVvvStakingBalanceSelector(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = (env.VVV_STAKING_BALANCE_SELECTOR || "").trim().replace(/^0x/, "");
  return /^[0-9a-fA-F]{8}$/.test(raw) ? raw.toLowerCase() : ERC20_BALANCE_OF_SELECTOR;
}

/**
 * Normalize a numeric value that may have come back from PostgREST
 * as a JSON Number (potentially in scientific notation) into a
 * fixed-point digit string suitable for BigInt() and downstream
 * formatters.
 *
 * Inputs we tolerate:
 *   - bigint                              → "1234"
 *   - number (precise integer, e.g. 0)    → "0"
 *   - number (lossy integer, e.g. 5e+22)  → "50000000000000000000000"
 *   - digit-only string                   → unchanged
 *   - hex string ("0x...")                → "..."
 *
 * Throws if the value can't be converted (a malformed RPC blob, etc.).
 */
export function normalizeNumericToBigIntString(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(value).toString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) return trimmed;
    if (/^0x[a-fA-F0-9]+$/.test(trimmed)) return BigInt(trimmed).toString();
    // Fall through — let BigInt throw a clearer error.
    return BigInt(trimmed).toString();
  }
  throw new Error(`Cannot normalize value of type ${typeof value} to a numeric string`);
}

function asSnapshot(row: TokenHoldingSnapshotRow): HermesTokenHoldingSnapshot {
  // PostgREST serializes Postgres numeric(78, 0) as a JSON Number when
  // possible. For values > 2^53 it loses precision and JSON.parse
  // produces a float, which String() then renders as scientific
  // notation ("5e+22"). BigInt(), and any of our downstream parsers,
  // cannot accept scientific notation as a string. Roundtripping
  // through BigInt() forces the value back into a fixed-point string
  // ("50000000000000000000000") that downstream code can parse.
  const balanceRaw = normalizeNumericToBigIntString(row.balance_raw);
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    walletAddress: row.wallet_address,
    normalizedWalletAddress: row.normalized_wallet_address,
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    tokenSymbol: row.token_symbol,
    tokenDecimals: row.token_decimals,
    balanceRaw,
    balanceDisplay: row.balance_display,
    balance: tokenBalanceRawToNumber(balanceRaw, row.token_decimals),
    qualifiesBaseTier: row.qualifies_base_tier,
    blockNumber: row.block_number,
    source: row.source,
    checkedAt: row.checked_at,
  };
}

function asWallet(row: UserWalletRow) {
  return {
    id: row.id,
    userId: row.user_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    chainId: row.chain_id,
    verifiedAt: row.verified_at,
    verificationMethod: row.verification_method ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function bankrWalletPurpose(row: UserWalletRow): string | null {
  if (!isRecord(row.metadata)) return null;
  const bankr = row.metadata.bankr;
  if (!isRecord(bankr)) return null;
  return typeof bankr.purpose === "string" ? bankr.purpose : null;
}

function isEligiblePrimaryTokenWallet(row: UserWalletRow): boolean {
  if (!row.verified_at) return false;
  if (row.verification_method === "signature" || row.verification_method === "admin") {
    return true;
  }

  if (row.verification_method === "bankr") {
    const purpose = bankrWalletPurpose(row);
    return !purpose || purpose === "hermesos_lock";
  }

  return !bankrWalletPurpose(row);
}

export function isEvmAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function normalizeEvmAddress(address: string): string {
  const trimmed = address.trim();
  if (!isEvmAddress(trimmed)) {
    throw new Error("Invalid EVM address");
  }

  return trimmed.toLowerCase();
}

export function parseTokenAmountToRaw(amount: string | number, decimals: number): bigint {
  const normalized = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error("Invalid token amount");
  }

  const [whole, fractional = ""] = normalized.split(".");
  if (fractional.length > decimals) {
    throw new Error("Token amount has too many decimal places");
  }

  return BigInt(whole + fractional.padEnd(decimals, "0"));
}

export function formatRawTokenBalance(raw: string | bigint, decimals: number): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const padded = absolute.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fractional = padded.slice(-decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fractional ? `.${fractional}` : ""}`;
}

function tokenBalanceRawToNumber(raw: string, decimals: number): number {
  return Number(formatRawTokenBalance(raw, decimals));
}

export function qualifiesForHermesBaseTier(raw: string | bigint): boolean {
  return BigInt(raw) >= BigInt(HERMESOS_BASE_TIER_MIN_RAW);
}

function qualifiesForTokenBaseTier(token: TokenBalanceConfig, raw: string | bigint): boolean {
  return token.baseTierMinimumRaw
    ? BigInt(raw) >= BigInt(token.baseTierMinimumRaw)
    : false;
}

export function encodeErc20BalanceOfCallData(walletAddress: string): string {
  const normalized = normalizeEvmAddress(walletAddress);
  return `0x${ERC20_BALANCE_OF_SELECTOR}${normalized.slice(2).padStart(64, "0")}`;
}

export function decodeUint256RpcResult(result: unknown): string {
  if (typeof result !== "string" || !/^0x[a-fA-F0-9]+$/.test(result)) {
    throw new Error("Invalid uint256 RPC result");
  }

  return BigInt(result).toString();
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
    // Throw a typed error so the shared retry layer can classify the status:
    // 429 (rate-limited) and 5xx are retried with backoff; a 4xx that isn't 429
    // is deterministic and fails fast. The .message is unchanged from before so
    // existing runtime-log assertions on the text keep matching.
    throw new RpcHttpError(response.status);
  }

  const payload = (await response.json()) as JsonRpcResponse;
  if (payload.error) {
    // A JSON-RPC error body is a deterministic application-level failure, not a
    // transport hiccup — a plain Error so it is NOT retried.
    throw new Error(payload.error.message || "Base RPC returned an error");
  }

  return payload.result as T;
}

// The shared/public Base RPC endpoint (https://mainnet.base.org) rate-limits
// (HTTP 429) once the refresh-token-holdings / refresh-token-tiers crons fan
// balanceOf reads across every verified wallet in a tight loop. Before this, a
// 429 threw straight out of rpcCall and surfaced per-user as
// "[refreshVerifiedHermesTokenHoldings] refresh failed ... status 429" — so
// holders' tier/holdings simply didn't refresh that tick. We now retry the read
// with exponential backoff + jitter on transient errors (429 / 5xx / network)
// via the shared base-rpc-retry layer, and fail fast on deterministic errors.
// Balance / tier / qualification logic is untouched — this only makes the
// on-chain READ resilient. The batch refresh additionally throttles between
// users to keep the per-tick request rate under the endpoint's threshold.
async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: JsonRpcFetch,
  rpcOptions?: RpcCallOptions
): Promise<T> {
  return withRpcRetry<T>(
    () => rpcCallOnce<T>(rpcUrl, method, params, fetchImpl),
    rpcOptions
  );
}

export async function fetchTokenBalance(params: {
  token: TokenBalanceConfig;
  walletAddress: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  rpcOptions?: RpcCallOptions;
}): Promise<HermesTokenBalanceCheck> {
  const normalizedWalletAddress = normalizeEvmAddress(params.walletAddress);
  const rpcUrl = params.rpcUrl || getBaseRpcUrl(params.env);
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const balanceRaw = decodeUint256RpcResult(
    await rpcCall<string>(
      rpcUrl,
      "eth_call",
      [
        {
          to: params.token.tokenAddress,
          data: encodeErc20BalanceOfCallData(normalizedWalletAddress),
        },
        "latest",
      ],
      fetchImpl,
      params.rpcOptions
    )
  );
  const blockHex = await rpcCall<string>(
    rpcUrl,
    "eth_blockNumber",
    [],
    fetchImpl,
    params.rpcOptions
  );
  const blockNumber = Number.parseInt(blockHex, 16);

  return {
    walletAddress: params.walletAddress,
    normalizedWalletAddress,
    chainId: params.token.chainId,
    tokenAddress: params.token.tokenAddress,
    tokenSymbol: params.token.tokenSymbol,
    tokenDecimals: params.token.tokenDecimals,
    balanceRaw,
    balanceDisplay: formatRawTokenBalance(balanceRaw, params.token.tokenDecimals),
    qualifiesBaseTier: qualifiesForTokenBaseTier(params.token, balanceRaw),
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : null,
  };
}

/**
 * Read a wallet's STAKED VVV (raw, in VVV's 18 decimals) from the staking
 * contract. Returns 0n when staking is disabled (zero-address override).
 *
 * Venice's sVVV is a yield-bearing share token (verified on-chain: ~1.05 VVV
 * per sVVV, no ERC-4626 convertToAssets), so balanceOf(user) returns shares. We
 * convert to VVV via the contract-wide share price:
 *
 *   stakedVVV = shares * VVV_held_by_staking / sVVV_totalSupply
 *
 * The share-token decimals cancel, so the result is in VVV's decimals. A true
 * 1:1 staking token yields rate 1 (no-op). Set VVV_STAKING_RAW_BALANCE=true to
 * skip the conversion when a contract's balanceOf already returns VVV.
 */
export async function fetchStakedVvvBalanceRaw(params: {
  walletAddress: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  rpcOptions?: RpcCallOptions;
}): Promise<bigint> {
  const env = params.env ?? process.env;
  const stakingAddress = getVvvStakingContractAddress(env);
  if (!stakingAddress) return 0n;

  const rpcUrl = params.rpcUrl || getBaseRpcUrl(env);
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const selector = getVvvStakingBalanceSelector(env);
  const normalizedWallet = normalizeEvmAddress(params.walletAddress);
  const ethCallUint = async (to: string, data: string) =>
    BigInt(
      decodeUint256RpcResult(
        await rpcCall<string>(
          rpcUrl,
          "eth_call",
          [{ to, data }, "latest"],
          fetchImpl,
          params.rpcOptions
        )
      )
    );

  const shares = await ethCallUint(
    stakingAddress,
    `0x${selector}${normalizedWallet.slice(2).padStart(64, "0")}`
  );
  if (shares <= 0n) return 0n;

  if ((env.VVV_STAKING_RAW_BALANCE || "").trim().toLowerCase() === "true") {
    return shares;
  }

  const [totalShares, backingVvv] = await Promise.all([
    ethCallUint(stakingAddress, "0x18160ddd"), // sVVV.totalSupply()
    ethCallUint(VVV_TOKEN_ADDRESS, encodeErc20BalanceOfCallData(stakingAddress)), // VVV.balanceOf(sVVV)
  ]);
  if (totalShares <= 0n) return shares;
  return (shares * backingVvv) / totalShares;
}

export async function fetchHermesTokenBalance(params: {
  walletAddress: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  rpcOptions?: RpcCallOptions;
}): Promise<HermesTokenBalanceCheck> {
  return fetchTokenBalance({
    ...params,
    token: HERMESOS_TOKEN_BALANCE_CONFIG,
  });
}

export async function getLatestHermesTokenHoldingSnapshot(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<HermesTokenHoldingSnapshot | null> {
  const admin = requireDb(db);
  const { data, error } = await table(admin, "token_holding_snapshots")
    .select("*")
    .eq("user_id", userId)
    .eq("chain_id", BASE_CHAIN_ID)
    .eq("token_address", HERMESOS_TOKEN_ADDRESS)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load Hivra token holding snapshot");
  }

  return data ? asSnapshot(data as TokenHoldingSnapshotRow) : null;
}

export async function getLatestHermesTokenHoldingSnapshotForWallet(params: {
  userId: string;
  walletAddress: string;
  db?: SupabaseLike | null;
}): Promise<HermesTokenHoldingSnapshot | null> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const normalizedWalletAddress = normalizeEvmAddress(params.walletAddress);
  const { data, error } = await table(admin, "token_holding_snapshots")
    .select("*")
    .eq("user_id", params.userId)
    .eq("chain_id", BASE_CHAIN_ID)
    .eq("token_address", HERMESOS_TOKEN_ADDRESS)
    .eq("normalized_wallet_address", normalizedWalletAddress)
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load Hivra token holding snapshot for wallet");
  }

  return data ? asSnapshot(data as TokenHoldingSnapshotRow) : null;
}

/**
 * Returns the grandfathered Bankr wallet $HERMESOS deposits are tracked against.
 *
 * The Bankr provisioning flow creates two distinct wallets per user:
 *   - credit_deposit (primary)  — receives USDC top-ups for credits
 *   - hermesos_lock             — receives $HERMESOS for tier eligibility
 *
 * The hermesos_lock wallet is the one users see on /dashboard/wallet
 * as their "$HERMESOS deposit address." New self-custody users should
 * use getTokenVerificationWallet(), which falls through to signature
 * verification without accepting generic Bankr credit-deposit wallets.
 */
export async function getHermesLockWallet(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const admin = requireDb(db);
  const { data, error } = await table(admin, "user_wallets")
    .select(USER_WALLET_SELECT)
    .eq("user_id", userId)
    .eq("chain_type", "evm")
    .eq("verification_method", "bankr")
    .eq("metadata->bankr->>purpose", "hermesos_lock")
    .not("verified_at", "is", null)
    .order("verified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load Hivra lock wallet");
  }
  return data ? asWallet(data as UserWalletRow) : null;
}

export async function getTokenVerificationWallet(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  const admin = requireDb(db);
  const grandfatheredLockWallet = await getHermesLockWallet(userId, admin);
  if (grandfatheredLockWallet) {
    const lockSnapshot = await getLatestHermesTokenHoldingSnapshotForWallet({
      userId,
      walletAddress: grandfatheredLockWallet.normalizedAddress,
      db: admin,
    });
    if (lockSnapshot && BigInt(lockSnapshot.balanceRaw) > 0n) {
      return grandfatheredLockWallet;
    }
  }

  const { data, error } = await table(admin, "user_wallets")
    .select(USER_WALLET_SELECT)
    .eq("user_id", userId)
    .eq("chain_type", "evm")
    .eq("is_primary", true)
    .not("verified_at", "is", null)
    .order("verified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load token verification wallet");
  }

  if (!data) return null;
  const row = data as UserWalletRow;
  return isEligiblePrimaryTokenWallet(row) ? asWallet(row) : null;
}

async function storeTokenHoldingSnapshot(params: {
  db: SupabaseLike;
  userId: string;
  wallet: ReturnType<typeof asWallet>;
  balance: HermesTokenBalanceCheck;
}) {
  const { data, error } = await table(params.db, "token_holding_snapshots")
    .insert({
      user_id: params.userId,
      wallet_id: params.wallet.id,
      wallet_address: params.wallet.address,
      normalized_wallet_address: params.wallet.normalizedAddress,
      chain_id: params.balance.chainId,
      token_address: params.balance.tokenAddress,
      token_symbol: params.balance.tokenSymbol,
      token_decimals: params.balance.tokenDecimals,
      balance_raw: params.balance.balanceRaw,
      balance_display: params.balance.balanceDisplay,
      qualifies_base_tier: params.balance.qualifiesBaseTier,
      block_number: params.balance.blockNumber,
      source: "base_rpc",
      metadata: { rpc: "base" },
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to store ${params.balance.tokenSymbol} token holding snapshot`);
  }

  return asSnapshot(data as TokenHoldingSnapshotRow);
}

/**
 * Fold a wallet's staked VVV into its VVV balance check so the Venice boost
 * counts liquid + staked together. No-op for non-VVV tokens or when no staking
 * contract is configured. A staking-read failure is swallowed (counts 0 staked)
 * so a transient staking-RPC error can never strip a user's liquid-VVV boost.
 */
async function withStakedVvv(
  balance: HermesTokenBalanceCheck,
  opts: {
    rpcUrl?: string;
    fetchImpl?: JsonRpcFetch;
    env?: Record<string, string | undefined>;
    rpcOptions?: RpcCallOptions;
  }
): Promise<HermesTokenBalanceCheck> {
  if (balance.tokenAddress !== VVV_TOKEN_ADDRESS) return balance;
  if (!getVvvStakingContractAddress(opts.env)) return balance;

  let stakedRaw: bigint;
  try {
    stakedRaw = await fetchStakedVvvBalanceRaw({
      walletAddress: balance.normalizedWalletAddress,
      rpcUrl: opts.rpcUrl,
      fetchImpl: opts.fetchImpl,
      env: opts.env,
      rpcOptions: opts.rpcOptions,
    });
  } catch {
    return balance;
  }
  if (stakedRaw <= 0n) return balance;

  const totalRaw = (BigInt(balance.balanceRaw) + stakedRaw).toString();
  return {
    ...balance,
    balanceRaw: totalRaw,
    balanceDisplay: formatRawTokenBalance(totalRaw, balance.tokenDecimals),
  };
}

export async function refreshPrimaryVerifiedTokenHoldings(params: {
  userId: string;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const wallet = await getTokenVerificationWallet(params.userId, admin);
  if (!wallet) {
    return { status: "no_verified_wallet" as const, snapshot: null, snapshots: [] };
  }

  const snapshots: HermesTokenHoldingSnapshot[] = [];
  for (const token of VERIFIED_TOKEN_BALANCE_CONFIGS) {
    const balance = await withStakedVvv(
      await fetchTokenBalance({
        token,
        walletAddress: wallet.address,
        rpcUrl: params.rpcUrl,
        fetchImpl: params.fetchImpl,
        rpcOptions: params.rpcOptions,
      }),
      {
        rpcUrl: params.rpcUrl,
        fetchImpl: params.fetchImpl,
        rpcOptions: params.rpcOptions,
      }
    );
    snapshots.push(await storeTokenHoldingSnapshot({
      db: admin,
      userId: params.userId,
      wallet,
      balance,
    }));
  }

  const hermesSnapshot =
    snapshots.find((snapshot) => snapshot.tokenAddress === HERMESOS_TOKEN_ADDRESS) ?? null;

  return {
    status: "refreshed" as const,
    snapshot: hermesSnapshot,
    snapshots,
  };
}

export async function refreshPrimaryHermesTokenHolding(params: {
  userId: string;
  db?: SupabaseLike | null;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  rpcOptions?: RpcCallOptions;
}) {
  const result = await refreshPrimaryVerifiedTokenHoldings(params);
  if (result.status === "no_verified_wallet") {
    return { status: result.status, snapshot: null };
  }
  return result;
}

export async function refreshVerifiedHermesTokenHoldings(params: {
  db?: SupabaseLike | null;
  limit?: number;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  refreshUserHolding?: RefreshUserHolding;
  // Base RPC resilience knobs (all optional; sensible defaults). Exposed mainly
  // so tests can inject a fake sleep/random and tighten the retry budget. The
  // retry/backoff/jitter on 429/5xx/network lives in the shared base-rpc-retry
  // layer; the throttle below spreads the per-tick load across the public
  // endpoint so a fleet-wide sweep doesn't trip the rate-limit in the first
  // place.
  rpcRetryConfig?: Partial<RpcRetryConfig>;
  rpcSleepImpl?: (ms: number) => Promise<void>;
  rpcRandom?: () => number;
  interUserDelayMs?: number;
} = {}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const limit = normalizeRefreshLimit(params.limit);
  const { data, error } = await (table(admin, "user_wallets")
    .select("id, user_id, address, normalized_address, chain_type, chain_id, is_primary, verified_at")
    .eq("chain_type", "evm")
    .eq("is_primary", true)
    .not("verified_at", "is", null)
    .order("verified_at", { ascending: true })
    .limit(limit) as unknown as Promise<{ data: unknown; error: unknown }>);

  if (error) {
    throw new Error("Failed to load verified wallets for token refresh");
  }

  const wallets = Array.isArray(data) ? (data as UserWalletRow[]) : [];

  // Build the per-call RPC options once: retry config + injectable sleep/random
  // ride along with every eth_* call this batch makes (only when the default
  // refresher is used — a caller-supplied refreshUserHolding owns its own RPC).
  const rpcOptions: RpcCallOptions = {
    retryConfig: normalizeRpcRetryConfig(params.rpcRetryConfig),
    sleepImpl: params.rpcSleepImpl,
    random: params.rpcRandom,
  };
  const sleepImpl = params.rpcSleepImpl ?? sleep;
  const interUserDelayMs = Number.isFinite(params.interUserDelayMs)
    ? Math.max(0, Math.floor(params.interUserDelayMs as number))
    : DEFAULT_INTER_USER_REFRESH_DELAY_MS;

  const refreshUserHolding: RefreshUserHolding =
    params.refreshUserHolding ??
    ((userId) =>
      refreshPrimaryHermesTokenHolding({
        userId,
        db: admin,
        rpcUrl: params.rpcUrl,
        fetchImpl: params.fetchImpl,
        rpcOptions,
      }));

  const results: Array<{
    userId: string;
    walletId: string;
    status: "refreshed" | "no_verified_wallet" | "failed";
    snapshotId?: string;
    qualifiesBaseTier?: boolean;
  }> = [];

  let refreshed = 0;
  let noVerifiedWallet = 0;
  let failed = 0;

  let walletIndex = 0;
  for (const wallet of wallets) {
    // Throttle between users (not before the first) to keep the per-tick request
    // rate under the public Base RPC endpoint's rate-limit threshold. Skipped
    // when a caller injects its own refreshUserHolding (it owns its pacing).
    if (walletIndex > 0 && !params.refreshUserHolding && interUserDelayMs > 0) {
      await sleepImpl(interUserDelayMs);
    }
    walletIndex += 1;
    try {
      const result = await refreshUserHolding(wallet.user_id);
      if (result.status === "refreshed") {
        refreshed += 1;
        results.push({
          userId: wallet.user_id,
          walletId: wallet.id,
          status: "refreshed",
          snapshotId: result.snapshot?.id,
          qualifiesBaseTier: result.snapshot?.qualifiesBaseTier,
        });
      } else {
        noVerifiedWallet += 1;
        results.push({
          userId: wallet.user_id,
          walletId: wallet.id,
          status: "no_verified_wallet",
        });
      }
    } catch (refreshErr) {
      // Diagnostic: gated on non-test so the existing leak tests still
      // pass. Surfaces the underlying refresh error to runtime logs so
      // schema/wallet-selection bugs are visible without redeploying.
      if (process.env.NODE_ENV !== "test") {
        // eslint-disable-next-line no-console
        console.error(
          `[refreshVerifiedHermesTokenHoldings] refresh failed user=${wallet.user_id} wallet=${wallet.id}:`,
          refreshErr
        );
      }
      failed += 1;
      results.push({
        userId: wallet.user_id,
        walletId: wallet.id,
        status: "failed",
      });
    }
  }

  return {
    checked: wallets.length,
    refreshed,
    noVerifiedWallet,
    failed,
    results,
  };
}
