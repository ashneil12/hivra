import {
  MANAGED_VENICE_LAUNCH_DISCOUNT_BPS,
  MANAGED_VENICE_STANDARD_DISCOUNT_BPS,
  MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD,
  MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD,
  calculateManagedVeniceDiscount,
  resolveManagedVeniceDiscount,
} from "@/lib/billing/managed-venice-discounts";
import { appendManagedVeniceFinancialEvent } from "@/lib/billing/managed-venice-financial-events";

type Row = Record<string, unknown>;

function createQuery(rows: Row[]) {
  const filters: Array<[string, unknown]> = [];
  const query: {
    eq: (column: string, value: unknown) => typeof query;
    maybeSingle: () => Promise<{ data: Row | null; error: null }>;
    single: () => Promise<{ data: Row | null; error: null }>;
    then: Promise<{ data: Row[]; error: null }>["then"];
  } = {} as typeof query;

  function filtered() {
    return rows.filter((row) =>
      filters.every(([column, value]) => row[column] === value)
    );
  }

  query.eq = (column, value) => {
    filters.push([column, value]);
    return query;
  };
  query.maybeSingle = async () => ({ data: filtered()[0] ?? null, error: null });
  query.single = async () => ({ data: filtered()[0] ?? null, error: null });
  query.then = (resolve, reject) =>
    Promise.resolve({ data: filtered(), error: null }).then(resolve, reject);

  return query;
}

function createMemoryDb() {
  const tables: Record<string, Row[]> = {
    managed_venice_financial_events: [],
  };

  function insertRow(tableName: string, row: Row) {
    const table = tables[tableName];
    const stored = {
      id: row.id ?? `${tableName}_${table.length + 1}`,
      created_at: row.created_at ?? new Date(2026, 0, table.length + 1).toISOString(),
      ...row,
    };
    table.push(stored);
    return stored;
  }

  function table(name: string) {
    const rows = tables[name];
    if (!rows) throw new Error(`Unexpected table ${name}`);

    return {
      insert: (row: Row) => {
        const stored = insertRow(name, row);
        return {
          select: () => ({
            single: async () => ({ data: stored, error: null }),
          }),
          then: (
            resolve: (value: { data: Row; error: null }) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve({ data: stored, error: null }).then(resolve, reject),
        };
      },
      select: () => createQuery(rows),
    };
  }

  return {
    db: { from: table },
    tables,
  };
}

describe("managed Venice discount policy", () => {
  it("uses the 20% launch rate for eligible Hivra spend", () => {
    expect(MANAGED_VENICE_LAUNCH_DISCOUNT_BPS).toBe(2000);

    expect(
      resolveManagedVeniceDiscount({
        walletType: "hermesos",
        userLaunchSubsidyUsedMicroUsd: 0,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toEqual({
      rate: "launch_20",
      discountBps: 2000,
      reason: "launch_wave_available",
    });

    expect(
      calculateManagedVeniceDiscount({
        walletType: "hermesos",
        costMicroUsd: 1_000_000,
        userLaunchSubsidyUsedMicroUsd: 0,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toMatchObject({
      chargeMicroUsd: 800_000,
      discountMicroUsd: 200_000,
      launchSubsidyMicroUsd: 200_000,
      standardSubsidyMicroUsd: 0,
    });
  });

  it("steps only the capped user down to 10%", () => {
    expect(MANAGED_VENICE_USER_LAUNCH_SUBSIDY_CAP_MICRO_USD).toBe(250_000_000);

    expect(
      resolveManagedVeniceDiscount({
        walletType: "hermesos",
        userLaunchSubsidyUsedMicroUsd: 250_000_000,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toEqual({
      rate: "standard_10",
      discountBps: 1000,
      reason: "user_launch_cap_reached",
    });

    expect(
      resolveManagedVeniceDiscount({
        walletType: "hermesos",
        userLaunchSubsidyUsedMicroUsd: 0,
        weeklySubsidyUsedMicroUsd: 0,
      }).rate
    ).toBe("launch_20");
  });

  it("steps all new launch-wave spend down to 10% after the weekly kill switch", () => {
    expect(MANAGED_VENICE_WEEKLY_SUBSIDY_LIMIT_MICRO_USD).toBe(1_000_000_000);

    expect(
      resolveManagedVeniceDiscount({
        walletType: "hermesos",
        userLaunchSubsidyUsedMicroUsd: 0,
        weeklySubsidyUsedMicroUsd: 1_000_000_000,
      })
    ).toEqual({
      rate: "standard_10",
      discountBps: 1000,
      reason: "weekly_kill_switch_reached",
    });
  });

  it("never chains the user cap and kill switch into a 0% discount", () => {
    expect(
      resolveManagedVeniceDiscount({
        walletType: "hermesos",
        userLaunchSubsidyUsedMicroUsd: 999_999_999,
        weeklySubsidyUsedMicroUsd: 999_999_999,
        killSwitchActive: true,
      })
    ).toEqual({
      rate: "standard_10",
      discountBps: 1000,
      reason: "weekly_kill_switch_active",
    });
  });

  it("does not discount card wallet spend", () => {
    expect(
      calculateManagedVeniceDiscount({
        walletType: "card",
        costMicroUsd: 1_000_000,
        userLaunchSubsidyUsedMicroUsd: 0,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toEqual({
      rate: "none",
      discountBps: 0,
      reason: "card_wallet_unsubsidized",
      costMicroUsd: 1_000_000,
      chargeMicroUsd: 1_000_000,
      discountMicroUsd: 0,
      launchSubsidyMicroUsd: 0,
      standardSubsidyMicroUsd: 0,
    });
  });

  it("keeps the standard 10% rate uncapped in v1", () => {
    expect(MANAGED_VENICE_STANDARD_DISCOUNT_BPS).toBe(1000);

    expect(
      calculateManagedVeniceDiscount({
        walletType: "hermesos",
        costMicroUsd: 10_000_000,
        userLaunchSubsidyUsedMicroUsd: 999_999_999,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toMatchObject({
      rate: "standard_10",
      chargeMicroUsd: 9_000_000,
      discountMicroUsd: 1_000_000,
      launchSubsidyMicroUsd: 0,
      standardSubsidyMicroUsd: 1_000_000,
    });
  });

  it("splits a call that crosses the personal launch cap instead of overspending launch subsidy", () => {
    expect(
      calculateManagedVeniceDiscount({
        walletType: "hermesos",
        costMicroUsd: 1_000_000,
        userLaunchSubsidyUsedMicroUsd: 249_900_000,
        weeklySubsidyUsedMicroUsd: 0,
      })
    ).toMatchObject({
      rate: "mixed_launch_standard",
      chargeMicroUsd: 850_000,
      discountMicroUsd: 150_000,
      launchSubsidyMicroUsd: 100_000,
      standardSubsidyMicroUsd: 50_000,
    });
  });
});

describe("managed Venice financial events", () => {
  it("appends financial events idempotently by key", async () => {
    const { db, tables } = createMemoryDb();

    const first = await appendManagedVeniceFinancialEvent(
      {
        userId: "user_1",
        accountId: "account_1",
        eventType: "usage_capture",
        walletType: "hermesos",
        amountMicroUsd: 800_000,
        veniceCostMicroUsd: 1_000_000,
        discountMicroUsd: 200_000,
        referenceId: "usage_1",
        idempotencyKey: "usage_1:capture",
      },
      db
    );
    const second = await appendManagedVeniceFinancialEvent(
      {
        userId: "user_1",
        accountId: "account_1",
        eventType: "usage_capture",
        walletType: "hermesos",
        amountMicroUsd: 800_000,
        veniceCostMicroUsd: 1_000_000,
        discountMicroUsd: 200_000,
        referenceId: "usage_1",
        idempotencyKey: "usage_1:capture",
      },
      db
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(tables.managed_venice_financial_events).toHaveLength(1);
  });
});
