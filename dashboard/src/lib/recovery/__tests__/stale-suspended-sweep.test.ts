/**
 * Tests for the stale-suspended sweeper. The contract this locks in:
 *   - Free-plan users (plan='free' or no active subscription) get the tight
 *     3-day-warn / 5-day-grace timeline by default.
 *   - Paid-canceled users (any other active plan) get the looser
 *     30-day-warn / 14-day-grace timeline.
 *   - Per-row threshold check: a paid-canceled row picked up by the looser
 *     SQL filter still gets skipped until it crosses its own warn threshold.
 *   - Sends the warning email FIRST, then writes the schedule. A failed
 *     email leaves the row eligible for retry on the next run.
 *   - The Resend idempotencyKey is stable per (instanceId, deletionDate)
 *     so transient retries inside the same day don't double-send.
 *   - Hits the per-run cap and reports capHit=true so the operator sees it.
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const sendMock = jest.fn();
jest.mock("@/lib/email/agent-deletion-warning", () => ({
  sendAgentDeletionWarningEmail: (...args: unknown[]) => sendMock(...args),
}));

const finalReminderSendMock = jest.fn();
jest.mock("@/lib/email/agent-deletion-final-reminder", () => ({
  sendAgentDeletionFinalReminderEmail: (...args: unknown[]) => finalReminderSendMock(...args),
}));

import {
  resolvePlanTier,
  runFinalReminderSweep,
  runStaleSuspendedSweep,
} from "../stale-suspended-sweep";

type Row = {
  id: string;
  user_id: string;
  name: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  last_lifecycle_transition_at: string;
  entitlement_state: string | null;
};

type Sub = { user_id: string; plan: string; status: string };

const FIXED_DEFAULTS = {
  freeWarnDays: 3,
  freeGraceDays: 5,
  paidCanceledWarnDays: 30,
  paidCanceledGraceDays: 14,
  maxPerRun: 50,
};

function buildSupabaseMock(rows: Row[], subs: Sub[], updateMock: jest.Mock) {
  // Sweep query (instances): from -> select -> .eq -> .eq -> .is -> .is -> .lt -> .neq -> .limit -> .order
  const limit = jest.fn().mockReturnValue({
    order: jest.fn().mockResolvedValue({ data: rows, error: null }),
  });
  const neq = jest.fn().mockReturnValue({ limit });
  const lt = jest.fn().mockReturnValue({ neq });
  const isDeletedAt = jest.fn().mockReturnValue({ lt });
  const isScheduled = jest.fn().mockReturnValue({ is: isDeletedAt });
  const eqInfra = jest.fn().mockReturnValue({ is: isScheduled });
  const eqLifecycle = jest.fn().mockReturnValue({ eq: eqInfra });
  const instanceSelect = jest.fn().mockReturnValue({ eq: eqLifecycle });

  // Subscription lookup: from -> select -> .in -> .eq
  const subEqStatus = jest.fn().mockResolvedValue({ data: subs, error: null });
  const subInUser = jest.fn().mockReturnValue({ eq: subEqStatus });
  const subSelect = jest.fn().mockReturnValue({ in: subInUser });

  // Update query: from -> update -> .eq -> .eq -> .is
  const updateIs = jest.fn().mockResolvedValue({ error: null });
  const updateEq2 = jest.fn().mockReturnValue({ is: updateIs });
  const updateEq1 = jest.fn().mockReturnValue({ eq: updateEq2 });
  updateMock.mockReturnValue({ eq: updateEq1 });

  return {
    from: jest.fn().mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") {
        return { select: subSelect };
      }
      return { select: instanceSelect, update: updateMock };
    }),
  };
}

function buildClerkUser(id: string, email: string | null = "user@example.com") {
  return {
    id,
    first_name: "Sam",
    primary_email_address_id: "addr_1",
    email_addresses: email
      ? [{ id: "addr_1", email_address: email, verification: { status: "verified" } }]
      : [],
  };
}

describe("resolvePlanTier", () => {
  it("returns 'free' when there's no subscription", () => {
    expect(resolvePlanTier(undefined)).toBe("free");
  });

  it("returns 'free' for plan='free'", () => {
    expect(resolvePlanTier({ user_id: "u", plan: "free", status: "active" })).toBe("free");
  });

  it("returns 'free' for plan='Free' (case-insensitive)", () => {
    expect(resolvePlanTier({ user_id: "u", plan: "Free", status: "active" })).toBe("free");
  });

  it("returns 'paid_canceled' for any other active plan", () => {
    expect(resolvePlanTier({ user_id: "u", plan: "operator", status: "active" })).toBe(
      "paid_canceled",
    );
    expect(resolvePlanTier({ user_id: "u", plan: "fleet", status: "active" })).toBe(
      "paid_canceled",
    );
    expect(resolvePlanTier({ user_id: "u", plan: "command", status: "active" })).toBe(
      "paid_canceled",
    );
  });
});

describe("runStaleSuspendedSweep", () => {
  const realFetch = global.fetch;
  // 4 days ago: past freeWarnDays(3), well short of paidCanceledWarnDays(30).
  const fourDaysAgoIso = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  // 31 days ago: past both thresholds.
  const thirtyOneDaysAgoIso = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_dummy";
    sendMock.mockReset();
    sendMock.mockResolvedValue({ sent: true, resendId: "re_1" });
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.CLERK_SECRET_KEY;
    jest.restoreAllMocks();
    mockSupabaseAdmin.value = null;
  });

  it("free plan: warns at 3 days and schedules deletion in 5 days", async () => {
    const updateMock = jest.fn();
    mockSupabaseAdmin.value = buildSupabaseMock(
      [
        {
          id: "inst-free-stale",
          user_id: "user_free",
          name: "Atlas",
          proxmox_node: "fixturenode3",
          proxmox_vmid: 305,
          last_lifecycle_transition_at: fourDaysAgoIso,
          entitlement_state: "grace",
        },
      ],
      [], // No active subscription = free
      updateMock,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_free"),
    }) as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep(FIXED_DEFAULTS);

    expect(summary.warnedAndScheduled).toBe(1);
    expect(summary.byTier).toEqual({ free: 1, paid_canceled: 0 });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daysRemaining: 5, // free grace
      }),
    );
  });

  it("paid-canceled below paid threshold: skipped (not yet eligible)", async () => {
    // Row is 4 days old. Free filter (the looser one) catches it for SQL,
    // but resolved plan is 'operator' (paid_canceled tier) which needs 30 days.
    const updateMock = jest.fn();
    mockSupabaseAdmin.value = buildSupabaseMock(
      [
        {
          id: "inst-paid-tooyoung",
          user_id: "user_paid",
          name: "Bravo",
          proxmox_node: "fixturenode3",
          proxmox_vmid: 306,
          last_lifecycle_transition_at: fourDaysAgoIso,
          entitlement_state: "suspended",
        },
      ],
      [{ user_id: "user_paid", plan: "operator", status: "active" }],
      updateMock,
    );
    global.fetch = jest.fn() as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep(FIXED_DEFAULTS);

    expect(summary.candidates).toBe(1);
    expect(summary.warnedAndScheduled).toBe(0);
    expect(summary.skippedNotYetEligible).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled(); // no Clerk lookup wasted
  });

  it("paid-canceled above paid threshold: warns at 30 days with 14-day grace", async () => {
    const updateMock = jest.fn();
    mockSupabaseAdmin.value = buildSupabaseMock(
      [
        {
          id: "inst-paid-stale",
          user_id: "user_paid_old",
          name: "Charlie",
          proxmox_node: "fixturenode3",
          proxmox_vmid: 307,
          last_lifecycle_transition_at: thirtyOneDaysAgoIso,
          entitlement_state: "suspended",
        },
      ],
      [{ user_id: "user_paid_old", plan: "fleet", status: "active" }],
      updateMock,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_paid_old"),
    }) as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep(FIXED_DEFAULTS);

    expect(summary.warnedAndScheduled).toBe(1);
    expect(summary.byTier).toEqual({ free: 0, paid_canceled: 1 });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daysRemaining: 14, // paid grace
      }),
    );
  });

  it("does NOT write the schedule when the email send fails", async () => {
    sendMock.mockResolvedValue({
      sent: false,
      reason: "send_failed",
      errorMessage: "rate_limit",
    });
    const updateMock = jest.fn();
    mockSupabaseAdmin.value = buildSupabaseMock(
      [
        {
          id: "inst-email-fail",
          user_id: "user_x",
          name: "Delta",
          proxmox_node: "fixturenode3",
          proxmox_vmid: 308,
          last_lifecycle_transition_at: fourDaysAgoIso,
          entitlement_state: "grace",
        },
      ],
      [],
      updateMock,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_x"),
    }) as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep(FIXED_DEFAULTS);

    expect(summary.emailFailed).toBe(1);
    expect(summary.warnedAndScheduled).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("skips rows whose Clerk user has no email and reports skippedNoEmail", async () => {
    const updateMock = jest.fn();
    mockSupabaseAdmin.value = buildSupabaseMock(
      [
        {
          id: "inst-no-email",
          user_id: "user_y",
          name: "Echo",
          proxmox_node: "fixturenode3",
          proxmox_vmid: 309,
          last_lifecycle_transition_at: fourDaysAgoIso,
          entitlement_state: "grace",
        },
      ],
      [],
      updateMock,
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_y", null),
    }) as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep(FIXED_DEFAULTS);

    expect(summary.skippedNoEmail).toBe(1);
    expect(summary.warnedAndScheduled).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reports capHit=true when more candidates exist than maxPerRun", async () => {
    const updateMock = jest.fn();
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `inst-${i + 1}`,
      user_id: `user_${i + 1}`,
      name: `Agent ${i + 1}`,
      proxmox_node: "fixturenode3",
      proxmox_vmid: 300 + i,
      last_lifecycle_transition_at: fourDaysAgoIso,
      entitlement_state: "grace",
    }));
    mockSupabaseAdmin.value = buildSupabaseMock(rows, [], updateMock);
    global.fetch = jest
      .fn()
      .mockImplementation((url: string) => {
        const userId = url.split("/").pop() || "";
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => buildClerkUser(userId),
        });
      }) as unknown as typeof fetch;

    const summary = await runStaleSuspendedSweep({ ...FIXED_DEFAULTS, maxPerRun: 2 });

    expect(summary.candidates).toBe(2);
    expect(summary.warnedAndScheduled).toBe(2);
    expect(summary.capHit).toBe(true);
  });

  it("throws when CLERK_SECRET_KEY is missing", async () => {
    delete process.env.CLERK_SECRET_KEY;
    mockSupabaseAdmin.value = buildSupabaseMock([], [], jest.fn());
    await expect(runStaleSuspendedSweep(FIXED_DEFAULTS)).rejects.toThrow(/CLERK_SECRET_KEY/);
  });
});

describe("runFinalReminderSweep", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_dummy";
    finalReminderSendMock.mockReset();
    finalReminderSendMock.mockResolvedValue({ sent: true, resendId: "re_final_1" });
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.CLERK_SECRET_KEY;
    jest.restoreAllMocks();
    mockSupabaseAdmin.value = null;
  });

  function buildFinalReminderSupabase(
    rows: Array<{ id: string; user_id: string; scheduled_deletion_at: string }>,
  ) {
    // from -> select -> .eq -> .gt -> .lte -> .is
    const isFn = jest.fn().mockResolvedValue({ data: rows, error: null });
    const lte = jest.fn().mockReturnValue({ is: isFn });
    const gt = jest.fn().mockReturnValue({ lte });
    const eqStatus = jest.fn().mockReturnValue({ gt });
    const select = jest.fn().mockReturnValue({ eq: eqStatus });
    return { from: jest.fn().mockReturnValue({ select }) };
  }

  it("sends final reminder for rows whose deletion is within 24 hours", async () => {
    const tomorrow = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    mockSupabaseAdmin.value = buildFinalReminderSupabase([
      { id: "row-1", user_id: "user_1", scheduled_deletion_at: tomorrow },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_1"),
    }) as unknown as typeof fetch;

    const summary = await runFinalReminderSweep();

    expect(summary.candidates).toBe(1);
    expect(summary.reminded).toBe(1);
    expect(finalReminderSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "user@example.com",
        idempotencyKey: expect.stringMatching(/^agent-deletion-final\/row-1\/\d{4}-\d{2}-\d{2}$/),
      }),
    );
  });

  it("skips when send fails — no row update needed since this is just a notification", async () => {
    finalReminderSendMock.mockResolvedValue({
      sent: false,
      reason: "send_failed",
      errorMessage: "transient",
    });
    const tomorrow = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    mockSupabaseAdmin.value = buildFinalReminderSupabase([
      { id: "row-2", user_id: "user_2", scheduled_deletion_at: tomorrow },
    ]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => buildClerkUser("user_2"),
    }) as unknown as typeof fetch;

    const summary = await runFinalReminderSweep();

    expect(summary.emailFailed).toBe(1);
    expect(summary.reminded).toBe(0);
  });
});
