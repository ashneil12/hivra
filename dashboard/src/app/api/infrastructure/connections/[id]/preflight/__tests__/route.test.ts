/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockPreflight = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));
jest.mock("@/lib/infrastructure/connection-preflight", () => ({
  preflightInfrastructureConnection: (...args: unknown[]) => mockPreflight(...args),
}));

import { POST } from "../route";

const CONNECTION_ID = "00000000-0000-4000-8000-000000001035";
const context = (id = CONNECTION_ID) => ({ params: Promise.resolve({ id }) });
const request = () => new NextRequest(
  `http://localhost/api/infrastructure/connections/${CONNECTION_ID}/preflight`,
  { method: "POST" },
);

describe("POST /api/infrastructure/connections/[id]/preflight", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "user_1" });
    mockRateLimit.mockReturnValue(null);
    mockPreflight.mockResolvedValue({
      ok: false,
      connectionId: CONNECTION_ID,
      checkedAt: "2026-08-25T17:00:00.000Z",
      error: {
        code: "PROVISIONER_UNAVAILABLE",
        message: "The portable provisioner is not ready on this target.",
      },
      unmetRequirements: [{
        code: "PROVISIONER_UNAVAILABLE",
        message: "No prepared-target template or assets were configured",
      }],
    });
  });

  it("requires authentication before performing network work", async () => {
    mockAuth.mockResolvedValue({ userId: null });

    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("returns 404 for malformed IDs without querying the store", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("returns cross-owner absence as 404", async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      error: { code: "CONNECTION_NOT_FOUND" },
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(404);
  });

  it("returns completed unmet requirements as no-store workflow evidence", async () => {
    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      success: true,
      data: { preflight: { ok: false, error: { code: "PROVISIONER_UNAVAILABLE" } } },
    });
    expect(mockPreflight).toHaveBeenCalledWith("user_1", CONNECTION_ID);
  });

  it("honors the bounded preflight rate limit", async () => {
    mockRateLimit.mockReturnValue(new Response("limited", { status: 429 }));

    const response = await POST(request(), context());

    expect(response.status).toBe(429);
    expect(mockPreflight).not.toHaveBeenCalled();
  });

  it("maps sanitized internal failures to HTTP 500", async () => {
    mockPreflight.mockResolvedValue({
      ok: false,
      error: { code: "PREFLIGHT_INTERNAL_ERROR" },
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Infrastructure preflight failed.",
    });
  });
});
