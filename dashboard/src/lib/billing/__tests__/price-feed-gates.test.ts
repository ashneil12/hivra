/** @jest-environment node */
import {
  PLATFORM_PRICE_MAX_DEVIATION_BPS,
  PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES,
  PLATFORM_PRICE_MIN_HISTORY_MINUTES,
  PLATFORM_PRICE_MIN_TRADED_CANDLES,
  PlatformTokenPriceGateError,
  _resetPlatformPriceReferenceCacheForTests,
  fetchPlatformTokenPriceCrossCheck,
  fetchPlatformTokenPriceCrossCheckForQuote,
  fetchPlatformTokenPriceUsd,
  priceGateRefusalFromError,
  toDecimalString,
} from "@/lib/billing/price-feed";
import { LivePriceUnavailableError } from "@/lib/billing/live-thresholds";
import {
  BASE_WETH_ADDRESS,
  HERMESOS_POOL_ID,
  HERMESOS_TOKEN,
  HIVRA_MIN_PRICE_LIQUIDITY_USD,
  HIVRA_MIN_QUOTE_LIQUIDITY_USD,
  NATIVE_ETH_ADDRESS,
  validateHivraLaunchConfig,
  type PlatformToken,
} from "@/lib/billing/token-registry";

const TOKEN = HERMESOS_TOKEN.address;
const SATELLITE = `0x${"99".repeat(32)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * A DEXScreener pair. By default the paired token is worth $1, so native and
 * USD prices are equal and candle closes read as USD; `usdPerNative` changes
 * that (an ETH move).
 */
function pair(pairAddress: string, priceUsd: string, liquidityUsd: number, usdPerNative = 1) {
  return {
    chainId: "base",
    pairAddress,
    baseToken: { address: TOKEN },
    quoteToken: { address: BASE_WETH_ADDRESS, symbol: "WETH" },
    priceUsd,
    priceNative: String(Number(priceUsd) / usdPerNative),
    liquidity: { usd: liquidityUsd },
  };
}

/** Traded candles a mature pool has before the listed ones (enough for the history gate). */
const MATURE_HISTORY_CANDLES = 30;

/**
 * `closes` are one per 5-minute candle, newest first (the first, age 0, is
 * still in progress); `candles` are explicit [ageMinutes, close] pairs for
 * pools that do not trade every 5 minutes. A pool is mature unless `young`:
 * MATURE_HISTORY_CANDLES traded candles at the oldest listed close, all older
 * than the median window and the listed candles, come first.
 */
function fakeFetch(opts: {
  pairs: unknown[];
  closes?: number[];
  candles?: [number, number][];
  geckoStatus?: number;
  young?: boolean;
}) {
  return jest.fn(async (url: string) => {
    if (url.includes("dexscreener")) {
      return { ok: true, status: 200, json: async () => ({ pairs: opts.pairs }) } as unknown as Response;
    }
    if (opts.geckoStatus && opts.geckoStatus !== 200) {
      return { ok: false, status: opts.geckoStatus, json: async () => ({}) } as unknown as Response;
    }
    const listed = opts.candles ?? (opts.closes ?? []).map((close, i): [number, number] => [i * 5, close]);
    const oldest = listed.reduce<[number, number] | null>((found, candle) => (!found || candle[0] > found[0] ? candle : found), null);
    const history: [number, number][] =
      opts.young || !oldest
        ? []
        : Array.from({ length: MATURE_HISTORY_CANDLES }, (_, i): [number, number] => [
            Math.max(oldest[0], PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES) + 5 * (i + 1),
            oldest[1],
          ]);
    const candles = [...listed, ...history];
    const list = candles.map(([ageMinutes, close]) => [nowSec() - ageMinutes * 60, close, close, close, close, 1]);
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: list } } }) } as unknown as Response;
  });
}

function env() {
  return { DEXSCREENER_BASE_URL: "https://dexscreener.test", GECKOTERMINAL_BASE_URL: "https://geckoterminal.test" };
}

beforeEach(() => _resetPlatformPriceReferenceCacheForTests());

describe("platform token price gates", () => {
  it("prices from the canonical pool when spot agrees with the recent median and liquidity is enough", async () => {
    const fetchImpl = fakeFetch({
      pairs: [pair(SATELLITE, "0.000009", 500_000), pair(HERMESOS_POOL_ID, "0.000001100", 80_000)],
      closes: [0.00000109, 0.0000011, 0.00000111, 0.00000112],
    });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    // The satellite pool is ignored even though it is deeper and pricier.
    expect(Number(quote.priceUsd)).toBeCloseTo(0.0000011, 12);
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining(`/pools/${HERMESOS_POOL_ID}/ohlcv/minute`), expect.anything());
    // The median is read in the paired token, not in USD.
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("currency=token"), expect.anything());
  });

  it("fails closed below the liquidity floor", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 9_999)], closes: [0.0000011, 0.0000011, 0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      name: "PlatformTokenPriceGateError",
      gate: "liquidity",
    });
  });

  it("fails closed when the spot was pumped away from the recent median", async () => {
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.0000013", 80_000)], // +18% vs median
      closes: [0.0000011, 0.0000011, 0.0000011, 0.00000111],
    });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "deviation",
    });
    expect(PLATFORM_PRICE_MAX_DEVIATION_BPS).toBe(1_000);
  });

  it("fails closed when the median source is down or the pool has never traded", async () => {
    const down = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 503 });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: down as never, env: env() })).rejects.toMatchObject({
      gate: "reference_unavailable",
    });
    _resetPlatformPriceReferenceCacheForTests();
    const never = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles: [] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: never as never, env: env() })).rejects.toMatchObject({
      gate: "reference_unavailable",
    });
  });

  it("maps a spot-source outage to a gate error (503), not a 500", async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response);
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      name: "PlatformTokenPriceGateError",
      gate: "spot_unavailable",
    });
  });

  it("keeps a quiet pool quotable: its last trade, hours ago, is still the reference", async () => {
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.00000105", 80_000)],
      candles: [[30 * 60, 0.000001]], // one trade, 30 hours ago
    });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    // Spot is 5% above that median: allowed, but priced at the median.
    expect(quote.priceUsd).toBe("0.000001");
    expect(quote.raw).toMatchObject({ gates: { medianNative: 0.000001, medianCandles: 0, aboveMedianBps: 500, pricedAt: "median" } });
  });

  it("prices a real drop at the lower spot instead of blocking quotes", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000006", 80_000)], candles: [[60, 0.000001]] });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(quote.priceUsd).toBe("0.0000006");
    expect(quote.raw).toMatchObject({ gates: { pricedAt: "spot" } });
  });

  it("does not mistake an ETH move in a quiet pool for a token move", async () => {
    // No trades for two days; ETH is up 20%, so the USD spot is 20% above the
    // last USD close, but the price in WETH has not moved.
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000012", 80_000, 1.2)], candles: [[48 * 60, 0.000001]] });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(quote.raw).toMatchObject({ gates: { aboveMedianBps: 0, pricedAt: "spot" } });
    expect(Number(quote.priceUsd)).toBeCloseTo(0.0000012, 12);
  });

  it("fails closed as a misconfigured pool when GeckoTerminal prices another token", async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes("dexscreener")) {
        return { ok: true, status: 200, json: async () => ({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)] }) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { attributes: { ohlcv_list: [[nowSec(), 1, 1, 1, 0.0000011, 1]] } },
          meta: { base: { address: "0x4200000000000000000000000000000000000006" } },
        }),
      } as unknown as Response;
    });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
    });
  });

  it("fails closed without a native price for the pair", async () => {
    const noNative = { ...pair(HERMESOS_POOL_ID, "0.0000011", 80_000), priceNative: undefined };
    const fetchImpl = fakeFetch({ pairs: [noNative], closes: [0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "spot_unavailable",
    });
  });

  it("reuses a failed reference read briefly instead of hammering the source", async () => {
    const down = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 429 });
    for (let i = 0; i < 3; i++) {
      await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: down as never, env: env() })).rejects.toMatchObject({
        gate: "reference_unavailable",
      });
    }
    expect(down.mock.calls.filter(([url]) => String(url).includes("geckoterminal"))).toHaveLength(1);
  });

  it("weighs wall-clock time, not trade count: a burst of pumped trades cannot move the median", async () => {
    // 40 trades in 4 completed minutes.
    const burst = Array.from({ length: 40 }, (_, i): [number, number] => [5 + i * 0.1, 0.0000013]);
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.0000013", 80_000)],
      candles: [...burst, [3 * 60, 0.000001]],
    });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "deviation",
    });
  });

  it("accepts a move once it has held for over half the window", async () => {
    const half = PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES / 2;
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.0000013", 80_000)],
      candles: [[half + 10, 0.0000013], [PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES + 60, 0.000001]],
    });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(quote.priceUsd).toBe("0.0000013");
  });

  it("fails closed when the canonical pool is missing from the price source", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(SATELLITE, "0.0000011", 500_000)], closes: [0.0000011, 0.0000011, 0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
    });
  });

  it("refuses a young pool's pumped price even when its few candles agree with the spot", async () => {
    // The pool first traded 10 minutes ago and every trade since has been at
    // five times the launch price: the median of its own candles is the pump.
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.000005", 80_000)],
      candles: [[0, 0.000005], [5, 0.000005], [10, 0.000005]],
      young: true,
    });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      name: "PlatformTokenPriceGateError",
      gate: "history",
      reason: "insufficient_history",
    });
  });

  it("refuses until the pool has a full median window of history, however busy it is", async () => {
    // Traded in every 5-minute period for three hours: plenty of candles, but
    // under the four-hour window.
    const candles = Array.from({ length: 36 }, (_, i): [number, number] => [5 + i * 5, 0.0000011]);
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles, young: true });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "history",
    });
  });

  it("refuses an old pool that has traded in too few periods, and does not count the in-progress one", async () => {
    // First traded five hours ago, in one completed period short of the
    // minimum; the in-progress candle would make up the difference.
    const completed = Array.from(
      { length: PLATFORM_PRICE_MIN_TRADED_CANDLES - 1 },
      (_, i): [number, number] => [5 * 60 - i * 5, 0.0000011]
    );
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)],
      candles: [[0, 0.0000011], ...completed],
      young: true,
    });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "history",
      observed: { tradedCandles: PLATFORM_PRICE_MIN_TRADED_CANDLES - 1 },
    });
  });

  it("trusts the median once the pool has the full window and enough traded periods", async () => {
    const candles = Array.from(
      { length: PLATFORM_PRICE_MIN_TRADED_CANDLES },
      (_, i): [number, number] => [PLATFORM_PRICE_MIN_HISTORY_MINUTES + 5 - i * 5, 0.0000011]
    );
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles, young: true });
    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(Number(quote.priceUsd)).toBeCloseTo(0.0000011, 12);
  });

  it("offers the median as a cross-check quote in plain decimal form", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles: [[PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES + 30, 2e-9]] });
    const cross = await fetchPlatformTokenPriceCrossCheck(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(cross).toMatchObject({ source: "geckoterminal_ohlcv_median", priceUsd: "0.000000002" });
    expect(toDecimalString(1.09036588922258e-6)).toBe("0.00000109036588922");
  });

  it("derives the cross-check from the gated quote's pool read without a second spot request", async () => {
    const fetchImpl = fakeFetch({
      pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)],
      closes: [0.00000109, 0.0000011, 0.00000111, 0.00000112],
    });
    const dexscreenerCalls = () => fetchImpl.mock.calls.filter(([url]) => url.includes("dexscreener")).length;

    const quote = await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    const spotReadsForGate = dexscreenerCalls();
    const derived = await fetchPlatformTokenPriceCrossCheckForQuote(HERMESOS_TOKEN, quote, {
      fetchImpl: fetchImpl as never,
      env: env(),
    });

    expect(spotReadsForGate).toBe(1);
    expect(dexscreenerCalls()).toBe(spotReadsForGate);
    const direct = await fetchPlatformTokenPriceCrossCheck(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(derived).toEqual(direct);
  });
});

describe("price gate refusals name the token, the reason and what was observed", () => {
  async function refusal(fetchImpl: unknown) {
    try {
      await fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformTokenPriceGateError);
      return error as PlatformTokenPriceGateError;
    }
    throw new Error("expected the price gate to refuse");
  }

  it("liquidity_floor: the pool's liquidity against the token's floor", async () => {
    const error = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 9_999)], closes: [0.0000011] }));
    expect(error.refusal).toEqual({
      assetKey: "hermesos",
      asset: "$HermesOS",
      reason: "liquidity_floor",
      gate: "liquidity",
      observed: { liquidityUsd: 9_999, minLiquidityUsd: 10_000, poolId: HERMESOS_POOL_ID },
    });
  });

  it("median_deviation: how far the spot sits above the median, and the band", async () => {
    const error = await refusal(
      fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000013", 80_000)], closes: [0.0000011, 0.0000011, 0.0000011, 0.00000111] })
    );
    expect(error.reason).toBe("median_deviation");
    expect(error.gate).toBe("deviation");
    expect(error.observed).toMatchObject({
      maxDeviationBps: PLATFORM_PRICE_MAX_DEVIATION_BPS,
      medianWindowMinutes: PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES,
      liquidityUsd: 80_000,
      poolId: HERMESOS_POOL_ID,
    });
    expect(Number(error.observed.aboveMedianBps)).toBeGreaterThan(PLATFORM_PRICE_MAX_DEVIATION_BPS);
  });

  it("insufficient_history: how old the pool is and how often it has traded, against the minimums", async () => {
    const error = await refusal(
      fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.000005", 80_000)], candles: [[5, 0.000005], [30, 0.000001]], young: true })
    );
    expect(error.refusal).toEqual({
      assetKey: "hermesos",
      asset: "$HermesOS",
      reason: "insufficient_history",
      gate: "history",
      observed: {
        stage: "reference",
        poolId: HERMESOS_POOL_ID,
        historyMinutes: 30,
        minHistoryMinutes: PLATFORM_PRICE_MIN_HISTORY_MINUTES,
        tradedCandles: 2,
        minTradedCandles: PLATFORM_PRICE_MIN_TRADED_CANDLES,
      },
    });
  });

  it("no_candle: a pool the median source has never seen trade (still a reference outage)", async () => {
    const error = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles: [] }));
    expect(error).toMatchObject({ gate: "reference_unavailable", reason: "no_candle", assetKey: "hermesos" });
    expect(error.observed).toEqual({ stage: "reference", poolId: HERMESOS_POOL_ID });
  });

  it("no_candle: a pool the median source has not indexed yet (HTTP 404), still a reference outage", async () => {
    // GeckoTerminal answers 404 for a pool it has not indexed, as it does for a new pool on launch day.
    const error = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 404 }));
    expect(error).toMatchObject({ gate: "reference_unavailable", reason: "no_candle", assetKey: "hermesos" });
    expect(error.observed).toEqual({ stage: "reference", poolId: HERMESOS_POOL_ID, httpStatus: 404 });
  });

  it("feed_error: a source outage or a canonical pool missing from the source", async () => {
    const geckoDown = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 503 }));
    expect(geckoDown).toMatchObject({ gate: "reference_unavailable", reason: "feed_error", asset: "$HermesOS" });
    // The status tells an outage (5xx) from a rate limit (429) in the log and the alert.
    expect(geckoDown.observed).toEqual({ stage: "reference", poolId: HERMESOS_POOL_ID, httpStatus: 503 });
    _resetPlatformPriceReferenceCacheForTests();
    const geckoLimited = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 429 }));
    expect(geckoLimited).toMatchObject({ reason: "feed_error", observed: { httpStatus: 429 } });
    _resetPlatformPriceReferenceCacheForTests();
    const dexDown = await refusal(jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response));
    expect(dexDown).toMatchObject({ gate: "spot_unavailable", reason: "feed_error", assetKey: "hermesos" });
    expect(dexDown.observed).toEqual({ stage: "spot", poolId: HERMESOS_POOL_ID, httpStatus: 502 });
    const poolMissing = await refusal(fakeFetch({ pairs: [pair(SATELLITE, "0.0000011", 500_000)], closes: [0.0000011] }));
    // Raised by the shared DEXScreener read, then named for the token.
    expect(poolMissing).toMatchObject({ gate: "pool_missing", reason: "feed_error", assetKey: "hermesos", asset: "$HermesOS" });
    expect(poolMissing.observed).toMatchObject({ stage: "spot", poolId: HERMESOS_POOL_ID, otherPairs: 1 });
  });

  it("finds the refusal behind a wrapped error, and none behind an unrelated one", async () => {
    const gateError = await refusal(fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 9_999)], closes: [0.0000011] }));
    expect(priceGateRefusalFromError(gateError)?.reason).toBe("liquidity_floor");
    const wrapped = new LivePriceUnavailableError("Live $HermesOS price unavailable", gateError);
    expect(priceGateRefusalFromError(wrapped)).toEqual(gateError.refusal);
    const carried = Object.assign(new Error("deposits paused"), {
      priceGateRefusal: { ...gateError.refusal, reason: "median_deviation" as const },
    });
    expect(priceGateRefusalFromError(carried)?.reason).toBe("median_deviation");
    expect(priceGateRefusalFromError(new Error("unrelated"))).toBeNull();
    expect(priceGateRefusalFromError(new LivePriceUnavailableError("down", new Error("socket hang up")))).toBeNull();
    expect(priceGateRefusalFromError(undefined)).toBeNull();
  });
});

describe("$HIVRA in a Doppler Uniswap v4 pool quoted in native ETH", () => {
  const HIVRA_ADDRESS = "0x1111111111111111111111111111111111111111";
  const HIVRA_POOL = `0x${"ab".repeat(32)}`;
  const configured = validateHivraLaunchConfig({
    contractAddress: HIVRA_ADDRESS,
    decimals: 18,
    poolId: HIVRA_POOL,
    activatesAt: "2026-10-01T16:00:00Z",
  });
  if (configured.status !== "configured") throw new Error("test $HIVRA launch block must validate");
  const HIVRA: PlatformToken = configured.token;
  const ETH_USD = 2_400;
  const SPOT_NATIVE = 0.000001 / ETH_USD;

  /**
   * The shape DEXScreener returns for a native-ETH v4 pool on Base (recorded
   * from /latest/dex/pairs/base/<pool>): quote token 0x000...000 "ETH", the
   * pool id as pairAddress, priceNative in ETH, and liquidity.quote in ETH.
   */
  function nativePair(
    opts: { priceUsd?: string; liquidityUsd?: number; quoteEth?: number | null; quote?: { address: string; symbol: string } } = {}
  ) {
    const priceUsd = opts.priceUsd ?? "0.000001";
    return {
      chainId: "base",
      dexId: "uniswap",
      labels: ["v4"],
      pairAddress: HIVRA_POOL,
      baseToken: { address: HIVRA_ADDRESS, name: "Hivra", symbol: "HIVRA" },
      quoteToken: opts.quote ?? { address: NATIVE_ETH_ADDRESS, name: "Ether", symbol: "ETH" },
      priceUsd,
      priceNative: String(Number(priceUsd) / ETH_USD),
      liquidity: {
        usd: opts.liquidityUsd ?? 2_000_000,
        base: 1_990_000_000_000,
        ...(opts.quoteEth === null ? {} : { quote: opts.quoteEth ?? 6 }),
      },
    };
  }

  /** GeckoTerminal OHLCV for the pool, priced in ETH (meta.quote 0x000...000, as recorded live). */
  function hivraFetch(opts: { pairs: unknown[]; candles?: [number, number][]; quoteAddress?: string }) {
    return jest.fn(async (url: string) => {
      if (url.includes("dexscreener")) {
        return { ok: true, status: 200, json: async () => ({ pairs: opts.pairs }) } as unknown as Response;
      }
      const candles = opts.candles ?? Array.from({ length: 60 }, (_, i): [number, number] => [5 + i * 5, SPOT_NATIVE]);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { attributes: { ohlcv_list: candles.map(([age, close]) => [nowSec() - age * 60, close, close, close, close, 1]) } },
          meta: {
            base: { address: HIVRA_ADDRESS, symbol: "HIVRA" },
            quote: { address: opts.quoteAddress ?? NATIVE_ETH_ADDRESS, symbol: "ETH" },
          },
        }),
      } as unknown as Response;
    });
  }

  it("prices $HIVRA from its native-ETH pool, comparing spot and median in ETH", async () => {
    const fetchImpl = hivraFetch({ pairs: [nativePair()] });
    const quote = await fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: fetchImpl as never, env: env() });
    expect(Number(quote.priceUsd)).toBeCloseTo(0.000001, 12);
    expect(quote.raw).toMatchObject({ gates: { aboveMedianBps: 0, pricedAt: "spot", minLiquidityUsd: HIVRA_MIN_PRICE_LIQUIDITY_USD } });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(`/pools/${HIVRA_POOL}/ohlcv/minute?aggregate=5&limit=1000&currency=token&token=${HIVRA_ADDRESS}`),
      expect.anything()
    );
    const cross = await fetchPlatformTokenPriceCrossCheck(HIVRA, { fetchImpl: fetchImpl as never, env: env() });
    expect(Number(cross.priceUsd)).toBeCloseTo(0.000001, 12);
  });

  it("accepts the same pool reported as WETH-quoted", async () => {
    const weth = { address: BASE_WETH_ADDRESS, symbol: "WETH" };
    const fetchImpl = hivraFetch({ pairs: [nativePair({ quote: weth })], quoteAddress: BASE_WETH_ADDRESS });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: fetchImpl as never, env: env() })).resolves.toMatchObject({
      source: "dexscreener",
    });
  });

  it("fails closed when the ETH side is thin, however large the token-heavy total looks", async () => {
    // A fresh Doppler pool: $2M of "liquidity", almost all of it $HIVRA, and 5 ETH ($12,000).
    const fetchImpl = hivraFetch({ pairs: [nativePair({ quoteEth: 5 })] });
    const error = await fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: fetchImpl as never, env: env() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformTokenPriceGateError);
    expect((error as PlatformTokenPriceGateError).refusal).toEqual({
      assetKey: "hivra",
      asset: "$HIVRA",
      reason: "liquidity_floor",
      gate: "liquidity",
      observed: {
        quoteLiquidityUsd: expect.closeTo(12_000, 6),
        minQuoteLiquidityUsd: HIVRA_MIN_QUOTE_LIQUIDITY_USD,
        liquidityUsd: 2_000_000,
        minLiquidityUsd: HIVRA_MIN_PRICE_LIQUIDITY_USD,
        poolId: HIVRA_POOL,
      },
    });
    // The median source is never asked: the pool is refused first.
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("geckoterminal"))).toBe(false);
  });

  it("fails closed when DEXScreener does not report the ETH side at all", async () => {
    const fetchImpl = hivraFetch({ pairs: [nativePair({ quoteEth: null })] });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "liquidity",
      observed: { quoteLiquidityUsd: 0 },
    });
  });

  it("keeps the total floor too", async () => {
    const fetchImpl = hivraFetch({ pairs: [nativePair({ liquidityUsd: 24_999, quoteEth: 100 })] });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "liquidity",
      observed: { liquidityUsd: 24_999, minLiquidityUsd: HIVRA_MIN_PRICE_LIQUIDITY_USD },
    });
  });

  it("keeps the 10% band and the four-hour history gate on the native-ETH pool", async () => {
    const pumped = hivraFetch({ pairs: [nativePair({ priceUsd: "0.0000012" })] }); // +20% vs the ETH median
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: pumped as never, env: env() })).rejects.toMatchObject({
      gate: "deviation",
      assetKey: "hivra",
    });
    _resetPlatformPriceReferenceCacheForTests();
    const young = hivraFetch({
      pairs: [nativePair()],
      candles: Array.from({ length: 30 }, (_, i): [number, number] => [5 + i * 5, SPOT_NATIVE]),
    });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: young as never, env: env() })).rejects.toMatchObject({
      gate: "history",
      reason: "insufficient_history",
    });
  });

  it("refuses a pool quoted in anything but ETH, on either source", async () => {
    const usdc = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC" };
    const spot = hivraFetch({ pairs: [nativePair({ quote: usdc })] });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: spot as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
      reason: "feed_error",
      observed: { stage: "spot", poolId: HIVRA_POOL, quoteAddress: usdc.address },
    });
    await expect(fetchPlatformTokenPriceCrossCheck(HIVRA, { fetchImpl: spot as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
    });
    const reference = hivraFetch({ pairs: [nativePair()], quoteAddress: usdc.address });
    await expect(fetchPlatformTokenPriceUsd(HIVRA, { fetchImpl: reference as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
      assetKey: "hivra",
      observed: { stage: "reference", poolId: HIVRA_POOL, quoteAddress: usdc.address },
    });
  });

  it("refuses a $HermesOS pair quoted in anything but ETH, and leaves its floor as it was", async () => {
    const usdcPair = { ...pair(HERMESOS_POOL_ID, "0.0000011", 80_000), quoteToken: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } };
    const fetchImpl = fakeFetch({ pairs: [usdcPair], closes: [0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
    });
    expect(HERMESOS_TOKEN.minQuoteLiquidityUsd).toBeNull();
  });
});
