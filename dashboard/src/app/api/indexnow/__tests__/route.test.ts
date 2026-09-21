import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { enforceRateLimit } from "@/lib/rate-limit";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/seo-urls", () => ({
  SITE_URL: "https://hivra.cloud",
  getSiteUrls: jest.fn(() => [
    { url: "https://hivra.cloud/" },
    { url: "https://hivra.cloud/token" },
  ]),
}));

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "203.0.113.7"),
}));

describe("POST /api/indexnow", () => {
  const originalIndexNowKey = process.env.INDEXNOW_KEY;
  const originalTriggerSecret = process.env.INDEXNOW_TRIGGER_SECRET;
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.INDEXNOW_KEY;
    delete process.env.INDEXNOW_TRIGGER_SECRET;
    global.fetch = jest.fn();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();

    if (originalIndexNowKey === undefined) {
      delete process.env.INDEXNOW_KEY;
    } else {
      process.env.INDEXNOW_KEY = originalIndexNowKey;
    }

    if (originalTriggerSecret === undefined) {
      delete process.env.INDEXNOW_TRIGGER_SECRET;
    } else {
      process.env.INDEXNOW_TRIGGER_SECRET = originalTriggerSecret;
    }
  });

  it("fails closed when INDEXNOW_KEY is not configured", async () => {
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toMatch(/indexnow key is not configured/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits the configured key to IndexNow", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
    });

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.indexnow.org/indexnow",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          host: "hivra.cloud",
          key: "indexnow-public-key",
          keyLocation: "https://hivra.cloud/indexnow-public-key.txt",
          urlList: [
            "https://hivra.cloud/",
            "https://hivra.cloud/token",
          ],
        }),
      })
    );
  });

  it("does not expose upstream IndexNow failure details to the client or logs", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 422,
      text: jest.fn().mockResolvedValue("client_secret=indexnow-secret-leak"),
    });

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("IndexNow submission failed");
    expect(body.statusCode).toBe(422);
    expect(JSON.stringify(body)).not.toContain("indexnow-secret-leak");
    expect(JSON.stringify(body)).not.toContain("details");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("indexnow-secret-leak");
  });

  it("does not log ordinary upstream IndexNow failure text", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      text: jest.fn().mockResolvedValue("quota controller rejected batch 7"),
    });

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("IndexNow submission failed");
    expect(body.statusCode).toBe(429);
    expect(JSON.stringify(body)).not.toContain("quota controller rejected batch 7");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("quota controller rejected batch 7");
  });

  it("does not expose unexpected IndexNow exceptions to the client or logs", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("indexnow-runtime-secret-leak"));

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("IndexNow submission failed");
    expect(body.error).not.toContain("indexnow-runtime-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("indexnow-runtime-secret-leak");
  });

  it("returns 429 when the per-IP rate limit is exceeded", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (enforceRateLimit as jest.Mock).mockReturnValueOnce({ success: false });

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));

    expect(response.status).toBe(429);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rate-limits before consulting IndexNow even with a valid trigger secret", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    process.env.INDEXNOW_TRIGGER_SECRET = "trigger-secret";
    mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);
    (enforceRateLimit as jest.Mock).mockReturnValueOnce({ success: false });

    const response = await POST(
      new Request("https://hivra.cloud/api/indexnow?secret=trigger-secret", { method: "POST" })
    );

    expect(response.status).toBe(429);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does not log ordinary runtime IndexNow exception text", async () => {
    process.env.INDEXNOW_KEY = "indexnow-public-key";
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("dns lookup to indexnow timed out"));

    const response = await POST(new Request("https://hivra.cloud/api/indexnow", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("IndexNow submission failed");
    expect(body.error).not.toContain("dns lookup to indexnow timed out");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("dns lookup to indexnow timed out");
  });
});
