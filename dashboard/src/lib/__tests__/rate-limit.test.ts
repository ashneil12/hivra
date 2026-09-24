import { enforceRateLimit, getIP, reserveRateLimit } from "../rate-limit";
import { NextRequest } from "next/server";

describe("Rate Limiting Utility", () => {
  let dateNowSpy: jest.SpyInstance;

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, "now").mockReturnValue(1000000000);
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  test("should allow requests under the limit", () => {
    for (let i = 0; i < 5; i++) {
      const res = enforceRateLimit("test_ip", { limit: 5, windowMs: 60000 });
      expect(res.success).toBe(true);
    }
  });

  test("should block requests exceeding the limit", () => {
    // 6th request should fail
    const res = enforceRateLimit("test_ip", { limit: 5, windowMs: 60000 });
    expect(res.success).toBe(false);
  });

  test("says how long a refused request must wait", () => {
    const config = { limit: 1, windowMs: 60_000 };
    expect(enforceRateLimit("retry_after_key", config).success).toBe(true);
    dateNowSpy.mockReturnValue(1000000000 + 15_000);
    expect(enforceRateLimit("retry_after_key", config)).toEqual({ success: false, retryAfterMs: 45_000 });
  });

  test("should allow requests after the window expires", () => {
    // Advance time beyond window
    dateNowSpy.mockReturnValue(1000000000 + 60001);
    const res = enforceRateLimit("test_ip", { limit: 5, windowMs: 60000 });
    expect(res.success).toBe(true);
  });

  test("getIP should extract ip from cf-connecting-ip", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("cf-connecting-ip", "203.0.113.4");
    expect(getIP(req)).toBe("203.0.113.4");
  });

  test("getIP should fall back to x-real-ip when cf-connecting-ip is missing", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("x-real-ip", "203.0.113.1");
    expect(getIP(req)).toBe("203.0.113.1");
  });

  test("getIP should fall back to x-forwarded-for if cf-connecting-ip is missing", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("x-forwarded-for", "10.240.0.1, 10.240.0.2");
    expect(getIP(req)).toBe("10.240.0.1");
  });

  test("getIP should strip a forwarded IPv4 port before returning it", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("x-real-ip", "203.0.113.7:443");
    expect(getIP(req)).toBe("203.0.113.7");
  });

  test("getIP should ignore invalid direct proxy headers instead of returning unsafe filter text", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("cf-connecting-ip", '198.51.100.7,or(status.eq.active)');
    req.headers.set("x-forwarded-for", "203.0.113.9");
    expect(getIP(req)).toBe("198.51.100.7");
  });

  test("getIP should prefer cf-connecting-ip over x-real-ip and x-forwarded-for", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("cf-connecting-ip", "198.51.100.5");
    req.headers.set("x-real-ip", "203.0.113.1");
    req.headers.set("x-forwarded-for", "10.240.0.1, 10.240.0.2");
    expect(getIP(req)).toBe("198.51.100.5");
  });

  test("getIP should default to 127.0.0.1 if no headers present", () => {
    const req = new NextRequest("http://localhost");
    expect(getIP(req)).toBe("127.0.0.1");
  });

  test("getIP should fall back when proxy headers do not contain a valid IP literal", () => {
    const req = new NextRequest("http://localhost");
    req.headers.set("cf-connecting-ip", "definitely-not-an-ip");
    expect(getIP(req)).toBe("127.0.0.1");
  });
});

describe("reserveRateLimit", () => {
  let now = 2_000_000_000;
  let dateNowSpy: jest.SpyInstance;
  const config = { limit: 1, windowMs: 15 * 60_000 };

  beforeEach(() => {
    dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
  });
  afterEach(() => dateNowSpy.mockRestore());

  test("gives a failed run's slot back so it can be retried at once", () => {
    const first = reserveRateLimit("reserve_failed", config);
    if (!first.success) throw new Error("expected a reservation");
    first.settle("failed");
    now += 1_000;
    expect(reserveRateLimit("reserve_failed", config).success).toBe(true);
  });

  test("keeps a successful run's slot for the rest of the window", () => {
    const first = reserveRateLimit("reserve_succeeded", config);
    if (!first.success) throw new Error("expected a reservation");
    first.settle("succeeded");
    now += 60_000;
    expect(reserveRateLimit("reserve_succeeded", config)).toEqual({
      success: false,
      retryAfterMs: 14 * 60_000,
      inFlight: false,
      reason: "recent_success",
    });
    now += 14 * 60_000 + 1;
    expect(reserveRateLimit("reserve_succeeded", config).success).toBe(true);
  });

  // Review of slice 5: the window started at the first reservation, so a run
  // that failed at 0:00 followed by a success at 14:30 let a third run in at
  // 15:01, 31 seconds after the success.
  test("restarts the window when a run succeeds", () => {
    const failed = reserveRateLimit("reserve_restart", config);
    if (!failed.success) throw new Error("expected a reservation");
    failed.settle("failed");
    now += 14 * 60_000 + 30_000;
    const succeeded = reserveRateLimit("reserve_restart", config);
    if (!succeeded.success) throw new Error("expected a reservation");
    succeeded.settle("succeeded");
    now += 31_000;
    expect(reserveRateLimit("reserve_restart", config)).toEqual({
      success: false,
      retryAfterMs: 15 * 60_000 - 31_000,
      inFlight: false,
      reason: "recent_success",
    });
  });

  test("caps failed runs per window when asked to", () => {
    const capped = { ...config, failureLimit: 3 };
    const started = now;
    for (let run = 0; run < 3; run += 1) {
      const attempt = reserveRateLimit("reserve_failure_cap", capped);
      if (!attempt.success) throw new Error("expected a reservation");
      attempt.settle("failed");
      now += 60_000;
    }
    expect(reserveRateLimit("reserve_failure_cap", capped)).toEqual({
      success: false,
      retryAfterMs: started + 15 * 60_000 - now,
      inFlight: false,
      reason: "repeated_failures",
    });
    now = started + 15 * 60_000 + 1;
    expect(reserveRateLimit("reserve_failure_cap", capped).success).toBe(true);
  });

  test("clears the failure count when a run succeeds", () => {
    const capped = { limit: 1, windowMs: 60_000, failureLimit: 2 };
    for (let run = 0; run < 2; run += 1) {
      const attempt = reserveRateLimit("reserve_failure_clear", capped);
      if (!attempt.success) throw new Error("expected a reservation");
      attempt.settle(run === 0 ? "failed" : "succeeded");
    }
    now += 60_001;
    const failed = reserveRateLimit("reserve_failure_clear", capped);
    if (!failed.success) throw new Error("expected a reservation");
    failed.settle("failed");
    // One failure since the success, under the cap of two.
    expect(reserveRateLimit("reserve_failure_clear", capped).success).toBe(true);
  });

  test("leaves failures uncapped without a failure limit", () => {
    for (let run = 0; run < 20; run += 1) {
      const attempt = reserveRateLimit("reserve_uncapped", config);
      if (!attempt.success) throw new Error("expected a reservation");
      attempt.settle("failed");
    }
  });

  test("refuses a concurrent run, even across a window rollover", () => {
    const first = reserveRateLimit("reserve_concurrent", config);
    if (!first.success) throw new Error("expected a reservation");
    expect(reserveRateLimit("reserve_concurrent", config)).toMatchObject({ success: false, inFlight: true });
    now += 16 * 60_000;
    expect(reserveRateLimit("reserve_concurrent", config)).toMatchObject({ success: false, inFlight: true });
    first.settle("failed");
    expect(reserveRateLimit("reserve_concurrent", config).success).toBe(true);
  });

  test("keeps a run that is still going through the hourly cleanup", () => {
    dateNowSpy.mockRestore();
    jest.useFakeTimers({ now: 3_000_000_000 });
    try {
      jest.isolateModules(() => {
        // A fresh module so its cleanup interval runs on the fake clock.
        const { reserveRateLimit: reserve } = jest.requireActual("../rate-limit") as typeof import("../rate-limit");
        const running = reserve("reserve_cleanup", config);
        if (!running.success) throw new Error("expected a reservation");
        jest.advanceTimersByTime(2 * 60 * 60_000);
        expect(reserve("reserve_cleanup", config)).toMatchObject({ success: false, inFlight: true });
        running.settle("failed");
        expect(reserve("reserve_cleanup", config).success).toBe(true);
      });
    } finally {
      jest.useRealTimers();
      dateNowSpy = jest.spyOn(Date, "now").mockImplementation(() => now);
    }
  });

  test("settles once", () => {
    const first = reserveRateLimit("reserve_once", { limit: 2, windowMs: 60_000 });
    const second = reserveRateLimit("reserve_once", { limit: 2, windowMs: 60_000 });
    if (!first.success || !second.success) throw new Error("expected reservations");
    first.settle("failed");
    first.settle("failed");
    // Only the first failure gave a slot back, so the second run still counts.
    expect(reserveRateLimit("reserve_once", { limit: 2, windowMs: 60_000 }).success).toBe(true);
    expect(reserveRateLimit("reserve_once", { limit: 2, windowMs: 60_000 }).success).toBe(false);
  });
});
