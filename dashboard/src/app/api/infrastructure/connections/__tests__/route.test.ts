import { NextRequest } from "next/server";

const mockListConnections = jest.fn();
const mockCreateConnection = jest.fn();
const mockConnectHetznerCloudProject = jest.fn();
const mockRateLimit = jest.fn<Response | null, [Request, Record<string, unknown>]>(() => null);

jest.mock("@/lib/infrastructure/connection-store", () => ({
  InfrastructureConnectionStoreError: class InfrastructureConnectionStoreError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  listInfrastructureConnections: (...args: unknown[]) => mockListConnections(...args),
  createInfrastructureConnection: (...args: unknown[]) => mockCreateConnection(...args),
}));

jest.mock("@/lib/infrastructure/hetzner-cloud", () => ({
  HetznerCloudConnectionError: class HetznerCloudConnectionError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  HetznerCloudTokenCheckError: class HetznerCloudTokenCheckError extends Error {
    constructor(public readonly code: string, message: string) {
      super(message);
    }
  },
  connectHetznerCloudProject: (...args: unknown[]) =>
    mockConnectHetznerCloudProject(...args),
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
import { GET, POST } from "../route";

const privateKey = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "A".repeat(96),
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

const connection = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Home Proxmox",
  provider: "proxmox" as const,
  operatingMode: "self-managed" as const,
  setupMode: "simple" as const,
  status: "pending" as const,
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

function post(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("https://hivra.test/api/infrastructure/connections", {
    method: "POST",
    headers: {
      origin: "https://hivra.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validBody() {
  return {
    name: "Home Proxmox",
    provider: "proxmox",
    operatingMode: "self-managed",
    setupMode: "simple",
    endpoint: {
      sshHost: "pve.example.com",
      sshPort: 22,
      sshUser: "root",
      sshHostFingerprintSha256: "a".repeat(64),
    },
    credentials: { sshPrivateKey: privateKey },
  };
}

describe("/api/infrastructure/connections", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockListConnections.mockResolvedValue([connection]);
    mockCreateConnection.mockResolvedValue(connection);
    mockConnectHetznerCloudProject.mockResolvedValue({
      connection: {
        ...connection,
        name: "My Hetzner",
        provider: "hetzner-cloud",
        endpoint: null,
        configuration: null,
        capabilities: {
          inventory: true,
          offerCatalog: true,
          createCapacity: false,
          agentLaunch: false,
          reason: "Provider VM bootstrap is not implemented yet.",
        },
      },
      inventory: [],
    });
  });

  it("lists the authenticated owner's sanitized connections", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockListConnections).toHaveBeenCalledWith("user_a");
    expect(body.data.connections).toEqual([connection]);
  });

  it("creates a connection under the secret-write rate limit without echoing the key", async () => {
    const requestBody = validBody();
    const response = await POST(post(requestBody));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        routeKey: "infrastructure_connections_post",
        userId: "user_a",
        limit: 20,
        windowMs: 60_000,
      }),
    );
    expect(mockCreateConnection).toHaveBeenCalledWith("user_a", requestBody);
    expect(body.data.connection).toEqual(connection);
    expect(JSON.stringify(body)).not.toContain(privateKey);
  });

  it("accepts a generic host connection without provider-specific settings", async () => {
    const requestBody = {
      ...validBody(),
      name: "My host",
      provider: "host",
    };
    mockCreateConnection.mockResolvedValueOnce({
      ...connection,
      name: "My host",
      provider: "host",
    });

    const response = await POST(post(requestBody));

    expect(response.status).toBe(201);
    expect(mockCreateConnection).toHaveBeenCalledWith("user_a", requestBody);
  });

  it("validates a Hetzner project token without echoing it or invoking the SSH store", async () => {
    const apiToken = "project-scoped-owner-token-value";
    const response = await POST(post({
      name: "My Hetzner",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken },
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(mockConnectHetznerCloudProject).toHaveBeenCalledWith({
      userId: "user_a",
      name: "My Hetzner",
      apiToken,
    });
    expect(mockCreateConnection).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain(apiToken);
    expect(body.data.connection.endpoint).toBeNull();
  });

  it("returns a read-only token as a same-screen fix, with nothing saved", async () => {
    const { HetznerCloudTokenCheckError } = jest.requireMock("@/lib/infrastructure/hetzner-cloud") as {
      HetznerCloudTokenCheckError: new (code: string, message: string) => Error;
    };
    mockConnectHetznerCloudProject.mockRejectedValueOnce(new HetznerCloudTokenCheckError(
      "token_read_only",
      "This token is read-only. Generate a Read & Write token in the same project and paste it here.",
    ));
    const response = await POST(post({
      name: "My Hetzner",
      provider: "hetzner-cloud",
      operatingMode: "self-managed",
      setupMode: "simple",
      credentials: { apiToken: "project-scoped-read-only-token" },
    }));
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      code: "token_read_only",
      error: "This token is read-only. Generate a Read & Write token in the same project and paste it here.",
    });
    expect(JSON.stringify(body)).not.toContain("project-scoped-read-only-token");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("rejects malformed connection data before the store", async () => {
    const response = await POST(post({ ...validBody(), endpoint: { sshHost: "https://bad" } }));

    expect(response.status).toBe(400);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("applies the limiter before parsing or storing a secret", async () => {
    mockRateLimit.mockReturnValueOnce(new Response(null, { status: 429 }));

    const response = await POST(post(validBody()));

    expect(response.status).toBe(429);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("fails closed for missing or cross-origin browser mutation metadata", async () => {
    const missingOrigin = post(validBody());
    missingOrigin.headers.delete("origin");
    expect((await POST(missingOrigin)).status).toBe(403);

    expect((await POST(post(validBody(), {
      origin: "https://attacker.test",
    }))).status).toBe(403);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("accepts the browser-visible loopback host when Next normalizes its internal origin", async () => {
    const response = await POST(new NextRequest(
      "http://localhost:3000/api/infrastructure/connections",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
        },
        body: JSON.stringify(validBody()),
      },
    ));

    expect(response.status).toBe(201);
    expect(mockCreateConnection).toHaveBeenCalledWith("user_a", validBody());
  });

  it("requires exact JSON and rejects an oversized streamed secret body", async () => {
    expect((await POST(post(validBody(), {
      "content-type": "application/json; charset=utf-8",
    }))).status).toBe(415);

    const oversized = post({ padding: "x".repeat(100_000) });
    oversized.headers.delete("content-length");
    expect((await POST(oversized)).status).toBe(413);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("does not expose owner metadata to unauthenticated callers", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mockListConnections).not.toHaveBeenCalled();
  });

  it("authenticates before enforcing browser metadata or reading a secret", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const unauthenticated = post(validBody());
    unauthenticated.headers.delete("origin");

    expect((await POST(unauthenticated)).status).toBe(401);
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });
});
