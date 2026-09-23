/**
 * Live $HERMESOS/USD price feed.
 *
 * Source: DEXScreener's free /latest/dex/tokens/{address} endpoint.
 * It returns every Uniswap pair the token appears in, with priceUsd
 * already de-quoted through DEXScreener's WETH/USD oracle. We pick the
 * pair with the highest USD liquidity — the same pair DEXScreener's UI
 * surfaces by default — so a tiny, stale satellite pool can't poison
 * the price.
 *
 * Why DEXScreener over CoinGecko: their /simple/token_price aggregator
 * round-trips through a JS Number with only ~3 sig figs of precision
 * for sub-cent tokens, AND only re-prices low-liquidity Base tokens
 * when their internal freshness threshold trips. DEXScreener publishes
 * per-block, full-precision strings.
 *
 * No auth required. Rate-limited to 300 req/min/IP — well above
 * anything we'd push from the deposit-quote flow even with no caching.
 *
 * Platform tokens ($HermesOS, $HIVRA) are priced with two gates, and every
 * quote or live threshold fails closed when either fails:
 *
 *   1. Liquidity floor: the pricing pool (the registry's canonical pool when
 *      set, else the highest-liquidity Base pair) must hold at least the
 *      token's minPriceLiquidityUsd. A thin pool is what makes
 *      pump-quote-dump profitable.
 *   2. Median cross-check: the spot price must sit within
 *      PLATFORM_PRICE_MAX_DEVIATION_BPS of the MEDIAN close of the pool's
 *      recent 5-minute candles from GeckoTerminal (an independent indexer).
 *      A price pumped just before a quote is far from that median and is
 *      refused until the move has persisted across several candles.
 */

import { VVV_TOKEN_ADDRESS } from "./token-holdings";
import { HERMESOS_TOKEN, type PlatformToken } from "./token-registry";

export interface HermesPriceQuote {
  /**
   * USD price per whole HERMESOS token, as a precise decimal STRING
   * (e.g. "0.000002250"). Always emitted as a string — JS Number can't
   * represent the precision we need without rounding artifacts.
   */
  priceUsd: string;
  /**
   * Unix timestamp (seconds) of when the price was sampled. DEXScreener
   * doesn't expose a per-pair "last trade" timestamp on this endpoint;
   * pricing is updated per-block, so we record the fetch time itself.
   */
  lastUpdatedAt: number;
  /**
   * The price source. Older quote rows persisted with "coingecko_v3"
   * before the DEXScreener swap; new rows will be "dexscreener". Kept
   * as a union so legacy rows still type-check on read.
   */
  source: "coingecko_v3" | "dexscreener";
  /**
   * The raw response payload, retained as `metadata` for the quote
   * row so we can audit later.
   */
  raw: unknown;
}

export type HermesPriceCrossCheck = {
  source: "uniswap_v4_base_quoter" | "geckoterminal_ohlcv_median";
  priceUsd: string;
  lastUpdatedAt: number;
  raw?: unknown;
};

interface DexScreenerPair {
  chainId: string;
  dexId?: string;
  labels?: string[];
  pairAddress?: string;
  baseToken: { address: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerTokensResponse {
  pairs: DexScreenerPair[] | null;
}

const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";
const GECKOTERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";

/** Spot may differ from the recent median close by at most this much. */
export const PLATFORM_PRICE_MAX_DEVIATION_BPS = 1_000;
/** How many of the pool's most recent 5-minute candles the median uses. */
export const PLATFORM_PRICE_MEDIAN_CANDLES = 12;
/** Fewer candles than this in the last day = not enough history to trust. */
export const PLATFORM_PRICE_MIN_CANDLES = 3;
const CANDLE_LOOKBACK_SEC = 24 * 60 * 60;
const REFERENCE_CACHE_MS = 60_000;

/** A platform-token price failed a safety gate; quotes must not be issued. */
export class PlatformTokenPriceGateError extends Error {
  constructor(
    readonly gate: "liquidity" | "reference_unavailable" | "deviation" | "pool_missing",
    message: string
  ) {
    super(message);
    this.name = "PlatformTokenPriceGateError";
  }
}

type FetchImpl = typeof fetch;

interface FetchTokenPriceOptions {
  fetchImpl?: FetchImpl;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/**
 * Generic DEX price lookup for any Base ERC-20 by contract address.
 * Picks the highest-USD-liquidity Base pair where the token is the base
 * token. Shared by the $HERMESOS tier-threshold path and the VVV
 * compute-boost valuation — same oracle, same precision guarantees.
 *
 * Internal: callers use the fetchHermesPriceUsd / fetchVvvPriceUsd wrappers.
 */
async function fetchTokenPriceUsd(
  tokenAddress: string,
  options: FetchTokenPriceOptions & { poolId?: string | null } = {}
): Promise<HermesPriceQuote & { pair: DexScreenerPair }> {
  const fetchImpl = options.fetchImpl || (fetch as FetchImpl);
  const env = options.env ?? process.env;
  const baseUrl = env.DEXSCREENER_BASE_URL || DEXSCREENER_BASE_URL;

  const url = `${baseUrl}/latest/dex/tokens/${tokenAddress}`;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 8000;
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!response.ok) {
    throw new Error(
      `DEXScreener price fetch failed status=${response.status}`
    );
  }

  const payload = (await response.json()) as DexScreenerTokensResponse;
  const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
  const tokenLower = tokenAddress.toLowerCase();

  // Only Base pairs where the target token is the base token, with a
  // valid USD price string. Excluding pairs where it's the quote token
  // avoids accidentally inverting the ratio.
  const eligible = pairs.filter(
    (p) =>
      p.chainId === "base" &&
      p.baseToken?.address?.toLowerCase() === tokenLower &&
      typeof p.priceUsd === "string" &&
      /^\d+(\.\d+)?$/.test(p.priceUsd)
  );

  // A canonical pool, when the registry names one, is the only pool that
  // prices the token: a satellite pool can never be chosen instead.
  const candidates = options.poolId
    ? eligible.filter((p) => p.pairAddress?.toLowerCase() === options.poolId!.toLowerCase())
    : eligible;

  if (candidates.length === 0) {
    if (options.poolId && eligible.length > 0) {
      throw new PlatformTokenPriceGateError(
        "pool_missing",
        `DEXScreener has no pair for the canonical pool ${options.poolId}`
      );
    }
    throw new Error(`DEXScreener returned no usable pair for ${tokenAddress}`);
  }

  // Highest-liquidity pair wins. Same default DEXScreener's UI uses.
  // A 4-figure tick on a $1 satellite pool can't move our number.
  const best = candidates.reduce((a, b) => {
    const al = a.liquidity?.usd ?? 0;
    const bl = b.liquidity?.usd ?? 0;
    return bl > al ? b : a;
  });

  return {
    priceUsd: best.priceUsd as string,
    lastUpdatedAt: Math.floor(Date.now() / 1000),
    source: "dexscreener",
    raw: best,
    pair: best,
  };
}

interface GeckoOhlcvResponse {
  data?: { attributes?: { ohlcv_list?: unknown } };
}

const referenceCache = new Map<string, { priceUsd: number; candles: number; fetchedAtMs: number }>();

/** Test seam. */
export function _resetPlatformPriceReferenceCacheForTests() {
  referenceCache.clear();
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median close of the pool's most recent 5-minute candles (GeckoTerminal,
 * priced in USD for the token side). Candles exist only when the pool trades,
 * so this is a median over recent trading, not over wall-clock time.
 */
async function fetchPoolMedianCloseUsd(
  poolId: string,
  tokenAddress: string,
  options: FetchTokenPriceOptions = {}
): Promise<{ priceUsd: number; candles: number }> {
  const cacheKey = `${poolId}:${tokenAddress}`;
  const nowMs = Date.now();
  const cached = referenceCache.get(cacheKey);
  if (cached && nowMs - cached.fetchedAtMs < REFERENCE_CACHE_MS) return cached;

  const fetchImpl = options.fetchImpl || (fetch as FetchImpl);
  const env = options.env ?? process.env;
  const baseUrl = env.GECKOTERMINAL_BASE_URL || GECKOTERMINAL_BASE_URL;
  const url =
    `${baseUrl}/networks/base/pools/${poolId}/ohlcv/minute` +
    `?aggregate=5&limit=${PLATFORM_PRICE_MEDIAN_CANDLES}&currency=usd&token=${tokenAddress}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!response.ok) throw new Error(`GeckoTerminal OHLCV fetch failed status=${response.status}`);
  const payload = (await response.json()) as GeckoOhlcvResponse;
  const list = Array.isArray(payload.data?.attributes?.ohlcv_list) ? (payload.data!.attributes!.ohlcv_list as unknown[]) : [];
  const cutoffSec = Math.floor(nowMs / 1000) - CANDLE_LOOKBACK_SEC;
  const closes = list
    .filter((c): c is number[] => Array.isArray(c) && c.length >= 5)
    .filter((c) => Number(c[0]) >= cutoffSec)
    .map((c) => Number(c[4]))
    .filter((close) => Number.isFinite(close) && close > 0);
  if (closes.length < PLATFORM_PRICE_MIN_CANDLES) {
    throw new Error(`GeckoTerminal has ${closes.length} recent candles for pool ${poolId}; need ${PLATFORM_PRICE_MIN_CANDLES}`);
  }
  const reference = { priceUsd: median(closes), candles: closes.length, fetchedAtMs: nowMs };
  referenceCache.set(cacheKey, reference);
  return reference;
}

/** A positive float as a plain decimal string with ~12 significant digits (never exponent notation). */
export function toDecimalString(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`Invalid price ${value}`);
  const decimals = Math.min(100, Math.max(0, 11 - Math.floor(Math.log10(value))));
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

function deviationBps(spot: number, reference: number) {
  return Math.round((Math.abs(spot - reference) / reference) * 10_000);
}

/**
 * Live USD price of a platform token ($HermesOS or $HIVRA), gated: the pool
 * must meet the token's liquidity floor and the spot must agree with the
 * pool's recent median close. Throws PlatformTokenPriceGateError otherwise;
 * callers fail closed (no quote, no new threshold).
 */
export async function fetchPlatformTokenPriceUsd(
  token: PlatformToken,
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceQuote> {
  const { pair, ...quote } = await fetchTokenPriceUsd(token.address, { ...options, poolId: token.poolId });
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  if (!(liquidityUsd >= token.minPriceLiquidityUsd)) {
    throw new PlatformTokenPriceGateError(
      "liquidity",
      `${token.displayUnit} pricing pool holds $${Math.floor(liquidityUsd)}, below the $${token.minPriceLiquidityUsd} floor`
    );
  }
  const poolId = token.poolId ?? pair.pairAddress;
  if (!poolId) throw new PlatformTokenPriceGateError("reference_unavailable", `${token.displayUnit} pool has no address`);
  let reference: { priceUsd: number; candles: number };
  try {
    reference = await fetchPoolMedianCloseUsd(poolId, token.address, options);
  } catch (error) {
    throw new PlatformTokenPriceGateError(
      "reference_unavailable",
      `${token.displayUnit} median cross-check unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const deviation = deviationBps(Number(quote.priceUsd), reference.priceUsd);
  if (deviation > PLATFORM_PRICE_MAX_DEVIATION_BPS) {
    throw new PlatformTokenPriceGateError(
      "deviation",
      `${token.displayUnit} spot ${quote.priceUsd} is ${deviation} bps from its recent median ${reference.priceUsd}`
    );
  }
  return {
    ...quote,
    raw: {
      pair,
      gates: {
        liquidityUsd,
        minLiquidityUsd: token.minPriceLiquidityUsd,
        medianCloseUsd: reference.priceUsd,
        medianCandles: reference.candles,
        deviationBps: deviation,
      },
    },
  };
}

/**
 * The same recent-median reference as a cross-check quote (for flows that
 * compare two sources explicitly, e.g. managed Venice deposits).
 */
export async function fetchPlatformTokenPriceCrossCheck(
  token: PlatformToken,
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceCrossCheck> {
  let poolId = token.poolId;
  if (!poolId) poolId = (await fetchTokenPriceUsd(token.address, options)).pair.pairAddress ?? null;
  if (!poolId) throw new PlatformTokenPriceGateError("reference_unavailable", `${token.displayUnit} pool has no address`);
  const reference = await fetchPoolMedianCloseUsd(poolId, token.address, options);
  return {
    source: "geckoterminal_ohlcv_median",
    priceUsd: toDecimalString(reference.priceUsd),
    lastUpdatedAt: Math.floor(Date.now() / 1000),
    raw: { medianCandles: reference.candles },
  };
}

export async function fetchHermesPriceUsd(
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceQuote> {
  return fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, options);
}

/**
 * Live VVV/USD price via DEX. Used to value a user's VVV holding for the
 * Venice compute-boost ($199-held → +1 vCPU / +2 GB) entitlement.
 */
export async function fetchVvvPriceUsd(
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceQuote> {
  return fetchTokenPriceUsd(VVV_TOKEN_ADDRESS, options);
}

export function isHermesPriceFresh(
  quote: Pick<HermesPriceQuote, "lastUpdatedAt">,
  now: Date = new Date(),
  maxAgeMs = 5 * 60 * 1000
): boolean {
  return now.getTime() - quote.lastUpdatedAt * 1000 <= maxAgeMs;
}

export async function fetchHermesPriceCrossCheck(
  token: PlatformToken = HERMESOS_TOKEN
): Promise<HermesPriceCrossCheck | null> {
  return fetchPlatformTokenPriceCrossCheck(token);
}

/**
 * Convert a USD-cents target plus a price-per-whole-token string into
 * the EXACT base-units quantity required (× 10^decimals).
 *
 * Math:
 *   tokensWhole   = ⌈(usdCents / 100) / priceUsdPerToken⌉   (whole tokens, ceiling)
 *   tokensBase    = tokensWhole × 10^decimals
 *
 * The result is ALWAYS an integer number of whole tokens — fractional
 * tokens are rounded up. This is intentional UX: the user sends round
 * numbers ("38,022,814 Hivra") instead of awkward decimals
 * ("38022813.6882129277566 Hivra"). Ceiling means they always
 * satisfy the USD target.
 */
export function computeTokensRequiredForUsdTarget(params: {
  usdTargetCents: number;
  priceUsdPerToken: string;
  tokenDecimals: number;
  /**
   * Round-up vs round-down at the WHOLE-TOKEN level. Default 'up' so
   * the user is always at-or-above the USD target.
   */
  rounding?: "up" | "down";
}): { raw: bigint; display: string; wholeTokens: bigint } {
  if (params.usdTargetCents <= 0) {
    throw new Error("usdTargetCents must be positive");
  }
  if (params.tokenDecimals < 0 || params.tokenDecimals > 36) {
    throw new Error("tokenDecimals out of range");
  }

  // Parse price string into (priceInteger, priceFractionDigits).
  // E.g. "0.00000255" → priceInteger = 255n, priceFractionDigits = 8
  //      "1.5"        → priceInteger = 15n, priceFractionDigits = 1
  //      "10"         → priceInteger = 10n, priceFractionDigits = 0
  const priceStr = params.priceUsdPerToken.trim();
  if (!/^\d+(\.\d+)?$/.test(priceStr)) {
    throw new Error(`Invalid price: ${priceStr}`);
  }
  const [whole, fraction = ""] = priceStr.split(".");
  const priceFractionDigits = fraction.length;
  const priceInteger = BigInt(whole + fraction);
  if (priceInteger <= 0n) {
    throw new Error("Price must be positive");
  }

  // wholeTokens = ⌈(usdCents × 10^fractionDigits) / (100 × priceInteger)⌉
  //
  // Compute as integer division at the whole-token level, then scale
  // to base units. This produces a clean integer base-units value
  // (e.g. 38_022_814n × 10^18n) — display shows a whole number.
  const numerator =
    BigInt(params.usdTargetCents) * 10n ** BigInt(priceFractionDigits);
  const denominator = 100n * priceInteger;

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const wholeTokens =
    (params.rounding ?? "up") === "up" && remainder > 0n
      ? quotient + 1n
      : quotient;

  const raw = wholeTokens * 10n ** BigInt(params.tokenDecimals);
  const display = wholeTokens.toString();

  return { raw, display, wholeTokens };
}
