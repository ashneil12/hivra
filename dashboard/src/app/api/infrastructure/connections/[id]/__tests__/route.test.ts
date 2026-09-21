import { NextRequest } from "next/server";

const mockGetConnection = jest.fn();
const mockUpdateConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockRateLimit = jest.fn<Response | null, [Request, Record<string, unknown>]>(() => null);

jest.mock("@/lib/infrastructure/connection-store", () => ({
  InfrastructureConnectionStoreError: class InfrastructureConnectionStoreError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  getInfrastructureConnection: (...args: unknown[]) => mockGetConnection(...args),
  updateInfrastructureConnection: (...args: unknown[]) => mockUpdateConnection(...args),
  deleteInfrastructureConnection: (...args: unknown[]) => mockDeleteConnection(...args),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (
    request: Request,
    options: Record<string, unknown>,
  ) => mockRateLimit(request, options),
  RATE_LIMIT_PRESETS: {
    secretWrite: { limit: 20, windowMs: 60_000 },
  },
}));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn().mockResolvedValue(null),
}));

import { auth } from "@clerk/nextjs/server";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { DELETE, GET, PATCH } from "../route";

const connectionId = "11111111-1111-4111-8111-111111111111";
const privateKey = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(96),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const connection = {
  id: connectionId,
  name: "Home Proxmox",
  provider: "proxmox",
  operatingMode: "self-managed",
  setupMode: "simple",
  status: "pending",
  endpoint: {
    sshHost: "pve.example.com",
    sshPort: 22,
    sshUser: "root",
    sshHostFingerprintSha256: "a".repeat(64),
  },
  configuration: null,
  credentialsConfigured: true,
  lastCheckedAt: null,
  lastErrorCode: null,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

function context(id = connectionId) {
  return { params: Promise.resolve({ id }) };
}

function request(
  method: "GET" | "PATCH" | "DELETE",
  body?: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  const requestHeaders = new Headers(headers);
  if (method !== "GET") {
    if (!requestHeaders.has("origin")) requestHeaders.set("origin", "https://hivra.test");
    if (!requestHeaders.has("sec-fetch-site")) {
      requestHeaders.set("sec-fetch-site", "same-origin");
    }
  }
  if (body && !requestHeaders.has("content-type")) {
    requestHeaders.set("content-type", "application/json");
  }
  return new NextRequest(`https://hivra.test/api/infrastructure/connections/${connectionId}`, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("/api/infrastructure/connections/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockGetConnection.mockResolvedValue(connection);
    mockUpdateConnection.mockResolvedValue(connection);
    mockDeleteConnection.mockResolvedValue(undefined);
  });

  it("gets a connection with both id and owner scope delegated to the store", async () => {
    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockGetConnection).toHaveBeenCalledWith("user_a", connectionId);
  });

  it("rotates a credential through authenticated PATCH without echoing it", async () => {
    const patch = { credentials: { sshPrivateKey: privateKey } };
    const response = await PATCH(request("PATCH", patch), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        routeKey: "infrastructure_connections_patch",
        userId: "user_a",
      }),
    );
    expect(mockUpdateConnection).toHaveBeenCalledWith("user_a", connectionId, patch);
    expect(JSON.stringify(body)).not.toContain(privateKey);
  });

  it("deletes under the secret-write rate limit", async () => {
    const response = await DELETE(request("DELETE"), context());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({ routeKey: "infrastructure_connections_delete" }),
    );
    expect(mockDeleteConnection).toHaveBeenCalledWith("user_a", connectionId);
    expect(body.data).toEqual({ deleted: true });
  });

  it.each([
    ["capacity_busy", "capacity_busy"],
    ["capacity_force_forget_required", "capacity_force_forget_required"],
  ] as const)("returns the safe Hetzner deletion boundary %s", async (storeCode, publicCode) => {
    mockDeleteConnection.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError(storeCode),
    );

    const response = await DELETE(request("DELETE"), context());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe(publicCode);
  });

  it("returns 404 for a cross-owner store miss", async () => {
    mockGetConnection.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("not_found"),
    );

    const response = await GET(request("GET"), context());

    expect(response.status).toBe(404);
  });

  it("returns truthful PATCH conflict copy for an optimistic-update or duplicate-name race", async () => {
    mockUpdateConnection.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("conflict"),
    );

    const response = await PATCH(request("PATCH", { name: "Renamed" }), context());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("changed or its name is already in use");
    expect(body.error).not.toContain("deployment targets");
  });

  it("uses 404 for invalid ids before calling the store", async () => {
    const response = await GET(request("GET"), context("not-a-uuid"));

    expect(response.status).toBe(404);
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it("rate limits PATCH before parsing the credential", async () => {
    mockRateLimit.mockReturnValueOnce(new Response(null, { status: 429 }));

    const response = await PATCH(
      request("PATCH", { credentials: { sshPrivateKey: privateKey } }),
      context(),
    );

    expect(response.status).toBe(429);
    expect(mockUpdateConnection).not.toHaveBeenCalled();
  });

  it("protects credential rotation with same-origin, exact JSON, and a bounded body", async () => {
    const missingOrigin = request("PATCH", { name: "Renamed" });
    missingOrigin.headers.delete("origin");
    expect((await PATCH(missingOrigin, context())).status).toBe(403);

    expect((await PATCH(request(
      "PATCH",
      { name: "Renamed" },
      { "content-type": "text/plain" },
    ), context())).status).toBe(415);

    const oversized = request("PATCH", { padding: "x".repeat(100_000) });
    oversized.headers.delete("content-length");
    expect((await PATCH(oversized, context())).status).toBe(413);
    expect(mockUpdateConnection).not.toHaveBeenCalled();
  });

  it("requires same-origin browser metadata before deleting a connection", async () => {
    const crossOrigin = request("DELETE", undefined, {
      origin: "https://attacker.test",
    });
    expect((await DELETE(crossOrigin, context())).status).toBe(403);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });

  it("requires Clerk authentication", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(401);
    expect(mockDeleteConnection).not.toHaveBeenCalled();
  });
});
