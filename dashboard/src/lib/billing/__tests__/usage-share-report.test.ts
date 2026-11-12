import type { SupabaseClient } from "@supabase/supabase-js";

import { loadUsageShareReport, parseUsageShareInputs, parseUsageShareMonth } from "../usage-share-report";

type Row = Record<string, unknown>;

interface Call {
  source: string;
  method: string;
  args: unknown[];
}

/** A stand-in database: every filter is recorded and ignored, range() pages the rows. */
function fakeDb(tables: Record<string, Row[] | Error>, rpcRows: Row[] = []) {
  const calls: Call[] = [];
  const builder = (source: string, rows: Row[] | Error) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "lt", "lte", "in", "order"]) {
      chain[method] = (...args: unknown[]) => {
        calls.push({ source, method, args });
        return chain;
      };
    }
    chain.range = (from: number, to: number) => {
      calls.push({ source, method: "range", args: [from, to] });
      if (rows instanceof Error) return Promise.resolve({ data: null, error: { message: rows.message } });
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    };
    return chain;
  };
  const db = {
    from: (table: string) => builder(table, tables[table] ?? []),
    rpc: (name: string, args: unknown) => {
      calls.push({ source: name, method: "rpc", args: [args] });
      return builder(name, rpcRows);
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const november = parseUsageShareMonth("2026-11");
const plainInputs = parseUsageShareInputs({ share: "10", fee: "0", fixed: "0" });

describe("parseUsageShareMonth", () => {
  it("reads a month as a UTC range", () => {
    expect(november.label).toBe("2026-11");
    expect(november.from.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(november.to.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(parseUsageShareMonth("2026-12").to.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("falls back to the current month for anything else", () => {
    const now = new Date("2026-03-15T12:00:00Z");
    expect(parseUsageShareMonth(undefined, now).label).toBe("2026-03");
    expect(parseUsageShareMonth("2026-13", now).label).toBe("2026-03");
    expect(parseUsageShareMonth("last month", now).label).toBe("2026-03");
  });
});

describe("parseUsageShareInputs", () => {
  it("has no share until one is typed in, and card-style fees by default", () => {
    expect(parseUsageShareInputs({})).toEqual({ sharePercent: 0, feePercent: 2.9, feeFixedMinor: 30, appStoreFeePercent: 30, usdRates: { USD: 1 } });
  });

  it("reads and limits what was typed", () => {
    expect(parseUsageShareInputs({ share: "250", fee: "-1", fixed: "0.5", appfee: "15", eur: "1.08", gbp: "abc" })).toEqual({
      sharePercent: 100, feePercent: 0, feeFixedMinor: 50, appStoreFeePercent: 15, usdRates: { USD: 1, EUR: 1.08 },
    });
  });
});

describe("loadUsageShareReport", () => {
  it("prices billed plans, converts server costs and splits by use", async () => {
    const { db, calls } = fakeDb(
      {
        hermes_subscriptions: [
          { user_id: "a", plan: "operator", stripe_subscription_id: "sub_1" },
          { user_id: "b", plan: "command", stripe_subscription_id: null }, // App Store
          { user_id: "c", plan: "fleet", stripe_subscription_id: null }, // no payment on record
        ],
        apple_iap_subscriptions: [{ user_id: "b" }],
        hivra_host_costs: [
          // newest first, as the query orders them
          { host_id: "host-a", monthly_cost_minor: 20000, currency: "USD", effective_from: "2026-11-01" },
          { host_id: "host-a", monthly_cost_minor: 15000, currency: "USD", effective_from: "2026-06-01" },
          { host_id: "host-b", monthly_cost_minor: 10000, currency: "EUR", effective_from: "2026-01-01" },
          { host_id: "host-c", monthly_cost_minor: 5000, currency: "GBP", effective_from: "2026-01-01" },
        ],
        proxmox_hosts: [
          { id: "host-a", status: "active" }, { id: "host-b", status: "active" },
          { id: "host-d", status: "active" }, { id: "host-e", status: "maintenance" },
        ],
      },
      [
        { user_id: "a", agent_type: "hermes", agents: 1, active_hours: 3, inference_requests: "12", inference_charged_micro_usd: "900000", inference_cost_micro_usd: "600000", run_events: "4" },
        { user_id: "b", agent_type: "openclaw", agents: 2, active_hours: 7, inference_requests: 0, inference_charged_micro_usd: 0, inference_cost_micro_usd: 0, run_events: 40 },
        { user_id: "c", agent_type: "hermes", agents: 1, active_hours: 5, inference_requests: 0, inference_charged_micro_usd: 0, inference_cost_micro_usd: 0, run_events: 9 },
      ],
    );

    const report = await loadUsageShareReport(db, november, { ...plainInputs, usdRates: { USD: 1, EUR: 1.1 } });

    expect(report.unbilledPaidPlans).toBe(1);
    expect(report.preview.payingPeople).toBe(2);
    expect(report.preview.revenueMinor).toBe(999 + 4900);
    expect(report.preview.appStorePeople).toBe(1);
    expect(report.preview.feesMinor).toBe(1470); // only b, at the App Store's 30%
    expect(report.serverCosts).toEqual({
      includedMinorUsd: 31000, // 20000 USD + 10000 EUR at 1.1; GBP has no rate
      byCurrency: { USD: 20000, EUR: 10000, GBP: 5000 },
      missingRates: ["GBP"],
      hostsPriced: 3,
      activeHosts: 3,
      unpricedHosts: ["host-d"],
    });
    expect(report.preview.netMinor).toBe(5899 - 1470 - 31000);
    expect(report.preview.poolMinor).toBe(0);

    const hermes = report.preview.byType.find((row) => row.agentType === "hermes");
    expect(hermes).toMatchObject({ activeHours: 8, people: 2, payingPeople: 1, inferenceRequests: 12, inferenceChargedMicroUsd: 900000, runEvents: 13 });

    const rpc = calls.find((call) => call.method === "rpc");
    expect(rpc).toMatchObject({ source: "hivra_usage_by_user_and_type", args: [{ p_from: "2026-11-01T00:00:00.000Z", p_to: "2026-12-01T00:00:00.000Z" }] });
    expect(calls).toContainEqual({ source: "hivra_host_costs", method: "lte", args: ["effective_from", "2026-11-30"] });
    expect(calls).toContainEqual({ source: "hermes_subscriptions", method: "lt", args: ["created_at", "2026-12-01T00:00:00.000Z"] });
  });

  it("gives each agent kind its part once servers are covered", async () => {
    const { db } = fakeDb(
      {
        hermes_subscriptions: [
          { user_id: "a", plan: "operator", stripe_subscription_id: "sub_1" },
          { user_id: "b", plan: "command", stripe_subscription_id: "sub_2" },
        ],
        hivra_host_costs: [{ host_id: "host-a", monthly_cost_minor: 899, currency: "USD", effective_from: "2026-01-01" }],
      },
      [
        { user_id: "a", agent_type: "hermes", agents: 1, active_hours: 4, inference_requests: 0, inference_charged_micro_usd: 0, inference_cost_micro_usd: 0, run_events: 1 },
        { user_id: "b", agent_type: "openclaw", agents: 1, active_hours: 1, inference_requests: 0, inference_charged_micro_usd: 0, inference_cost_micro_usd: 0, run_events: 1 },
      ],
    );

    const report = await loadUsageShareReport(db, november, plainInputs);

    expect(report.preview.netMinor).toBe(5000);
    expect(report.preview.poolMinor).toBe(500);
    // The split follows what each person pays, then hours: b pays more, so OpenClaw gets more.
    expect(report.preview.byType.map((row) => [row.agentType, row.shareMinor])).toEqual([["openclaw", 415], ["hermes", 85]]);
  });

  it("reads past the first page", async () => {
    const subscriptions = Array.from({ length: 1001 }, (_, index) => ({ user_id: `u${index}`, plan: "operator", stripe_subscription_id: `sub_${index}` }));
    const { db, calls } = fakeDb({ hermes_subscriptions: subscriptions });

    const report = await loadUsageShareReport(db, november, plainInputs);

    expect(report.preview.payingPeople).toBe(1001);
    expect(calls.filter((call) => call.source === "hermes_subscriptions" && call.method === "range").map((call) => call.args)).toEqual([[0, 999], [1000, 1999]]);
  });

  it("still reports when the server list cannot be read, and fails loudly when usage cannot", async () => {
    const ok = fakeDb({ proxmox_hosts: new Error("permission denied") });
    const report = await loadUsageShareReport(ok.db, november, plainInputs);
    expect(report.serverCosts.activeHosts).toBeNull();
    expect(report.serverCosts.unpricedHosts).toEqual([]);

    const broken = fakeDb({ hermes_subscriptions: new Error("relation does not exist") });
    await expect(loadUsageShareReport(broken.db, november, plainInputs)).rejects.toThrow("subscriptions: relation does not exist");
  });
});
