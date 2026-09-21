import { enforceRateLimit, getIP } from "../rate-limit";
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
