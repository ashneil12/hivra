/**
 * Tests for the live-priced tier threshold resolver.
 *
 * Cache + stale + throw semantics:
 *   - Cache fresh         → no fetch
 *   - Cache miss          → fetch
 *   - Fetch fails, stale  → cached price (within STALE_TTL)
 *   - Cache too old/none  → throws LivePriceUnavailableError (no static fallback)
 */

import {
  LIVE_TTL_MS,
  STALE_TTL_MS,
  LivePriceUnavailableError,
  _resetLivePriceCacheForTests,
  getLiveActiveThresholds,
} from "../live-thresholds";
import {
  LAUNCH_PROMO_END_DATE,
  HERMESOS_TOKEN_DECIMALS,
} from "../tier-thresholds";
import { PlatformTokenPriceGateError, type HermesPriceQuote } from "../price-feed";

const NOW_DURING_LAUNCH = new Date("2026-04-29T12:00:00.000Z");

function priceQuote(priceUsd: string, lastUpdatedAt = 1714377600): HermesPriceQuote {
  return { priceUsd, lastUpdatedAt, source: "dexscreener", raw: {} };
}

describe("getLiveActiveThresholds", () => {
  beforeEach(() => {
    _resetLivePriceCacheForTests();
  });

  it("derives token threshold from live USD target ÷ live price (launch epoch)", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return priceQuote("0.00002609");
    };

    const result = await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });

    expect(result.epoch).toBe("launch");
    expect(result.priceUsd).toBe("0.00002609");
    expect(calls).toBe(1);

    // $99 / $0.00002609 = 3,794,558 tokens (ceiling). × 10^18 base units.
    const expectedPro = 3_794_558n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);
    expect(result.pro.amount).toBe(expectedPro);
    expect(result.pro.code).toBe("PRO_LAUNCH");

    // $199 / $0.00002609 = 7,627,444 tokens (ceiling).
    const expectedPower = 7_627_444n * 10n ** BigInt(HERMESOS_TOKEN_DECIMALS);
    expect(result.power.amount).toBe(expectedPower);
    expect(result.power.code).toBe("POWER_LAUNCH");
  });

  it("serves a fresh cache hit without re-fetching", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return priceQuote("0.00002609");
    };

    await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });
    await getLiveActiveThresholds({
      now: new Date(NOW_DURING_LAUNCH.getTime() + LIVE_TTL_MS - 1000),
      fetchImpl,
    });

    expect(calls).toBe(1);
  });

  it("re-fetches once the cache is older than LIVE_TTL_MS", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return priceQuote(calls === 1 ? "0.00002609" : "0.00005218");
    };

    await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });
    const second = await getLiveActiveThresholds({
      now: new Date(NOW_DURING_LAUNCH.getTime() + LIVE_TTL_MS + 1000),
      fetchImpl,
    });

    expect(calls).toBe(2);
    expect(second.priceUsd).toBe("0.00005218");
  });

  it("returns the cached price when fetch fails but cache is within STALE_TTL_MS", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return priceQuote("0.00002609");
      throw new Error("DEXScreener 503");
    };

    await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });

    const stale = await getLiveActiveThresholds({
      now: new Date(NOW_DURING_LAUNCH.getTime() + LIVE_TTL_MS + 30 * 60 * 1000),
      fetchImpl,
    });

    expect(stale.priceUsd).toBe("0.00002609");
    expect(stale.pro.amount).toBeGreaterThan(0n);
  });

  it.each(["liquidity", "deviation", "history", "pool_missing"] as const)(
    "fails closed on a tripped %s gate instead of serving the cached price",
    async (gate) => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) return priceQuote("0.00002609");
        throw new PlatformTokenPriceGateError(gate, `${gate} tripped`);
      };
      await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });
      await expect(
        getLiveActiveThresholds({ now: new Date(NOW_DURING_LAUNCH.getTime() + LIVE_TTL_MS + 60_000), fetchImpl })
      ).rejects.toBeInstanceOf(LivePriceUnavailableError);
    }
  );

  it("serves the cached price through a price-source outage", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return priceQuote("0.00002609");
      throw new PlatformTokenPriceGateError("reference_unavailable", "GeckoTerminal down");
    };
    await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });
    const stale = await getLiveActiveThresholds({ now: new Date(NOW_DURING_LAUNCH.getTime() + LIVE_TTL_MS + 60_000), fetchImpl });
    expect(stale.priceUsd).toBe("0.00002609");
  });

  it("throws LivePriceUnavailableError when no cache is available and fetch fails", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };

    await expect(
      getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl })
    ).rejects.toBeInstanceOf(LivePriceUnavailableError);
  });

  it("throws LivePriceUnavailableError when cached price is older than STALE_TTL_MS", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return priceQuote("0.00002609");
      throw new Error("DEXScreener down");
    };

    await getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl });

    await expect(
      getLiveActiveThresholds({
        now: new Date(NOW_DURING_LAUNCH.getTime() + STALE_TTL_MS + 1000),
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(LivePriceUnavailableError);
  });

  it("uses the standard epoch after the launch promo window closes", async () => {
    const afterLaunch = new Date(LAUNCH_PROMO_END_DATE.getTime() + 24 * 60 * 60 * 1000);
    const fetchImpl = async () => priceQuote("0.00002609");

    const result = await getLiveActiveThresholds({ now: afterLaunch, fetchImpl });

    expect(result.epoch).toBe("standard");
    expect(result.pro.code).toBe("PRO_STANDARD");
    expect(result.power.code).toBe("POWER_STANDARD");
  });

  it("pins the launch epoch past the window when forceLaunchEpoch is set (founders rate)", async () => {
    const afterLaunch = new Date(LAUNCH_PROMO_END_DATE.getTime() + 30 * 24 * 60 * 60 * 1000);
    const fetchImpl = async () => priceQuote("0.00002609");

    const standard = await getLiveActiveThresholds({ now: afterLaunch, fetchImpl });
    const founder = await getLiveActiveThresholds({
      now: afterLaunch,
      fetchImpl,
      forceLaunchEpoch: true,
    });

    // Same moment, same price — only the per-user override flips the epoch.
    expect(standard.epoch).toBe("standard");
    expect(founder.epoch).toBe("launch");
    expect(founder.pro.code).toBe("PRO_LAUNCH");
    expect(founder.power.code).toBe("POWER_LAUNCH");
    // The launch threshold is cheaper, so the required token amount is lower.
    expect(founder.pro.amount).toBeLessThan(standard.pro.amount);
  });

  it("dedupes concurrent cache-miss fetches into a single in-flight call", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      // Force the cache miss to interleave by yielding once.
      await Promise.resolve();
      return priceQuote("0.00002609");
    };

    const [a, b, c] = await Promise.all([
      getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl }),
      getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl }),
      getLiveActiveThresholds({ now: NOW_DURING_LAUNCH, fetchImpl }),
    ]);

    expect(calls).toBe(1);
    expect(a.pro.amount).toBe(b.pro.amount);
    expect(b.pro.amount).toBe(c.pro.amount);
  });
});
