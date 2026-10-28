import { beginStripeWebhookEvent, markStripeWebhookEventFailed } from "../stripe-webhook-events";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

describe("markStripeWebhookEventFailed", () => {
  let updateBuilder: {
    update: jest.Mock;
    eq: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    updateBuilder = {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(updateBuilder);
  });

  it("redacts secret-like values before persisting the failure message", async () => {
    await markStripeWebhookEventFailed(
      "evt_123",
      new Error("refresh_token=super-secret client_secret=top-secret")
    );

    const updatePayload = updateBuilder.update.mock.calls[0][0];

    expect(updatePayload.status).toBe("failed");
    expect(updatePayload.last_error).toContain("refresh_token=[REDACTED]");
    expect(updatePayload.last_error).toContain("client_secret=[REDACTED]");
    expect(updatePayload.last_error).not.toContain("super-secret");
    expect(updatePayload.last_error).not.toContain("top-secret");
  });
});

describe("beginStripeWebhookEvent", () => {
  const eventId = "evt_reclaim";
  const staleUpdatedAt = "2026-01-01T00:00:00.000Z";
  const uniqueViolation = { code: "23505", message: "duplicate key value" };

  function insertBuilder(error: unknown) {
    return { insert: jest.fn().mockResolvedValue({ error }) };
  }
  function readBuilder(row: unknown) {
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }),
    };
  }
  function updateBuilder(result: { data: unknown; error: unknown }) {
    return {
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(result),
    };
  }
  function mockFromQueue(...builders: unknown[]) {
    const queue = [...builders];
    (supabaseAdmin!.from as jest.Mock).mockImplementation(() => queue.shift());
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reserves a fresh event", async () => {
    const insert = insertBuilder(null);
    mockFromQueue(insert);

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("reserved");
    expect(insert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: eventId, status: "processing" })
    );
  });

  it("returns duplicate when the existing event is already processed", async () => {
    mockFromQueue(
      insertBuilder(uniqueViolation),
      readBuilder({ event_id: eventId, status: "processed", updated_at: staleUpdatedAt })
    );

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("duplicate");
  });

  it("returns processing while a fresh processing row is still owned", async () => {
    mockFromQueue(
      insertBuilder(uniqueViolation),
      readBuilder({ event_id: eventId, status: "processing", updated_at: new Date().toISOString() })
    );

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("processing");
  });

  it("reclaims a stale processing row with a compare-and-set on the read updated_at", async () => {
    const update = updateBuilder({ data: [{ event_id: eventId }], error: null });
    mockFromQueue(
      insertBuilder(uniqueViolation),
      readBuilder({ event_id: eventId, status: "processing", updated_at: staleUpdatedAt }),
      update
    );

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("reserved");
    expect(update.eq).toHaveBeenCalledWith("event_id", eventId);
    expect(update.eq).toHaveBeenCalledWith("updated_at", staleUpdatedAt);
    expect(update.in).toHaveBeenCalledWith("status", ["failed", "processing"]);
    expect(update.select).toHaveBeenCalledWith("event_id");
  });

  it("reports duplicate when the reclaim CAS loses to a worker that already processed the event", async () => {
    mockFromQueue(
      insertBuilder(uniqueViolation),
      readBuilder({ event_id: eventId, status: "failed", updated_at: staleUpdatedAt }),
      updateBuilder({ data: [], error: null }),
      readBuilder({ event_id: eventId, status: "processed", updated_at: new Date().toISOString() })
    );

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("duplicate");
  });

  it("reports processing when the reclaim CAS loses to a concurrent reclaim", async () => {
    mockFromQueue(
      insertBuilder(uniqueViolation),
      readBuilder({ event_id: eventId, status: "processing", updated_at: staleUpdatedAt }),
      updateBuilder({ data: [], error: null }),
      readBuilder({ event_id: eventId, status: "processing", updated_at: new Date().toISOString() })
    );

    await expect(beginStripeWebhookEvent(eventId, "checkout.session.completed")).resolves.toBe("processing");
  });
});
