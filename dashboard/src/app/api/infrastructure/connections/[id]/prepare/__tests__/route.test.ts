/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockPrepare = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/infrastructure/connection-preparation", () => ({
  prepareSimpleProxmoxConnection: (...args: unknown[]) => mockPrepare(...args),
}));

import { POST } from "../route";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001035";
const context = (id = CONNECTION_ID) => ({ params: Promise.resolve({ id }) });
const request = () => new NextRequest(
  `http://localhost/api/infrastructure/connections/${CONNECTION_ID}/prepare`,
  { method: "POST" },
);

describe("POST /api/infrastructure/connections/[id]/prepare", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_1" });
    mockRateLimit.mockReturnValue(null);
    mockPrepare.mockResolvedValue({
      ok: true,
      connectionId: CONNECTION_ID,
      provisionerVersion: "2026.08.26.3",
      preflight: {
        ok: false,
        connectionId: CONNECTION_ID,
        checkedAt: "2026-08-26T12:00:00.000Z",
        error: {
          code: "CAPACITY_UNAVAILABLE",
          message: "Target capacity could not be measured safely.",
        },
        unmetRequirements: [{
          code: "CAPACITY_UNAVAILABLE",
          message: "Target capacity could not be measured safely.",
        }],
      },
    });
  });

  it("requires authentication before rate limiting or preparation", async () => {
    mockAuth.mockResolvedValue({ userId: null });

    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("returns malformed IDs as absence before preparation", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockRateLimit).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("enforces a connection-scoped one-per-fifteen-minute limit", async () => {
    mockRateLimit.mockReturnValue(new Response("limited", { status: 429 }));

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockRateLimit).toHaveBeenCalledWith(expect.any(NextRequest), {
      routeKey: `infrastructure_connection_prepare:${CONNECTION_ID}`,
      userId: "user_1",
      limit: 1,
      windowMs: 900_000,
    });
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("returns versioned preparation plus truthful read-only preflight evidence", async () => {
    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      success: true,
      data: {
        preparation: {
          ok: true,
          connectionId: CONNECTION_ID,
          provisionerVersion: "2026.08.26.3",
          preflight: { ok: false, error: { code: "CAPACITY_UNAVAILABLE" } },
        },
      },
    });
    expect(mockPrepare).toHaveBeenCalledWith("user_1", CONNECTION_ID);
  });

  it.each([
    ["CONNECTION_NOT_FOUND", 404],
    ["SIMPLE_MODE_REQUIRED", 409],
    ["PREPARATION_SUPERSEDED", 409],
    ["INVALID_CONNECTION", 422],
    ["HOST_ADDRESS_BLOCKED", 422],
    ["SSH_AUTHENTICATION_FAILED", 502],
    ["PREPARATION_FAILED", 502],
    ["PREPARATION_INTERNAL_ERROR", 500],
  ] as const)("maps %s to a sanitized %i response", async (code, status) => {
    mockPrepare.mockResolvedValue({
      ok: false,
      connectionId: CONNECTION_ID,
      error: {
        code,
        message: "Sanitized preparation failure.",
        remediation: "Safe remediation.",
      },
    });

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      success: false,
      error: "Sanitized preparation failure.",
      code,
    });
    expect(JSON.stringify(body)).not.toContain("Safe remediation");
  });

  it("never exposes an unexpected exception message", async () => {
    mockPrepare.mockRejectedValue(new Error("remote output includes a private key"));

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: "Infrastructure host preparation failed.",
      code: "PREPARATION_INTERNAL_ERROR",
    });
    expect(JSON.stringify(body)).not.toContain("private key");
  });
});
