import {
  MANAGED_VENICE_MAX_SUMMARY_RANGE_DAYS,
  getManagedVeniceUsageSummary,
  parseSummaryRange,
} from "@/lib/venice/invoice-reconciliation";

type Row = Record<string, unknown>;

function createMemoryDb(rows: Row[]) {
  function buildChain() {
    let filtered = [...rows];
    const chain = {
      select: () => chain,
      gte: (column: string, value: unknown) => {
        filtered = filtered.filter(
          (row) => String(row[column] ?? "") >= String(value)
        );
        return chain;
      },
      lt: (column: string, value: unknown) => {
        filtered = filtered.filter(
          (row) => String(row[column] ?? "") < String(value)
        );
        return chain;
      },
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (
        resolve: (value: { data: Row[]; error: null }) => unknown,
        reject?: (reason: unknown) => unknown
      ) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };
    return chain;
  }

  return { from: () => buildChain() };
}

describe("Managed Venice invoice reconciliation summary", () => {
  it("defaults to a 24h window when neither bound is given", () => {
    const now = new Date("2026-05-17T12:00:00Z");
    const range = parseSummaryRange({ now });
    expect(range.to.toISOString()).toBe("2026-05-17T12:00:00.000Z");
    expect(range.from.toISOString()).toBe("2026-05-16T12:00:00.000Z");
  });

  it("rejects ranges longer than the configured max", () => {
    expect(() =>
      parseSummaryRange({
        from: "2026-01-01T00:00:00Z",
        to: "2026-06-01T00:00:00Z",
      })
    ).toThrow(
      new RegExp(`exceeds ${MANAGED_VENICE_MAX_SUMMARY_RANGE_DAYS} days`)
    );
  });

  it("aggregates usage by model and surfaces margin", async () => {
    const db = createMemoryDb([
      {
        created_at: "2026-05-16T01:00:00Z",
        model: "venice-uncensored-1-2",
        prompt_tokens: 100,
        completion_tokens: 200,
        actual_cost_micro_usd: 200,
        charged_micro_usd: 200,
        upstream_status: 200,
      },
      {
        created_at: "2026-05-16T02:00:00Z",
        model: "venice-uncensored-1-2",
        prompt_tokens: 50,
        completion_tokens: 80,
        actual_cost_micro_usd: 100,
        charged_micro_usd: 50, // overage uncovered case
        upstream_status: 200,
      },
      {
        created_at: "2026-05-16T03:00:00Z",
        model: "openai-gpt-52",
        prompt_tokens: 1_000,
        completion_tokens: 500,
        actual_cost_micro_usd: 10_950,
        charged_micro_usd: 10_950,
        upstream_status: 200,
      },
      {
        // Should be skipped — upstream failure means no Venice charge.
        created_at: "2026-05-16T04:00:00Z",
        model: "openai-gpt-52",
        prompt_tokens: 10,
        completion_tokens: 0,
        actual_cost_micro_usd: 0,
        charged_micro_usd: 0,
        upstream_status: 500,
      },
    ]);

    const summary = await getManagedVeniceUsageSummary(
      {
        from: new Date("2026-05-16T00:00:00Z"),
        to: new Date("2026-05-17T00:00:00Z"),
      },
      db
    );

    expect(summary.totals.requestCount).toBe(3);
    expect(summary.totals.veniceCostMicroUsd).toBe(11_250);
    expect(summary.totals.chargedMicroUsd).toBe(11_200);
    expect(summary.totals.marginMicroUsd).toBe(-50);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.byModel[0]).toMatchObject({
      model: "openai-gpt-52",
      requestCount: 1,
      veniceCostMicroUsd: 10_950,
    });
  });
});
