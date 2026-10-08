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
import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, isAddress } from "viem";

export const DEFAULT_ENDPOINTS = Object.freeze({
  rpcUrl: "https://mainnet.base.org",
  dexscreenerUrl: "https://api.dexscreener.com",
  geckoterminalUrl: "https://api.geckoterminal.com/api/v2",
});

/** What the Bankr launch must have produced. The platform code expects exactly these. */
export const EXPECTED_TOKEN = Object.freeze({
  name: "Hivra",
  symbol: "HIVRA",
  decimals: 18,
  totalSupplyWhole: 100_000_000_000n,
});

/** WETH on Base: the paired token of the pool that prices $HIVRA. */
export const BASE_WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
/** The legacy $HermesOS contract (token-registry.ts), never a valid $HIVRA address. */
export const HERMESOS_ADDRESS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";

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
--pool-id  use this HIVRA/WETH pool instead of the deepest one
--write    when every check passes, fill in src/lib/billing/hivra-token-launch.ts
--json     print the result as JSON`;

// ── Registry values ─────────────────────────────────────────────────────

/** The $HIVRA liquidity floor, read from token-registry.ts so a reviewed change there applies here too. */
export function readMinPriceLiquidityUsd(registrySource) {
  const match = /export const HIVRA_MIN_PRICE_LIQUIDITY_USD = ([\d_]+);/.exec(registrySource);
  if (!match) throw new Error("HIVRA_MIN_PRICE_LIQUIDITY_USD not found in token-registry.ts");
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
  return { hasCode: true, name, symbol, decimals: Number(decimals), totalSupply: BigInt(totalSupply) };
}

/**
 * Everything the checks need, read from Base, DEXScreener and GeckoTerminal.
 * A source that fails is recorded as an error for its checks, not thrown.
 */
export async function collectObservations({ address, poolId = null, fetchImpl = fetch, endpoints = DEFAULT_ENDPOINTS }) {
  const token = address.toLowerCase();
  const observations = { chain: null, chainError: null, pools: null, poolsError: null, candles: null, candlesError: null };

  try {
    observations.chain = await readErc20(fetchImpl, endpoints.rpcUrl, token);
  } catch (error) {
    observations.chainError = errorText(error);
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
        priceNative: pair.priceNative == null ? null : Number(pair.priceNative),
      }));
  } catch (error) {
    observations.poolsError = errorText(error);
  }

  const chosen = choosePool(observations.pools ?? [], poolId);
  if (chosen) {
    try {
      const url =
        `${endpoints.geckoterminalUrl}/networks/base/pools/${chosen.poolId}/ohlcv/minute` +
        `?aggregate=5&limit=${CANDLES_FETCHED}&currency=token&token=${token}`;
      const payload = await fetchJson(fetchImpl, url, { method: "GET", headers: { accept: "application/json" } });
      const list = Array.isArray(payload?.data?.attributes?.ohlcv_list) ? payload.data.attributes.ohlcv_list : [];
      observations.candles = {
        baseAddress: payload?.meta?.base?.address?.toLowerCase() ?? null,
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

// ── Checks (pure: no network, no clock) ─────────────────────────────────

/** The HIVRA/WETH pools on Base, deepest first. */
export function wethPools(pools) {
  return pools
    .filter((pool) => pool.quoteAddress === BASE_WETH_ADDRESS)
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

/** The pinned pool when --pool-id is given, else the deepest HIVRA/WETH pool. */
export function choosePool(pools, poolId = null) {
  const candidates = wethPools(pools);
  if (poolId) return candidates.find((pool) => pool.poolId.toLowerCase() === poolId.toLowerCase()) ?? null;
  return candidates[0] ?? null;
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
export function evaluateActivation({ address, activatesAt, poolId = null, nowMs, minLiquidityUsd, observations }) {
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
  }

  // Pricing pool
  const pool = choosePool(observations.pools ?? [], poolId);
  let poolIdOk = false;
  if (observations.poolsError) {
    check(checks, "pool.read", "error", false, `could not read DEXScreener: ${observations.poolsError}`);
  } else {
    const all = wethPools(observations.pools ?? []);
    const found = check(
      checks,
      "pool.found",
      "error",
      Boolean(pool),
      pool
        ? `${pool.poolId} (${[pool.dexId, ...pool.labels].filter(Boolean).join(" ")}, ${pool.baseSymbol ?? "?"}/${pool.quoteSymbol ?? "WETH"})`
        : poolId
          ? `DEXScreener lists no HIVRA/WETH pool on Base with id ${poolId}`
          : "DEXScreener lists no HIVRA/WETH pool on Base for this address"
    );
    if (found) {
      poolIdOk = check(checks, "pool.id_format", "error", POOL_ID_PATTERN.test(pool.poolId), "a Uniswap v4 pool id (0x + 64 hex) or pair address (0x + 40 hex), as token-registry.ts accepts");
      const others = all.filter((candidate) => candidate !== pool);
      check(
        checks,
        "pool.single",
        "warn",
        others.length === 0,
        others.length === 0
          ? "the only HIVRA/WETH pool on Base"
          : `${others.length} other HIVRA/WETH pool(s): ${others.map((other) => `${other.poolId} ($${Math.floor(other.liquidityUsd)})`).join(", ")}. The price feed will accept only the one written.`
      );
      check(
        checks,
        "pool.liquidity",
        "error",
        pool.liquidityUsd >= minLiquidityUsd,
        `$${Math.floor(pool.liquidityUsd).toLocaleString("en-US")} of liquidity; the floor is $${minLiquidityUsd.toLocaleString("en-US")} (HIVRA_MIN_PRICE_LIQUIDITY_USD). Below it every $HIVRA quote fails closed.`
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
    ok && publishedAddress && pool && poolIdOk && instantOk && observations.chain?.hasCode
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

  const minLiquidityUsd = readMinPriceLiquidityUsd(readFileSync(REGISTRY_FILE, "utf8"));
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
    observations,
  });

  if (args.json) {
    stdout(JSON.stringify({ ...result, minLiquidityUsd }, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
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
