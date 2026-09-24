/** @jest-environment node */
const mockWarn = jest.fn();
const mockReportOpsEvent = jest.fn();

jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args) } }));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
}));

import { buildOpsEventFingerprint, sanitizeOpsMetadata } from "@/lib/ops-events";
import { LivePriceUnavailableError } from "@/lib/billing/live-thresholds";
import { ManagedVeniceTokenQuotePriceError } from "@/lib/billing/managed-venice-token-quotes";
import {
  PRICE_GATE_ALERT_INTERVAL_MS,
  PRICE_GATE_ALERT_SOURCE,
  PRICE_GATE_LOG_INTERVAL_MS,
  _resetPriceGateAlertStateForTests,
  reportPriceGateRefusal,
} from "@/lib/billing/price-gate-alerts";
import { PlatformTokenPriceGateError, type PriceGateReason } from "@/lib/billing/price-feed";
import { HERMESOS_TOKEN, validateHivraLaunchConfig, type PlatformToken } from "@/lib/billing/token-registry";

const configured = validateHivraLaunchConfig({
  contractAddress: "0x1111111111111111111111111111111111111111",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-10-01T16:00:00Z",
});
if (configured.status !== "configured") throw new Error("test $HIVRA config must be valid");
const HIVRA: PlatformToken = configured.token;

const CONTEXT = { source: "billing/wallet-quote", route: "/api/billing/wallet/quote", method: "POST" };
// 10:03 UTC: inside the 10:00 alert window.
const T0 = Date.parse("2026-10-01T10:03:00Z");

function gateError(token: PlatformToken, gate: PlatformTokenPriceGateError["gate"], reason?: PriceGateReason) {
  return new PlatformTokenPriceGateError(gate, `${token.displayUnit} refused`, {
    token,
    reason,
    observed: gate === "liquidity" ? { liquidityUsd: 12_000, minLiquidityUsd: 25_000, poolId: token.poolId } : { poolId: token.poolId },
  });
}

beforeEach(() => {
  _resetPriceGateAlertStateForTests();
  mockReportOpsEvent.mockResolvedValue({ id: "evt_1", fingerprint: "fp" });
});

describe("reportPriceGateRefusal", () => {
  it("logs the source, token, gate reason and observed values, and raises one ops alert", async () => {
    const result = await reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0);
    expect(result).toMatchObject({ logged: true, alerted: true, refusal: { assetKey: "hivra", reason: "liquidity_floor" } });

    expect(mockWarn).toHaveBeenCalledTimes(1);
    const [message, context] = mockWarn.mock.calls[0];
    expect(message).toBe("Price gate refused a token quote");
    expect(context).toEqual({
      source: "billing/wallet-quote",
      route: "/api/billing/wallet/quote",
      method: "POST",
      failureType: "price_gate_refused",
      asset: "$HIVRA",
      assetKey: "hivra",
      gateReason: "liquidity_floor",
      gate: "liquidity",
      observed: { liquidityUsd: 12_000, minLiquidityUsd: 25_000, poolId: HIVRA.poolId },
      refusalsSinceLastLog: 0,
    });
    // The logger redacts keys containing "token"; none of these may be lost to it.
    expect(sanitizeOpsMetadata(context)).toEqual(context);

    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    const alert = mockReportOpsEvent.mock.calls[0][0];
    expect(alert).toMatchObject({
      source: PRICE_GATE_ALERT_SOURCE,
      severity: "warn",
      title: "$HIVRA quotes refused by a price gate",
      metadata: {
        asset: "$HIVRA",
        assetKey: "hivra",
        gateReason: "liquidity_floor",
        quoteSource: "billing/wallet-quote",
        windowStart: "2026-10-01T10:00:00.000Z",
      },
    });
    expect(alert.message).not.toMatch(/[–—]/);
    expect(sanitizeOpsMetadata(alert.metadata)).toEqual(alert.metadata);
  });

  it("folds a burst into one log line a minute per token and reason, and counts what it folded", async () => {
    const error = gateError(HIVRA, "liquidity");
    await reportPriceGateRefusal(error, CONTEXT, T0);
    for (let i = 1; i <= 5; i += 1) {
      expect((await reportPriceGateRefusal(error, CONTEXT, T0 + i * 1_000)).logged).toBe(false);
    }
    expect(mockWarn).toHaveBeenCalledTimes(1);

    // Another reason for the same token is its own signal.
    expect((await reportPriceGateRefusal(gateError(HIVRA, "deviation"), CONTEXT, T0 + 6_000)).logged).toBe(true);

    const next = await reportPriceGateRefusal(error, CONTEXT, T0 + PRICE_GATE_LOG_INTERVAL_MS);
    expect(next.logged).toBe(true);
    expect(mockWarn).toHaveBeenCalledTimes(3);
    expect(mockWarn.mock.calls[2][1]).toMatchObject({ gateReason: "liquidity_floor", refusalsSinceLastLog: 5 });
  });

  it("sends at most one ops alert per token per 30 minutes", async () => {
    await reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0);
    await reportPriceGateRefusal(gateError(HIVRA, "deviation"), CONTEXT, T0 + 60_000);
    await reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0 + PRICE_GATE_ALERT_INTERVAL_MS - 1);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);

    // Each token has its own budget.
    await reportPriceGateRefusal(gateError(HERMESOS_TOKEN, "liquidity"), CONTEXT, T0 + 120_000);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(2);
    expect(mockReportOpsEvent.mock.calls[1][0]).toMatchObject({ title: "$HermesOS quotes refused by a price gate" });

    await reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0 + PRICE_GATE_ALERT_INTERVAL_MS);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(3);
  });

  it("gives every server process the same ops row within a 30-minute window, and a new one after it", async () => {
    const fingerprintAt = async (nowMs: number, context = CONTEXT) => {
      _resetPriceGateAlertStateForTests(); // a fresh server process
      mockReportOpsEvent.mockClear();
      await reportPriceGateRefusal(gateError(HIVRA, "deviation"), context, nowMs);
      return buildOpsEventFingerprint(mockReportOpsEvent.mock.calls[0][0]);
    };
    const first = await fingerprintAt(T0);
    // Another process, another route and reason, later in the same window: same row.
    expect(await fingerprintAt(T0 + 20 * 60_000, { source: "billing/yearly-token-quote", route: "/api/billing/yearly-token-quote", method: "POST" })).toBe(first);
    expect(await fingerprintAt(T0 + 30 * 60_000)).not.toBe(first);
  });

  it("reads the refusal behind the quote errors each route catches", async () => {
    const wrapped = new LivePriceUnavailableError("Live $HIVRA price unavailable", gateError(HIVRA, "reference_unavailable", "no_candle"));
    expect((await reportPriceGateRefusal(wrapped, CONTEXT, T0)).refusal).toMatchObject({ assetKey: "hivra", reason: "no_candle" });

    const deposit = new ManagedVeniceTokenQuotePriceError("deposits paused", { cause: gateError(HIVRA, "deviation") });
    expect((await reportPriceGateRefusal(deposit, CONTEXT, T0)).refusal).toMatchObject({ assetKey: "hivra", reason: "median_deviation" });

    // An error with no gate behind it is still logged, as a feed error for an unknown token.
    const unknown = await reportPriceGateRefusal(new LivePriceUnavailableError("down", new Error("socket hang up")), CONTEXT, T0);
    expect(unknown.refusal).toEqual({ assetKey: "unknown", asset: "unknown", reason: "feed_error", gate: "unknown", observed: {} });
  });

  it("never throws, and reports no alert when the ops store is unavailable", async () => {
    mockReportOpsEvent.mockResolvedValueOnce(null);
    expect((await reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0)).alerted).toBe(false);
    _resetPriceGateAlertStateForTests();
    mockReportOpsEvent.mockRejectedValueOnce(new Error("db down"));
    await expect(reportPriceGateRefusal(gateError(HIVRA, "liquidity"), CONTEXT, T0)).resolves.toMatchObject({ logged: true, alerted: false });
  });
});
