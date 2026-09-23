/** @jest-environment node */
import {
  PLATFORM_PRICE_MAX_DEVIATION_BPS,
  PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES,
  _resetPlatformPriceReferenceCacheForTests,
  fetchPlatformTokenPriceCrossCheck,
  fetchPlatformTokenPriceUsd,
  toDecimalString,
} from "@/lib/billing/price-feed";
import { HERMESOS_POOL_ID, HERMESOS_TOKEN } from "@/lib/billing/token-registry";

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
    quoteToken: { address: "0xweth" },
    priceUsd,
    priceNative: String(Number(priceUsd) / usdPerNative),
    liquidity: { usd: liquidityUsd },
  };
}

/**
 * `closes` are one per 5-minute candle, newest first; `candles` are explicit
 * [ageMinutes, close] pairs for pools that do not trade every 5 minutes.
 */
function fakeFetch(opts: { pairs: unknown[]; closes?: number[]; candles?: [number, number][]; geckoStatus?: number }) {
  return jest.fn(async (url: string) => {
    if (url.includes("dexscreener")) {
      return { ok: true, status: 200, json: async () => ({ pairs: opts.pairs }) } as unknown as Response;
    }
    if (opts.geckoStatus && opts.geckoStatus !== 200) {
      return { ok: false, status: opts.geckoStatus, json: async () => ({}) } as unknown as Response;
    }
    const candles = opts.candles ?? (opts.closes ?? []).map((close, i): [number, number] => [i * 5, close]);
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
    const burst = Array.from({ length: 40 }, (_, i): [number, number] => [i * 0.1, 0.0000013]); // 40 trades in 4 minutes
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

  it("offers the median as a cross-check quote in plain decimal form", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], candles: [[PLATFORM_PRICE_MEDIAN_WINDOW_MINUTES + 30, 2e-9]] });
    const cross = await fetchPlatformTokenPriceCrossCheck(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(cross).toMatchObject({ source: "geckoterminal_ohlcv_median", priceUsd: "0.000000002" });
    expect(toDecimalString(1.09036588922258e-6)).toBe("0.00000109036588922");
  });
});
