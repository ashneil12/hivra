/**
 * Live-priced tier thresholds.
 *
 * Threshold = ceil(usdTargetCents / 100 / livePriceUsd × 10^decimals).
 * Live prices come from DEXScreener via `fetchHermesPriceUsd()` and are
 * cached in-process for `LIVE_TTL_MS`. Concurrent cache-miss callers
 * dedupe through a single in-flight Promise.
 *
 * Failure modes:
 *   1. Live fetch succeeds            → returns thresholds
 *   2. Live fetch fails, cache fresh  → returns thresholds (cached price)
 *   3. Live fetch fails, cache stale  → returns thresholds (cached price, age ≤ STALE_TTL_MS)
 *   4. Otherwise                      → throws LivePriceUnavailableError
 *
 * There is intentionally NO fallback to the static token-quantity
 * constants in `tier-thresholds.ts`. Those constants were calibrated
 * against a snapshot price and would silently mislead users if the
 * price has moved. When live + stale both fail we'd rather hard-fail
 * with "try again later" than serve a wrong number.
 *
 * Existing holders are unaffected by either threshold movement OR a
 * temporary price-feed outage: `qualifying_quantity` is snapshotted at
 * first qualification on `token_tier_qualifications` and never
 * re-evaluated against a moving target.
 */

import {
  fetchPlatformTokenPriceUsd,
  PlatformTokenPriceGateError,
  computeTokensRequiredForUsdTarget,
  type HermesPriceQuote,
} from "./price-feed";
import { HERMESOS_TOKEN, type PlatformToken } from "./token-registry";
import {
  LAUNCH_PROMO_END_DATE,
  USD_TARGET_CENTS,
  type ResolvedThreshold,
  type ThresholdEpoch,
  type ThresholdTierCode,
  type TierKey,
  type TierThresholdsForEpoch,
} from "./tier-thresholds";

export const LIVE_TTL_MS = 5 * 60 * 1000;        // 5 min — serve from cache, no fetch
export const STALE_TTL_MS = 60 * 60 * 1000;      // 60 min — serve cached on fetch failure
const PRICE_FETCH_TIMEOUT_MS = 8000;

export class LivePriceUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LivePriceUnavailableError";
  }
}

export interface LiveTierThresholds extends TierThresholdsForEpoch {
  /** Live-fetched price as a precise decimal string. */
  priceUsd: string;
  /** When the underlying CoinGecko response was sampled. */
  priceFetchedAt: Date;
}

interface CacheEntry {
  price: HermesPriceQuote;
  fetchedAt: Date;
}

// One cache and one in-flight fetch per platform token, keyed by contract.
const cachedByToken = new Map<string, CacheEntry>();
const inFlightByToken = new Map<string, Promise<HermesPriceQuote>>();

/** Test seam — clears the in-process cache and any in-flight fetch. */
export function _resetLivePriceCacheForTests(): void {
  cachedByToken.clear();
  inFlightByToken.clear();
}

type PriceFetch = (options: { timeoutMs?: number }) => Promise<HermesPriceQuote>;

interface GetLivePriceOptions {
  now?: Date;
  fetchImpl?: PriceFetch;
  /** Token to price. Defaults to $HermesOS. USD targets are the same for every token. */
  token?: PlatformToken;
  /**
   * Force the launch epoch regardless of the date — used to grant the
   * founders rate to allowlisted users past the global promo window.
   * See `isFoundersRateUser` in tier-thresholds.ts.
   */
  forceLaunchEpoch?: boolean;
}

async function getCachedOrFreshPrice(
  options: GetLivePriceOptions
): Promise<{ price: HermesPriceQuote; fetchedAt: Date }> {
  const now = options.now ?? new Date();
  const token = options.token ?? HERMESOS_TOKEN;
  const fetchImpl: PriceFetch =
    options.fetchImpl ?? ((fetchOptions) => fetchPlatformTokenPriceUsd(token, fetchOptions));
  const cacheKey = token.address;

  const cached = cachedByToken.get(cacheKey);
  if (cached) {
    const age = now.getTime() - cached.fetchedAt.getTime();
    if (age >= 0 && age < LIVE_TTL_MS) {
      return { price: cached.price, fetchedAt: cached.fetchedAt };
    }
  }

  // Cache miss or stale — refresh. Concurrent callers share one fetch.
  // `fetchedAt` records the caller-supplied `now` (or wall-clock if the
  // caller didn't pass one) so cache age math stays consistent under
  // synthetic time in tests and across staggered request times in prod.
  let inFlight = inFlightByToken.get(cacheKey);
  if (!inFlight) {
    inFlight = fetchImpl({ timeoutMs: PRICE_FETCH_TIMEOUT_MS })
      .then((price) => {
        cachedByToken.set(cacheKey, { price, fetchedAt: now });
        return price;
      })
      .finally(() => {
        inFlightByToken.delete(cacheKey);
      });
    inFlightByToken.set(cacheKey, inFlight);
  }

  try {
    const price = await inFlight;
    return { price, fetchedAt: cachedByToken.get(cacheKey)?.fetchedAt ?? now };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const stale = cachedByToken.get(cacheKey);
    // A tripped safety gate (thin pool, pumped spot, missing canonical pool)
    // means the market itself is unsafe to price from right now: fail closed
    // rather than keep an older price for up to STALE_TTL_MS. Only a source
    // outage falls back to the cached price.
    const sourceOutage =
      !(error instanceof PlatformTokenPriceGateError) ||
      error.gate === "spot_unavailable" ||
      error.gate === "reference_unavailable";
    if (stale && sourceOutage) {
      const age = now.getTime() - stale.fetchedAt.getTime();
      if (age >= 0 && age < STALE_TTL_MS) {
        // Visible only in server logs — caller doesn't differentiate.
        // eslint-disable-next-line no-console
        console.warn(
          `[live-thresholds] live ${token.displayUnit} fetch failed (${reason}); serving cached price aged ${Math.round(age / 1000)}s`
        );
        return { price: stale.price, fetchedAt: stale.fetchedAt };
      }
    }
    // eslint-disable-next-line no-console
    console.error(
      `[live-thresholds] live ${token.displayUnit} fetch failed (${reason}) and cache exhausted; threshold unavailable`
    );
    throw new LivePriceUnavailableError(
      `Live ${token.displayUnit} price unavailable: ${reason}`,
      error
    );
  }
}

function buildResolved(
  tier: TierKey,
  epoch: ThresholdEpoch,
  amount: bigint
): ResolvedThreshold {
  const code = `${tier.toUpperCase()}_${epoch.toUpperCase()}` as ThresholdTierCode;
  return { tier, epoch, code, amount };
}

function tokensFromUsd(
  code: ThresholdTierCode,
  priceUsd: string,
  tokenDecimals: number
): bigint {
  return computeTokensRequiredForUsdTarget({
    usdTargetCents: USD_TARGET_CENTS[code],
    priceUsdPerToken: priceUsd,
    tokenDecimals,
    rounding: "up",
  }).raw;
}

/**
 * Resolve the active tier thresholds in `options.token` (default $HermesOS)
 * using its live USD price. The USD targets, and so the launch/founders
 * discounts, are the same for every platform token.
 * Throws {@link LivePriceUnavailableError} when neither live nor cached
 * price is available — callers must decide whether to skip the work
 * (cron writer) or surface a 503 to the user (HTTP route).
 */
export async function getLiveActiveThresholds(
  options: GetLivePriceOptions = {}
): Promise<LiveTierThresholds> {
  const now = options.now ?? new Date();
  const inLaunchWindow = options.forceLaunchEpoch === true || now < LAUNCH_PROMO_END_DATE;
  const epoch: ThresholdEpoch = inLaunchWindow ? "launch" : "standard";

  const proCode: ThresholdTierCode = inLaunchWindow ? "PRO_LAUNCH" : "PRO_STANDARD";
  const powerCode: ThresholdTierCode = inLaunchWindow ? "POWER_LAUNCH" : "POWER_STANDARD";

  const token = options.token ?? HERMESOS_TOKEN;
  const { price, fetchedAt } = await getCachedOrFreshPrice({
    now,
    fetchImpl: options.fetchImpl,
    token,
  });

  return {
    epoch,
    promoEndsAt: LAUNCH_PROMO_END_DATE,
    pro: buildResolved("pro", epoch, tokensFromUsd(proCode, price.priceUsd, token.decimals)),
    power: buildResolved("power", epoch, tokensFromUsd(powerCode, price.priceUsd, token.decimals)),
    priceUsd: price.priceUsd,
    priceFetchedAt: fetchedAt,
  };
}
