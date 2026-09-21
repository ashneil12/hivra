import { NextRequest } from "next/server";

describe("POST /api/webhooks/apple", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  function createRequest(body: unknown = { signedPayload: "jws-payload" }) {
    return new NextRequest("http://localhost/api/webhooks/apple", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function mockRateLimit() {
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
  }

  function mockService(overrides: Record<string, jest.Mock> = {}) {
    const verifyNotification =
      overrides.verifyNotification ??
      jest.fn().mockResolvedValue({
        payload: {
          notificationType: "SUBSCRIBED",
          subtype: "INITIAL_BUY",
          notificationUUID: "uuid-1",
        },
        environment: "Production",
        verifier: {},
      });
    const decodeNotificationData =
      overrides.decodeNotificationData ??
      jest.fn().mockResolvedValue({
        notificationType: "SUBSCRIBED",
        subtype: "INITIAL_BUY",
        notificationUUID: "uuid-1",
        environment: "Production",
        transaction: {},
        renewalInfo: null,
      });
    const handleNotification =
      overrides.handleNotification ??
      jest.fn().mockResolvedValue({ action: "activated", userId: "user_1" });

    jest.doMock("@/lib/services/apple-webhook-service", () => ({
      AppleWebhookService: {
        verifyNotification,
        decodeNotificationData,
        handleNotification,
      },
    }));

    return { verifyNotification, decodeNotificationData, handleNotification };
  }

  function mockEvents(overrides: Record<string, jest.Mock> = {}) {
    const begin =
      overrides.begin ?? jest.fn().mockResolvedValue("reserved");
    const markProcessed =
      overrides.markProcessed ?? jest.fn().mockResolvedValue(undefined);
    const markFailed =
      overrides.markFailed ?? jest.fn().mockResolvedValue(undefined);

    jest.doMock("@/lib/apple-webhook-events", () => ({
      beginAppleWebhookEvent: begin,
      markAppleWebhookEventProcessed: markProcessed,
      markAppleWebhookEventFailed: markFailed,
    }));

    return { begin, markProcessed, markFailed };
  }

  it("verifies, handles and marks a notification processed", async () => {
    mockRateLimit();
    const service = mockService();
    const events = mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(service.verifyNotification).toHaveBeenCalledWith("jws-payload");
    expect(events.begin).toHaveBeenCalledWith("uuid-1", "SUBSCRIBED", "INITIAL_BUY");
    expect(service.handleNotification).toHaveBeenCalled();
    expect(events.markProcessed).toHaveBeenCalledWith("uuid-1");
    expect(events.markFailed).not.toHaveBeenCalled();
  });

  it("rejects a missing signedPayload with 400", async () => {
    mockRateLimit();
    const service = mockService();
    mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest({}));

    expect(res.status).toBe(400);
    expect(service.verifyNotification).not.toHaveBeenCalled();
  });

  it("rejects an unverifiable payload with 401 without touching the ledger", async () => {
    mockRateLimit();
    mockService({
      verifyNotification: jest
        .fn()
        .mockRejectedValue(new Error("VERIFICATION_FAILURE")),
    });
    const events = mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(401);
    expect(events.begin).not.toHaveBeenCalled();
  });

  it("acks duplicates without re-running the state machine", async () => {
    mockRateLimit();
    const service = mockService();
    const events = mockEvents({
      begin: jest.fn().mockResolvedValue("duplicate"),
    });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.duplicate).toBe(true);
    expect(service.handleNotification).not.toHaveBeenCalled();
    expect(events.markProcessed).not.toHaveBeenCalled();
  });

  it("acks in-flight (processing) deliveries without re-running", async () => {
    mockRateLimit();
    const service = mockService();
    mockEvents({ begin: jest.fn().mockResolvedValue("processing") });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(service.handleNotification).not.toHaveBeenCalled();
  });

  it("refuses untracked events in production with 503 (idempotency required)", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
    });
    try {
      mockRateLimit();
      const service = mockService();
      mockEvents({ begin: jest.fn().mockResolvedValue("untracked") });

      const { POST } = await import("../route");
      const res = await POST(createRequest());

      expect(res.status).toBe(503);
      expect(service.handleNotification).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: originalNodeEnv,
        configurable: true,
      });
    }
  });

  it("processes untracked events outside production (local Apple testing)", async () => {
    mockRateLimit();
    const service = mockService();
    mockEvents({ begin: jest.fn().mockResolvedValue("untracked") });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(service.handleNotification).toHaveBeenCalled();
  });

  it("marks the event failed and returns 500 when the state machine throws (Apple redelivers)", async () => {
    mockRateLimit();
    mockService({
      handleNotification: jest
        .fn()
        .mockRejectedValue(new Error("No user mapping for apple transaction")),
    });
    const events = mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(500);
    expect(events.markFailed).toHaveBeenCalledWith("uuid-1", expect.any(Error));
    expect(events.markProcessed).not.toHaveBeenCalled();
  });

  it("rejects notifications without a notificationUUID", async () => {
    mockRateLimit();
    mockService({
      verifyNotification: jest.fn().mockResolvedValue({
        payload: { notificationType: "TEST" },
        environment: "Production",
        verifier: {},
      }),
    });
    const events = mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(400);
    expect(events.begin).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limited", async () => {
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: false })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));
    const service = mockService();
    mockEvents();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(429);
    expect(service.verifyNotification).not.toHaveBeenCalled();
  });
});
