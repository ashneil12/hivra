/**
 * Lifecycle-email sweep tests. The contract this locks in:
 *   - cohort windows: day1_idle (signup 24–48h, zero instances),
 *     day1_active (FIRST instance 24–48h), day3_usecase (72–96h),
 *     day7_offer (168–192h, free plan only), stalled_5d (live instance
 *     idle 5–21 days)
 *   - at most one email per user per run, in priority order
 *   - at most one send per (user, key) ever via the lifecycle_email_sends
 *     ledger; the Resend idempotencyKey is stable per (key, user)
 *   - per-send failures don't kill the run
 *   - the batch cap stops the run and reports capHit
 *   - a PostHog lifecycle_email_sent capture per successful send + a flush
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const sendMock = jest.fn();
jest.mock("@/lib/email/lifecycle", () => ({
  sendLifecycleEmail: (...args: unknown[]) => sendMock(...args),
}));

const captureMock = jest.fn();
const flushMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: (...args: unknown[]) => flushMock(...args),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

// Mobile push fan-out (iOS Phase 2) is strictly additive beside the emails;
// mocked so the sweep's supabase call ledger (buildDb queues) stays exactly as
// it was pre-push and no expo transport ever loads in tests.
const pushMock = jest.fn();
jest.mock("@/lib/push/expo-push", () => ({
  sendMobilePushToUser: (...args: unknown[]) => pushMock(...args),
}));

import {
  activityDigestInstance,
  activityDigestKey,
  earliestInstance,
  fetchActivityDigestSummary,
  isoYearWeek,
  runLifecycleEmailSweep,
  selectDueLifecycleEmails,
  stalledInstance,
  summarizeActivityDigest,
  withinHoursAgo,
  type LifecycleInstanceRow,
  type LifecycleSubscriptionRow,
} from "@/lib/recovery/lifecycle-email-sweep";
import type { InstanceActivityDigest } from "@/lib/command-center/activity";

const NOW = new Date("2026-06-10T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}

function sub(overrides: Partial<LifecycleSubscriptionRow> = {}): LifecycleSubscriptionRow {
  return { user_id: "user_1", plan: "free", created_at: hoursAgo(36), ...overrides };
}

function inst(overrides: Partial<LifecycleInstanceRow> = {}): LifecycleInstanceRow {
  return {
    id: "inst_1",
    user_id: "user_1",
    name: "Hermes",
    created_at: hoursAgo(36),
    last_activity_at: hoursAgo(1),
    ...overrides,
  };
}

// ---------- pure helpers ----------

describe("withinHoursAgo", () => {
  it("is inclusive at the min bound and exclusive at the max bound", () => {
    expect(withinHoursAgo(hoursAgo(24), NOW, 24, 48)).toBe(true);
    expect(withinHoursAgo(hoursAgo(47.9), NOW, 24, 48)).toBe(true);
    expect(withinHoursAgo(hoursAgo(48), NOW, 24, 48)).toBe(false);
    expect(withinHoursAgo(hoursAgo(23.9), NOW, 24, 48)).toBe(false);
  });

  it("rejects unparseable timestamps", () => {
    expect(withinHoursAgo("not-a-date", NOW, 0, 1_000_000)).toBe(false);
  });
});

describe("earliestInstance", () => {
  it("returns the oldest-created instance", () => {
    const a = inst({ id: "a", created_at: hoursAgo(30) });
    const b = inst({ id: "b", created_at: hoursAgo(240) });
    expect(earliestInstance([a, b])?.id).toBe("b");
    expect(earliestInstance([])).toBeNull();
  });
});

describe("stalledInstance", () => {
  it("returns the most recently active instance inside the 5–21 day window", () => {
    const fresh = inst({ id: "fresh", last_activity_at: hoursAgo(24) });
    const stalled6d = inst({ id: "stalled6d", last_activity_at: hoursAgo(6 * 24) });
    const stalled10d = inst({ id: "stalled10d", last_activity_at: hoursAgo(10 * 24) });
    const ancient = inst({ id: "ancient", last_activity_at: hoursAgo(40 * 24) });
    expect(stalledInstance([fresh, stalled10d, stalled6d, ancient], NOW)?.id).toBe("stalled6d");
  });

  it("ignores instances with no activity timestamp or outside the window", () => {
    expect(stalledInstance([inst({ last_activity_at: null })], NOW)).toBeNull();
    expect(stalledInstance([inst({ last_activity_at: hoursAgo(2) })], NOW)).toBeNull();
    expect(stalledInstance([inst({ last_activity_at: hoursAgo(30 * 24) })], NOW)).toBeNull();
  });
});

describe("fetchActivityDigestSummary (snapshot-sourced)", () => {
  function dbReturning(rows: unknown[], error: { message: string } | null = null) {
    return { from: jest.fn().mockReturnValue(makeQuery({ data: rows, error })) };
  }

  it("summarizes instance_usage_snapshots into the digest email shape", async () => {
    mockSupabaseAdmin.value = dbReturning([
      {
        stat_date: "2026-06-08",
        sessions: 3,
        api_calls: 10,
        tool_calls: 4,
        total_tokens: 1000,
        estimated_cost_usd: 0.5,
        by_model: { "opus-4.8": { tokens: 900 } },
      },
      {
        stat_date: "2026-06-09",
        sessions: 2,
        api_calls: 5,
        tool_calls: 1,
        total_tokens: 200,
        estimated_cost_usd: 0.1,
        by_model: { "opus-4.8": { tokens: 200 } },
      },
    ]);
    const summary = await fetchActivityDigestSummary({
      instanceId: "inst_x",
      userId: "user_x",
      instanceName: "Atlas",
    });
    expect(summary).toEqual({
      sessionCount: 5,
      totalMessages: null,
      topModel: "opus-4.8",
      estimatedCostUsd: expect.closeTo(0.6, 5),
      attentionLabels: [],
    });
  });

  it("returns null when the agent recorded no sessions in the window", async () => {
    mockSupabaseAdmin.value = dbReturning([
      {
        stat_date: "2026-06-08",
        sessions: 0,
        api_calls: 0,
        tool_calls: 0,
        total_tokens: 0,
        estimated_cost_usd: 0,
        by_model: null,
      },
    ]);
    expect(
      await fetchActivityDigestSummary({ instanceId: "inst_x", userId: "user_x", instanceName: null })
    ).toBeNull();
  });

  it("returns null on a snapshot query error", async () => {
    mockSupabaseAdmin.value = dbReturning([], { message: "boom" });
    expect(
      await fetchActivityDigestSummary({ instanceId: "inst_x", userId: "user_x", instanceName: null })
    ).toBeNull();
  });
});

describe("isoYearWeek / activityDigestKey", () => {
  it("formats the ISO year-week as YYYY'W'WW", () => {
    expect(isoYearWeek(new Date("2026-06-10T12:00:00.000Z"))).toBe("2026W24");
    expect(isoYearWeek(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026W01");
  });

  it("uses the ISO week-year at the year boundary (week 53 / week 1 rollover)", () => {
    // 2026-12-31 is a Thursday → still ISO week 53 of 2026.
    expect(isoYearWeek(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026W53");
    // 2027-01-04 is the first Monday → ISO week 1 of 2027.
    expect(isoYearWeek(new Date("2027-01-04T00:00:00.000Z"))).toBe("2027W01");
  });

  it("only changes once per ISO week (daily cron, weekly key)", () => {
    // Wed–Sun of the same ISO week all map to W24; the next Monday rolls over.
    expect(activityDigestKey(new Date("2026-06-10T00:00:00Z"))).toBe("activity_digest_2026W24");
    expect(activityDigestKey(new Date("2026-06-14T23:59:59Z"))).toBe("activity_digest_2026W24");
    expect(activityDigestKey(new Date("2026-06-15T00:00:00Z"))).toBe("activity_digest_2026W25");
  });
});

describe("activityDigestInstance", () => {
  it("returns the most recently active instance within 7 days (backend-agnostic)", () => {
    const stale = inst({ id: "stale", backend: "gateway", last_activity_at: hoursAgo(10 * 24) });
    const recent3d = inst({ id: "recent3d", backend: "gateway", last_activity_at: hoursAgo(3 * 24) });
    const recent1d = inst({ id: "recent1d", backend: "gateway", last_activity_at: hoursAgo(1 * 24) });
    expect(activityDigestInstance([stale, recent3d, recent1d], NOW)?.id).toBe("recent1d");
  });

  it("qualifies gateway instances (gateway is now the only backend)", () => {
    expect(
      activityDigestInstance([inst({ id: "gw", backend: "gateway", last_activity_at: hoursAgo(1) })], NOW)?.id
    ).toBe("gw");
    expect(
      activityDigestInstance([inst({ id: "nb", backend: null, last_activity_at: hoursAgo(1) })], NOW)?.id
    ).toBe("nb");
  });

  it("skips missing activity and stale instances", () => {
    expect(
      activityDigestInstance([inst({ backend: "gateway", last_activity_at: null })], NOW)
    ).toBeNull();
    expect(
      activityDigestInstance([inst({ backend: "gateway", last_activity_at: hoursAgo(8 * 24) })], NOW)
    ).toBeNull();
  });
});

describe("summarizeActivityDigest", () => {
  function digest(overrides: Partial<InstanceActivityDigest> = {}): InstanceActivityDigest {
    return {
      state: "idle",
      headline: "Waiting",
      lastActiveAt: null,
      activeStreams: 0,
      recentSessions: [],
      attentionItems: [],
      source: "webui",
      ...overrides,
    };
  }

  it("aggregates messages, picks the top model, sums cost and surfaces attention", () => {
    const summary = summarizeActivityDigest(
      digest({
        recentSessions: [
          { id: "s1", title: "A", updatedAt: null, messageCount: 10, model: "glm-5.1", estimatedCostUsd: 0.02 },
          { id: "s2", title: "B", updatedAt: null, messageCount: 5, model: "glm-5.1", estimatedCostUsd: 0.01 },
          { id: "s3", title: "C", updatedAt: null, messageCount: 2, model: "other", estimatedCostUsd: null },
        ],
        attentionItems: [
          { type: "runtime", label: "Agent not running", severity: "warning" },
        ],
      })
    );
    expect(summary).toEqual({
      sessionCount: 3,
      totalMessages: 17,
      topModel: "glm-5.1",
      estimatedCostUsd: 0.03,
      attentionLabels: ["Agent not running"],
    });
  });

  it("returns null when there are no recent sessions (skip empty digest)", () => {
    expect(summarizeActivityDigest(digest({ recentSessions: [] }))).toBeNull();
  });

  it("nulls out stats nobody reported", () => {
    const summary = summarizeActivityDigest(
      digest({
        recentSessions: [
          { id: "s1", title: "A", updatedAt: null, messageCount: null, model: null, estimatedCostUsd: null },
        ],
      })
    );
    expect(summary).toEqual({
      sessionCount: 1,
      totalMessages: null,
      topModel: null,
      estimatedCostUsd: null,
      attentionLabels: [],
    });
  });
});

describe("selectDueLifecycleEmails", () => {
  it("day1_idle: signup 24–48h ago with zero instances", () => {
    const due = selectDueLifecycleEmails({
      subscription: sub({ created_at: hoursAgo(36) }),
      instances: [],
      now: NOW,
    });
    expect(due).toEqual([{ key: "day1_idle", instance: null }]);
  });

  it("day1_idle is NOT due when an instance exists or outside the window", () => {
    expect(
      selectDueLifecycleEmails({
        subscription: sub({ created_at: hoursAgo(36) }),
        instances: [inst({ created_at: hoursAgo(2), last_activity_at: hoursAgo(1) })],
        now: NOW,
      }).map((d) => d.key)
    ).not.toContain("day1_idle");
    expect(
      selectDueLifecycleEmails({
        subscription: sub({ created_at: hoursAgo(50) }),
        instances: [],
        now: NOW,
      })
    ).toEqual([]);
  });

  it("day1_active: first instance created 24–48h ago, deep-linked", () => {
    const first = inst({ id: "first", created_at: hoursAgo(30) });
    const due = selectDueLifecycleEmails({
      subscription: null,
      instances: [first],
      now: NOW,
    });
    expect(due).toEqual([{ key: "day1_active", instance: first }]);
  });

  it("day1_active is NOT due when the windowed instance isn't the user's first", () => {
    const older = inst({ id: "older", created_at: hoursAgo(10 * 24), last_activity_at: hoursAgo(1) });
    const newer = inst({ id: "newer", created_at: hoursAgo(30), last_activity_at: hoursAgo(1) });
    const due = selectDueLifecycleEmails({
      subscription: null,
      instances: [older, newer],
      now: NOW,
    });
    expect(due.map((d) => d.key)).not.toContain("day1_active");
  });

  it("day3_usecase: signup 72–96h ago, linking the first instance when present", () => {
    const first = inst({ id: "first", created_at: hoursAgo(80), last_activity_at: hoursAgo(1) });
    const due = selectDueLifecycleEmails({
      subscription: sub({ created_at: hoursAgo(80) }),
      instances: [first],
      now: NOW,
    });
    expect(due).toEqual([{ key: "day3_usecase", instance: first }]);
  });

  it("day7_offer: signup 168–192h ago on the free plan only", () => {
    const free = selectDueLifecycleEmails({
      subscription: sub({ created_at: hoursAgo(170) }),
      instances: [],
      now: NOW,
    });
    expect(free.map((d) => d.key)).toContain("day7_offer");

    for (const plan of ["operator", "fleet", "command"]) {
      const paid = selectDueLifecycleEmails({
        subscription: sub({ created_at: hoursAgo(170), plan }),
        instances: [],
        now: NOW,
      });
      expect(paid.map((d) => d.key)).not.toContain("day7_offer");
    }
  });

  it("stalled_5d: live instance idle 5–21 days", () => {
    const stalled = inst({
      id: "stalled",
      created_at: hoursAgo(20 * 24),
      last_activity_at: hoursAgo(6 * 24),
    });
    const due = selectDueLifecycleEmails({
      subscription: null,
      instances: [stalled],
      now: NOW,
    });
    expect(due).toEqual([{ key: "stalled_5d", instance: stalled }]);
  });

  describe("trial_day5 cohort", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
      process.env = { ...ORIGINAL_ENV };
      // 100% rollout → every user buckets 'trial' deterministically.
      process.env.TRIAL_EXPERIMENT_PERCENT = "100";
    });

    afterAll(() => {
      process.env = ORIGINAL_ENV;
    });

    const trialSub = (overrides: Partial<LifecycleSubscriptionRow> = {}) =>
      sub({
        plan: "operator",
        created_at: hoursAgo(40 * 24),
        upgraded_at: hoursAgo(130),
        ...overrides,
      });

    it("due on a paid plan upgraded 120–144h ago when the experiment is on", () => {
      const first = inst({ id: "first", created_at: hoursAgo(40 * 24), last_activity_at: hoursAgo(1) });
      const due = selectDueLifecycleEmails({
        subscription: trialSub(),
        instances: [first],
        now: NOW,
        trialExperimentEnabled: true,
      });
      expect(due).toEqual([{ key: "trial_day5", instance: first }]);
    });

    it("inert when the experiment flag is off (the default)", () => {
      expect(
        selectDueLifecycleEmails({
          subscription: trialSub(),
          instances: [],
          now: NOW,
        })
      ).toEqual([]);
      expect(
        selectDueLifecycleEmails({
          subscription: trialSub(),
          instances: [],
          now: NOW,
          trialExperimentEnabled: false,
        })
      ).toEqual([]);
    });

    it("not due for control-bucket users", () => {
      process.env.TRIAL_EXPERIMENT_PERCENT = "0"; // everyone control
      expect(
        selectDueLifecycleEmails({
          subscription: trialSub(),
          instances: [],
          now: NOW,
          trialExperimentEnabled: true,
        })
      ).toEqual([]);
    });

    it("not due for free plans, missing upgraded_at, or outside the 120–144h window", () => {
      for (const subscription of [
        trialSub({ plan: "free" }),
        trialSub({ upgraded_at: null }),
        trialSub({ upgraded_at: hoursAgo(100) }),
        trialSub({ upgraded_at: hoursAgo(150) }),
      ]) {
        expect(
          selectDueLifecycleEmails({
            subscription,
            instances: [],
            now: NOW,
            trialExperimentEnabled: true,
          })
        ).toEqual([]);
      }
    });

    it("outranks stalled_5d for the same user", () => {
      const stalled = inst({
        id: "stalled",
        created_at: hoursAgo(40 * 24),
        last_activity_at: hoursAgo(6 * 24),
      });
      const due = selectDueLifecycleEmails({
        subscription: trialSub(),
        instances: [stalled],
        now: NOW,
        trialExperimentEnabled: true,
      });
      expect(due.map((d) => d.key)).toEqual(["trial_day5", "stalled_5d"]);
    });
  });

  it("returns overlapping cohorts in priority order", () => {
    // Signed up 3 days ago AND an instance stalled — day3 wins the run.
    const stalled = inst({
      id: "stalled",
      created_at: hoursAgo(90),
      last_activity_at: hoursAgo(6 * 24),
    });
    const due = selectDueLifecycleEmails({
      subscription: sub({ created_at: hoursAgo(80) }),
      instances: [stalled],
      now: NOW,
    });
    expect(due.map((d) => d.key)).toEqual(["day3_usecase", "stalled_5d"]);
  });
});

// ---------- the sweep ----------

type Result = { data: unknown[]; error: { message: string } | null };

function makeQuery(result: Result) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "gte", "lte", "eq", "neq", "is", "in", "limit"]) {
    q[m] = jest.fn().mockReturnValue(q);
  }
  q.then = (resolve: (v: Result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function buildDb(opts: {
  subs?: LifecycleSubscriptionRow[];
  /** Rows returned by the trial-day5 upgraded_at window query (call #2). */
  trialSubs?: LifecycleSubscriptionRow[];
  newInstances?: LifecycleInstanceRow[];
  stalled?: LifecycleInstanceRow[];
  /** Rows returned by the activity-digest window query (webui, active 7d). */
  digestWindow?: LifecycleInstanceRow[];
  byUser?: LifecycleInstanceRow[];
  sentRows?: Array<{ user_id: string; email_key: string }>;
  upsertError?: { message: string } | null;
}) {
  const instanceQueue: Result[] = [
    { data: opts.newInstances ?? [], error: null },
    { data: opts.stalled ?? [], error: null },
    { data: opts.digestWindow ?? [], error: null },
  ];
  // The signup-window query always runs first; the trial-day5 query only
  // fires when the trial experiment is enabled.
  const subscriptionQueue: Result[] = [
    { data: opts.subs ?? [], error: null },
    { data: opts.trialSubs ?? [], error: null },
  ];
  const upsertMock = jest.fn().mockResolvedValue({ error: opts.upsertError ?? null });
  const db = {
    from: jest.fn().mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") {
        return makeQuery(
          subscriptionQueue.shift() ?? { data: [], error: null }
        );
      }
      if (table === "lifecycle_email_sends") {
        const q = makeQuery({ data: opts.sentRows ?? [], error: null });
        q.upsert = upsertMock;
        return q;
      }
      // hermes_instances: new-instance window, then stalled window, then
      // the per-user fetches.
      const next = instanceQueue.shift() ?? { data: opts.byUser ?? [], error: null };
      return makeQuery(next);
    }),
  };
  return { db, upsertMock };
}

function clerkResponse(userId: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: userId,
      first_name: "Sam",
      primary_email_address_id: "addr_1",
      email_addresses: [
        {
          id: "addr_1",
          email_address: `${userId}@example.com`,
          verification: { status: "verified" },
        },
      ],
    }),
  };
}

describe("runLifecycleEmailSweep", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...originalEnv, CLERK_SECRET_KEY: "clerk-secret" };
    global.fetch = jest.fn().mockImplementation((url: string) => {
      const userId = String(url).split("/").pop() as string;
      return Promise.resolve(clerkResponse(userId));
    }) as unknown as typeof fetch;
    sendMock.mockResolvedValue({ sent: true, messageId: "msg_1" });
    flushMock.mockResolvedValue(undefined);
    pushMock.mockResolvedValue({
      attempted: 1,
      sent: 1,
      failed: 0,
      pruned: 0,
      skippedNoTokens: false,
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("sends each user's due email, records the ledger and captures analytics", async () => {
    const stalledInst = inst({
      id: "inst_e",
      user_id: "user_e",
      name: "Atlas",
      created_at: hoursAgo(15 * 24),
      last_activity_at: hoursAgo(6 * 24),
    });
    const { db, upsertMock } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })],
      stalled: [stalledInst],
      byUser: [stalledInst],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary).toMatchObject({
      candidates: 2,
      day1_idle: 1,
      stalled_5d: 1,
      skipped_already_sent: 0,
      skipped_no_email: 0,
      failed: 0,
      capHit: false,
    });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith("day1_idle", {
      email: "user_a@example.com",
      firstName: "Sam",
      agentName: null,
      instanceId: null,
      goal: null,
      firstTask: null,
      idempotencyKey: "lifecycle_day1_idle_user_a",
    });
    expect(sendMock).toHaveBeenCalledWith("stalled_5d", {
      email: "user_e@example.com",
      firstName: "Sam",
      agentName: "Atlas",
      instanceId: "inst_e",
      goal: null,
      firstTask: null,
      idempotencyKey: "lifecycle_stalled_5d_user_e",
    });

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      { user_id: "user_a", email_key: "day1_idle" },
      { onConflict: "user_id,email_key", ignoreDuplicates: true }
    );

    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "user_a",
      event: "lifecycle_email_sent",
      properties: {
        email_key: "day1_idle",
        $insert_id: "lifecycle_email_sent_day1_idle_user_a",
      },
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("mails the trial_day5 cohort from the upgraded_at window when the experiment is on", async () => {
    process.env.TRIAL_EXPERIMENT_ENABLED = "true";
    process.env.TRIAL_EXPERIMENT_PERCENT = "100";
    const agent = inst({
      id: "inst_t",
      user_id: "user_t",
      name: "Atlas",
      created_at: hoursAgo(30 * 24),
      last_activity_at: hoursAgo(1),
    });
    const { db, upsertMock } = buildDb({
      trialSubs: [
        sub({
          user_id: "user_t",
          plan: "operator",
          created_at: hoursAgo(40 * 24),
          upgraded_at: hoursAgo(130),
        }),
      ],
      byUser: [agent],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.trial_day5).toBe(1);
    expect(sendMock).toHaveBeenCalledWith("trial_day5", {
      email: "user_t@example.com",
      firstName: "Sam",
      agentName: "Atlas",
      instanceId: "inst_t",
      goal: null,
      firstTask: null,
      idempotencyKey: "lifecycle_trial_day5_user_t",
    });
    expect(upsertMock).toHaveBeenCalledWith(
      { user_id: "user_t", email_key: "trial_day5" },
      { onConflict: "user_id,email_key", ignoreDuplicates: true }
    );
  });

  it("never queries or mails the trial_day5 cohort while the experiment is off", async () => {
    const { db } = buildDb({
      subs: [],
      trialSubs: [
        sub({
          user_id: "user_t",
          plan: "operator",
          created_at: hoursAgo(40 * 24),
          upgraded_at: hoursAgo(130),
        }),
      ],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.trial_day5).toBe(0);
    expect(summary.candidates).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    // Only the signup-window subscription query ran.
    const subscriptionCalls = (db.from as jest.Mock).mock.calls.filter(
      ([table]) => table === "hermes_subscriptions"
    );
    expect(subscriptionCalls).toHaveLength(1);
  });

  it("skips users whose due email is already in the ledger", async () => {
    const { db, upsertMock } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })],
      sentRows: [{ user_id: "user_a", email_key: "day1_idle" }],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.skipped_already_sent).toBe(1);
    expect(summary.day1_idle).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("sends at most one email per user per run", async () => {
    // Signed up 3 days ago AND stalled → only the day3 email goes out.
    const stalledInst = inst({
      id: "inst_a",
      user_id: "user_a",
      created_at: hoursAgo(90),
      last_activity_at: hoursAgo(6 * 24),
    });
    const { db } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(80) })],
      stalled: [stalledInst],
      byUser: [stalledInst],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("day3_usecase");
    expect(summary.day3_usecase).toBe(1);
    expect(summary.stalled_5d).toBe(0);
  });

  it("threads the captured goal/first_task into the day3_usecase send (Wave 1.2)", async () => {
    // Signed up 3 days ago, with a launch-personalized first instance.
    const personalizedInst = inst({
      id: "inst_p",
      user_id: "user_p",
      name: "Scout",
      created_at: hoursAgo(80),
      last_activity_at: hoursAgo(1),
      goal: "research",
      first_task: "Compare three CRMs for a small team.",
    });
    const { db } = buildDb({
      subs: [sub({ user_id: "user_p", created_at: hoursAgo(80) })],
      byUser: [personalizedInst],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.day3_usecase).toBe(1);
    expect(sendMock).toHaveBeenCalledWith("day3_usecase", {
      email: "user_p@example.com",
      firstName: "Sam",
      agentName: "Scout",
      instanceId: "inst_p",
      goal: "research",
      firstTask: "Compare three CRMs for a small team.",
      idempotencyKey: "lifecycle_day3_usecase_user_p",
    });

    // The per-user instance fetch must request the new columns.
    const instanceSelects = (db.from as jest.Mock).mock.results
      .filter((_, i) => (db.from as jest.Mock).mock.calls[i][0] === "hermes_instances")
      .map((r) => (r.value.select as jest.Mock).mock.calls[0]?.[0]);
    expect(instanceSelects.some((sel) => typeof sel === "string" && sel.includes("goal") && sel.includes("first_task"))).toBe(true);
  });

  it("enforces the batch cap and reports capHit", async () => {
    const { db } = buildDb({
      subs: [
        sub({ user_id: "user_a", created_at: hoursAgo(36) }),
        sub({ user_id: "user_b", created_at: hoursAgo(36) }),
      ],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 1 });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(summary.capHit).toBe(true);
    expect(summary.day1_idle).toBe(1);
  });

  it("a failing send doesn't kill the run", async () => {
    sendMock
      .mockRejectedValueOnce(new Error("resend down"))
      .mockResolvedValueOnce({ sent: true, messageId: "msg_2" });
    const { db } = buildDb({
      subs: [
        sub({ user_id: "user_a", created_at: hoursAgo(36) }),
        sub({ user_id: "user_b", created_at: hoursAgo(36) }),
      ],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(summary.failed).toBe(1);
    expect(summary.day1_idle).toBe(1);
  });

  it("counts a rejected Resend send as failed without a ledger write", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "send_failed" });
    const { db, upsertMock } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.failed).toBe(1);
    expect(summary.day1_idle).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("counts a sent-but-unrecorded email as failed (Resend idempotency covers the retry)", async () => {
    const { db } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })],
      upsertError: { message: "insert blew up" },
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.failed).toBe(1);
    expect(summary.day1_idle).toBe(0);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("skips sends without a Clerk secret instead of throwing", async () => {
    delete process.env.CLERK_SECRET_KEY;
    const { db } = buildDb({
      subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

    expect(summary.skipped_no_email).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("throws when the database is not configured", async () => {
    mockSupabaseAdmin.value = null;
    await expect(runLifecycleEmailSweep({ now: NOW })).rejects.toThrow(
      "Database not configured"
    );
  });

  describe("mobile push fan-out (additive beside emails)", () => {
    it("pushes beside the stalled_5d email (chat deep link) but never for marketing cohorts", async () => {
      const stalledInst = inst({
        id: "inst_e",
        user_id: "user_e",
        name: "Atlas",
        created_at: hoursAgo(15 * 24),
        last_activity_at: hoursAgo(6 * 24),
      });
      const { db } = buildDb({
        subs: [sub({ user_id: "user_a", created_at: hoursAgo(36) })], // day1_idle
        stalled: [stalledInst],
        byUser: [stalledInst],
      });
      mockSupabaseAdmin.value = db;

      const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

      // Two emails went out (day1_idle + stalled_5d) but ONLY the stalled
      // attention moment pushes.
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_e",
          title: "Atlas is ready for more",
          url: "hivra://chat/inst_e",
        })
      );
      expect(summary.pushes_sent).toBe(1);
      expect(summary.pushes_failed).toBe(0);
    });

    it("keeps email accounting byte-identical when the push lane throws", async () => {
      pushMock.mockRejectedValue(new Error("expo exploded"));
      const stalledInst = inst({
        id: "inst_e",
        user_id: "user_e",
        name: "Atlas",
        created_at: hoursAgo(15 * 24),
        last_activity_at: hoursAgo(6 * 24),
      });
      const { db, upsertMock } = buildDb({
        stalled: [stalledInst],
        byUser: [stalledInst],
      });
      mockSupabaseAdmin.value = db;

      const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

      expect(summary.stalled_5d).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.pushes_failed).toBe(1);
      expect(upsertMock).toHaveBeenCalledWith(
        { user_id: "user_e", email_key: "stalled_5d" },
        { onConflict: "user_id,email_key", ignoreDuplicates: true }
      );
      expect(captureMock).toHaveBeenCalledTimes(1);
    });

    it("does not push when the email send failed (shared once-guard)", async () => {
      sendMock.mockResolvedValue({ sent: false, reason: "send_failed" });
      const stalledInst = inst({
        id: "inst_e",
        user_id: "user_e",
        name: "Atlas",
        created_at: hoursAgo(15 * 24),
        last_activity_at: hoursAgo(6 * 24),
      });
      const { db } = buildDb({ stalled: [stalledInst], byUser: [stalledInst] });
      mockSupabaseAdmin.value = db;

      const summary = await runLifecycleEmailSweep({ now: NOW, batchSize: 50 });

      expect(pushMock).not.toHaveBeenCalled();
      expect(summary.pushes_sent).toBe(0);
    });
  });

  describe("activity_digest cohort", () => {
    const digestSummary = {
      sessionCount: 3,
      totalMessages: 42,
      topModel: "glm-5.1",
      estimatedCostUsd: 0.12,
      attentionLabels: [],
    };

    const webuiInst = (overrides: Partial<LifecycleInstanceRow> = {}) =>
      inst({
        id: "inst_w",
        user_id: "user_w",
        name: "Atlas",
        backend: "webui",
        created_at: hoursAgo(20 * 24),
        last_activity_at: hoursAgo(2 * 24),
        ...overrides,
      });

    it("mails a week-stamped digest to a webui user active in the last 7 days", async () => {
      const agent = webuiInst();
      const { db, upsertMock } = buildDb({
        digestWindow: [agent],
        byUser: [agent],
      });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue(digestSummary);

      const summary = await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      expect(summary.activity_digest).toBe(1);
      expect(fetcher).toHaveBeenCalledWith({
        instanceId: "inst_w",
        userId: "user_w",
        instanceName: "Atlas",
      });
      expect(sendMock).toHaveBeenCalledWith("activity_digest", {
        email: "user_w@example.com",
        firstName: "Sam",
        agentName: "Atlas",
        instanceId: "inst_w",
        activityDigest: digestSummary,
        idempotencyKey: "lifecycle_activity_digest_2026W24_user_w",
      });
      // Ledger keyed by the week-stamped key, not the bare cohort name.
      expect(upsertMock).toHaveBeenCalledWith(
        { user_id: "user_w", email_key: "activity_digest_2026W24" },
        { onConflict: "user_id,email_key", ignoreDuplicates: true }
      );
      expect(captureMock).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: "user_w",
          event: "lifecycle_email_sent",
          properties: expect.objectContaining({
            email_key: "activity_digest_2026W24",
            email_cohort: "activity_digest",
          }),
        })
      );
    });

    it("pushes the weekly recap beside the digest email, leading with attention labels", async () => {
      const agent = webuiInst();
      const { db } = buildDb({ digestWindow: [agent], byUser: [agent] });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue({
        ...digestSummary,
        // Mirrors the email's attentionItems→attentionLabels thread.
        attentionLabels: ["Credits low", "Agent not running"],
      });

      const summary = await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      expect(summary.activity_digest).toBe(1);
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user_w",
          title: "What Atlas got done this week",
          body: "Needs your attention: Credits low, Agent not running",
          url: "hivra://chat/inst_w",
        })
      );
      expect(summary.pushes_sent).toBe(1);
    });

    it("falls back to the session-count recap body when nothing needs attention", async () => {
      const agent = webuiInst();
      const { db } = buildDb({ digestWindow: [agent], byUser: [agent] });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue(digestSummary);

      await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "3 work sessions — open the recap.",
        })
      );
    });

    it("skips (no send) when the box is unreachable / has no recent sessions", async () => {
      const agent = webuiInst();
      const { db, upsertMock } = buildDb({ digestWindow: [agent], byUser: [agent] });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue(null);

      const summary = await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(summary.activity_digest).toBe(0);
      expect(summary.activity_digest_skipped).toBe(1);
      expect(sendMock).not.toHaveBeenCalled();
      expect(upsertMock).not.toHaveBeenCalled();
    });

    it("dedupes by ISO week — no re-send once this week's key is in the ledger", async () => {
      const agent = webuiInst();
      const { db } = buildDb({
        digestWindow: [agent],
        byUser: [agent],
        sentRows: [{ user_id: "user_w", email_key: "activity_digest_2026W24" }],
      });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue(digestSummary);

      const summary = await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      // Ledger already holds this ISO week → fetch never runs, nothing sent.
      expect(fetcher).not.toHaveBeenCalled();
      expect(summary.activity_digest).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("does NOT send a digest to a user already getting a higher-priority email", async () => {
      // user_w is BOTH a day1_idle signup (24–48h, zero instances) and... no:
      // day1_idle needs zero instances, so use a stalled user who also has a
      // fresh webui instance. The stalled email wins; no digest.
      const stalledAgent = inst({
        id: "inst_s",
        user_id: "user_w",
        name: "Atlas",
        backend: "webui",
        created_at: hoursAgo(20 * 24),
        last_activity_at: hoursAgo(6 * 24),
      });
      const freshAgent = webuiInst({ id: "inst_f", last_activity_at: hoursAgo(1 * 24) });
      const { db } = buildDb({
        stalled: [stalledAgent],
        digestWindow: [freshAgent],
        byUser: [stalledAgent, freshAgent],
      });
      mockSupabaseAdmin.value = db;
      const fetcher = jest.fn().mockResolvedValue(digestSummary);

      const summary = await runLifecycleEmailSweep({
        now: NOW,
        batchSize: 50,
        activityDigestFetcher: fetcher,
      });

      expect(summary.stalled_5d).toBe(1);
      expect(summary.activity_digest).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(sendMock.mock.calls[0][0]).toBe("stalled_5d");
    });
  });
});
