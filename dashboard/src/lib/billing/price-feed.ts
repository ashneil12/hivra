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
 *   2. Median cross-check: the reference is the median price over the last
 *      PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES of wall-clock time, from the
 *      pool's 5-minute candles on GeckoTerminal (an independent indexer).
 *      Each 5-minute bucket carries the last traded close forward, so a quiet
 *      pool still has a reference (its last price). Both sides are compared
 *      in the pool's paired token (WETH), so an ETH move while the pool is
 *      quiet is not mistaken for a token move.
 *
 * Every flow gains from a higher token price (fewer tokens to hold or pay,
 * more credit per token), so a quote is priced at min(spot, median): a pump
 * never buys a cheaper quote. A spot more than PLATFORM_PRICE_MAX_DEVIATION_BPS
 * above the median is refused outright; a spot below it is simply used.
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
  /** Price in the pair's quote token (WETH for the platform pools). */
  priceNative?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerTokensResponse {
  pairs: DexScreenerPair[] | null;
}

const DEXSCREENER_BASE_URL = "https://api.dexscreener.com";
const GECKOTERMINAL_BASE_URL = "https://api.geckoterminal.com/api/v2";

/** Spot may sit at most this far above the recent median; the quote is priced at the lower of the two. */
export const PLATFORM_PRICE_MAX_DEVIATION_BPS = 1_000;
/** The wall-clock window the reference median covers, in 5-minute buckets. */
export const PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES = 4 * 60;
const BUCKET_SEC = 5 * 60;
/**
 * Candles fetched per reference read. Candles exist only for 5-minute periods
 * with trades, so this reaches back past the window to find the last close
 * before it (the price a quiet pool opened the window at).
 */
const CANDLES_FETCHED = 1_000;
const REFERENCE_CACHE_MS = 60_000;
/** A failed reference read is reused this long, so an outage does not become a request storm (and a 429). */
const REFERENCE_FAILURE_CACHE_MS = 30_000;

/** A platform-token price failed a safety gate; quotes must not be issued. */
export class PlatformTokenPriceGateError extends Error {
  constructor(
    readonly gate: "liquidity" | "spot_unavailable" | "reference_unavailable" | "deviation" | "pool_missing",
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
  meta?: { base?: { address?: string }; quote?: { address?: string } };
}

interface PoolReference {
  /** Median price in the pool's paired token (WETH). */
  priceNative: number;
  /** Candles with trades inside the window (the rest carry a close forward). */
  candles: number;
  fetchedAtMs: number;
}

const referenceCache = new Map<string, PoolReference>();
const referenceFailures = new Map<string, { error: Error; fetchedAtMs: number }>();

/** Test seam. */
export function _resetPlatformPriceReferenceCacheForTests() {
  referenceCache.clear();
  referenceFailures.clear();
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median price of the pool over the last PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES
 * of wall-clock time, from GeckoTerminal 5-minute candles priced in the
 * pool's paired token. Each 5-minute bucket holds the close of the latest candle at
 * or before it, so buckets with no trades carry the last price forward: a
 * quiet pool keeps a reference, and a burst of trades cannot outvote hours of
 * earlier price. Throws only when the pool has no candle at all.
 */
async function fetchPoolMedianCloseNative(
  poolId: string,
  tokenAddress: string,
  options: FetchTokenPriceOptions = {}
): Promise<PoolReference> {
  const cacheKey = `${poolId}:${tokenAddress}`;
  const nowMs = Date.now();
  const cached = referenceCache.get(cacheKey);
  if (cached && nowMs - cached.fetchedAtMs < REFERENCE_CACHE_MS) return cached;
  const failed = referenceFailures.get(cacheKey);
  if (failed && nowMs - failed.fetchedAtMs < REFERENCE_FAILURE_CACHE_MS) throw failed.error;
  try {
    const reference = await readPoolMedianCloseNative(poolId, tokenAddress, nowMs, options);
    referenceCache.set(cacheKey, reference);
    referenceFailures.delete(cacheKey);
    return reference;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    referenceFailures.set(cacheKey, { error: failure, fetchedAtMs: nowMs });
    throw failure;
  }
}

async function readPoolMedianCloseNative(
  poolId: string,
  tokenAddress: string,
  nowMs: number,
  options: FetchTokenPriceOptions
): Promise<PoolReference> {
  const fetchImpl = options.fetchImpl || (fetch as FetchImpl);
  const env = options.env ?? process.env;
  const baseUrl = env.GECKOTERMINAL_BASE_URL || GECKOTERMINAL_BASE_URL;
  const url =
    `${baseUrl}/networks/base/pools/${poolId}/ohlcv/minute` +
    `?aggregate=5&limit=${CANDLES_FETCHED}&currency=token&token=${tokenAddress}`;
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
  const base = payload.meta?.base?.address?.toLowerCase();
  if (base && base !== tokenAddress.toLowerCase()) {
    throw new Error(`GeckoTerminal priced pool ${poolId} for ${base}, not ${tokenAddress}`);
  }
  const list = Array.isArray(payload.data?.attributes?.ohlcv_list) ? (payload.data!.attributes!.ohlcv_list as unknown[]) : [];
  const nowSec = Math.floor(nowMs / 1000);
  const candles = list
    .filter((c): c is number[] => Array.isArray(c) && c.length >= 5)
    .map((c) => ({ at: Number(c[0]), close: Number(c[4]) }))
    .filter((c) => Number.isFinite(c.at) && c.at <= nowSec && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => a.at - b.at);
  if (candles.length === 0) throw new Error(`GeckoTerminal has no candles for pool ${poolId}`);

  const lastBucket = nowSec - (nowSec % BUCKET_SEC);
  const buckets = PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES / 5;
  const firstBucket = lastBucket - (buckets - 1) * BUCKET_SEC;
  const closes: number[] = [];
  let next = 0;
  let carried: number | null = null;
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += BUCKET_SEC) {
    while (next < candles.length && candles[next].at <= bucket) carried = candles[next++].close;
    // Before the pool's first candle there is no price to carry: skip.
    if (carried !== null) closes.push(carried);
  }
  if (closes.length === 0) throw new Error(`GeckoTerminal has no candles for pool ${poolId} before now`);
  return {
    priceNative: median(closes),
    candles: candles.filter((c) => c.at >= firstBucket).length,
    fetchedAtMs: nowMs,
  };
}

/** A positive float as a plain decimal string with ~12 significant digits (never exponent notation). */
export function toDecimalString(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) throw new Error(`Invalid price ${value}`);
  const decimals = Math.min(100, Math.max(0, 11 - Math.floor(Math.log10(value))));
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
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
  let spot: Awaited<ReturnType<typeof fetchTokenPriceUsd>>;
  try {
    spot = await fetchTokenPriceUsd(token.address, { ...options, poolId: token.poolId });
  } catch (error) {
    if (error instanceof PlatformTokenPriceGateError) throw error;
    throw new PlatformTokenPriceGateError(
      "spot_unavailable",
      `${token.displayUnit} spot price unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const { pair, ...quote } = spot;
  const liquidityUsd = pair.liquidity?.usd ?? 0;
  if (!(liquidityUsd >= token.minPriceLiquidityUsd)) {
    throw new PlatformTokenPriceGateError(
      "liquidity",
      `${token.displayUnit} pricing pool holds $${Math.floor(liquidityUsd)}, below the $${token.minPriceLiquidityUsd} floor`
    );
  }
  const spotUsd = Number(quote.priceUsd);
  const spotNative = Number(pair.priceNative);
  if (!(spotNative > 0) || !Number.isFinite(spotNative)) {
    throw new PlatformTokenPriceGateError("spot_unavailable", `${token.displayUnit} pool has no native price`);
  }
  const reference = await referenceFor(token, pair, options);
  // Positive = spot above the median (the direction a pump pushes).
  const aboveMedianBps = Math.round(((spotNative - reference.priceNative) / reference.priceNative) * 10_000);
  if (aboveMedianBps > PLATFORM_PRICE_MAX_DEVIATION_BPS) {
    throw new PlatformTokenPriceGateError(
      "deviation",
      `${token.displayUnit} spot is ${aboveMedianBps} bps above its ${PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES}-minute median`
    );
  }
  // The median in USD at today's paired-token rate (the spot's own rate).
  const medianUsd = reference.priceNative * (spotUsd / spotNative);
  const pricedAt = aboveMedianBps > 0 ? "median" : "spot";
  return {
    ...quote,
    priceUsd: pricedAt === "median" ? toDecimalString(medianUsd) : quote.priceUsd,
    raw: {
      pair,
      gates: {
        liquidityUsd,
        minLiquidityUsd: token.minPriceLiquidityUsd,
        spotUsd: quote.priceUsd,
        medianUsd,
        medianNative: reference.priceNative,
        medianWindowMinutes: PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES,
        medianCandles: reference.candles,
        aboveMedianBps,
        pricedAt,
      },
    },
  };
}

async function referenceFor(
  token: PlatformToken,
  pair: DexScreenerPair,
  options: FetchTokenPriceOptions
): Promise<PoolReference> {
  const poolId = token.poolId ?? pair.pairAddress;
  if (!poolId) throw new PlatformTokenPriceGateError("reference_unavailable", `${token.displayUnit} pool has no address`);
  try {
    return await fetchPoolMedianCloseNative(poolId, token.address, options);
  } catch (error) {
    throw new PlatformTokenPriceGateError(
      "reference_unavailable",
      `${token.displayUnit} median cross-check unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * The recent median alone, in USD at today's paired-token rate, as a
 * cross-check quote. It is the same reference the gated price was checked
 * against, not an independent source: flows that compare the two (managed
 * Venice deposits) are applying a tighter band around the median.
 */
export async function fetchPlatformTokenPriceCrossCheck(
  token: PlatformToken,
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceCrossCheck> {
  let pair: DexScreenerPair;
  try {
    pair = (await fetchTokenPriceUsd(token.address, { ...options, poolId: token.poolId })).pair;
  } catch (error) {
    if (error instanceof PlatformTokenPriceGateError) throw error;
    throw new PlatformTokenPriceGateError(
      "spot_unavailable",
      `${token.displayUnit} spot price unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const usdPerNative = Number(pair.priceUsd) / Number(pair.priceNative);
  if (!(usdPerNative > 0) || !Number.isFinite(usdPerNative)) {
    throw new PlatformTokenPriceGateError("spot_unavailable", `${token.displayUnit} pool has no native price`);
  }
  const reference = await referenceFor(token, pair, options);
  return {
    source: "geckoterminal_ohlcv_median",
    priceUsd: toDecimalString(reference.priceNative * usdPerNative),
    // When the reference was read (it is cached briefly), not when it was asked for.
    lastUpdatedAt: Math.floor(reference.fetchedAtMs / 1000),
    raw: { medianWindowMinutes: PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES, medianCandles: reference.candles },
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
