import {
  beginAppleWebhookEvent,
  markAppleWebhookEventFailed,
  markAppleWebhookEventProcessed,
} from "../apple-webhook-events";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

const fromMock = supabaseAdmin!.from as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("beginAppleWebhookEvent", () => {
  it("reserves a fresh notificationUUID", async () => {
    const insert = jest.fn().mockResolvedValue({ error: null });
    fromMock.mockReturnValue({ insert });

    const result = await beginAppleWebhookEvent("uuid-1", "SUBSCRIBED", "INITIAL_BUY");

    expect(result).toBe("reserved");
    expect(fromMock).toHaveBeenCalledWith("apple_webhook_events");
    const row = insert.mock.calls[0][0];
    expect(row.notification_uuid).toBe("uuid-1");
    expect(row.notification_type).toBe("SUBSCRIBED");
    expect(row.subtype).toBe("INITIAL_BUY");
    expect(row.status).toBe("processing");
  });

  it("returns duplicate for an already-processed notification", async () => {
    const insert = jest
      .fn()
      .mockResolvedValue({ error: { code: "23505", message: "dup" } });
    const select = jest.fn().mockReturnThis();
    const eq = jest.fn().mockReturnThis();
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        notification_uuid: "uuid-1",
        status: "processed",
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    fromMock.mockReturnValue({ insert, select, eq, maybeSingle });

    const result = await beginAppleWebhookEvent("uuid-1", "DID_RENEW");
    expect(result).toBe("duplicate");
  });

  it("returns processing while another delivery is still in-flight", async () => {
    const insert = jest
      .fn()
      .mockResolvedValue({ error: { code: "23505", message: "dup" } });
    const select = jest.fn().mockReturnThis();
    const eq = jest.fn().mockReturnThis();
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        notification_uuid: "uuid-1",
        status: "processing",
        updated_at: new Date().toISOString(),
      },
      error: null,
    });
    fromMock.mockReturnValue({ insert, select, eq, maybeSingle });

    const result = await beginAppleWebhookEvent("uuid-1", "DID_RENEW");
    expect(result).toBe("processing");
  });

  it("reclaims a stale processing row (handler died mid-flight)", async () => {
    const staleUpdatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const insert = jest
      .fn()
      .mockResolvedValue({ error: { code: "23505", message: "dup" } });
    const select = jest.fn().mockReturnThis();
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        notification_uuid: "uuid-1",
        status: "processing",
        updated_at: staleUpdatedAt,
      },
      error: null,
    });
    const inFilter = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({ in: inFilter }),
    });
    fromMock.mockReturnValue({
      insert,
      select,
      eq: jest.fn().mockReturnThis(),
      maybeSingle,
      update,
    });

    const result = await beginAppleWebhookEvent("uuid-1", "EXPIRED");
    expect(result).toBe("reserved");
    expect(update).toHaveBeenCalled();
  });

  it("returns untracked when the table does not exist", async () => {
    const insert = jest
      .fn()
      .mockResolvedValue({ error: { code: "42P01", message: "missing" } });
    fromMock.mockReturnValue({ insert });

    const result = await beginAppleWebhookEvent("uuid-1", "TEST");
    expect(result).toBe("untracked");
  });
});

describe("markAppleWebhookEventProcessed", () => {
  it("flips the row to processed", async () => {
    const eq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    await markAppleWebhookEventProcessed("uuid-1");

    const payload = update.mock.calls[0][0];
    expect(payload.status).toBe("processed");
    expect(payload.last_error).toBeNull();
    expect(eq).toHaveBeenCalledWith("notification_uuid", "uuid-1");
  });
});

describe("markAppleWebhookEventFailed", () => {
  it("redacts secret-like values before persisting the failure message", async () => {
    const eq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq });
    fromMock.mockReturnValue({ update });

    await markAppleWebhookEventFailed(
      "uuid-1",
      new Error("refresh_token=super-secret client_secret=top-secret")
    );

    const payload = update.mock.calls[0][0];
    expect(payload.status).toBe("failed");
    expect(payload.last_error).toContain("refresh_token=[REDACTED]");
    expect(payload.last_error).toContain("client_secret=[REDACTED]");
    expect(payload.last_error).not.toContain("super-secret");
    expect(payload.last_error).not.toContain("top-secret");
  });
});
