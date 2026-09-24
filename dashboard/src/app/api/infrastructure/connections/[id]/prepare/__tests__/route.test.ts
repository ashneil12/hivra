/** @jest-environment node */

import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockPrepare = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  ...jest.requireActual("@/lib/authenticated-rate-limit"),
  reserveAuthenticatedRouteRateLimit: (...args: unknown[]) => mockReserve(...args),
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
    mockReserve.mockReturnValue({ limited: null, settle: mockSettle });
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
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("returns malformed IDs as absence before preparation", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  // Retired: the limit used to count every attempt and answer a bare "Too
  // Many Requests". It now counts only a run still going or one that
  // succeeded, and says when to try again.
  it("refuses a second run within fifteen minutes of a success with a Retry-After", async () => {
    mockReserve.mockReturnValue({ limited: { retryAfterMs: 11 * 60_000 + 5_000, inFlight: false }, settle: null });

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("665");
    expect(body).toMatchObject({
      success: false,
      error: "This server was set up in the last 15 minutes. You can try again in 12 minutes.",
      code: "PREPARATION_RATE_LIMITED",
      retryAfterSeconds: 665,
    });
    expect(mockReserve).toHaveBeenCalledWith(expect.any(NextRequest), {
      routeKey: `infrastructure_connection_prepare:${CONNECTION_ID}`,
      userId: "user_1",
      limit: 1,
      windowMs: 900_000,
    });
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("refuses a concurrent run as in progress rather than rate limited", async () => {
    mockReserve.mockReturnValue({ limited: { retryAfterMs: 14 * 60_000, inFlight: true }, settle: null });

    const response = await POST(request(), context());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(body).toMatchObject({ success: false, code: "PREPARATION_IN_PROGRESS" });
    expect(body.error).toMatch(/already running on this server/);
    expect(mockPrepare).not.toHaveBeenCalled();
  });

  it("gives a failed run's slot back and keeps a successful one", async () => {
    await POST(request(), context());
    expect(mockSettle).toHaveBeenLastCalledWith("succeeded");

    mockPrepare.mockResolvedValueOnce({
      ok: false,
      connectionId: CONNECTION_ID,
      error: { code: "PREPARATION_FAILED", message: "Setup couldn't find active Proxmox storage for virtual machines.", cause: "storage_unavailable" },
    });
    const failed = await POST(request(), context());
    expect(mockSettle).toHaveBeenLastCalledWith("failed");
    expect(await failed.json()).toEqual({
      success: false,
      error: "Setup couldn't find active Proxmox storage for virtual machines.",
      code: "PREPARATION_FAILED",
      cause: "storage_unavailable",
    });

    mockPrepare.mockRejectedValueOnce(new Error("unexpected"));
    await POST(request(), context());
    expect(mockSettle).toHaveBeenLastCalledWith("failed");
    expect(mockSettle).toHaveBeenCalledTimes(3);
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
