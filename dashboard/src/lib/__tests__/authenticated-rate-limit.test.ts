import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

describe("enforceAuthenticatedRouteRateLimit", () => {
  const makeRequest = (ip: string) =>
    new Request("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": ip,
      },
    });

  it("keys the throttle by route and user", () => {
    const routeKey = `settings_global_post_${Date.now()}`;

    const first = enforceAuthenticatedRouteRateLimit(makeRequest("198.51.100.10"), {
      routeKey,
      userId: "user-a",
      limit: 1,
      windowMs: 60_000,
    });
    const secondDifferentUser = enforceAuthenticatedRouteRateLimit(makeRequest("198.51.100.10"), {
      routeKey,
      userId: "user-b",
      limit: 1,
      windowMs: 60_000,
    });
    const secondDifferentRoute = enforceAuthenticatedRouteRateLimit(makeRequest("198.51.100.10"), {
      routeKey: `${routeKey}_other`,
      userId: "user-a",
      limit: 1,
      windowMs: 60_000,
    });

    expect(first).toBeNull();
    expect(secondDifferentUser).toBeNull();
    expect(secondDifferentRoute).toBeNull();
  });

  it("a signed-in user cannot open a fresh bucket by changing client address headers", () => {
    const routeKey = `settings_spoof_${Date.now()}`;
    const spoofedRequests = [
      new Request("http://localhost/api/test", { headers: { "cf-connecting-ip": "198.51.100.21" } }),
      new Request("http://localhost/api/test", { headers: { "cf-connecting-ip": "198.51.100.22" } }),
      new Request("http://localhost/api/test", { headers: { "x-real-ip": "198.51.100.23" } }),
      makeRequest("198.51.100.24"),
      makeRequest("198.51.100.25, 198.51.100.26"),
    ];

    const results = spoofedRequests.map((request) =>
      enforceAuthenticatedRouteRateLimit(request, { routeKey, userId: "user-spoofer", limit: 2, windowMs: 60_000 }),
    );

    expect(results.slice(0, 2)).toEqual([null, null]);
    for (const refused of results.slice(2)) {
      expect(refused?.status).toBe(429);
    }
  });

  it("returns a 429 response once the configured limit is exceeded", () => {
    const routeKey = `vault_post_${Date.now()}`;
    const request = makeRequest("203.0.113.20");

    expect(
      enforceAuthenticatedRouteRateLimit(request, {
        routeKey,
        userId: "user-rate-limited",
        limit: 2,
        windowMs: 60_000,
      })
    ).toBeNull();
    expect(
      enforceAuthenticatedRouteRateLimit(request, {
        routeKey,
        userId: "user-rate-limited",
        limit: 2,
        windowMs: 60_000,
      })
    ).toBeNull();

    const blocked = enforceAuthenticatedRouteRateLimit(request, {
      routeKey,
      userId: "user-rate-limited",
      limit: 2,
      windowMs: 60_000,
    });

    expect(blocked?.status).toBe(429);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(blocked?.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });
});
