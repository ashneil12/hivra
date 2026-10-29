/**
 * Feedback-email sweep tests. The contract this locks in:
 *   - feedback_checkin: active paid plan, paid for 14+ days (upgraded_at, else created_at)
 *   - cancel_feedback: cancelled 2–30 days ago (updated_at)
 *   - at most one send per (user, key) ever via lifecycle_email_sends, with a
 *     stable Resend idempotency key
 *   - the batch cap stops the run and reports capHit
 *   - per-send failures don't kill the run
 */

const mockSupabaseAdmin = { value: null as unknown };
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return mockSupabaseAdmin.value;
  },
}));

const sendMock = jest.fn();
jest.mock("@/lib/email/feedback", () => ({
  sendFeedbackEmail: (...args: unknown[]) => sendMock(...args),
}));

const recipientMock = jest.fn();
jest.mock("@/lib/recovery/lifecycle-email-sweep", () => ({
  resolveClerkRecipient: (...args: unknown[]) => recipientMock(...args),
}));

const captureMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: jest.fn(),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  runFeedbackEmailSweep,
  selectFeedbackEmail,
  type FeedbackSubscriptionRow,
} from "@/lib/recovery/feedback-email-sweep";

const NOW = new Date("2026-10-29T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function sub(overrides: Partial<FeedbackSubscriptionRow> = {}): FeedbackSubscriptionRow {
  return {
    user_id: "user_1",
    plan: "operator",
    status: "active",
    created_at: daysAgo(40),
    updated_at: daysAgo(1),
    upgraded_at: null,
    ...overrides,
  };
}

describe("selectFeedbackEmail", () => {
  it("asks a customer who has paid for at least 14 days", () => {
    expect(selectFeedbackEmail(sub({ upgraded_at: daysAgo(14) }), NOW)).toBe("feedback_checkin");
    expect(selectFeedbackEmail(sub({ upgraded_at: daysAgo(13) }), NOW)).toBeNull();
  });

  it("falls back to created_at when there is no upgrade stamp", () => {
    expect(selectFeedbackEmail(sub({ created_at: daysAgo(20) }), NOW)).toBe("feedback_checkin");
    expect(selectFeedbackEmail(sub({ created_at: daysAgo(3) }), NOW)).toBeNull();
  });

  it("never asks free accounts", () => {
    expect(selectFeedbackEmail(sub({ plan: "free" }), NOW)).toBeNull();
  });

  it("asks why only inside the 2 to 30 day cancellation window", () => {
    const cancelled = (d: number) => sub({ status: "canceled", updated_at: daysAgo(d) });
    expect(selectFeedbackEmail(cancelled(1), NOW)).toBeNull();
    expect(selectFeedbackEmail(cancelled(2), NOW)).toBe("cancel_feedback");
    expect(selectFeedbackEmail(cancelled(29), NOW)).toBe("cancel_feedback");
    expect(selectFeedbackEmail(cancelled(30), NOW)).toBeNull();
  });

  it("ignores past-due and other states", () => {
    expect(selectFeedbackEmail(sub({ status: "past_due" }), NOW)).toBeNull();
  });
});

// ---------- the sweep (mocked client) ----------

type Recorded = { table: string; calls: Array<[string, unknown[]]> };

function buildDb(opts: {
  paid?: FeedbackSubscriptionRow[];
  cancelled?: FeedbackSubscriptionRow[];
  sent?: Array<{ user_id: string; email_key: string }>;
  upsertError?: { message: string } | null;
}) {
  const upserts: unknown[] = [];
  const queries: Recorded[] = [];
  const from = jest.fn((table: string) => {
    const query: Recorded = { table, calls: [] };
    queries.push(query);
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gte", "lte", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        query.calls.push([m, args]);
        return builder;
      };
    }
    builder.upsert = (row: unknown) => {
      upserts.push(row);
      return Promise.resolve({ error: opts.upsertError ?? null });
    };
    builder.then = (resolve: (v: unknown) => unknown) => {
      let data: unknown[] = [];
      if (table === "hermes_subscriptions") {
        const status = query.calls.find(([m, a]) => m === "eq" && a[0] === "status")?.[1][1];
        data = status === "canceled" ? opts.cancelled ?? [] : opts.paid ?? [];
      } else if (table === "lifecycle_email_sends") {
        data = opts.sent ?? [];
      }
      return Promise.resolve(resolve({ data, error: null }));
    };
    return builder;
  });
  return { db: { from }, upserts, queries };
}

describe("runFeedbackEmailSweep", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CLERK_SECRET_KEY: "sk_test" };
    recipientMock.mockImplementation(async (_secret: string, userId: string) => ({
      email: `${userId}@example.com`,
      firstName: "Sam",
    }));
    sendMock.mockResolvedValue({ sent: true, messageId: "m1" });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("sends each due email once and records it in the ledger", async () => {
    const { db, upserts } = buildDb({
      paid: [sub({ user_id: "paid_1", upgraded_at: daysAgo(20) }), sub({ user_id: "paid_new", upgraded_at: daysAgo(3) })],
      cancelled: [sub({ user_id: "gone_1", status: "canceled", updated_at: daysAgo(5) })],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runFeedbackEmailSweep({ now: NOW });

    expect(summary).toMatchObject({ candidates: 2, feedback_checkin: 1, cancel_feedback: 1, failed: 0 });
    expect(sendMock).toHaveBeenCalledWith("feedback_checkin", {
      email: "paid_1@example.com",
      firstName: "Sam",
      idempotencyKey: "feedback_feedback_checkin_paid_1",
    });
    expect(sendMock).toHaveBeenCalledWith("cancel_feedback", expect.objectContaining({
      idempotencyKey: "feedback_cancel_feedback_gone_1",
    }));
    expect(upserts).toEqual([
      { user_id: "paid_1", email_key: "feedback_checkin" },
      { user_id: "gone_1", email_key: "cancel_feedback" },
    ]);
    expect(captureMock).toHaveBeenCalledTimes(2);
  });

  it("skips users the ledger says were already asked", async () => {
    const { db } = buildDb({
      paid: [sub({ user_id: "paid_1", upgraded_at: daysAgo(20) })],
      sent: [{ user_id: "paid_1", email_key: "feedback_checkin" }],
    });
    mockSupabaseAdmin.value = db;

    const summary = await runFeedbackEmailSweep({ now: NOW });

    expect(summary.skipped_already_sent).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("stops at the batch cap", async () => {
    const { db } = buildDb({
      paid: ["a", "b", "c"].map((id) => sub({ user_id: id, upgraded_at: daysAgo(20) })),
    });
    mockSupabaseAdmin.value = db;

    const summary = await runFeedbackEmailSweep({ now: NOW, batchSize: 2 });

    expect(summary.capHit).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("keeps going after one failed send and does not ledger it", async () => {
    const { db, upserts } = buildDb({
      paid: [sub({ user_id: "a", upgraded_at: daysAgo(20) }), sub({ user_id: "b", upgraded_at: daysAgo(20) })],
    });
    mockSupabaseAdmin.value = db;
    sendMock.mockResolvedValueOnce({ sent: false, reason: "send_failed" });

    const summary = await runFeedbackEmailSweep({ now: NOW });

    expect(summary).toMatchObject({ failed: 1, feedback_checkin: 1 });
    expect(upserts).toEqual([{ user_id: "b", email_key: "feedback_checkin" }]);
  });

  it("skips everyone when Clerk is not configured", async () => {
    delete process.env.CLERK_SECRET_KEY;
    const { db } = buildDb({ paid: [sub({ upgraded_at: daysAgo(20) })] });
    mockSupabaseAdmin.value = db;

    const summary = await runFeedbackEmailSweep({ now: NOW });

    expect(summary.skipped_no_email).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
