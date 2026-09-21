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
  fetchHermesPriceUsd,
  computeTokensRequiredForUsdTarget,
  type HermesPriceQuote,
} from "./price-feed";
import {
  HERMESOS_TOKEN_DECIMALS,
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

let cached: CacheEntry | null = null;
let inFlight: Promise<HermesPriceQuote> | null = null;

/** Test seam — clears the in-process cache and any in-flight fetch. */
export function _resetLivePriceCacheForTests(): void {
  cached = null;
  inFlight = null;
}

interface GetLivePriceOptions {
  now?: Date;
  fetchImpl?: typeof fetchHermesPriceUsd;
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
  const fetchImpl = options.fetchImpl ?? fetchHermesPriceUsd;

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
  if (!inFlight) {
    inFlight = fetchImpl({ timeoutMs: PRICE_FETCH_TIMEOUT_MS })
      .then((price) => {
        cached = { price, fetchedAt: now };
        return price;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  try {
    const price = await inFlight;
    return { price, fetchedAt: cached?.fetchedAt ?? now };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (cached) {
      const age = now.getTime() - cached.fetchedAt.getTime();
      if (age >= 0 && age < STALE_TTL_MS) {
        // Visible only in server logs — caller doesn't differentiate.
        // eslint-disable-next-line no-console
        console.warn(
          `[live-thresholds] live fetch failed (${reason}); serving cached price aged ${Math.round(age / 1000)}s`
        );
        return { price: cached.price, fetchedAt: cached.fetchedAt };
      }
    }
    // eslint-disable-next-line no-console
    console.error(
      `[live-thresholds] live fetch failed (${reason}) and cache exhausted; threshold unavailable`
    );
    throw new LivePriceUnavailableError(
      `Live $HERMESOS price unavailable: ${reason}`,
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
  priceUsd: string
): bigint {
  return computeTokensRequiredForUsdTarget({
    usdTargetCents: USD_TARGET_CENTS[code],
    priceUsdPerToken: priceUsd,
    tokenDecimals: HERMESOS_TOKEN_DECIMALS,
    rounding: "up",
  }).raw;
}

/**
 * Resolve the active tier thresholds using the live $HERMESOS/USD price.
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

  const { price, fetchedAt } = await getCachedOrFreshPrice({
    now,
    fetchImpl: options.fetchImpl,
  });

  return {
    epoch,
    promoEndsAt: LAUNCH_PROMO_END_DATE,
    pro: buildResolved("pro", epoch, tokensFromUsd(proCode, price.priceUsd)),
    power: buildResolved("power", epoch, tokensFromUsd(powerCode, price.priceUsd)),
    priceUsd: price.priceUsd,
    priceFetchedAt: fetchedAt,
  };
}
