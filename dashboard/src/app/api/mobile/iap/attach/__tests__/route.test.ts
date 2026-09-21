import { NextRequest } from "next/server";

describe("POST /api/mobile/iap/attach", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  const FUTURE_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;

  beforeEach(() => {
    jest.resetModules();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
  });

  function createRequest(body: unknown = { signedTransaction: "signed-jws" }) {
    return new NextRequest("http://localhost/api/mobile/iap/attach", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function transaction(overrides: Record<string, unknown> = {}) {
    return {
      originalTransactionId: "2000000123456789",
      productId: "cloud.hivra.pro.monthly",
      purchaseDate: Date.now() - 1000,
      expiresDate: FUTURE_MS,
      ...overrides,
    };
  }

  function mockAll(opts: {
    userId?: string | null;
    txn?: Record<string, unknown> | null;
    verifyThrows?: boolean;
    existingBinding?: { user_id: string } | null;
  } = {}) {
    const userId = opts.userId === undefined ? "user_1" : opts.userId;

    jest.doMock("@clerk/nextjs/server", () => ({
      auth: jest.fn().mockResolvedValue({ userId }),
    }));
    jest.doMock("@/lib/rate-limit", () => ({
      enforceRateLimit: jest.fn(() => ({ success: true })),
      getIP: jest.fn(() => "127.0.0.1"),
    }));

    const verifyTransaction = opts.verifyThrows
      ? jest.fn().mockRejectedValue(new Error("VERIFICATION_FAILURE"))
      : jest.fn().mockResolvedValue({
          transaction: opts.txn ?? transaction(),
          environment: "Production",
        });
    const activateFromTransaction = jest
      .fn()
      .mockResolvedValue({ action: "activated", userId });

    jest.doMock("@/lib/services/apple-webhook-service", () => ({
      AppleWebhookService: {
        verifyTransaction,
        activateFromTransaction,
      },
    }));

    const maybeSingle = jest
      .fn()
      .mockResolvedValue({ data: opts.existingBinding ?? null, error: null });
    jest.doMock("@/lib/supabase", () => ({
      supabaseAdmin: {
        from: jest.fn(() => ({
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle,
        })),
      },
    }));

    return { verifyTransaction, activateFromTransaction };
  }

  it("verifies, binds and activates through the canonical activation primitive", async () => {
    const mocks = mockAll();

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.attached).toBe(true);
    expect(mocks.verifyTransaction).toHaveBeenCalledWith("signed-jws");
    expect(mocks.activateFromTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        environment: "Production",
        notificationType: "ATTACH",
      })
    );
  });

  it("requires Clerk auth", async () => {
    const mocks = mockAll({ userId: null });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(401);
    expect(mocks.verifyTransaction).not.toHaveBeenCalled();
  });

  it("rejects a missing signedTransaction with 400", async () => {
    const mocks = mockAll();

    const { POST } = await import("../route");
    const res = await POST(createRequest({}));

    expect(res.status).toBe(400);
    expect(mocks.verifyTransaction).not.toHaveBeenCalled();
  });

  it("rejects a forged/unverifiable transaction with 401", async () => {
    const mocks = mockAll({ verifyThrows: true });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(401);
    expect(mocks.activateFromTransaction).not.toHaveBeenCalled();
  });

  it("rejects unknown products with 422 (no plan guessing)", async () => {
    const mocks = mockAll({ txn: transaction({ productId: "com.other.sub" }) });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(422);
    expect(mocks.activateFromTransaction).not.toHaveBeenCalled();
  });

  it("rejects an expired transaction with 400 (attach never grants lapsed access)", async () => {
    const mocks = mockAll({
      txn: transaction({ expiresDate: Date.now() - 1000 }),
    });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(400);
    expect(mocks.activateFromTransaction).not.toHaveBeenCalled();
  });

  it("refuses with 409 when the subscription is bound to a different account", async () => {
    const mocks = mockAll({ existingBinding: { user_id: "user_other" } });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(409);
    expect(mocks.activateFromTransaction).not.toHaveBeenCalled();
  });

  it("re-attaching the caller's own subscription is idempotent (activation dedupes)", async () => {
    const mocks = mockAll({ existingBinding: { user_id: "user_1" } });

    const { POST } = await import("../route");
    const res = await POST(createRequest());

    expect(res.status).toBe(200);
    expect(mocks.activateFromTransaction).toHaveBeenCalled();
  });
});
