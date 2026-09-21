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
 * Future: cross-check against the Uniswap V4 quoter on Base for
 * sanity. If two sources disagree by more than a configured tolerance
 * we should refuse to mint a quote rather than giving a bad rate.
 * Out of scope for V1 — flagged in the BACKLOG.
 */

import { HERMESOS_TOKEN_ADDRESS, VVV_TOKEN_ADDRESS } from "./token-holdings";

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
  source: "uniswap_v4_base_quoter";
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
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceQuote> {
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

  if (eligible.length === 0) {
    throw new Error(`DEXScreener returned no usable pair for ${tokenAddress}`);
  }

  // Highest-liquidity pair wins. Same default DEXScreener's UI uses.
  // A 4-figure tick on a $1 satellite pool can't move our number.
  const best = eligible.reduce((a, b) => {
    const al = a.liquidity?.usd ?? 0;
    const bl = b.liquidity?.usd ?? 0;
    return bl > al ? b : a;
  });

  return {
    priceUsd: best.priceUsd as string,
    lastUpdatedAt: Math.floor(Date.now() / 1000),
    source: "dexscreener",
    raw: best,
  };
}

export async function fetchHermesPriceUsd(
  options: FetchTokenPriceOptions = {}
): Promise<HermesPriceQuote> {
  return fetchTokenPriceUsd(HERMESOS_TOKEN_ADDRESS, options);
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

export async function fetchHermesPriceCrossCheck(): Promise<HermesPriceCrossCheck | null> {
  return null;
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
