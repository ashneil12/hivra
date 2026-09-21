import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

import { createDepositQuote } from "../deposit-quotes";

interface DepositQuoteRow {
  id: string;
  user_id: string;
  tier: "pro" | "power";
  threshold_tier_code: string;
  usd_target_cents: number;
  price_usd_at_quote: string;
  tokens_required_raw: string;
  tokens_required_display: string;
  quoted_at: string;
  expires_at: string;
  status: "active" | "consumed" | "expired" | "cancelled";
  consumed_balance_raw: string | null;
  consumed_at: string | null;
  source: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface DepositQuoteInsert {
  user_id: string;
  tier: "pro" | "power";
  threshold_tier_code: string;
  usd_target_cents: number;
  price_usd_at_quote: string;
  tokens_required_raw: string;
  tokens_required_display: string;
  quoted_at: string;
  expires_at: string;
  status: "active";
  source: string;
  metadata: Record<string, unknown>;
}

interface DepositQuoteQueryMock {
  update: jest.Mock;
  insert: jest.Mock;
  select: jest.Mock;
  eq: jest.Mock;
  lt: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  then: Promise<{ data: DepositQuoteRow[]; error: null }>["then"];
}

function installDepositQuoteDb(rows: DepositQuoteRow[]) {
  const from = supabaseAdmin!.from as jest.Mock;
  from.mockImplementation((tableName: string) => {
    if (tableName !== "deposit_quotes") {
      const emptyQuery: {
        eq: jest.Mock;
        lt: jest.Mock;
        order: jest.Mock;
        limit: jest.Mock;
        then: Promise<{ data: unknown[] | null; error: null }>["then"];
      } = {} as {
        eq: jest.Mock;
        lt: jest.Mock;
        order: jest.Mock;
        limit: jest.Mock;
        then: Promise<{ data: unknown[] | null; error: null }>["then"];
      };
      emptyQuery.eq = jest.fn(() => emptyQuery);
      emptyQuery.lt = jest.fn(() => emptyQuery);
      emptyQuery.order = jest.fn(() => emptyQuery);
      emptyQuery.limit = jest.fn(() => emptyQuery);
      emptyQuery.then = (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
      return {
        select: jest.fn(() => emptyQuery),
        update: jest.fn(() => emptyQuery),
      };
    }

    let updatePayload: Partial<DepositQuoteRow> | null = null;
    const eqFilters: Array<[string, unknown]> = [];
    const ltFilters: Array<[string, string]> = [];

    const matches = (row: DepositQuoteRow) =>
      eqFilters.every(([column, value]) => row[column as keyof DepositQuoteRow] === value) &&
      ltFilters.every(([column, value]) => String(row[column as keyof DepositQuoteRow]) < value);

    const query = {} as DepositQuoteQueryMock;
    query.update = jest.fn((payload: Partial<DepositQuoteRow>) => {
      updatePayload = payload;
      return query;
    });
    query.insert = jest.fn((payload: DepositQuoteInsert) => ({
      select: jest.fn(() => ({
        single: jest.fn(async () => {
          const row: DepositQuoteRow = {
            id: `quote_${rows.length + 1}`,
            ...payload,
            consumed_balance_raw: null,
            consumed_at: null,
            created_at: payload.quoted_at,
            updated_at: payload.quoted_at,
          };
          rows.push(row);
          return { data: row, error: null };
        }),
      })),
    }));
    query.select = jest.fn(() => query);
    query.eq = jest.fn((column: string, value: unknown) => {
      eqFilters.push([column, value]);
      return query;
    });
    query.lt = jest.fn((column: string, value: string) => {
      ltFilters.push([column, value]);
      if (updatePayload) {
        for (const row of rows) {
          if (matches(row)) Object.assign(row, updatePayload);
        }
      }
      return query;
    });
    query.order = jest.fn(() => query);
    query.limit = jest.fn(() => query);
    query.then = (resolve, reject) => Promise.resolve({
      data: rows.filter(matches).sort((a, b) => b.quoted_at.localeCompare(a.quoted_at)),
      error: null,
    }).then(resolve, reject);

    return query;
  });
}

describe("deposit quotes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("locks a quoted tier price for the full 20 minutes and reuses the active lock", async () => {
    const rows: DepositQuoteRow[] = [];
    installDepositQuoteDb(rows);

    const first = await createDepositQuote({
      userId: "user_a",
      tier: "pro",
      now: new Date("2026-05-12T12:00:00.000Z"),
      priceQuote: {
        priceUsd: "1",
        lastUpdatedAt: 1_778_586_000,
        source: "dexscreener",
        raw: {},
      },
    });

    const second = await createDepositQuote({
      userId: "user_a",
      tier: "pro",
      now: new Date("2026-05-12T12:05:00.000Z"),
      priceQuote: {
        priceUsd: "0.5",
        lastUpdatedAt: 1_778_586_300,
        source: "dexscreener",
        raw: {},
      },
    });

    expect(first.expiresAt).toBe("2026-05-12T12:20:00.000Z");
    expect(second.id).toBe(first.id);
    expect(second.priceUsdAtQuote).toBe("1");
    expect(second.tokensRequiredRaw).toBe(first.tokensRequiredRaw);
    expect(rows).toHaveLength(1);
  });
});
