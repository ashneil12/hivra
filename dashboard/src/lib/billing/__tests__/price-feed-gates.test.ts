/** @jest-environment node */
import {
  PLATFORM_PRICE_MAX_DEVIATION_BPS,
  PlatformTokenPriceGateError,
  _resetPlatformPriceReferenceCacheForTests,
  fetchPlatformTokenPriceCrossCheck,
  fetchPlatformTokenPriceUsd,
  toDecimalString,
} from "@/lib/billing/price-feed";
import { HERMESOS_POOL_ID, HERMESOS_TOKEN } from "@/lib/billing/token-registry";

const TOKEN = HERMESOS_TOKEN.address;
const SATELLITE = `0x${"99".repeat(32)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

function pair(pairAddress: string, priceUsd: string, liquidityUsd: number) {
  return { chainId: "base", pairAddress, baseToken: { address: TOKEN }, quoteToken: { address: "0xweth" }, priceUsd, liquidity: { usd: liquidityUsd } };
}

function fakeFetch(opts: { pairs: unknown[]; closes?: number[] | null; geckoStatus?: number }) {
  return jest.fn(async (url: string) => {
    if (url.includes("dexscreener")) {
      return { ok: true, status: 200, json: async () => ({ pairs: opts.pairs }) } as unknown as Response;
    }
    if (opts.geckoStatus && opts.geckoStatus !== 200) {
      return { ok: false, status: opts.geckoStatus, json: async () => ({}) } as unknown as Response;
    }
    const list = (opts.closes ?? []).map((close, i) => [nowSec() - i * 300, close, close, close, close, 1]);
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
    expect(quote.priceUsd).toBe("0.000001100");
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining(`/pools/${HERMESOS_POOL_ID}/ohlcv/minute`), expect.anything());
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

  it("fails closed without a usable median (source down, or too little recent trading)", async () => {
    const down = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], geckoStatus: 503 });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: down as never, env: env() })).rejects.toMatchObject({
      gate: "reference_unavailable",
    });
    _resetPlatformPriceReferenceCacheForTests();
    const quiet = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], closes: [0.0000011, 0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: quiet as never, env: env() })).rejects.toBeInstanceOf(
      PlatformTokenPriceGateError
    );
  });

  it("fails closed when the canonical pool is missing from the price source", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(SATELLITE, "0.0000011", 500_000)], closes: [0.0000011, 0.0000011, 0.0000011] });
    await expect(fetchPlatformTokenPriceUsd(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() })).rejects.toMatchObject({
      gate: "pool_missing",
    });
  });

  it("offers the median as a cross-check quote in plain decimal form", async () => {
    const fetchImpl = fakeFetch({ pairs: [pair(HERMESOS_POOL_ID, "0.0000011", 80_000)], closes: [1e-9, 2e-9, 3e-9] });
    const cross = await fetchPlatformTokenPriceCrossCheck(HERMESOS_TOKEN, { fetchImpl: fetchImpl as never, env: env() });
    expect(cross).toMatchObject({ source: "geckoterminal_ohlcv_median", priceUsd: "0.000000002" });
    expect(toDecimalString(1.09036588922258e-6)).toBe("0.00000109036588922");
  });
});
