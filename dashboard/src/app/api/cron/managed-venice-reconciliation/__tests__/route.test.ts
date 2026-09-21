/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockRefund = jest.fn();
const mockReportOpsEvent = jest.fn();
const mockGetPricingMap = jest.fn();
const mockCalculateActualChatCost = jest.fn();

interface FakeUsageRow {
  id: string;
  user_id: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  actual_cost_micro_usd: number;
  charged_micro_usd: number;
  reference_id: string;
  created_at: string;
  metadata?: Record<string, unknown>;
}

let usageRowsForRun: FakeUsageRow[] = [];
const usageQueryError: { message: string } | null = null;

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          gte: () => ({
            order: () => ({
              limit: async () => ({
                data: usageRowsForRun,
                error: usageQueryError,
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

jest.mock("@/lib/billing/managed-venice-wallets", () => ({
  refundManagedVeniceOvercharge: (...args: unknown[]) => mockRefund(...args),
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
  sanitizeOpsMetadata: (m: Record<string, unknown> | undefined) => m ?? {},
}));

jest.mock("@/lib/venice/live-pricing", () => ({
  getVenicePricingMap: (...args: unknown[]) => mockGetPricingMap(...args),
}));

// The route imports calculateActualChatCost but the test references
// UnsupportedVeniceModelError too. Inline-mock both so the route's import
// graph never hits the real cost-estimator (which pulls in the static
// pricing catalog and isn't needed here).
class FakeUnsupportedVeniceModelError extends Error {
  constructor(model: string) {
    super(`Unsupported Venice chat model: ${model}`);
    this.name = "UnsupportedVeniceModelError";
  }
}
jest.mock("@/lib/venice/cost-estimator", () => ({
  calculateActualChatCost: (...args: unknown[]) => mockCalculateActualChatCost(...args),
  UnsupportedVeniceModelError: FakeUnsupportedVeniceModelError,
}));

// The stale-reservation sweep is exercised in its own suite
// (src/lib/venice/__tests__/reservation-sweep.test.ts). Stub it to a no-op
// here so these pricing-drift assertions aren't perturbed by it.
jest.mock("@/lib/venice/reservation-sweep", () => ({
  sweepStaleManagedVeniceReservations: jest.fn(async () => ({
    scanned: 0,
    closed: 0,
    releasedReservations: 0,
    totalReleasedMicroUsd: 0,
    results: [],
  })),
  pruneTerminalManagedVeniceReservations: jest.fn(async () => ({ pruned: 0 })),
}));

import { GET } from "../route";

const originalCronSecret = process.env.CRON_SECRET;

function req(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/managed-venice-reconciliation", {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function usage(overrides: Partial<FakeUsageRow> = {}): FakeUsageRow {
  return {
    id: "ue_default",
    user_id: "user_test",
    model: "deepseek-v4-flash",
    prompt_tokens: 1000,
    completion_tokens: 500,
    actual_cost_micro_usd: 1_000,
    charged_micro_usd: 1_000,
    reference_id: "ref_default",
    created_at: "2026-05-17T10:00:00Z",
    metadata: {},
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  usageRowsForRun = [];
  mockGetPricingMap.mockResolvedValue({
    map: new Map(),
    source: "merged",
    fetchedAt: Date.now(),
    liveModelCount: 70,
  });
});

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

describe("GET /api/cron/managed-venice-reconciliation", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(req("wrong"));
    expect(response.status).toBe(401);
    expect(mockGetPricingMap).not.toHaveBeenCalled();
  });

  it("makes no refunds when every chat is settled correctly", async () => {
    usageRowsForRun = [usage({ charged_micro_usd: 2_500 })];
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 2_500 });

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { refundedCount: number; totalOverchargeMicroUsd: number; breachedAlertThreshold: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data.refundedCount).toBe(0);
    expect(body.data.totalOverchargeMicroUsd).toBe(0);
    expect(body.data.breachedAlertThreshold).toBe(false);
    expect(mockRefund).not.toHaveBeenCalled();
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("refunds overcharges to the card wallet with idempotent reference_id", async () => {
    usageRowsForRun = [
      usage({
        id: "ue_overcharge",
        reference_id: "ref_over",
        charged_micro_usd: 5_000,
      }),
    ];
    // Live cost should have been 4_000 → we overcharged by 1_000 µ-USD
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 4_000 });
    mockRefund.mockResolvedValue({ alreadyRefunded: false });

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { refundedCount: number; totalOverchargeMicroUsd: number };
    };

    expect(response.status).toBe(200);
    expect(body.data.refundedCount).toBe(1);
    expect(body.data.totalOverchargeMicroUsd).toBe(1_000);
    expect(mockRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_test",
        amountMicroUsd: 1_000,
        referenceId: "ref_over",
      }),
    );
  });

  it("absorbs undercharges silently (no extra debit) and counts toward the total", async () => {
    usageRowsForRun = [
      usage({
        id: "ue_under",
        reference_id: "ref_under",
        charged_micro_usd: 3_000,
      }),
    ];
    // Live cost should have been 4_500 → we undercharged by 1_500 µ-USD
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 4_500 });

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { refundedCount: number; totalUnderchargeMicroUsd: number };
    };

    expect(response.status).toBe(200);
    expect(body.data.refundedCount).toBe(0);
    expect(body.data.totalUnderchargeMicroUsd).toBe(1_500);
    expect(mockRefund).not.toHaveBeenCalled();
    // Undercharge below the $5 threshold — no ops alert yet
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("ignores sub-µUSD rounding noise without writing anything", async () => {
    usageRowsForRun = [usage({ charged_micro_usd: 2_500 })];
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 2_501 });

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { refundedCount: number; totalOverchargeMicroUsd: number; totalUnderchargeMicroUsd: number };
    };

    expect(response.status).toBe(200);
    expect(body.data.refundedCount).toBe(0);
    expect(body.data.totalOverchargeMicroUsd).toBe(0);
    expect(body.data.totalUnderchargeMicroUsd).toBe(0);
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it("fires an ops alert when aggregate overcharge breaches $1.00", async () => {
    usageRowsForRun = [
      usage({ id: "u1", reference_id: "r1", charged_micro_usd: 700_000 }),
      usage({ id: "u2", reference_id: "r2", charged_micro_usd: 700_000 }),
    ];
    // Each chat: charged $0.70, should be $0.10 → overcharged $0.60 each =
    // $1.20 total, over the $1.00 threshold.
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 100_000 });
    mockRefund.mockResolvedValue({ alreadyRefunded: false });

    const response = await GET(req());
    const body = (await response.json()) as { data: { breachedAlertThreshold: boolean } };

    expect(response.status).toBe(200);
    expect(body.data.breachedAlertThreshold).toBe(true);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    expect(mockReportOpsEvent.mock.calls[0][0]).toMatchObject({
      severity: "error",
      metadata: expect.objectContaining({
        totalOverchargeMicroUsd: 1_200_000,
        refundedCount: 2,
      }),
    });
  });

  it("escalates to error severity + flags refund_failed count when refund throws", async () => {
    usageRowsForRun = [
      usage({ id: "ue_fail", reference_id: "ref_fail", charged_micro_usd: 5_000 }),
    ];
    mockCalculateActualChatCost.mockReturnValue({ actualCostMicroUsd: 1_000 });
    mockRefund.mockRejectedValue(new Error("db connection lost"));

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { refundedCount: number; refundFailedCount: number; breachedAlertThreshold: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data.refundedCount).toBe(0);
    expect(body.data.refundFailedCount).toBe(1);
    expect(body.data.breachedAlertThreshold).toBe(true);
    // The logger also mirrors the per-event log.error into ops_events, so
    // total ops_events emissions ≥ 1. The one we care about is the
    // aggregate reconciliation-drift alert with failureType set.
    const driftAlerts = mockReportOpsEvent.mock.calls.filter(
      ([arg]) => arg?.metadata?.failureType === "managed_venice_reconciliation_drift",
    );
    expect(driftAlerts).toHaveLength(1);
    expect(driftAlerts[0][0]).toMatchObject({
      severity: "error",
      metadata: expect.objectContaining({ refundFailedCount: 1 }),
    });
  });

  it("flags unpriceable models so the operator notices missing catalog entries", async () => {
    usageRowsForRun = [
      usage({ id: "ue_unknown", reference_id: "ref_unknown", model: "ghost-model-xyz" }),
    ];
    mockCalculateActualChatCost.mockImplementation(() => {
      throw new FakeUnsupportedVeniceModelError("ghost-model-xyz");
    });

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { unpriceableCount: number; breachedAlertThreshold: boolean };
    };

    expect(response.status).toBe(200);
    expect(body.data.unpriceableCount).toBe(1);
    expect(body.data.breachedAlertThreshold).toBe(true);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
  });
});
