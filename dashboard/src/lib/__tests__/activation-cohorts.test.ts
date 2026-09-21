import {
  buildActivationCohorts,
  getActivationCohorts,
  groupInstancesByUser,
  isRetained,
  isUsedKnownForWeek,
  pickSubscriptionByUser,
  utcWeekEndKey,
  FIRST_USAGE_INSTRUMENTED_FROM,
  RETENTION_DAYS,
  type ActivationInstanceRow,
  type ActivationSubscriptionRow,
} from "@/lib/activation-cohorts";
import { lastNWeekStarts } from "@/lib/conversion-funnel";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// 2026-06-10 is a Wednesday (UTC). Current week starts Mon 2026-06-08.
const NOW = new Date("2026-06-10T15:30:00.000Z");

function inst(overrides: Partial<ActivationInstanceRow> = {}): ActivationInstanceRow {
  return {
    user_id: "user_1",
    created_at: "2026-06-08T11:00:00.000Z",
    first_active_at: null,
    first_usage_at: null,
    last_activity_at: null,
    deleted_at: null,
    standing_task_seeded_at: null,
    ...overrides,
  };
}

function sub(overrides: Partial<ActivationSubscriptionRow> = {}): ActivationSubscriptionRow {
  return {
    user_id: "user_1",
    plan: "free",
    status: "active",
    current_period_end: null,
    ...overrides,
  };
}

describe("week-end / instrumentation discontinuity", () => {
  it("utcWeekEndKey returns the Sunday ending the week", () => {
    expect(utcWeekEndKey("2026-06-08")).toBe("2026-06-14"); // Mon → Sun
    expect(utcWeekEndKey("2026-05-25")).toBe("2026-05-31");
  });

  it("isUsedKnownForWeek is false only when the whole week ends before instrumentation", () => {
    // first_usage instrumented from 2026-05-30
    // Week 2026-05-18 → ends 2026-05-24, fully dark → unknown
    expect(isUsedKnownForWeek("2026-05-18", FIRST_USAGE_INSTRUMENTED_FROM)).toBe(false);
    // Week 2026-05-25 → ends 2026-05-31 ≥ 2026-05-30, straddles → known (honest floor)
    expect(isUsedKnownForWeek("2026-05-25", FIRST_USAGE_INSTRUMENTED_FROM)).toBe(true);
    // Week starting on the cutoff → known
    expect(isUsedKnownForWeek("2026-06-01", FIRST_USAGE_INSTRUMENTED_FROM)).toBe(true);
  });
});

describe("isRetained", () => {
  const deploy = "2026-05-01T00:00:00.000Z";

  it("retains a paid active sub whose period end advanced past the horizon", () => {
    expect(
      isRetained(
        deploy,
        [],
        sub({ plan: "operator", status: "active", current_period_end: "2026-06-20T00:00:00Z" }),
        NOW
      )
    ).toBe(true);
  });

  it("does not retain when the period end is within cycle 1", () => {
    expect(
      isRetained(
        deploy,
        [],
        sub({ plan: "operator", status: "active", current_period_end: "2026-05-20T00:00:00Z" }),
        NOW
      )
    ).toBe(false);
  });

  it("retains a still-alive instance active past the horizon (even on free)", () => {
    expect(
      isRetained(
        deploy,
        [inst({ deleted_at: null, last_activity_at: "2026-06-09T00:00:00Z" })],
        sub({ plan: "free" }),
        NOW
      )
    ).toBe(true);
  });

  it("does not retain a deleted instance even if it was active late", () => {
    expect(
      isRetained(
        deploy,
        [inst({ deleted_at: "2026-06-01T00:00:00Z", last_activity_at: "2026-06-09T00:00:00Z" })],
        sub({ plan: "free" }),
        NOW
      )
    ).toBe(false);
  });

  it("ignores activity timestamps in the future relative to now", () => {
    expect(
      isRetained(
        deploy,
        [inst({ last_activity_at: "2027-01-01T00:00:00Z" })],
        sub({ plan: "free" }),
        NOW
      )
    ).toBe(false);
  });
});

describe("pickSubscriptionByUser", () => {
  it("prefers a paid active subscription over a free row for the same user", () => {
    const byUser = pickSubscriptionByUser([
      sub({ user_id: "u1", plan: "free", status: "active" }),
      sub({ user_id: "u1", plan: "operator", status: "active" }),
      sub({ user_id: "u2", plan: "free", status: "active" }),
    ]);
    expect(byUser.get("u1")?.plan).toBe("operator");
    expect(byUser.get("u2")?.plan).toBe("free");
  });
});

describe("buildActivationCohorts", () => {
  const weekStarts = lastNWeekStarts(8, NOW);

  it("splits booted vs used vs paid vs retained, counting each user once per cohort", () => {
    const instances = [
      // u1: booted + used (current week), two instances → counted once
      inst({ user_id: "u1", created_at: "2026-06-08T10:00:00Z", first_active_at: "2026-06-08T11:00:00Z", first_usage_at: "2026-06-08T12:00:00Z", standing_task_seeded_at: "2026-06-08T12:30:00Z", last_activity_at: "2026-06-10T00:00:00Z" }),
      inst({ user_id: "u1", created_at: "2026-06-09T10:00:00Z" }),
      // u2: booted only (current week)
      inst({ user_id: "u2", created_at: "2026-06-09T10:00:00Z", first_active_at: "2026-06-09T11:00:00Z" }),
      // u3: deployed only, never booted (current week)
      inst({ user_id: "u3", created_at: "2026-06-10T10:00:00Z" }),
      // u4: previous week, booted + used + retained (still active long after deploy)
      inst({ user_id: "u4", created_at: "2026-06-01T10:00:00Z", first_active_at: "2026-06-01T11:00:00Z", first_usage_at: "2026-06-01T12:00:00Z" }),
    ];
    const subsByUser = pickSubscriptionByUser([
      sub({ user_id: "u1", plan: "operator", status: "active", current_period_end: "2026-07-20T00:00:00Z" }),
      sub({ user_id: "u2", plan: "free" }),
      sub({ user_id: "u3", plan: "free" }),
      sub({ user_id: "u4", plan: "fleet", status: "active", current_period_end: "2026-07-20T00:00:00Z" }),
    ]);
    const digestUsers = new Set(["u1", "u4"]);

    const cohorts = buildActivationCohorts(instances, subsByUser, digestUsers, weekStarts, NOW);

    expect(cohorts).toHaveLength(8);
    const current = cohorts[7];
    expect(current).toEqual({
      weekStart: "2026-06-08",
      deployed: 3, // u1, u2, u3
      booted: 2, // u1, u2
      used: 1, // u1
      usedKnown: true,
      paid: 1, // u1 (operator)
      retained: 1, // u1 (period end advanced past horizon)
      digestEmailed: 1, // u1
      withStandingTask: 1, // u1
    });
    const previous = cohorts[6];
    expect(previous).toEqual({
      weekStart: "2026-06-01",
      deployed: 1, // u4
      booted: 1,
      used: 1,
      usedKnown: true,
      paid: 1,
      retained: 1, // fleet period end advanced
      digestEmailed: 1,
      withStandingTask: 0,
    });
  });

  it("reports used as 0 with usedKnown=false for cohorts before instrumentation", () => {
    // Force a fixed instrumentation date so the assertion is stable.
    const instances = [
      inst({ user_id: "old1", created_at: "2026-04-21T10:00:00Z", first_active_at: "2026-04-21T11:00:00Z", first_usage_at: "2026-04-21T12:00:00Z" }),
    ];
    const cohorts = buildActivationCohorts(
      instances,
      new Map(),
      new Set(),
      weekStarts,
      NOW,
      { instrumentedFrom: "2026-05-30" }
    );
    // 2026-04-20 week ends 2026-04-26, fully before 2026-05-30 → unknown
    const dark = cohorts.find((c) => c.weekStart === "2026-04-20")!;
    expect(dark.deployed).toBe(1);
    expect(dark.booted).toBe(1);
    expect(dark.used).toBe(0); // not counted because usedKnown is false
    expect(dark.usedKnown).toBe(false);
  });

  it("returns fully-zeroed cohorts for empty input, honoring the discontinuity flag", () => {
    const cohorts = buildActivationCohorts(
      [],
      new Map(),
      new Set(),
      weekStarts,
      NOW,
      { instrumentedFrom: "2026-05-30" }
    );
    expect(cohorts).toHaveLength(8);
    for (const c of cohorts) {
      expect(c.deployed).toBe(0);
      expect(c.booted).toBe(0);
      expect(c.used).toBe(0);
      expect(c.paid).toBe(0);
      expect(c.retained).toBe(0);
    }
    // earliest bucket is dark, current week is known
    expect(cohorts[0].usedKnown).toBe(false);
    expect(cohorts[7].usedKnown).toBe(true);
  });
});

describe("groupInstancesByUser", () => {
  it("groups by user and drops null user_id", () => {
    const map = groupInstancesByUser([
      inst({ user_id: "a" }),
      inst({ user_id: "a" }),
      inst({ user_id: null }),
      inst({ user_id: "b" }),
    ]);
    expect(map.get("a")).toHaveLength(2);
    expect(map.get("b")).toHaveLength(1);
    expect(map.has("null")).toBe(false);
  });
});

// ---------- getActivationCohorts (mocked client) ----------

type MockResponse = { data?: unknown; error?: unknown };
type RecordedQuery = { table: string; calls: Array<[string, unknown[]]> };

const BUILDER_METHODS = ["select", "gte", "lt", "eq", "in", "like", "or", "not", "order", "limit", "range"];

function has(query: RecordedQuery, method: string, matcher?: (args: unknown[]) => boolean): boolean {
  return query.calls.some(([m, args]) => m === method && (!matcher || matcher(args)));
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
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject: (reason: unknown) => unknown
    ) =>
      Promise.resolve()
        .then(() => respond(query))
        .then((r) => resolve({ data: null, error: null, ...r }), reject);
    return builder;
  });
}

describe("getActivationCohorts", () => {
  it("assembles cohorts from instances + subscriptions + digest sends", async () => {
    mockSupabase((query) => {
      if (query.table === "hermes_instances") {
        return {
          data: [
            inst({ user_id: "u1", created_at: "2026-06-08T10:00:00Z", first_active_at: "2026-06-08T11:00:00Z", first_usage_at: "2026-06-08T12:00:00Z" }),
            inst({ user_id: "u2", created_at: "2026-06-09T10:00:00Z", first_active_at: "2026-06-09T11:00:00Z" }),
          ],
        };
      }
      if (query.table === "hermes_subscriptions") {
        expect(has(query, "in", (args) => args[0] === "user_id")).toBe(true);
        return {
          data: [
            sub({ user_id: "u1", plan: "operator", status: "active", current_period_end: "2026-07-20T00:00:00Z" }),
            sub({ user_id: "u2", plan: "free" }),
          ],
        };
      }
      if (query.table === "lifecycle_email_sends") {
        expect(has(query, "like", (args) => args[0] === "email_key" && String(args[1]).startsWith("activity_digest"))).toBe(true);
        return { data: [{ user_id: "u1" }] };
      }
      throw new Error(`unexpected table ${query.table}`);
    });

    const stats = await getActivationCohorts(NOW);

    expect(stats.firstUsageInstrumentedFrom).toBe(FIRST_USAGE_INSTRUMENTED_FROM);
    expect(stats.retentionDays).toBe(RETENTION_DAYS);
    expect(stats.cohorts).toHaveLength(8);
    const current = stats.cohorts[7];
    expect(current.weekStart).toBe("2026-06-08");
    expect(current.deployed).toBe(2);
    expect(current.booted).toBe(2);
    expect(current.used).toBe(1); // only u1
    expect(current.paid).toBe(1); // u1 operator
    expect(current.retained).toBe(1); // u1 period end advanced
    expect(current.digestEmailed).toBe(1); // u1
  });

  it("returns zeroed stats when a query fails", async () => {
    mockSupabase(() => ({ error: { message: "boom" } }));
    const stats = await getActivationCohorts(NOW);
    expect(stats.cohorts).toHaveLength(8);
    expect(stats.cohorts.every((c) => c.deployed === 0)).toBe(true);
    // discontinuity flag is still computed in the empty path
    expect(stats.cohorts[7].usedKnown).toBe(true);
  });
});
