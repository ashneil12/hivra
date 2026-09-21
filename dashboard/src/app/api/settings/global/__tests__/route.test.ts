import { POST } from "../route";
import { auth, clerkClient } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  clerkClient: jest.fn(),
}));

describe("POST /api/settings/global", () => {
  let mockUpdateUser: jest.Mock;
  let mockGetUser: jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    mockUpdateUser = jest.fn().mockResolvedValue({});
    mockGetUser = jest.fn().mockResolvedValue({
      publicMetadata: {
        hermesSettings: {
          sessionExpiryHours: 24,
        },
      },
    });

    (clerkClient as unknown as jest.Mock).mockResolvedValue({
      users: {
        updateUser: mockUpdateUser,
        getUser: mockGetUser,
      },
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  const generateRequest = (body: Record<string, unknown>) => {
    return new Request("http://localhost:3000/api/settings/global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  it("should return 401 if unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const req = generateRequest({});
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("should return 400 on invalid payload types", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    const req = generateRequest({ sessionExpiryHours: "not-a-number" });
    const res = await POST(req);
    const data = await res.json();
    
    expect(res.status).toBe(400);
    expect(data.error).toBe("Invalid payload");
  });

  it("should return 400 if userContextLimit is out of bounds", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    const req = generateRequest({ userContextLimit: 99999999 }); // Max is 10000
    const res = await POST(req);
    
    expect(res.status).toBe(400);
  });

  it("should successfully update and merge clerk public metadata", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    
    const req = generateRequest({ memoryContextLimit: 8000 });
    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    
    // Check that memoryContextLimit was updated and sessionExpiryHours was merged/preserved
    expect(data.settings).toEqual({
      sessionExpiryHours: 24,
      memoryContextLimit: 8000,
    });

    expect(mockUpdateUser).toHaveBeenCalledWith("user_123", {
      publicMetadata: expect.objectContaining({
        hermesSettings: {
          sessionExpiryHours: 24,
          memoryContextLimit: 8000,
        },
      }),
    });
  });

  it("returns 429 when the same user bursts too many settings writes", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_rate_limit_settings" });

    let lastResponse: Response | null = null;
    for (let index = 0; index < 11; index += 1) {
      lastResponse = await POST(
        new Request("http://localhost:3000/api/settings/global", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "198.51.100.40",
          },
          body: JSON.stringify({ sessionExpiryHours: 24 }),
        })
      );
    }

    expect(lastResponse).not.toBeNull();
    expect(lastResponse!.status).toBe(429);
  });

  it("does not leak unexpected persistence errors to the client or logs", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    mockUpdateUser.mockRejectedValueOnce(new Error("settings-secret-leak"));

    const res = await POST(generateRequest({ sessionExpiryHours: 24 }));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toBe("Failed to persist settings");
    expect(data.error).not.toContain("settings-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("settings-secret-leak");
  });
});
