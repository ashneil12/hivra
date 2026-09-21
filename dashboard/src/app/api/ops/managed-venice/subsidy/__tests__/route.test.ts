import { NextRequest } from "next/server";

import { GET } from "../route";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

type QueryError = { message?: string } | null;

function selectChain(data: unknown, error: QueryError = null) {
  const chain: {
    select: jest.Mock;
    gte: jest.Mock;
    eq: jest.Mock;
    order: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  } = {
    select: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(async () => ({ data, error })),
    maybeSingle: jest.fn(async () => ({ data, error })),
  };
  return chain;
}

describe("GET /api/ops/managed-venice/subsidy", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const mockedSupabaseAdmin = supabaseAdmin as unknown as { from: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-05-12T12:00:00.000Z"));
    process.env.CRON_SECRET = "expected-secret";
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
  });

  function request(secret = "expected-secret") {
    return new NextRequest("http://localhost/api/ops/managed-venice/subsidy", {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/cron secret/i);
    expect(mockedSupabaseAdmin.from).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer token", async () => {
    const response = await GET(request("wrong-secret"));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
    expect(mockedSupabaseAdmin.from).not.toHaveBeenCalled();
  });

  it("returns subsidy burn, kill-switch alerts, whale warnings, and model spend", async () => {
    const financialRows = [
      {
        user_id: "user_whale",
        wallet_type: "hermesos",
        event_type: "subsidy_applied",
        amount_micro_usd: 0,
        venice_cost_micro_usd: 900_000_000,
        discount_micro_usd: 160_000_000,
        metadata: { model: "llama-3.1-405b" },
        created_at: "2026-05-12T09:00:00.000Z",
      },
      {
        user_id: "user_2",
        wallet_type: "hermesos",
        event_type: "subsidy_applied",
        amount_micro_usd: 0,
        venice_cost_micro_usd: 200_000_000,
        discount_micro_usd: 40_000_000,
        metadata: { model: "qwen-2.5" },
        created_at: "2026-05-10T09:00:00.000Z",
      },
      {
        user_id: "user_whale",
        wallet_type: "hermesos",
        event_type: "token_deposit",
        amount_micro_usd: 500_000_000,
        venice_cost_micro_usd: 0,
        discount_micro_usd: 0,
        metadata: {},
        created_at: "2026-05-12T08:00:00.000Z",
      },
    ];
    const usageRows = [
      {
        user_id: "user_whale",
        model: "llama-3.1-405b",
        wallet_type: "hermesos",
        actual_cost_micro_usd: 900_000_000,
        charged_micro_usd: 740_000_000,
        discount_micro_usd: 160_000_000,
        status: "recorded",
        created_at: "2026-05-12T09:00:00.000Z",
      },
      {
        user_id: "user_2",
        model: "qwen-2.5",
        wallet_type: "card",
        actual_cost_micro_usd: 50_000_000,
        charged_micro_usd: 50_000_000,
        discount_micro_usd: 0,
        status: "recorded",
        created_at: "2026-05-12T10:00:00.000Z",
      },
    ];
    const stateRow = {
      weekly_kill_switch_active: false,
      weekly_subsidy_used_micro_usd: 820_000_000,
      weekly_subsidy_limit_micro_usd: 1_000_000_000,
    };

    mockedSupabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "managed_venice_financial_events") return selectChain(financialRows);
      if (table === "managed_venice_usage_events") return selectChain(usageRows);
      if (table === "managed_venice_reconciliation_items") return selectChain([]);
      if (table === "managed_venice_platform_state") return selectChain(stateRow);
      throw new Error(`unexpected table ${table}`);
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.dailySubsidyBurnMicroUsd).toBe(160_000_000);
    expect(body.data.weeklySubsidyBurnMicroUsd).toBe(200_000_000);
    expect(body.data.killSwitch.alertLevel).toBe("eighty_percent");
    expect(body.data.usersOverWeeklyAlert).toEqual([
      expect.objectContaining({ userId: "user_whale", subsidyMicroUsd: 160_000_000 }),
    ]);
    expect(body.data.topSubsidyUsers[0]).toEqual(
      expect.objectContaining({ userId: "user_whale", subsidyMicroUsd: 160_000_000 })
    );
    expect(body.data.volumeLoop).toEqual(
      expect.objectContaining({
        dailyTokenInMicroUsd: 500_000_000,
        dailyVeniceCostOutMicroUsd: 950_000_000,
      })
    );
    expect(body.data.modelSpend).toEqual([
      expect.objectContaining({
        model: "llama-3.1-405b",
        actualCostMicroUsd: 900_000_000,
        discountMicroUsd: 160_000_000,
        callCount: 1,
      }),
      expect.objectContaining({
        model: "qwen-2.5",
        actualCostMicroUsd: 50_000_000,
        discountMicroUsd: 0,
        callCount: 1,
      }),
    ]);
  });

  it("flags drift between usage events and immutable financial events", async () => {
    const financialRows = [
      {
        user_id: "user_1",
        wallet_type: "hermesos",
        event_type: "usage_capture",
        reference_id: "ref_ok",
        amount_micro_usd: 90,
        venice_cost_micro_usd: 100,
        discount_micro_usd: 10,
        metadata: {},
        created_at: "2026-05-12T08:00:00.000Z",
      },
      {
        user_id: "user_2",
        wallet_type: "card",
        event_type: "usage_capture",
        reference_id: "ref_mismatch",
        amount_micro_usd: 40,
        venice_cost_micro_usd: 50,
        discount_micro_usd: 10,
        metadata: {},
        created_at: "2026-05-12T08:01:00.000Z",
      },
      {
        user_id: "user_ledger_only",
        wallet_type: "hermesos",
        event_type: "usage_capture",
        reference_id: "ref_ledger_only",
        amount_micro_usd: 20,
        venice_cost_micro_usd: 20,
        discount_micro_usd: 0,
        metadata: {},
        created_at: "2026-05-12T08:02:00.000Z",
      },
    ];
    const usageRows = [
      {
        user_id: "user_1",
        model: "venice-uncensored-1-2",
        wallet_type: "hermesos",
        reference_id: "ref_ok",
        actual_cost_micro_usd: 100,
        charged_micro_usd: 90,
        discount_micro_usd: 10,
        status: "recorded",
        created_at: "2026-05-12T08:00:00.000Z",
      },
      {
        user_id: "user_2",
        model: "zai-org-glm-4.7",
        wallet_type: "card",
        reference_id: "ref_mismatch",
        actual_cost_micro_usd: 50,
        charged_micro_usd: 45,
        discount_micro_usd: 5,
        status: "recorded",
        created_at: "2026-05-12T08:01:00.000Z",
      },
      {
        user_id: "user_usage_only",
        model: "deepseek-v4-flash",
        wallet_type: "hermesos",
        reference_id: "ref_usage_only",
        actual_cost_micro_usd: 30,
        charged_micro_usd: 30,
        discount_micro_usd: 0,
        status: "recorded",
        created_at: "2026-05-12T08:03:00.000Z",
      },
      {
        user_id: "user_multimodal",
        model: "venice-sd35",
        wallet_type: "hermesos",
        reference_id: "ref_offline_reconcile",
        actual_cost_micro_usd: 0,
        charged_micro_usd: 0,
        discount_micro_usd: 0,
        status: "reconciliation_required",
        created_at: "2026-05-12T08:04:00.000Z",
      },
    ];
    const reconciliationRows = [
      {
        user_id: "user_multimodal",
        status: "open",
        reason: "multimodal_offline_reconciliation",
        metadata: { referenceId: "ref_offline_reconcile" },
        created_at: "2026-05-12T08:04:00.000Z",
      },
    ];
    const stateRow = {
      weekly_kill_switch_active: false,
      weekly_subsidy_used_micro_usd: 0,
      weekly_subsidy_limit_micro_usd: 1_000_000_000,
    };

    mockedSupabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "managed_venice_financial_events") return selectChain(financialRows);
      if (table === "managed_venice_usage_events") return selectChain(usageRows);
      if (table === "managed_venice_reconciliation_items") {
        return selectChain(reconciliationRows);
      }
      if (table === "managed_venice_platform_state") return selectChain(stateRow);
      throw new Error(`unexpected table ${table}`);
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.reconciliation).toEqual(
      expect.objectContaining({
        openItemCount: 1,
        usageLedger: expect.objectContaining({
          usageActualCostMicroUsd: 180,
          financialVeniceCostMicroUsd: 170,
          actualCostDriftMicroUsd: 10,
          usageChargedMicroUsd: 165,
          financialChargedMicroUsd: 150,
          chargedDriftMicroUsd: 15,
          usageDiscountMicroUsd: 15,
          financialDiscountMicroUsd: 20,
          discountDriftMicroUsd: -5,
          missingFinancialEventCount: 1,
          missingUsageEventCount: 1,
          mismatchedReferenceCount: 1,
          reconciliationRequiredUsageCount: 1,
        }),
      })
    );
    expect(body.data.reconciliation.usageLedger.missingFinancialEvents).toEqual([
      expect.objectContaining({
        referenceId: "ref_usage_only",
        actualCostMicroUsd: 30,
        chargedMicroUsd: 30,
      }),
    ]);
    expect(body.data.reconciliation.usageLedger.missingUsageEvents).toEqual([
      expect.objectContaining({
        referenceId: "ref_ledger_only",
        veniceCostMicroUsd: 20,
        amountMicroUsd: 20,
      }),
    ]);
    expect(body.data.reconciliation.usageLedger.mismatchedReferences).toEqual([
      expect.objectContaining({
        referenceId: "ref_mismatch",
        drift: expect.objectContaining({
          chargedMicroUsd: 5,
          discountMicroUsd: -5,
        }),
      }),
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      "managed Venice usage ledger drift detected",
      expect.objectContaining({
        source: "ops/managed-venice/subsidy",
        route: "/api/ops/managed-venice/subsidy",
        failureType: "managed_venice_usage_ledger_drift_detected",
        actualCostDriftMicroUsd: 10,
        missingFinancialEventCount: 1,
        missingUsageEventCount: 1,
        mismatchedReferenceCount: 1,
      })
    );
  });
});
