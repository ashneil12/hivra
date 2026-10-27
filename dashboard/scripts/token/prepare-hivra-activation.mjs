#!/usr/bin/env node
/**
 * Prepare the $HIVRA activation block (src/lib/billing/hivra-token-launch.ts).
 *
 * READ-ONLY. It reads Base (eth_getCode and eth_call on the public RPC),
 * DEXScreener and GeckoTerminal, checks the launch against what the platform
 * expects, and prints a report. It signs nothing, sends no transaction and
 * writes to no service. With --write, and only when every check passes, it
 * fills in the four fields of hivra-token-launch.ts in this checkout. That
 * edit still ships only through a reviewed PR (docs/token/HIVRA-ACTIVATION.md).
 *
 * Usage (from dashboard/):
 *   node scripts/token/prepare-hivra-activation.mjs \
 *     --address 0x... --activates-at 2026-10-01T16:00:00Z [--pool-id 0x...] [--write] [--json]
 *
 * Exit code: 0 when every check passes, 1 when one fails, 2 on bad usage.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
} from "viem";

export const DEFAULT_ENDPOINTS = Object.freeze({
  rpcUrl: "https://mainnet.base.org",
  dexscreenerUrl: "https://api.dexscreener.com",
  geckoterminalUrl: "https://api.geckoterminal.com/api/v2",
});

/** What the $HIVRA launch must have produced. The platform code expects exactly these. */
export const EXPECTED_TOKEN = Object.freeze({
  name: "Hivra",
  symbol: "HIVRA",
  decimals: 18,
  totalSupplyWhole: 100_000_000_000n,
});

/**
 * The pool that prices $HIVRA is quoted in ETH. $HIVRA launches into a Doppler
 * Uniswap v4 pool against native ETH (currency0 = address(0)), which DEXScreener
 * and GeckoTerminal both report as quote "ETH" at the zero address. WETH is the
 * other form of ETH the price feed accepts (token-registry.ts isEthQuoteAddress).
 */
export const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";
export const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
export const ETH_QUOTE_ADDRESSES = Object.freeze([NATIVE_ETH_ADDRESS, BASE_WETH_ADDRESS]);
/** What the launch plan uses as the pool's numeraire. A WETH pool is accepted with a warning. */
export const EXPECTED_NUMERAIRE = NATIVE_ETH_ADDRESS;
/** The legacy $HermesOS contract (token-registry.ts), never a valid $HIVRA address. */
export const HERMESOS_ADDRESS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";

/**
 * Doppler on Base (whetstoneresearch/doppler, Deployments.md). The Multicurve
 * launch creates the pool through DopplerHookInitializer, which is also the
 * pool's v4 hook and records the pool key per token (getState). The token is
 * an EIP-1167 clone of the DopplerERC20V1 implementation: a clone cannot be
 * upgraded, and DopplerERC20V1 mints only inside initialize() (no mint function,
 * no yearly inflation), so its supply can never grow after launch.
 */
export const DOPPLER_HOOK_INITIALIZER = "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544";
// Two DopplerERC20V1 deployments are accepted, both read on Base on 2026-10-27:
// - 0xdb7b…be87: the one in doppler's Deployments.md, cloned by DopplerERC20V1Factory 0x89c2…5292.
// - 0xedf3…50f8: the current one in doppler-sdk's deployments.generated.ts for chain 8453, cloned by
//   DopplerERC20V1Factory 0xf154…2ce5, which the Airlock 0x660e…8d12 whitelists as a token factory
//   (getModuleState = 1). $HIVRA was created through that factory. Its dispatcher is 0xdb7b's 57
//   selectors plus getPastTotalSupply(uint256) and 0x46758fc9 (no public name); it keeps the vesting
//   functions (vestingStart, vestingOf, vestingSchedules, release, releaseFor) and has no mint entry point.
export const DOPPLER_ERC20_V1_IMPLEMENTATIONS = Object.freeze([
  "0xdb7b520bb5c3a2c5d4871198081911359f93be87",
  "0xedf3f3981e98077591c1b909bccff0e572bd50f8",
]);

/** Entry points that would let a token mint after launch. The older Doppler DERC20 has mintInflation() and yearlyMintRate(). */
export const MINT_FUNCTIONS = Object.freeze(["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "mintInflation()"]);
export const YEARLY_MINT_RATE_FUNCTION = "yearlyMintRate()";

/** DopplerHookInitializer PoolStatus: Uninitialized, Initialized, Locked, Graduated, Exited. */
const DOPPLER_POOL_STATUS = Object.freeze(["Uninitialized", "Initialized", "Locked", "Graduated", "Exited"]);
export const DOPPLER_STATE_ABI = parseAbi([
  "function getState(address asset) view returns (address numeraire, uint256 totalTokensOnBondingCurve, address dopplerHook, bytes graduationDopplerHookCalldata, uint8 status, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 farTick)",
]);
const POOL_KEY_PARAMS = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }];
/** Uniswap v4 LPFeeLibrary.DYNAMIC_FEE_FLAG: the hook sets the fee (Doppler's 1.58%). */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;

// These mirror token-registry.ts (POOL_ID, UTC_INSTANT) and price-feed.ts. The
// jest test __tests__/prepare-hivra-activation.test.ts fails if they drift.
export const POOL_ID_PATTERN = /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
export const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const PRICE_MEDIAN_WINDOW_MINUTES = 240;
export const PRICE_MAX_DEVIATION_BPS = 1_000;

/** activatesAt closer than this is flagged: the PR, the Canary build and the Promote all come first. */
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const CANDLES_FETCHED = 1_000;
const BUCKET_SEC = 5 * 60;
const FETCH_TIMEOUT_MS = 10_000;

const DASHBOARD_ROOT = new URL("../../", import.meta.url);
export const LAUNCH_FILE = fileURLToPath(new URL("src/lib/billing/hivra-token-launch.ts", DASHBOARD_ROOT));
export const REGISTRY_FILE = fileURLToPath(new URL("src/lib/billing/token-registry.ts", DASHBOARD_ROOT));

// ── Arguments ───────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { address: null, activatesAt: null, poolId: null, write: false, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--address" || arg === "--activates-at" || arg === "--pool-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      if (arg === "--address") args.address = value.trim();
      else if (arg === "--activates-at") args.activatesAt = value.trim();
      else args.poolId = value.trim();
      i += 1;
    } else throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (!args.help && (!args.address || !args.activatesAt)) throw new UsageError("--address and --activates-at are required");
  return args;
}

export class UsageError extends Error {}

const USAGE = `Usage: node scripts/token/prepare-hivra-activation.mjs --address 0x... --activates-at 2026-10-01T16:00:00Z [--pool-id 0x...] [--write] [--json]

Read-only check of the $HIVRA launch on Base, DEXScreener and GeckoTerminal.
--pool-id  use this ETH-quoted HIVRA pool instead of the Doppler pool (or the deepest one)
--write    when every check passes, fill in src/lib/billing/hivra-token-launch.ts
--json     print the result as JSON`;

// ── Registry values ─────────────────────────────────────────────────────

/** The $HIVRA liquidity floor, read from token-registry.ts so a reviewed change there applies here too. */
export function readMinPriceLiquidityUsd(registrySource) {
  const match = /export const HIVRA_MIN_PRICE_LIQUIDITY_USD = ([\d_]+);/.exec(registrySource);
  if (!match) throw new Error("HIVRA_MIN_PRICE_LIQUIDITY_USD not found in token-registry.ts");
  return Number(match[1].replace(/_/g, ""));
}

/** The $HIVRA ETH-side floor, read from token-registry.ts like the total floor. */
export function readMinQuoteLiquidityUsd(registrySource) {
  const match = /export const HIVRA_MIN_QUOTE_LIQUIDITY_USD = ([\d_]+);/.exec(registrySource);
  if (!match) throw new Error("HIVRA_MIN_QUOTE_LIQUIDITY_USD not found in token-registry.ts");
  return Number(match[1].replace(/_/g, ""));
}

const LAUNCH_BLOCK =
  /export const HIVRA_TOKEN_LAUNCH: HivraTokenLaunchConfig = \{\n {2}contractAddress: ("[^"\n]*"),\n {2}decimals: (\d+),\n {2}poolId: ("[^"\n]*"),\n {2}activatesAt: ("[^"\n]*"),\n\};/;

/** The four fields of hivra-token-launch.ts as committed. */
export function readLaunchBlock(launchSource) {
  const match = LAUNCH_BLOCK.exec(launchSource);
  if (!match) throw new Error("hivra-token-launch.ts does not have the expected HIVRA_TOKEN_LAUNCH block");
  return {
    contractAddress: JSON.parse(match[1]),
    decimals: Number(match[2]),
    poolId: JSON.parse(match[3]),
    activatesAt: JSON.parse(match[4]),
  };
}

/** hivra-token-launch.ts with its launch block set to `config`; everything else is kept byte for byte. */
export function renderLaunchSource(launchSource, config) {
  readLaunchBlock(launchSource); // throws on an unexpected shape
  const block =
    "export const HIVRA_TOKEN_LAUNCH: HivraTokenLaunchConfig = {\n" +
    `  contractAddress: ${JSON.stringify(config.contractAddress)},\n` +
    `  decimals: ${Number(config.decimals)},\n` +
    `  poolId: ${JSON.stringify(config.poolId)},\n` +
    `  activatesAt: ${JSON.stringify(config.activatesAt)},\n` +
    "};";
  return launchSource.replace(LAUNCH_BLOCK, () => block);
}

// ── Reading the chain and the markets (the only network access) ─────────

async function fetchJson(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${new URL(url).host} answered HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function rpc(fetchImpl, rpcUrl, method, params) {
  // Read-only JSON-RPC: eth_getCode and eth_call only.
  if (method !== "eth_getCode" && method !== "eth_call") throw new Error(`refusing non-read RPC method ${method}`);
  const body = await fetchJson(fetchImpl, rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body.error) throw new Error(`${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

// Runtime code of a minimal proxy: the classic EIP-1167 form, and Solady
// LibClone's PUSH0 form (what DopplerERC20V1Factory deploys; read live on Base).
const CLONE_PATTERNS = [
  /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/,
  /^0x3d3d3d3d363d3d37363d73([0-9a-f]{40})5af43d3d93803e602a57fd5bf3$/,
];

/** The implementation a minimal-proxy clone delegates to, or null for any other code. */
export function cloneImplementation(code) {
  const normalized = String(code ?? "").toLowerCase();
  for (const pattern of CLONE_PATTERNS) {
    const match = pattern.exec(normalized);
    if (match) return `0x${match[1]}`;
  }
  return null;
}

/**
 * Whether runtime code dispatches `signature` (a PUSH4 of its selector, as the
 * Solidity dispatcher emits). A byte pattern that happens to match in data reads
 * as present, so the check errs toward refusing.
 */
export function codeHasFunction(code, signature) {
  return String(code ?? "").toLowerCase().includes(`63${toFunctionSelector(signature).slice(2)}`);
}

/** The Uniswap v4 PoolId of a pool key: keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)). */
export function v4PoolId(key) {
  return keccak256(encodeAbiParameters(POOL_KEY_PARAMS, [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
}

async function readErc20(fetchImpl, rpcUrl, address) {
  const call = async (functionName) => {
    const data = encodeFunctionData({ abi: erc20Abi, functionName });
    const result = await rpc(fetchImpl, rpcUrl, "eth_call", [{ to: address, data }, "latest"]);
    return decodeFunctionResult({ abi: erc20Abi, functionName, data: result });
  };
  const code = await rpc(fetchImpl, rpcUrl, "eth_getCode", [address, "latest"]);
  if (!code || code === "0x") return { hasCode: false };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    call("name"),
    call("symbol"),
    call("decimals"),
    call("totalSupply"),
  ]);

  // Can the supply ever grow? Read the code that actually runs (the clone's
  // implementation) for a mint entry point, and an inflation rate if it has one.
  const implementation = cloneImplementation(code);
  const runCode = implementation ? await rpc(fetchImpl, rpcUrl, "eth_getCode", [implementation, "latest"]) : code;
  const mintFunctions = MINT_FUNCTIONS.filter((signature) => codeHasFunction(runCode, signature));
  let yearlyMintRate = null;
  if (codeHasFunction(runCode, YEARLY_MINT_RATE_FUNCTION)) {
    const result = await rpc(fetchImpl, rpcUrl, "eth_call", [{ to: address, data: toFunctionSelector(YEARLY_MINT_RATE_FUNCTION) }, "latest"]);
    yearlyMintRate = BigInt(result);
  }
  return {
    hasCode: true,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: BigInt(totalSupply),
    implementation,
    implementationHasCode: Boolean(runCode && runCode !== "0x"),
    mintFunctions,
    yearlyMintRate,
  };
}

/** The pool DopplerHookInitializer recorded for this token, with its v4 PoolId. */
async function readDopplerState(fetchImpl, rpcUrl, address) {
  const data = encodeFunctionData({ abi: DOPPLER_STATE_ABI, functionName: "getState", args: [address] });
  const result = await rpc(fetchImpl, rpcUrl, "eth_call", [{ to: DOPPLER_HOOK_INITIALIZER, data }, "latest"]);
  const [numeraire, , , , status, poolKey] = decodeFunctionResult({ abi: DOPPLER_STATE_ABI, functionName: "getState", data: result });
  const key = {
    currency0: poolKey.currency0.toLowerCase(),
    currency1: poolKey.currency1.toLowerCase(),
    fee: Number(poolKey.fee),
    tickSpacing: Number(poolKey.tickSpacing),
    hooks: poolKey.hooks.toLowerCase(),
  };
  return {
    numeraire: numeraire.toLowerCase(),
    status: DOPPLER_POOL_STATUS[Number(status)] ?? `unknown(${status})`,
    poolKey: key,
    poolId: Number(status) === 0 ? null : v4PoolId(key),
  };
}

/**
 * Everything the checks need, read from Base, DEXScreener and GeckoTerminal.
 * A source that fails is recorded as an error for its checks, not thrown.
 */
export async function collectObservations({ address, poolId = null, fetchImpl = fetch, endpoints = DEFAULT_ENDPOINTS }) {
  const token = address.toLowerCase();
  const observations = {
    chain: null,
    chainError: null,
    doppler: null,
    dopplerError: null,
    pools: null,
    poolsError: null,
    candles: null,
    candlesError: null,
  };

  try {
    observations.chain = await readErc20(fetchImpl, endpoints.rpcUrl, token);
  } catch (error) {
    observations.chainError = errorText(error);
  }

  if (observations.chain?.hasCode) {
    try {
      observations.doppler = await readDopplerState(fetchImpl, endpoints.rpcUrl, token);
    } catch (error) {
      observations.dopplerError = errorText(error);
    }
  }

  try {
    const payload = await fetchJson(fetchImpl, `${endpoints.dexscreenerUrl}/latest/dex/tokens/${token}`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    observations.pools = (Array.isArray(payload.pairs) ? payload.pairs : [])
      .filter((pair) => pair?.chainId === "base" && pair.baseToken?.address?.toLowerCase() === token)
      .map((pair) => ({
        poolId: String(pair.pairAddress ?? ""),
        dexId: pair.dexId ?? null,
        labels: Array.isArray(pair.labels) ? pair.labels : [],
        baseSymbol: pair.baseToken?.symbol ?? null,
        quoteAddress: String(pair.quoteToken?.address ?? "").toLowerCase(),
        quoteSymbol: pair.quoteToken?.symbol ?? null,
        liquidityUsd: Number(pair.liquidity?.usd ?? 0),
        // The ETH side in USD at the pool's own ETH rate; 0 when DEXScreener does not report it.
        quoteLiquidityUsd: quoteSideUsd(pair),
        priceNative: pair.priceNative == null ? null : Number(pair.priceNative),
      }));
  } catch (error) {
    observations.poolsError = errorText(error);
  }

  const chosen = choosePool(observations.pools ?? [], poolId, observations.doppler?.poolId ?? null);
  if (chosen) {
    try {
      const url =
        `${endpoints.geckoterminalUrl}/networks/base/pools/${chosen.poolId}/ohlcv/minute` +
        `?aggregate=5&limit=${CANDLES_FETCHED}&currency=token&token=${token}`;
      const payload = await fetchJson(fetchImpl, url, { method: "GET", headers: { accept: "application/json" } });
      const list = Array.isArray(payload?.data?.attributes?.ohlcv_list) ? payload.data.attributes.ohlcv_list : [];
      observations.candles = {
        baseAddress: payload?.meta?.base?.address?.toLowerCase() ?? null,
        quoteAddress: payload?.meta?.quote?.address?.toLowerCase() ?? null,
        list: list
          .filter((candle) => Array.isArray(candle) && candle.length >= 5)
          .map((candle) => ({ at: Number(candle[0]), close: Number(candle[4]) }))
          .filter((candle) => Number.isFinite(candle.at) && Number.isFinite(candle.close) && candle.close > 0),
      };
    } catch (error) {
      observations.candlesError = errorText(error);
    }
  }
  return observations;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function quoteSideUsd(pair) {
  const quote = Number(pair.liquidity?.quote ?? 0);
  const usdPerQuote = Number(pair.priceUsd) / Number(pair.priceNative);
  const value = quote * usdPerQuote;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ── Checks (pure: no network, no clock) ─────────────────────────────────

export function isEthQuote(address) {
  return ETH_QUOTE_ADDRESSES.includes(String(address ?? "").toLowerCase());
}

/**
 * The ETH-quoted (native ETH or WETH) $HIVRA pools on Base, deepest ETH side
 * first: a Doppler pool's total "liquidity" is mostly $HIVRA, so the ETH side
 * is the depth that counts.
 */
export function ethPools(pools) {
  return pools
    .filter((pool) => isEthQuote(pool.quoteAddress))
    .sort((a, b) => (b.quoteLiquidityUsd ?? 0) - (a.quoteLiquidityUsd ?? 0) || b.liquidityUsd - a.liquidityUsd);
}

/**
 * The pinned pool when --pool-id is given; else the pool Doppler recorded for
 * the token, when DEXScreener lists it; else the deepest ETH-quoted pool.
 */
export function choosePool(pools, poolId = null, dopplerPoolId = null) {
  const candidates = ethPools(pools);
  const byId = (id) => candidates.find((pool) => pool.poolId.toLowerCase() === id.toLowerCase()) ?? null;
  if (poolId) return byId(poolId);
  return (dopplerPoolId && byId(dopplerPoolId)) || candidates[0] || null;
}

/**
 * The median close over the last PRICE_MEDIAN_WINDOW_MINUTES of 5-minute
 * buckets, each carrying the last close forward: the same reference
 * price-feed.ts checks a quote against. Null without a candle.
 */
export function medianCloseNative(candles, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  const sorted = candles.filter((candle) => candle.at <= nowSec).sort((a, b) => a.at - b.at);
  const lastBucket = nowSec - (nowSec % BUCKET_SEC);
  const firstBucket = lastBucket - (PRICE_MEDIAN_WINDOW_MINUTES / 5 - 1) * BUCKET_SEC;
  const closes = [];
  let next = 0;
  let carried = null;
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += BUCKET_SEC) {
    while (next < sorted.length && sorted[next].at <= bucket) carried = sorted[next++].close;
    if (carried !== null) closes.push(carried);
  }
  if (closes.length === 0) return null;
  closes.sort((a, b) => a - b);
  const mid = Math.floor(closes.length / 2);
  return closes.length % 2 ? closes[mid] : (closes[mid - 1] + closes[mid]) / 2;
}

function check(results, id, level, ok, detail) {
  results.push({ id, level, ok: Boolean(ok), detail });
  return Boolean(ok);
}

/**
 * Every check, from the inputs and what was observed. `ok` is true when no
 * error-level check failed; `config` is then the block to write.
 */
export function evaluateActivation({ address, activatesAt, poolId = null, nowMs, minLiquidityUsd, minQuoteLiquidityUsd, observations }) {
  const checks = [];

  // Address
  const addressOk = check(
    checks,
    "address.format",
    "error",
    EVM_ADDRESS.test(address) && !ZERO_ADDRESS.test(address),
    "a non-zero 0x-prefixed 20-byte address"
  );
  let publishedAddress = null;
  if (addressOk) {
    const notHermesos = address.toLowerCase() !== HERMESOS_ADDRESS;
    check(checks, "address.not_hermesos", "error", notHermesos, notHermesos ? "not the legacy $HermesOS contract" : "this is the legacy $HermesOS contract, not $HIVRA");
    const mixedCase = address !== address.toLowerCase() && address !== `0x${address.slice(2).toUpperCase()}`;
    const checksumOk = !mixedCase || isAddress(address, { strict: true });
    check(
      checks,
      "address.checksum",
      "error",
      checksumOk,
      mixedCase
        ? checksumOk
          ? "the EIP-55 checksum matches"
          : `the EIP-55 checksum does not match (expected ${getAddress(address.toLowerCase())}): check for a typo`
        : `no checksum in the input; writing the EIP-55 form ${getAddress(address.toLowerCase())}`
    );
    publishedAddress = getAddress(address.toLowerCase());
  }

  // Activation instant
  const instantMs = UTC_INSTANT_PATTERN.test(activatesAt) ? Date.parse(activatesAt) : Number.NaN;
  const instantOk = check(
    checks,
    "activatesAt.format",
    "error",
    Number.isFinite(instantMs) && new Date(instantMs).toISOString().slice(0, 19) === activatesAt.slice(0, 19),
    "a real UTC instant to the second, e.g. 2026-10-01T16:00:00Z"
  );
  if (instantOk) {
    const leadMs = instantMs - nowMs;
    if (check(checks, "activatesAt.future", "error", leadMs > 0, leadMs > 0 ? `in ${formatDuration(leadMs)}` : `${formatDuration(-leadMs)} ago: never paste a past instant`)) {
      check(
        checks,
        "activatesAt.lead",
        "warn",
        leadMs >= MIN_LEAD_MS,
        leadMs >= MIN_LEAD_MS
          ? "leaves time for the reviewed PR, the Canary build and the Promote"
          : `only ${formatDuration(leadMs)} away: the PR, the Canary build and, for production, the Promote must all land first (HIVRA-ACTIVATION.md precondition 5)`
      );
    }
  }

  // Nothing was read for a malformed address: only its own failure is reported.
  if (observations.skipped) return { ok: false, checks, config: null };

  // On-chain token
  const chain = observations.chain;
  if (observations.chainError) {
    check(checks, "chain.read", "error", false, `could not read the contract on Base: ${observations.chainError}`);
  } else if (chain && !chain.hasCode) {
    check(checks, "chain.code", "error", false, "no contract code at this address on Base");
  } else if (chain) {
    check(checks, "chain.code", "error", true, "contract code present on Base");
    check(checks, "chain.name", "error", chain.name === EXPECTED_TOKEN.name, `name() is ${JSON.stringify(chain.name)}, expected ${JSON.stringify(EXPECTED_TOKEN.name)}`);
    check(checks, "chain.symbol", "error", chain.symbol === EXPECTED_TOKEN.symbol, `symbol() is ${JSON.stringify(chain.symbol)}, expected ${JSON.stringify(EXPECTED_TOKEN.symbol)}`);
    check(checks, "chain.decimals", "error", chain.decimals === EXPECTED_TOKEN.decimals, `decimals() is ${chain.decimals}, expected ${EXPECTED_TOKEN.decimals}`);
    const expectedSupply = EXPECTED_TOKEN.totalSupplyWhole * 10n ** BigInt(chain.decimals);
    check(
      checks,
      "chain.total_supply",
      "error",
      chain.totalSupply === expectedSupply,
      `totalSupply() is ${formatWhole(chain.totalSupply, chain.decimals)}, expected ${formatWhole(expectedSupply, chain.decimals)}`
    );

    // Fixed supply: an immutable DopplerERC20V1 clone, no mint entry point, no inflation.
    const knownImplementation = DOPPLER_ERC20_V1_IMPLEMENTATIONS.includes(chain.implementation ?? "");
    check(
      checks,
      "chain.implementation",
      "error",
      knownImplementation && chain.implementationHasCode,
      knownImplementation
        ? chain.implementationHasCode
          ? `an EIP-1167 clone of DopplerERC20V1 ${chain.implementation}: it cannot be upgraded, and DopplerERC20V1 mints only at launch`
          : `a clone of ${chain.implementation}, which has no code on Base`
        : chain.implementation
          ? `a clone of ${chain.implementation}, not the DopplerERC20V1 implementation on Base (${DOPPLER_ERC20_V1_IMPLEMENTATIONS.join(", ")})`
          : "not a minimal-proxy clone of the DopplerERC20V1 implementation on Base: its code could mint or be upgraded"
    );
    const mintFunctions = chain.mintFunctions ?? [];
    check(
      checks,
      "chain.no_mint",
      "error",
      mintFunctions.length === 0,
      mintFunctions.length === 0
        ? `no mint entry point (${MINT_FUNCTIONS.join(", ")}) in the code that runs`
        : `the token's code has ${mintFunctions.join(", ")}: its supply could grow after launch`
    );
    check(
      checks,
      "chain.inflation",
      "error",
      chain.yearlyMintRate === null || chain.yearlyMintRate === undefined || chain.yearlyMintRate === 0n,
      chain.yearlyMintRate === null || chain.yearlyMintRate === undefined
        ? "no yearlyMintRate(): no inflation schedule"
        : chain.yearlyMintRate === 0n
          ? "yearlyMintRate() is 0"
          : `yearlyMintRate() is ${chain.yearlyMintRate} (WAD per year): the supply inflates`
    );
  }

  // The Doppler pool, as DopplerHookInitializer recorded it on Base
  const doppler = observations.doppler;
  if (observations.dopplerError) {
    check(checks, "doppler.state", "error", false, `could not read DopplerHookInitializer.getState: ${observations.dopplerError}`);
  } else if (doppler) {
    const live = doppler.status === "Initialized" || doppler.status === "Locked";
    check(
      checks,
      "doppler.state",
      "error",
      live,
      live
        ? `DopplerHookInitializer ${DOPPLER_HOOK_INITIALIZER} holds this token's pool (${doppler.status}); expected Doppler pool ${doppler.poolId}`
        : doppler.status === "Uninitialized"
          ? `DopplerHookInitializer ${DOPPLER_HOOK_INITIALIZER} has no pool for this token: not a Doppler Multicurve launch`
          : `the Doppler pool is ${doppler.status}: its liquidity has left the pool`
    );
    if (live) {
      const numeraireOk = isEthQuote(doppler.numeraire);
      check(
        checks,
        "doppler.numeraire",
        numeraireOk ? "warn" : "error",
        doppler.numeraire === EXPECTED_NUMERAIRE,
        doppler.numeraire === EXPECTED_NUMERAIRE
          ? "numeraire is native ETH (currency0 = address(0))"
          : numeraireOk
            ? `numeraire is WETH (${doppler.numeraire}), not native ETH as planned; the price feed accepts it`
            : `numeraire is ${doppler.numeraire}: the price feed prices $HIVRA only against ETH`
      );
    }
  }

  // Pricing pool
  const pool = choosePool(observations.pools ?? [], poolId, doppler?.poolId ?? null);
  let poolIdOk = false;
  let poolKeyOk = false;
  if (observations.poolsError) {
    check(checks, "pool.read", "error", false, `could not read DEXScreener: ${observations.poolsError}`);
  } else {
    const all = ethPools(observations.pools ?? []);
    const found = check(
      checks,
      "pool.found",
      "error",
      Boolean(pool),
      pool
        ? `${pool.poolId} (${[pool.dexId, ...pool.labels].filter(Boolean).join(" ")}, ${pool.baseSymbol ?? "?"}/${pool.quoteSymbol ?? "ETH"})`
        : poolId
          ? `DEXScreener lists no ETH-quoted HIVRA pool on Base with id ${poolId}`
          : "DEXScreener lists no ETH-quoted (native ETH or WETH) HIVRA pool on Base for this address"
    );
    if (found) {
      poolIdOk = check(checks, "pool.id_format", "error", POOL_ID_PATTERN.test(pool.poolId), "a Uniswap v4 pool id (0x + 64 hex) or pair address (0x + 40 hex), as token-registry.ts accepts");
      // The written pool must be the Doppler pool itself: its id is the hash of the key Doppler recorded.
      // (Without a Doppler read the chain checks have already failed; poolKeyOk stays false.)
      const key = doppler?.poolKey;
      const keyMatches =
        Boolean(doppler?.poolId) &&
        doppler.poolId === pool.poolId.toLowerCase() &&
        key.hooks === DOPPLER_HOOK_INITIALIZER &&
        (key.currency1 === address.toLowerCase() || key.currency0 === address.toLowerCase());
      if (doppler || observations.dopplerError) poolKeyOk = check(
        checks,
        "pool.doppler_key",
        "error",
        keyMatches,
        keyMatches
          ? `the Doppler pool: currency0 ${key.currency0 === NATIVE_ETH_ADDRESS ? "native ETH" : key.currency0}, currency1 ${key.currency1}, ` +
              `fee ${key.fee === V4_DYNAMIC_FEE_FLAG ? "dynamic (set by the Doppler hook)" : `${key.fee / 10_000}%`}, tickSpacing ${key.tickSpacing}, hook ${key.hooks}`
          : doppler?.poolId
            ? `not the pool Doppler recorded for this token (${doppler.poolId}); pass --pool-id ${doppler.poolId} once DEXScreener lists it`
            : "no Doppler pool on record to compare this pool with (see doppler.state)"
      );
      const others = all.filter((candidate) => candidate !== pool);
      check(
        checks,
        "pool.single",
        "warn",
        others.length === 0,
        others.length === 0
          ? "the only ETH-quoted HIVRA pool on Base"
          : `${others.length} other ETH-quoted HIVRA pool(s): ${others.map((other) => `${other.poolId} ($${Math.floor(other.quoteLiquidityUsd ?? 0)} of ETH)`).join(", ")}. The price feed will accept only the one written.`
      );
      check(
        checks,
        "pool.liquidity",
        "error",
        pool.liquidityUsd >= minLiquidityUsd,
        `$${Math.floor(pool.liquidityUsd).toLocaleString("en-US")} of liquidity; the floor is $${minLiquidityUsd.toLocaleString("en-US")} (HIVRA_MIN_PRICE_LIQUIDITY_USD). Below it every $HIVRA quote fails closed.`
      );
      const quoteUsd = pool.quoteLiquidityUsd ?? 0;
      check(
        checks,
        "pool.eth_liquidity",
        "error",
        quoteUsd >= minQuoteLiquidityUsd,
        `$${Math.floor(quoteUsd).toLocaleString("en-US")} of ETH in the pool; the ETH-side floor is $${minQuoteLiquidityUsd.toLocaleString("en-US")} ` +
          "(HIVRA_MIN_QUOTE_LIQUIDITY_USD). A Doppler pool starts almost all $HIVRA; below this floor every $HIVRA quote fails closed."
      );
    }
  }

  // Median source
  if (pool) {
    if (observations.candlesError) {
      check(checks, "candles.present", "error", false, `could not read GeckoTerminal: ${observations.candlesError}`);
    } else {
      const candles = observations.candles ?? { baseAddress: null, list: [] };
      const baseOk = !candles.baseAddress || candles.baseAddress === address.toLowerCase();
      check(checks, "candles.pool_token", "error", baseOk, baseOk ? "GeckoTerminal prices this pool for this address" : `GeckoTerminal prices this pool for ${candles.baseAddress}, not this address`);
      const quoteOk = !candles.quoteAddress || isEthQuote(candles.quoteAddress);
      check(
        checks,
        "candles.quote",
        "error",
        quoteOk,
        quoteOk
          ? `GeckoTerminal prices the candles in ETH${candles.quoteAddress === NATIVE_ETH_ADDRESS ? " (native)" : candles.quoteAddress ? " (WETH)" : ""}`
          : `GeckoTerminal prices the candles in ${candles.quoteAddress}, not ETH: the price feed refuses this pool`
      );
      const median = medianCloseNative(candles.list, nowMs);
      const hasCandle = check(
        checks,
        "candles.present",
        "error",
        median !== null,
        median !== null
          ? `${candles.list.length} five-minute candle(s) on GeckoTerminal`
          : "GeckoTerminal has no five-minute candle for this pool yet: every $HIVRA quote fails closed until it has one"
      );
      if (hasCandle) {
        const firstCandleSec = Math.min(...candles.list.map((candle) => candle.at));
        const historyMinutes = Math.floor((nowMs / 1000 - firstCandleSec) / 60);
        check(
          checks,
          "candles.history",
          "warn",
          historyMinutes >= PRICE_MEDIAN_WINDOW_MINUTES,
          historyMinutes >= PRICE_MEDIAN_WINDOW_MINUTES
            ? `at least ${PRICE_MEDIAN_WINDOW_MINUTES} minutes of candle history (first candle ${historyMinutes} minutes ago)`
            : `only ${historyMinutes} minutes of candle history: every $HIVRA quote fails closed (insufficient_history) until the pool has ${PRICE_MEDIAN_WINDOW_MINUTES} minutes of history and 24 traded five-minute periods (docs/token/HIVRA-ACTIVATION.md, section 5)`
        );
      }
      if (hasCandle && pool.priceNative) {
        const aboveBps = Math.round(((pool.priceNative - median) / median) * 10_000);
        check(
          checks,
          "candles.deviation",
          "warn",
          aboveBps <= PRICE_MAX_DEVIATION_BPS,
          `spot is ${aboveBps} bps from the ${PRICE_MEDIAN_WINDOW_MINUTES}-minute median; above ${PRICE_MAX_DEVIATION_BPS} bps, quotes pause until the median catches up`
        );
      }
    }
  }

  const ok = checks.every((result) => result.ok || result.level !== "error");
  const config =
    ok && publishedAddress && pool && poolIdOk && poolKeyOk && instantOk && observations.chain?.hasCode
      ? {
          contractAddress: publishedAddress,
          decimals: observations.chain.decimals,
          poolId: pool.poolId.toLowerCase(),
          activatesAt,
        }
      : null;
  return { ok: ok && config !== null, checks, config };
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatWhole(raw, decimals) {
  const whole = raw / 10n ** BigInt(decimals);
  const remainder = raw % 10n ** BigInt(decimals);
  return `${whole.toLocaleString("en-US")}${remainder ? `.${remainder.toString().padStart(decimals, "0").replace(/0+$/, "")}` : ""}`;
}

export function formatReport(result, { address, activatesAt }) {
  const lines = ["$HIVRA activation check (read-only)", `  address      ${address}`, `  activatesAt  ${activatesAt}`, ""];
  for (const item of result.checks) {
    const status = item.ok ? "PASS" : item.level === "error" ? "FAIL" : "WARN";
    lines.push(`${status}  ${item.id.padEnd(20)} ${item.detail}`);
  }
  const failures = result.checks.filter((item) => !item.ok && item.level === "error").length;
  const warnings = result.checks.filter((item) => !item.ok && item.level === "warn").length;
  lines.push("");
  lines.push(result.ok ? `READY (${warnings} warning(s))` : `NOT READY: ${failures} check(s) failed, ${warnings} warning(s)`);
  if (result.config) {
    lines.push("", "hivra-token-launch.ts block:", JSON.stringify(result.config, null, 2));
  }
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────

export async function main(argv, { fetchImpl = fetch, nowMs = Date.now(), stdout = console.log, stderr = console.error } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    stdout(USAGE);
    return 0;
  }

  const registrySource = readFileSync(REGISTRY_FILE, "utf8");
  const minLiquidityUsd = readMinPriceLiquidityUsd(registrySource);
  const minQuoteLiquidityUsd = readMinQuoteLiquidityUsd(registrySource);
  const addressShapeOk = EVM_ADDRESS.test(args.address);
  const observations = addressShapeOk
    ? await collectObservations({ address: args.address, poolId: args.poolId, fetchImpl })
    : { skipped: true };
  const result = evaluateActivation({
    address: args.address,
    activatesAt: args.activatesAt,
    poolId: args.poolId,
    nowMs,
    minLiquidityUsd,
    minQuoteLiquidityUsd,
    observations,
  });

  if (args.json) {
    stdout(JSON.stringify({ ...result, minLiquidityUsd, minQuoteLiquidityUsd },(_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } else {
    stdout(formatReport(result, args));
  }

  if (!args.write) return result.ok ? 0 : 1;
  if (!result.ok) {
    stderr("\nNot written: fix the failed checks above, then run it again.");
    return 1;
  }
  const current = readFileSync(LAUNCH_FILE, "utf8");
  const committed = readLaunchBlock(current);
  const dormant = !committed.contractAddress && !committed.poolId && !committed.activatesAt;
  const same = JSON.stringify(committed) === JSON.stringify(result.config);
  if (same) {
    stdout("\nhivra-token-launch.ts already has this block. Nothing written.");
    return 0;
  }
  if (!dormant) {
    stderr(
      "\nNot written: hivra-token-launch.ts already names a $HIVRA launch. Change it by hand in a reviewed PR, " +
        "after reading docs/token/HIVRA-ACTIVATION.md section 7 (rolling back)."
    );
    return 1;
  }
  writeFileSync(LAUNCH_FILE, renderLaunchSource(current, result.config));
  stdout(
    `\nWrote ${LAUNCH_FILE}.\nNothing is live yet: open a reviewed PR into canary. Production needs the same PR in main and Ash's Promote.`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    }
  );
}
