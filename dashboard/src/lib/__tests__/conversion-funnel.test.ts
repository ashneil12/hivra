import {
  buildDailySeries,
  buildUpgradeSplit,
  buildWeeklyCohorts,
  classifyUpgrade,
  fetchEngagedFreeUserIds,
  getConversionFunnel,
  groupInstancesByUser,
  instanceUsedPastDay1,
  isPaidPlan,
  lastNDayKeys,
  lastNWeekStarts,
  utcDayKey,
  utcWeekStartKey,
  type FunnelInstanceRow,
  type FunnelSubscriptionRow,
} from "@/lib/conversion-funnel";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// 2026-06-10 is a Wednesday (UTC).
const NOW = new Date("2026-06-10T15:30:00.000Z");

function sub(overrides: Partial<FunnelSubscriptionRow> = {}): FunnelSubscriptionRow {
  return {
    user_id: "user_1",
    plan: "free",
    created_at: "2026-06-08T10:00:00.000Z",
    current_period_start: null,
    ...overrides,
  };
}

function inst(overrides: Partial<FunnelInstanceRow> = {}): FunnelInstanceRow {
  return {
    user_id: "user_1",
    created_at: "2026-06-08T11:00:00.000Z",
    first_active_at: null,
    last_activity_at: null,
    ...overrides,
  };
}

describe("bucketing helpers", () => {
  it("utcDayKey uses the UTC date", () => {
    expect(utcDayKey("2026-06-10T23:59:59.000Z")).toBe("2026-06-10");
    expect(utcDayKey("2026-06-10T00:00:00.000Z")).toBe("2026-06-10");
  });

  it("utcWeekStartKey returns the UTC Monday of the week", () => {
    expect(utcWeekStartKey("2026-06-10T15:30:00.000Z")).toBe("2026-06-08"); // Wed → Mon
    expect(utcWeekStartKey("2026-06-08T00:00:00.000Z")).toBe("2026-06-08"); // Mon → itself
    expect(utcWeekStartKey("2026-06-07T23:59:59.000Z")).toBe("2026-06-01"); // Sun → prior Mon
  });

  it("lastNWeekStarts ends in the current week, oldest first", () => {
    const weeks = lastNWeekStarts(8, NOW);
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toBe("2026-06-08");
    expect(weeks[0]).toBe("2026-04-20");
    expect(weeks[1]).toBe("2026-04-27");
  });

  it("lastNDayKeys ends today, oldest first", () => {
    const days = lastNDayKeys(14, NOW);
    expect(days).toHaveLength(14);
    expect(days[13]).toBe("2026-06-10");
    expect(days[0]).toBe("2026-05-28");
  });
});

describe("classifyUpgrade", () => {
  it("classifies < 1h after signup as day0", () => {
    expect(classifyUpgrade("2026-06-08T10:00:00Z", "2026-06-08T10:59:59Z")).toBe("day0");
    // grandfathered rows can have a period start before signup
    expect(classifyUpgrade("2026-06-08T10:00:00Z", "2026-06-08T09:00:00Z")).toBe("day0");
  });

  it("classifies > 24h after signup as later", () => {
    expect(classifyUpgrade("2026-06-08T10:00:00Z", "2026-06-09T10:00:01Z")).toBe("later");
  });

  it("classifies 1h–24h or missing/invalid timestamps as unclear", () => {
    expect(classifyUpgrade("2026-06-08T10:00:00Z", "2026-06-08T12:00:00Z")).toBe("unclear");
    expect(classifyUpgrade("2026-06-08T10:00:00Z", null)).toBe("unclear");
    expect(classifyUpgrade("2026-06-08T10:00:00Z", "not-a-date")).toBe("unclear");
  });
});

describe("instanceUsedPastDay1", () => {
  it("requires activity more than 24h after first activation", () => {
    expect(
      instanceUsedPastDay1(
        inst({ first_active_at: "2026-06-01T00:00:00Z", last_activity_at: "2026-06-02T00:00:01Z" })
      )
    ).toBe(true);
    expect(
      instanceUsedPastDay1(
        inst({ first_active_at: "2026-06-01T00:00:00Z", last_activity_at: "2026-06-01T23:00:00Z" })
      )
    ).toBe(false);
    expect(instanceUsedPastDay1(inst({ last_activity_at: "2026-06-02T00:00:01Z" }))).toBe(false);
  });
});

describe("buildWeeklyCohorts", () => {
  const weekStarts = lastNWeekStarts(8, NOW);

  it("buckets signups by UTC week and computes funnel stages per cohort", () => {
    const subs = [
      // current week: deployed + active + day1 + paid
      sub({
        user_id: "u1",
        plan: "operator",
        created_at: "2026-06-08T10:00:00Z",
      }),
      // current week: deployed only
      sub({ user_id: "u2", created_at: "2026-06-09T10:00:00Z" }),
      // current week: never deployed
      sub({ user_id: "u3", created_at: "2026-06-10T10:00:00Z" }),
      // previous week
      sub({ user_id: "u4", created_at: "2026-06-03T10:00:00Z" }),
      // outside the 8-week window — dropped
      sub({ user_id: "u5", created_at: "2026-01-01T10:00:00Z" }),
    ];
    const instancesByUser = groupInstancesByUser([
      inst({
        user_id: "u1",
        first_active_at: "2026-06-08T11:00:00Z",
        last_activity_at: "2026-06-10T11:00:01Z",
      }),
      inst({ user_id: "u2" }),
      inst({ user_id: "u4", first_active_at: "2026-06-03T11:00:00Z" }),
    ]);

    const cohorts = buildWeeklyCohorts(subs, instancesByUser, weekStarts);

    expect(cohorts).toHaveLength(8);
    const current = cohorts[7];
    expect(current).toEqual({
      weekStart: "2026-06-08",
      signups: 3,
      deployed: 2,
      wentActive: 1,
      usedPastDay1: 1,
      paidNow: 1,
    });
    const previous = cohorts[6];
    expect(previous).toEqual({
      weekStart: "2026-06-01",
      signups: 1,
      deployed: 1,
      wentActive: 1,
      usedPastDay1: 0,
      paidNow: 0,
    });
    // untouched buckets stay zeroed
    expect(cohorts[0]).toEqual({
      weekStart: "2026-04-20",
      signups: 0,
      deployed: 0,
      wentActive: 0,
      usedPastDay1: 0,
      paidNow: 0,
    });
  });
});

describe("buildDailySeries", () => {
  it("counts each event type per UTC day and drops out-of-window timestamps", () => {
    const dayKeys = lastNDayKeys(14, NOW);
    const daily = buildDailySeries(dayKeys, {
      signupDates: ["2026-06-10T01:00:00Z", "2026-06-10T23:00:00Z", "2026-05-01T00:00:00Z"],
      deployDates: ["2026-06-09T12:00:00Z"],
      activationDates: ["2026-05-28T00:00:00Z"],
      paymentDates: ["2026-06-10T02:00:00Z"],
    });

    expect(daily).toHaveLength(14);
    expect(daily[13]).toEqual({ date: "2026-06-10", signups: 2, deploys: 0, activations: 0, payments: 1 });
    expect(daily[12]).toEqual({ date: "2026-06-09", signups: 0, deploys: 1, activations: 0, payments: 0 });
    expect(daily[0]).toEqual({ date: "2026-05-28", signups: 0, deploys: 0, activations: 1, payments: 0 });
    expect(daily.reduce((acc, d) => acc + d.signups, 0)).toBe(2);
  });
});

describe("buildUpgradeSplit", () => {
  it("prefers upgraded_at over current_period_start and only counts paid plans", () => {
    const split = buildUpgradeSplit([
      // day-0 by upgraded_at even though period start says later
      sub({
        plan: "operator",
        created_at: "2026-06-01T10:00:00Z",
        upgraded_at: "2026-06-01T10:30:00Z",
        current_period_start: "2026-06-05T10:00:00Z",
      }),
      // later by period-start inference
      sub({
        plan: "fleet",
        created_at: "2026-06-01T10:00:00Z",
        current_period_start: "2026-06-05T10:00:00Z",
      }),
      // paid but no usable timestamp
      sub({ plan: "command", created_at: "2026-06-01T10:00:00Z" }),
      // free rows are ignored
      sub({ plan: "free", created_at: "2026-06-01T10:00:00Z", current_period_start: "2026-06-01T10:00:00Z" }),
    ]);
    expect(split).toEqual({ day0: 1, later: 1, unclear: 1 });
  });
});

describe("isPaidPlan", () => {
  it("treats operator/fleet/command as paid and everything else as not", () => {
    expect(isPaidPlan("operator")).toBe(true);
    expect(isPaidPlan("fleet")).toBe(true);
    expect(isPaidPlan("command")).toBe(true);
    expect(isPaidPlan("free")).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
  });
});

// ---------- getConversionFunnel (mocked client) ----------

type MockResponse = { data?: unknown; error?: unknown; count?: number | null };
type RecordedQuery = { table: string; calls: Array<[string, unknown[]]> };

const BUILDER_METHODS = ["select", "gte", "lt", "eq", "in", "or", "not", "order", "limit", "range"];

function has(query: RecordedQuery, method: string, matcher?: (args: unknown[]) => boolean): boolean {
  return query.calls.some(([m, args]) => m === method && (!matcher || matcher(args)));
}

function selectCols(query: RecordedQuery): string {
  const call = query.calls.find(([m]) => m === "select");
  return typeof call?.[1][0] === "string" ? (call[1][0] as string) : "";
}

function mockSupabase(respond: (query: RecordedQuery) => MockResponse) {
  (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
    const query: RecordedQuery = { table, calls: [] };
    const builder: Record<string, unknown> = {};
    for (const method of BUILDER_METHODS) {
      builder[method] = (...args: unknown[]) => {
        query.calls.push([method, args]);
        return builder;
      };
    }
    builder.then = (
      resolve: (value: { data: unknown; error: unknown; count: number | null }) => unknown,
      reject: (reason: unknown) => unknown
    ) =>
      Promise.resolve()
        .then(() => respond(query))
        .then((r) => resolve({ data: null, error: null, count: null, ...r }), reject);
    return builder;
  });
}

describe("getConversionFunnel", () => {
  it("assembles funnel stats from the queries (upgraded_at present)", async () => {
    mockSupabase((query) => {
      if (query.table === "hermes_subscriptions") {
        // upgraded_at probe
        if (has(query, "limit")) return { data: [] };
        // plan totals
        if (has(query, "select", (args) => (args[1] as { head?: boolean })?.head === true)) {
          const plan = query.calls.find(([m, args]) => m === "eq" && args[0] === "plan")?.[1][1];
          return { count: plan === "free" ? 10 : plan === "operator" ? 3 : 0 };
        }
        // engaged-free pool membership (plan=free + in(user_id))
        if (has(query, "eq", (args) => args[0] === "plan" && args[1] === "free")) {
          return { data: [{ user_id: "engaged_1" }] };
        }
        // payments window (paid plans + or-filter)
        if (has(query, "or")) {
          expect(selectCols(query)).toContain("upgraded_at");
          return {
            data: [
              sub({
                user_id: "u1",
                plan: "operator",
                created_at: "2026-06-08T10:00:00Z",
                upgraded_at: "2026-06-09T12:00:00Z",
              }),
            ],
          };
        }
        // signups window
        expect(selectCols(query)).toContain("upgraded_at");
        return {
          data: [
            sub({
              user_id: "u1",
              plan: "operator",
              created_at: "2026-06-08T10:00:00Z",
              upgraded_at: "2026-06-09T12:00:00Z",
            }),
            sub({ user_id: "u2", created_at: "2026-06-09T10:00:00Z" }),
          ],
        };
      }
      if (query.table === "hermes_instances") {
        // engaged pool: live instances with recent activity
        if (has(query, "eq", (args) => args[0] === "lifecycle_state")) {
          return { data: [{ user_id: "engaged_1" }, { user_id: "engaged_2" }] };
        }
        // cohort instances for window users
        if (has(query, "in")) {
          return {
            data: [
              inst({
                user_id: "u1",
                first_active_at: "2026-06-08T11:00:00Z",
                last_activity_at: "2026-06-10T11:00:01Z",
              }),
            ],
          };
        }
        // daily deploys / activations
        if (selectCols(query).includes("first_active_at")) {
          return { data: [{ first_active_at: "2026-06-08T11:00:00Z" }] };
        }
        return { data: [{ created_at: "2026-06-08T11:00:00Z" }] };
      }
      throw new Error(`unexpected table ${query.table}`);
    });

    const stats = await getConversionFunnel(NOW);

    expect(stats.upgradeTimestampSource).toBe("upgraded_at");
    expect(stats.weeklyCohorts).toHaveLength(8);
    expect(stats.weeklyCohorts[7]).toEqual({
      weekStart: "2026-06-08",
      signups: 2,
      deployed: 1,
      wentActive: 1,
      usedPastDay1: 1,
      paidNow: 1,
    });
    expect(stats.daily).toHaveLength(14);
    const june9 = stats.daily.find((d) => d.date === "2026-06-09")!;
    expect(june9.signups).toBe(1);
    expect(june9.payments).toBe(1); // from upgraded_at, not period start
    const june8 = stats.daily.find((d) => d.date === "2026-06-08")!;
    expect(june8).toMatchObject({ signups: 1, deploys: 1, activations: 1 });
    expect(stats.engagedFreePool).toBe(1);
    expect(stats.currentTotals).toEqual({
      free: 10,
      paidByPlan: { operator: 3, fleet: 0, command: 0 },
    });
    expect(stats.upgradeSplit).toEqual({ day0: 0, later: 1, unclear: 0 });
  });

  it("falls back to current_period_start when upgraded_at does not exist", async () => {
    mockSupabase((query) => {
      if (query.table === "hermes_subscriptions") {
        if (has(query, "limit")) {
          return { error: { code: "42703", message: 'column "upgraded_at" does not exist' } };
        }
        if (has(query, "select", (args) => (args[1] as { head?: boolean })?.head === true)) {
          return { count: 0 };
        }
        // No select in this module may reference the missing column.
        expect(selectCols(query)).not.toContain("upgraded_at");
        if (has(query, "or")) throw new Error("or-filter must not be used without upgraded_at");
        if (has(query, "gte", (args) => args[0] === "current_period_start")) {
          return {
            data: [
              sub({
                user_id: "u1",
                plan: "operator",
                created_at: "2026-05-01T10:00:00Z",
                current_period_start: "2026-06-09T10:00:00Z",
              }),
            ],
          };
        }
        return { data: [] };
      }
      if (query.table === "hermes_instances") return { data: [] };
      throw new Error(`unexpected table ${query.table}`);
    });

    const stats = await getConversionFunnel(NOW);

    expect(stats.upgradeTimestampSource).toBe("period_start_inference");
    const june9 = stats.daily.find((d) => d.date === "2026-06-09")!;
    expect(june9.payments).toBe(1);
  });

  it("returns zeroed stats when a query fails", async () => {
    mockSupabase((query) => {
      if (query.table === "hermes_subscriptions" && has(query, "limit")) return { data: [] };
      return { error: { message: "boom" } };
    });

    const stats = await getConversionFunnel(NOW);

    expect(stats.weeklyCohorts).toHaveLength(8);
    expect(stats.weeklyCohorts.every((c) => c.signups === 0)).toBe(true);
    expect(stats.daily).toHaveLength(14);
    expect(stats.engagedFreePool).toBe(0);
    expect(stats.currentTotals.free).toBe(0);
  });

  it("paginates row fetches past the 1000-row PostgREST cap", async () => {
    const ranges: Array<[number, number]> = [];
    mockSupabase((query) => {
      if (query.table === "hermes_subscriptions") {
        if (has(query, "limit")) return { data: [] };
        if (has(query, "select", (args) => (args[1] as { head?: boolean })?.head === true)) {
          return { count: 0 };
        }
        if (has(query, "or") || has(query, "eq")) return { data: [] };
        // signups window: serve a full first page, then a short second page
        const range = query.calls.find(([m]) => m === "range")?.[1] as [number, number];
        ranges.push(range);
        if (range[0] === 0) {
          return {
            data: Array.from({ length: 1000 }, (_, i) =>
              sub({ user_id: `u${i}`, created_at: "2026-06-09T10:00:00Z" })
            ),
          };
        }
        return { data: [sub({ user_id: "u_last", created_at: "2026-06-09T10:00:00Z" })] };
      }
      if (query.table === "hermes_instances") return { data: [] };
      throw new Error(`unexpected table ${query.table}`);
    });

    const stats = await getConversionFunnel(NOW);

    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(stats.weeklyCohorts[7].signups).toBe(1001);
  });
});

describe("fetchEngagedFreeUserIds", () => {
  it("returns the deduped, sorted free-plan owners of recently-active live instances", async () => {
    mockSupabase((query) => {
      if (query.table === "hermes_instances") {
        // engaged pool: lifecycle_state='active' + recent last_activity_at
        expect(has(query, "eq", (args) => args[0] === "lifecycle_state" && args[1] === "active")).toBe(true);
        expect(has(query, "gte", (args) => args[0] === "last_activity_at")).toBe(true);
        return {
          data: [
            { user_id: "user_c" },
            { user_id: "user_a" },
            { user_id: "user_a" }, // two live instances → one user
            { user_id: "user_b" },
          ],
        };
      }
      if (query.table === "hermes_subscriptions") {
        expect(has(query, "eq", (args) => args[0] === "plan" && args[1] === "free")).toBe(true);
        // user_b is on a paid plan → not in the free membership result
        return { data: [{ user_id: "user_c" }, { user_id: "user_a" }] };
      }
      throw new Error(`unexpected table ${query.table}`);
    });

    const ids = await fetchEngagedFreeUserIds(
      supabaseAdmin as NonNullable<typeof supabaseAdmin>,
      "2026-06-03T12:00:00.000Z"
    );
    expect(ids).toEqual(["user_a", "user_c"]);
  });
});
