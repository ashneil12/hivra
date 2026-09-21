import { NextRequest } from "next/server";

const mockCreateKey = jest.fn();
const mockListKeys = jest.fn();
const mockRevokeKey = jest.fn();
const mockRateLimit = jest.fn<Response | null, [Request, Record<string, unknown>]>(
  () => null
);

jest.mock("@/lib/venice/proxy-keys", () => ({
  AgentModelKeyInUseError: jest.requireActual("@/lib/venice/proxy-keys").AgentModelKeyInUseError,
  createManagedVeniceProxyKey: (...args: unknown[]) => mockCreateKey(...args),
  listManagedVeniceProxyKeys: (...args: unknown[]) => mockListKeys(...args),
  revokeManagedVeniceProxyKey: (...args: unknown[]) => mockRevokeKey(...args),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (
    request: Request,
    options: Record<string, unknown>
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
import { DELETE, GET, POST } from "../route";
import { AgentModelKeyInUseError } from "@/lib/venice/proxy-keys";

function makeReq(url: string, body?: unknown): NextRequest {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const listedKey = {
  id: "key_1",
  name: "Production key",
  keyPrefix: "hven_live_abc1",
  status: "active" as const,
  lastUsedAt: null,
  createdAt: "2026-05-12T12:00:00.000Z",
  revokedAt: null,
};

it("routes adopted agent keys back to their confirmed-clear workflow", async () => {
  jest.mocked(auth).mockResolvedValue({ userId: "owner" } as never);
  mockRateLimit.mockReturnValue(null); mockRevokeKey.mockRejectedValueOnce(new AgentModelKeyInUseError());
  const response = await DELETE(makeReq("https://canary.hivra.test/api/managed-venice/keys?id=fixture-key"));
  expect(response.status).toBe(409); expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.json();
  expect(body).toMatchObject({ success: false, code: "agent_model_key_in_use" });
  expect(body.error).toContain("Manage → Inference");
});

describe("/api/managed-venice/keys", () => {
  let consoleWarnSpy: jest.SpyInstance;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockListKeys.mockResolvedValue([listedKey]);
    mockCreateKey.mockResolvedValue({
      ...listedKey,
      plaintextKey: "hven_live_plaintext_secret",
    });
    mockRevokeKey.mockResolvedValue({ revoked: true });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("lists proxy keys for authenticated users", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockListKeys).toHaveBeenCalledWith("user_a");
  });

  it("creates proxy keys for authenticated users", async () => {
    const response = await POST(
      makeReq("http://localhost/api/managed-venice/keys", {
        name: "Production key",
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateKey).toHaveBeenCalledWith({
      userId: "user_a",
      name: "Production key",
    });
  });

  it("revokes proxy keys for authenticated users", async () => {
    const response = await DELETE(
      makeReq("http://localhost/api/managed-venice/keys?id=key_1")
    );

    expect(response.status).toBe(200);
    expect(mockRevokeKey).toHaveBeenCalledWith({
      userId: "user_a",
      keyId: "key_1",
    });
  });

  it("returns 401 when unauthenticated", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockListKeys).not.toHaveBeenCalled();
  });

  it("lists proxy keys without plaintext", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockListKeys).toHaveBeenCalledWith("user_a");
    expect(body.data.keys).toEqual([listedKey]);
    expect(JSON.stringify(body)).not.toContain("plaintext");
  });

  it("creates a proxy key and returns plaintext once", async () => {
    const response = await POST(
      makeReq("http://localhost/api/managed-venice/keys", {
        name: "Production key",
      })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        routeKey: "managed_venice_keys_post",
        userId: "user_a",
        limit: 20,
        windowMs: 60_000,
      })
    );
    expect(mockCreateKey).toHaveBeenCalledWith({
      userId: "user_a",
      name: "Production key",
    });
    expect(body.data.plaintextKey).toBe("hven_live_plaintext_secret");
    // The one-time plaintext secret must never be cached by the browser or
    // an intermediate proxy/CDN.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("passes walletType through as the key's default wallet", async () => {
    const response = await POST(
      makeReq("http://localhost/api/managed-venice/keys", {
        name: "Aeon box key",
        walletType: "card",
      })
    );

    expect(response.status).toBe(200);
    expect(mockCreateKey).toHaveBeenCalledWith({
      userId: "user_a",
      name: "Aeon box key",
      defaultWalletType: "card",
    });
  });

  it("rejects an unknown walletType", async () => {
    const response = await POST(
      makeReq("http://localhost/api/managed-venice/keys", {
        walletType: "paypal",
      })
    );

    expect(response.status).toBe(400);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it("applies the secret-write rate limit to key creation", async () => {
    const limited = new Response(JSON.stringify({ success: false }), { status: 429 });
    mockRateLimit.mockReturnValueOnce(limited);

    const response = await POST(
      makeReq("http://localhost/api/managed-venice/keys", {
        name: "Production key",
      })
    );

    expect(response.status).toBe(429);
    expect(mockCreateKey).not.toHaveBeenCalled();
  });

  it("revokes a proxy key for the authenticated user", async () => {
    const response = await DELETE(
      makeReq("http://localhost/api/managed-venice/keys?id=key_1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        routeKey: "managed_venice_keys_delete",
        userId: "user_a",
      })
    );
    expect(mockRevokeKey).toHaveBeenCalledWith({
      userId: "user_a",
      keyId: "key_1",
    });
    expect(body.data).toEqual({ revoked: true });
  });

  it("requires a key id for revoke", async () => {
    const response = await DELETE(makeReq("http://localhost/api/managed-venice/keys"));

    expect(response.status).toBe(400);
    expect(mockRevokeKey).not.toHaveBeenCalled();
  });
});
