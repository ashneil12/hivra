/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockDiscover = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/infrastructure/host-discovery", () => ({
  discoverInfrastructureHost: (...args: unknown[]) => mockDiscover(...args),
}));

import { POST } from "../route";

const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const context = (id = CONNECTION_ID) => ({ params: Promise.resolve({ id }) });
const request = () => new NextRequest(
  `http://localhost/api/infrastructure/connections/${CONNECTION_ID}/discover`,
  { method: "POST" },
);

function failure(code: string, message = "Host discovery failed.") {
  return {
    ok: false,
    connectionId: CONNECTION_ID,
    attemptedAt: "2026-08-26T12:00:00.000Z",
    error: { code, message },
  };
}

describe("POST /api/infrastructure/connections/[id]/discover", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_1" });
    mockRateLimit.mockReturnValue(null);
    mockDiscover.mockResolvedValue({
      ok: true,
      snapshot: {
        discoveryId: "11111111-1111-4111-8111-111111111111",
        connectionId: CONNECTION_ID,
        connectionRevision: 2,
        connectionProvider: "host",
        contractVersion: 1,
      },
    });
  });

  it("requires authentication before discovery or network work", async () => {
    mockAuth.mockResolvedValue({ userId: null });

    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("returns malformed IDs as owner-indistinguishable 404s", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("returns sanitized no-store discovery evidence", async () => {
    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      success: true,
      data: {
        discovery: {
          ok: true,
          snapshot: {
            connectionId: CONNECTION_ID,
            connectionRevision: 2,
            connectionProvider: "host",
          },
        },
      },
    });
    expect(mockDiscover).toHaveBeenCalledWith("user_1", CONNECTION_ID);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.anything(), {
      routeKey: "infrastructure_host_discovery",
      userId: "user_1",
      limit: 5,
      windowMs: 60_000,
    });
  });

  it.each([
    ["CONNECTION_NOT_FOUND", 404],
    ["DISCOVERY_SUPERSEDED", 409],
    ["INVALID_CONNECTION", 422],
    ["HOST_ADDRESS_BLOCKED", 422],
    ["SSH_AUTHENTICATION_FAILED", 502],
    ["DISCOVERY_OUTPUT_INVALID", 502],
    ["DISCOVERY_INTERNAL_ERROR", 500],
  ])("maps %s to HTTP %i while returning only the sanitized failure", async (code, status) => {
    mockDiscover.mockResolvedValue(failure(code, `Safe ${code}`));

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      success: false,
      error: `Safe ${code}`,
      discovery: { ok: false, error: { code } },
    });
  });

  it("honors the connection-scoped discovery rate limit", async () => {
    mockRateLimit.mockReturnValue(new Response("limited", { status: 429 }));

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("does not expose unexpected thrown messages", async () => {
    mockDiscover.mockRejectedValue(new Error("private-key and raw ssh stderr"));

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ success: false, error: "Host discovery failed." });
    expect(JSON.stringify(body)).not.toContain("private-key");
    expect(JSON.stringify(body)).not.toContain("raw ssh stderr");
  });
});
