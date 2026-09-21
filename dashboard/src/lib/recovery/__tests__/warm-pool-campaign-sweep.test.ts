/**
 * Warm-pool campaign sweep tests. The contract this locks in:
 *   - cohort = the engaged-free pool (fetchEngagedFreeUserIds) minus anyone
 *     in lifecycle_email_sends with email_key day7_offer or warm_pool_2026_06
 *   - dryRun NEVER touches Clerk, Resend, the ledger, or PostHog — it only
 *     counts and previews (first 20 ids + the rendered subject)
 *   - dryRun:false is still inert until WARM_POOL_CAMPAIGN_ENABLED=true
 *     (blockedBy reports the gate; nothing sends)
 *   - real sends use the stable Resend idempotencyKey
 *     warm_pool_2026_06_<user_id>, write the ledger row after Resend
 *     accepts, and capture posthog warm_pool_email_sent + flush
 *   - the optional limit and the 300 hard cap truncate deterministically
 *   - per-send failures don't kill the run; ledger-write failures count as
 *     failed and skip analytics
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const fetchEngagedMock = jest.fn();
jest.mock("@/lib/conversion-funnel", () => ({
  ENGAGED_POOL_ACTIVITY_DAYS: 7,
  fetchEngagedFreeUserIds: (...args: unknown[]) => fetchEngagedMock(...args),
}));

const sendMock = jest.fn();
jest.mock("@/lib/email/warm-pool-campaign", () => ({
  WARM_POOL_EMAIL_KEY: "warm_pool_2026_06",
  buildWarmPoolEmail: () => ({
    subject: "what your agent could be doing",
    text: "text",
    html: "html",
    ctaUrl: "https://hermesos.cloud/dashboard/billing?from=warm_pool",
  }),
  sendWarmPoolEmail: (...args: unknown[]) => sendMock(...args),
}));

const resolveRecipientMock = jest.fn();
jest.mock("@/lib/recovery/lifecycle-email-sweep", () => ({
  resolveClerkRecipient: (...args: unknown[]) => resolveRecipientMock(...args),
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

import {
  WARM_POOL_HARD_CAP,
  isWarmPoolCampaignEnabled,
  planWarmPoolSends,
  runWarmPoolCampaign,
} from "@/lib/recovery/warm-pool-campaign-sweep";

const NOW = new Date("2026-06-10T12:00:00.000Z");

function buildDb(opts: {
  sentRows?: Array<{ user_id: string }>;
  exclusionError?: { message: string } | null;
  upsertError?: { message: string } | null;
}) {
  const upsertMock = jest.fn().mockResolvedValue({ error: opts.upsertError ?? null });
  const db = {
    from: jest.fn().mockImplementation((table: string) => {
      if (table !== "lifecycle_email_sends") {
        throw new Error(`unexpected table ${table}`);
      }
      const q: Record<string, unknown> = {};
      for (const m of ["select", "in", "limit"]) {
        q[m] = jest.fn().mockReturnValue(q);
      }
      q.upsert = upsertMock;
      q.then = (
        resolve: (v: { data: unknown; error: unknown }) => unknown,
        reject?: (e: unknown) => unknown
      ) =>
        Promise.resolve({
          data: opts.exclusionError ? null : (opts.sentRows ?? []),
          error: opts.exclusionError ?? null,
        }).then(resolve, reject);
      return q;
    }),
  };
  return { db, upsertMock };
}

describe("planWarmPoolSends", () => {
  const pool = ["user_a", "user_b", "user_c", "user_d"];

  it("excludes already-emailed users and reports the split", () => {
    const plan = planWarmPoolSends({
      engagedUserIds: pool,
      alreadyEmailedUserIds: new Set(["user_b", "user_d"]),
    });
    expect(plan).toEqual({
      cohortSize: 4,
      excludedAlreadyEmailed: 2,
      eligible: 2,
      planned: ["user_a", "user_c"],
      capHit: false,
    });
  });

  it("applies the caller limit and reports capHit", () => {
    const plan = planWarmPoolSends({
      engagedUserIds: pool,
      alreadyEmailedUserIds: new Set(),
      limit: 2,
    });
    expect(plan.planned).toEqual(["user_a", "user_b"]);
    expect(plan.capHit).toBe(true);
  });

  it("enforces the 300 hard cap even with a huge limit", () => {
    const big = Array.from({ length: 500 }, (_, i) => `user_${String(i).padStart(3, "0")}`);
    const plan = planWarmPoolSends({
      engagedUserIds: big,
      alreadyEmailedUserIds: new Set(),
      limit: 10_000,
    });
    expect(WARM_POOL_HARD_CAP).toBe(300);
    expect(plan.planned).toHaveLength(300);
    expect(plan.capHit).toBe(true);
  });

  it("ignores non-positive / non-finite limits", () => {
    for (const limit of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planWarmPoolSends({
        engagedUserIds: pool,
        alreadyEmailedUserIds: new Set(),
        limit,
      });
      expect(plan.planned).toHaveLength(4);
    }
  });
});

describe("isWarmPoolCampaignEnabled", () => {
  const originalEnv = process.env;
  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults FALSE and only accepts explicit truthy values", () => {
    process.env = { ...originalEnv };
    delete process.env.WARM_POOL_CAMPAIGN_ENABLED;
    expect(isWarmPoolCampaignEnabled()).toBe(false);
    for (const v of ["false", "0", "no", "", "  "]) {
      process.env.WARM_POOL_CAMPAIGN_ENABLED = v;
      expect(isWarmPoolCampaignEnabled()).toBe(false);
    }
    for (const v of ["true", "TRUE", "1", "yes"]) {
      process.env.WARM_POOL_CAMPAIGN_ENABLED = v;
      expect(isWarmPoolCampaignEnabled()).toBe(true);
    }
  });
});

describe("runWarmPoolCampaign", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, CLERK_SECRET_KEY: "clerk-secret" };
    delete process.env.WARM_POOL_CAMPAIGN_ENABLED;
    fetchEngagedMock.mockResolvedValue(["user_a", "user_b", "user_c"]);
    resolveRecipientMock.mockImplementation((_secret: string, userId: string) =>
      Promise.resolve({ email: `${userId}@example.com`, firstName: "Sam" })
    );
    sendMock.mockResolvedValue({ sent: true, messageId: "msg_1" });
    flushMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when the database is not configured", async () => {
    mockSupabaseAdmin.value = null;
    await expect(runWarmPoolCampaign({ dryRun: true })).rejects.toThrow(
      "Database not configured"
    );
  });

  it("dry run: counts the cohort, applies exclusions, previews — and sends NOTHING", async () => {
    const { db, upsertMock } = buildDb({ sentRows: [{ user_id: "user_b" }] });
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: true, now: NOW });

    expect(fetchEngagedMock).toHaveBeenCalledWith(db, "2026-06-03T12:00:00.000Z");
    expect(summary).toMatchObject({
      dryRun: true,
      enabled: false,
      blockedBy: null,
      cohortSize: 3,
      excludedAlreadyEmailed: 1,
      eligible: 2,
      plannedSends: 2,
      capHit: false,
      sampleUserIds: ["user_a", "user_c"],
      subject: "what your agent could be doing",
      sent: 0,
      failed: 0,
      skippedNoEmail: 0,
    });

    // The dry run must never touch Clerk, Resend, the ledger, or PostHog.
    expect(resolveRecipientMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(flushMock).not.toHaveBeenCalled();
  });

  it("dry run previews at most 20 user ids", async () => {
    fetchEngagedMock.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => `user_${String(i).padStart(2, "0")}`)
    );
    const { db } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: true, now: NOW });

    expect(summary.plannedSends).toBe(50);
    expect(summary.sampleUserIds).toHaveLength(20);
    expect(summary.sampleUserIds[0]).toBe("user_00");
  });

  it("dryRun:false WITHOUT the env gate: blocked, nothing sends", async () => {
    const { db, upsertMock } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.blockedBy).toBe("WARM_POOL_CAMPAIGN_ENABLED");
    expect(summary.enabled).toBe(false);
    expect(summary.sent).toBe(0);
    expect(resolveRecipientMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("real send: resolves via Clerk, sends with the stable idempotency key, writes the ledger, captures analytics", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    const { db, upsertMock } = buildDb({ sentRows: [{ user_id: "user_b" }] });
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary).toMatchObject({
      dryRun: false,
      enabled: true,
      blockedBy: null,
      eligible: 2,
      sent: 2,
      failed: 0,
      skippedNoEmail: 0,
    });

    expect(resolveRecipientMock).toHaveBeenCalledWith("clerk-secret", "user_a");
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock).toHaveBeenCalledWith({
      email: "user_a@example.com",
      firstName: "Sam",
      idempotencyKey: "warm_pool_2026_06_user_a",
    });
    expect(sendMock).toHaveBeenCalledWith({
      email: "user_c@example.com",
      firstName: "Sam",
      idempotencyKey: "warm_pool_2026_06_user_c",
    });

    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(upsertMock).toHaveBeenCalledWith(
      { user_id: "user_a", email_key: "warm_pool_2026_06" },
      { onConflict: "user_id,email_key", ignoreDuplicates: true }
    );

    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: "user_a",
      event: "warm_pool_email_sent",
      properties: {
        email_key: "warm_pool_2026_06",
        $insert_id: "warm_pool_email_sent_user_a",
      },
    });
    expect(flushMock).toHaveBeenCalledTimes(1);
  });

  it("real send respects the limit", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    const { db } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, limit: 1, now: NOW });

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "warm_pool_2026_06_user_a" })
    );
    expect(summary.capHit).toBe(true);
    expect(summary.sent).toBe(1);
  });

  it("a failing send doesn't kill the run", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    sendMock
      .mockRejectedValueOnce(new Error("resend down"))
      .mockResolvedValue({ sent: true, messageId: "msg_2" });
    const { db } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(2);
  });

  it("counts a rejected Resend send as failed without a ledger write or capture", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    sendMock.mockResolvedValue({ sent: false, reason: "send_failed" });
    const { db, upsertMock } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.failed).toBe(3);
    expect(summary.sent).toBe(0);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("counts a sent-but-unrecorded email as failed (Resend idempotency covers the retry)", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    fetchEngagedMock.mockResolvedValue(["user_a"]);
    const { db } = buildDb({ upsertError: { message: "insert blew up" } });
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("skips users without a resolvable email instead of throwing", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    fetchEngagedMock.mockResolvedValue(["user_a", "user_b"]);
    resolveRecipientMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ email: "user_b@example.com", firstName: null });
    const { db } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.skippedNoEmail).toBe(1);
    expect(summary.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("skips everyone without a Clerk secret instead of throwing", async () => {
    process.env.WARM_POOL_CAMPAIGN_ENABLED = "true";
    delete process.env.CLERK_SECRET_KEY;
    const { db } = buildDb({});
    mockSupabaseAdmin.value = db;

    const summary = await runWarmPoolCampaign({ dryRun: false, now: NOW });

    expect(summary.skippedNoEmail).toBe(3);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("propagates exclusion-query failures", async () => {
    const { db } = buildDb({ exclusionError: { message: "ledger query down" } });
    mockSupabaseAdmin.value = db;

    await expect(runWarmPoolCampaign({ dryRun: true, now: NOW })).rejects.toThrow(
      "warm-pool exclusion query failed: ledger query down"
    );
  });
});
