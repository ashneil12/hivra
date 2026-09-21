import { enforceRateLimit, getIP } from "@/lib/rate-limit";

// Reset the module between tests to clear the in-memory store
beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("enforceRateLimit", () => {
  it("allows the first request", () => {
    const result = enforceRateLimit("test-ip-1", { limit: 5, windowMs: 60_000 });
    expect(result.success).toBe(true);
  });

  it("allows up to the limit", () => {
    const id = `test-ip-${Math.random()}`;
    const config = { limit: 3, windowMs: 60_000 };
    expect(enforceRateLimit(id, config).success).toBe(true);
    expect(enforceRateLimit(id, config).success).toBe(true);
    expect(enforceRateLimit(id, config).success).toBe(true);
    // 4th request — over limit
    expect(enforceRateLimit(id, config).success).toBe(false);
  });

  it("rejects requests over the limit", () => {
    const id = `test-ip-${Math.random()}`;
    const config = { limit: 1, windowMs: 60_000 };
    enforceRateLimit(id, config); // allowed
    const result = enforceRateLimit(id, config); // blocked
    expect(result.success).toBe(false);
  });

  it("resets the counter after the window expires", () => {
    jest.useFakeTimers();
    const id = `test-ip-${Math.random()}`;
    const config = { limit: 1, windowMs: 1_000 };

    expect(enforceRateLimit(id, config).success).toBe(true);
    expect(enforceRateLimit(id, config).success).toBe(false);

    // Advance past the window
    jest.advanceTimersByTime(1_001);

    expect(enforceRateLimit(id, config).success).toBe(true);
    jest.useRealTimers();
  });

  it("handles multiple independent identifiers correctly", () => {
    const idA = `ip-a-${Math.random()}`;
    const idB = `ip-b-${Math.random()}`;
    const config = { limit: 2, windowMs: 60_000 };

    // Exhaust idA
    enforceRateLimit(idA, config);
    enforceRateLimit(idA, config);
    expect(enforceRateLimit(idA, config).success).toBe(false);

    // idB should still be unaffected
    expect(enforceRateLimit(idB, config).success).toBe(true);
  });
});

describe("getIP", () => {
  const makeReq = (headers: Record<string, string>) =>
    ({ headers: { get: (k: string) => headers[k] ?? null } } as unknown as Request);

  it("prefers cf-connecting-ip", () => {
    const req = makeReq({ "cf-connecting-ip": "203.0.113.4", "x-forwarded-for": "198.51.100.8" });
    expect(getIP(req)).toBe("203.0.113.4");
  });

  it("falls back to x-forwarded-for and strips extra IPs", () => {
    const req = makeReq({ "x-forwarded-for": "198.51.100.8, 192.0.2.12" });
    expect(getIP(req)).toBe("198.51.100.8");
  });

  it("strips IPv4 ports from direct proxy headers", () => {
    const req = makeReq({ "x-real-ip": "203.0.113.7:443" });
    expect(getIP(req)).toBe("203.0.113.7");
  });

  it("sanitizes direct proxy headers before returning them", () => {
    const req = makeReq({
      "cf-connecting-ip": '198.51.100.7,or(status.eq.active)',
      "x-forwarded-for": "198.51.100.8",
    });
    expect(getIP(req)).toBe("198.51.100.7");
  });

  it("returns localhost when no IP header is present", () => {
    const req = makeReq({});
    expect(getIP(req)).toBe("127.0.0.1");
  });

  it("falls back to localhost for invalid proxy headers", () => {
    const req = makeReq({ "cf-connecting-ip": "not-an-ip" });
    expect(getIP(req)).toBe("127.0.0.1");
  });
});
