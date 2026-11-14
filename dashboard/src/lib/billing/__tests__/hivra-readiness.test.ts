/** @jest-environment node */
/**
 * $HIVRA readiness: usable = live in the registry AND the live price gate
 * passes now. Fails closed on any failure, never serves an older price, and
 * reuses the live-thresholds price cache.
 */
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-10-01T16:00:00Z",
  },
}));

import {
  HivraNotReadyError,
  READINESS_FAILURE_CACHE_MS,
  _resetHivraReadinessForTests,
  accessDependsOnHivraReadiness,
  assertHivraReadyFor,
  getHivraReadiness,
  hasExistingTokenTier,
  isHivraUsable,
  newHivraTiersAllowed,
  resolveTokenPaymentAvailability,
} from "../hivra-readiness";
import { LIVE_TTL_MS, _resetLivePriceCacheForTests, getLiveActiveThresholds } from "../live-thresholds";
import { PlatformTokenPriceGateError } from "../price-feed";
import { computeUserTokenAccess } from "../token-access";
import { getActiveHivraToken } from "../token-registry";

const ACTIVE_NOW = new Date("2026-10-02T12:00:00Z");
const BEFORE_LAUNCH = new Date("2026-09-30T12:00:00Z");
const PRICE = { priceUsd: "0.05", lastUpdatedAt: 0, source: "dexscreener" as const, raw: {} };

const newUser = computeUserTokenAccess({ phase: "active", cohort: null, now: ACTIVE_NOW });
const grandfathered = computeUserTokenAccess({
  phase: "active",
  cohort: { user_id: "old", converted_at: null, conversion_grace_ends_at: null, metadata: {} },
  now: ACTIVE_NOW,
});
const beforeLaunch = computeUserTokenAccess({ phase: "scheduled", cohort: null, now: BEFORE_LAUNCH });

const pass = () => jest.fn(async () => PRICE);
const gateRefuses = () =>
  jest.fn(async () => {
    throw new PlatformTokenPriceGateError("liquidity", "pool holds $3,000 of ETH, below the $12,500 ETH-side floor");
  });

beforeEach(() => {
  _resetHivraReadinessForTests();
  _resetLivePriceCacheForTests();
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("getHivraReadiness", () => {
  it("is not usable before $HIVRA is live, without asking the price feed", async () => {
    const fetchImpl = pass();
    expect(await getHivraReadiness({ now: BEFORE_LAUNCH, fetchImpl })).toEqual({ usable: false, reason: "not_live" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is usable once live and the price gate passes", async () => {
    const result = await getHivraReadiness({ now: ACTIVE_NOW, fetchImpl: pass() });
    expect(result).toMatchObject({ usable: true, token: { key: "hivra" } });
  });

  it("is not usable while the price gate refuses", async () => {
    expect(await getHivraReadiness({ now: ACTIVE_NOW, fetchImpl: gateRefuses() })).toEqual({
      usable: false,
      reason: "price_gate",
    });
  });

  it("fails closed when the feed is down", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("DEXScreener price fetch failed status=503");
    });
    expect(await isHivraUsable({ now: ACTIVE_NOW, fetchImpl })).toBe(false);
  });

  it("never serves an older passing price, unlike the live thresholds", async () => {
    await isHivraUsable({ now: ACTIVE_NOW, fetchImpl: pass() });
    _resetHivraReadinessForTests();
    const later = new Date(ACTIVE_NOW.getTime() + LIVE_TTL_MS + 1_000);
    const down = jest.fn(async () => {
      throw new Error("feed timeout");
    });
    // The thresholds may fall back to the cached price on an outage...
    await expect(getLiveActiveThresholds({ now: later, fetchImpl: down, token: getActiveHivraToken(ACTIVE_NOW)! })).resolves.toBeDefined();
    // ...readiness does not.
    expect(await isHivraUsable({ now: later, fetchImpl: down })).toBe(false);
  });

  it("reuses a pass from the shared price cache instead of calling the feed again", async () => {
    const fetchImpl = pass();
    expect(await isHivraUsable({ now: ACTIVE_NOW, fetchImpl })).toBe(true);
    expect(await isHivraUsable({ now: new Date(ACTIVE_NOW.getTime() + 60_000), fetchImpl })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("remembers a failure briefly, then asks the gate again", async () => {
    const refuses = gateRefuses();
    expect(await isHivraUsable({ now: ACTIVE_NOW, fetchImpl: refuses })).toBe(false);
    const passes = pass();
    expect(await isHivraUsable({ now: new Date(ACTIVE_NOW.getTime() + 10_000), fetchImpl: passes })).toBe(false);
    expect(passes).not.toHaveBeenCalled();
    expect(
      await isHivraUsable({ now: new Date(ACTIVE_NOW.getTime() + READINESS_FAILURE_CACHE_MS + 1), fetchImpl: passes })
    ).toBe(true);
  });
});

describe("who readiness applies to", () => {
  it("applies only to accounts outside the grandfather cohort after activation", () => {
    expect(accessDependsOnHivraReadiness(newUser)).toBe(true);
    expect(accessDependsOnHivraReadiness(grandfathered)).toBe(false);
    expect(accessDependsOnHivraReadiness(beforeLaunch)).toBe(false);
  });

  it("refuses a new $HIVRA payment for a new user while not usable, with a plain message", async () => {
    const attempt = assertHivraReadyFor(newUser, "hivra", { now: ACTIVE_NOW, fetchImpl: gateRefuses() });
    await expect(attempt).rejects.toBeInstanceOf(HivraNotReadyError);
    await expect(attempt).rejects.toThrow("Token payments aren't available yet.");
  });

  it("never gates $HermesOS or a grandfathered account", async () => {
    const fetchImpl = gateRefuses();
    await expect(assertHivraReadyFor(newUser, "hermesos", { now: ACTIVE_NOW, fetchImpl })).resolves.toBeUndefined();
    await expect(assertHivraReadyFor(grandfathered, "hivra", { now: ACTIVE_NOW, fetchImpl })).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("tells Billing what it may offer, in the account's token", async () => {
    expect(await resolveTokenPaymentAvailability(newUser, { now: ACTIVE_NOW, fetchImpl: gateRefuses() })).toEqual({
      available: false,
      paymentToken: "hivra",
      displayUnit: "$HIVRA",
    });
    _resetHivraReadinessForTests();
    expect(await resolveTokenPaymentAvailability(newUser, { now: ACTIVE_NOW, fetchImpl: pass() })).toEqual({
      available: true,
      paymentToken: "hivra",
      displayUnit: "$HIVRA",
    });
    expect(await resolveTokenPaymentAvailability(grandfathered, { now: ACTIVE_NOW, fetchImpl: gateRefuses() })).toEqual({
      available: true,
      paymentToken: "hermesos",
      displayUnit: "$HermesOS",
    });
  });
});

describe("new tiers versus tiers already held", () => {
  it("allows new $HIVRA tiers only while usable, and never gates a grandfathered account", async () => {
    expect(await newHivraTiersAllowed(newUser, { now: ACTIVE_NOW, fetchImpl: gateRefuses() })).toBe(false);
    _resetHivraReadinessForTests();
    expect(await newHivraTiersAllowed(newUser, { now: ACTIVE_NOW, fetchImpl: pass() })).toBe(true);
    expect(await newHivraTiersAllowed(grandfathered, { now: ACTIVE_NOW, fetchImpl: gateRefuses() })).toBe(true);
  });

  function fakeDb(rows: { quals: unknown[]; instances: unknown[]; error?: boolean }) {
    const chain = (data: unknown[]) => {
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not", "limit"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data, error: rows.error ? { message: "down" } : null }).then(resolve);
      return builder;
    };
    return { from: (name: string) => chain(name === "token_tier_qualifications" ? rows.quals : rows.instances) };
  }

  it("counts a qualification row or a computer on a token tier as a tier already held", async () => {
    expect(await hasExistingTokenTier("u", fakeDb({ quals: [{ id: 1 }], instances: [] }))).toBe(true);
    expect(await hasExistingTokenTier("u", fakeDb({ quals: [], instances: [{ id: 2 }] }))).toBe(true);
    expect(await hasExistingTokenTier("u", fakeDb({ quals: [], instances: [] }))).toBe(false);
  });

  it("throws on a read error, so a refusal that depends on it fails closed", async () => {
    await expect(hasExistingTokenTier("u", fakeDb({ quals: [], instances: [], error: true }))).rejects.toThrow();
  });
});
