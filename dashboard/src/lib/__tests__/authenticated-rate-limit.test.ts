import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

describe("enforceAuthenticatedRouteRateLimit", () => {
  const makeRequest = (ip: string) =>
    new Request("http://localhost/api/test", {
      headers: {
        "x-forwarded-for": ip,
      },
    });

  it("keys the throttle by route, user, and IP address", () => {
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
    const secondDifferentIp = enforceAuthenticatedRouteRateLimit(makeRequest("198.51.100.11"), {
      routeKey,
      userId: "user-a",
      limit: 1,
      windowMs: 60_000,
    });

    expect(first).toBeNull();
    expect(secondDifferentUser).toBeNull();
    expect(secondDifferentIp).toBeNull();
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
  });
});
