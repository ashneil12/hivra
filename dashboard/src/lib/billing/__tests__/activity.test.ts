import {
  getBillingActivity,
  normalizeBillingActivityLimit,
} from "@/lib/billing/activity";

function createMemoryDb(rowsByTable: Record<string, Array<Record<string, unknown>>>) {
  return {
    from: jest.fn((tableName: string) => ({
      select: () => {
        const filters: Record<string, unknown> = {};
        let orderColumn = "created_at";
        let ascending = false;

        const query = {
          eq: (column: string, value: unknown) => {
            filters[column] = value;
            return query;
          },
          order: (column: string, options?: { ascending?: boolean }) => {
            orderColumn = column;
            ascending = Boolean(options?.ascending);
            return query;
          },
          limit: async (limit: number) => {
            const rows = [...(rowsByTable[tableName] || [])]
              .filter((row) => Object.entries(filters).every(([column, value]) => row[column] === value))
              .sort((a, b) => {
                const left = String(a[orderColumn] || "");
                const right = String(b[orderColumn] || "");
                return ascending ? left.localeCompare(right) : right.localeCompare(left);
              })
              .slice(0, limit);

            return { data: rows, error: null };
          },
        };

        return query;
      },
    })),
  };
}

describe("billing activity", () => {
  it("normalizes activity limits", () => {
    expect(normalizeBillingActivityLimit(null)).toBe(10);
    expect(normalizeBillingActivityLimit("bad")).toBe(10);
    expect(normalizeBillingActivityLimit("0")).toBe(1);
    expect(normalizeBillingActivityLimit("500")).toBe(50);
    expect(normalizeBillingActivityLimit(7.8)).toBe(7);
  });

  it("returns recent billing rows without raw metadata", async () => {
    const db = createMemoryDb({
      credit_ledger_entries: [
        {
          id: "ledger_other",
          user_id: "other_user",
          amount_credits: 999,
          source: "admin",
          actor: "admin",
          reason: "admin_adjustment",
          reference_id: "secret_reference",
          metadata: { secret: "do-not-return" },
          created_at: "2026-04-24T12:00:00.000Z",
        },
        {
          id: "ledger_1",
          user_id: "user_1",
          amount_credits: 1000,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          reference_id: "cs_1",
          metadata: { secret: "do-not-return" },
          created_at: "2026-04-24T13:00:00.000Z",
        },
      ],
      payment_transactions: [
        {
          id: "payment_1",
          user_id: "user_1",
          provider: "stripe",
          provider_reference_id: "cs_1",
          status: "succeeded",
          asset: "USD",
          amount_minor: 1000,
          package_credits: 1000,
          metadata: { rawPayload: "do-not-return" },
          created_at: "2026-04-24T13:00:01.000Z",
        },
      ],
      compute_usage_events: [
        {
          id: "compute_1",
          user_id: "user_1",
          instance_id: "00000000-0000-4000-8000-000000000001",
          credits_delta: -100,
          usage_kind: "compute",
          reference_id: "inst_1:2026-04-24T13",
          usage_period_start: "2026-04-24T13:00:00.000Z",
          usage_period_end: "2026-04-24T14:00:00.000Z",
          status: "recorded",
          metadata: { rawPayload: "do-not-return" },
          created_at: "2026-04-24T14:00:00.000Z",
        },
      ],
      llm_usage_events: [
        {
          id: "llm_1",
          user_id: "user_1",
          instance_id: "00000000-0000-4000-8000-000000000001",
          conversation_id: "chat_1",
          provider: "bankr",
          model: "claude-opus-4.7",
          billing_source: "hermes_credits",
          credits_delta: -75,
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
          reference_id: "llm:chat_1:turn_1",
          status: "recorded",
          metadata: { rawPayload: "do-not-return" },
          created_at: "2026-04-24T13:30:00.000Z",
        },
      ],
      managed_venice_usage_events: [],
      managed_venice_financial_events: [],
    });

    const activity = await getBillingActivity("user_1", { limit: 10 }, db);

    expect(activity.creditLedgerEntries).toEqual([
      {
        id: "ledger_1",
        amountCredits: 1000,
        source: "stripe",
        actor: "stripe_webhook",
        reason: "stripe_topup",
        referenceId: "cs_1",
        createdAt: "2026-04-24T13:00:00.000Z",
      },
    ]);
    expect(activity.paymentTransactions).toEqual([
      expect.objectContaining({
        id: "payment_1",
        provider: "stripe",
        amountMinor: 1000,
        packageCredits: 1000,
      }),
    ]);
    expect(activity.computeUsageEvents).toEqual([
      expect.objectContaining({
        id: "compute_1",
        creditsDelta: -100,
        usageKind: "compute",
      }),
    ]);
    expect(activity.llmUsageEvents).toEqual([
      expect.objectContaining({
        id: "llm_1",
        provider: "bankr",
        billingSource: "hermes_credits",
        creditsDelta: -75,
        totalTokens: 1500,
      }),
    ]);
    expect(JSON.stringify(activity)).not.toContain("do-not-return");
    expect(JSON.stringify(activity)).not.toContain("ledger_other");
  });

  it("includes managed Venice usage and financial events for the account", async () => {
    const db = createMemoryDb({
      credit_ledger_entries: [],
      payment_transactions: [],
      compute_usage_events: [],
      llm_usage_events: [],
      managed_venice_usage_events: [
        {
          id: "usage_1",
          user_id: "user_123",
          wallet_type: "hermesos",
          endpoint: "/api/v1/chat/completions",
          model: "llama-3.1-405b",
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          actual_cost_micro_usd: 1_000_000,
          charged_micro_usd: 800_000,
          discount_micro_usd: 200_000,
          status: "recorded",
          reference_id: "mv_usage_1",
          created_at: "2026-05-12T09:00:00.000Z",
        },
      ],
      managed_venice_financial_events: [
        {
          id: "financial_1",
          user_id: "user_123",
          wallet_type: "hermesos",
          event_type: "subsidy_applied",
          reference_id: "mv_usage_1",
          amount_micro_usd: 0,
          venice_cost_micro_usd: 1_000_000,
          discount_micro_usd: 200_000,
          created_at: "2026-05-12T09:00:01.000Z",
        },
      ],
    });

    const activity = await getBillingActivity("user_123", { limit: 5 }, db);

    expect(activity.managedVeniceUsageEvents).toEqual([
      {
        id: "usage_1",
        walletType: "hermesos",
        endpoint: "/api/v1/chat/completions",
        model: "llama-3.1-405b",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        actualCostMicroUsd: 1_000_000,
        chargedMicroUsd: 800_000,
        discountMicroUsd: 200_000,
        status: "recorded",
        referenceId: "mv_usage_1",
        createdAt: "2026-05-12T09:00:00.000Z",
      },
    ]);
    expect(activity.managedVeniceFinancialEvents).toEqual([
      {
        id: "financial_1",
        walletType: "hermesos",
        eventType: "subsidy_applied",
        referenceId: "mv_usage_1",
        amountMicroUsd: 0,
        veniceCostMicroUsd: 1_000_000,
        discountMicroUsd: 200_000,
        createdAt: "2026-05-12T09:00:01.000Z",
      },
    ]);
    expect(db.from).toHaveBeenCalledWith("managed_venice_usage_events");
    expect(db.from).toHaveBeenCalledWith("managed_venice_financial_events");
  });

  it("requires a user id", async () => {
    const db = createMemoryDb({});

    await expect(getBillingActivity("", {}, db)).rejects.toThrow(/user ID is required/);
  });
});
