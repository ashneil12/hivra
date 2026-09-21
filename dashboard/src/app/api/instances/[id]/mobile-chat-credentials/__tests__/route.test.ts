import { NextRequest, NextResponse } from "next/server";

import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { log } from "@/lib/logger";
import { getSecureUserInstance } from "@/lib/services/instance-security";

const mockReadinessSingle = jest.fn();
const mockReadinessNeq = jest.fn(() => ({ single: mockReadinessSingle }));
const mockReadinessEqUser = jest.fn(() => ({ neq: mockReadinessNeq }));
const mockReadinessEqId = jest.fn(() => ({ eq: mockReadinessEqUser }));
const mockReadinessSelect = jest.fn(() => ({ eq: mockReadinessEqId }));
const mockReadinessFrom = jest.fn(() => ({ select: mockReadinessSelect }));

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

// The real limiter is a process-global fixed-window store; exercising it here
// would leak budget across tests. Wiring is asserted instead (routeKey +
// userId + a returned 429 short-circuits before any DB read).
jest.mock("@/lib/authenticated-rate-limit", () => ({
  ...jest.requireActual("@/lib/authenticated-rate-limit"),
  enforceAuthenticatedRouteRateLimit: jest.fn(() => null),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => mockReadinessFrom(),
  },
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/instances/[id]/mobile-chat-credentials", () => {
  type SecureUserInstanceResult = Awaited<ReturnType<typeof getSecureUserInstance>>;
  type SecureUserInstanceSuccess = Extract<SecureUserInstanceResult, { error: null }>;

  const API_SERVER_KEY = "a".repeat(32) + "b".repeat(32);

  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<typeof getSecureUserInstance>;
  const mockedFetchFirstReachableGatewayResponse =
    fetchFirstReachableGatewayResponse as jest.MockedFunction<typeof fetchFirstReachableGatewayResponse>;
  const mockedEnforceRateLimit =
    enforceAuthenticatedRouteRateLimit as jest.MockedFunction<typeof enforceAuthenticatedRouteRateLimit>;

  function happyInstance(): SecureUserInstanceSuccess {
    return {
      instance: {
        id: "inst_123",
        gateway_url: "https://agent.example.com",
        api_server_key_encrypted: "encrypted-key",
        user_id: "user_123",
        status: "running",
        backend: "webui",
        config: {},
        host_id: null,
        hetzner_server_id: null,
        cpu_limit: null,
        ram_limit: null,
      },
      apiServerKey: API_SERVER_KEY,
      instanceIpv4: "203.0.113.10",
      error: null,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedEnforceRateLimit.mockReturnValue(null);
    mockedFetchFirstReachableGatewayResponse.mockResolvedValue({
      url: "https://agent.example.com/api/sessions",
      response: new Response(JSON.stringify({ sessions: [] }), { status: 200 }),
    });
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockReadinessSingle.mockResolvedValue({
      data: { status: "running" },
      error: null,
    });
    mockedGetSecureUserInstance.mockResolvedValue(happyInstance());
  });

  function callRoute(id = "inst_123") {
    return GET(
      new NextRequest(`http://localhost/api/instances/${id}/mobile-chat-credentials`),
      { params: Promise.resolve({ id }) },
    );
  }

  function allLoggedPayloads(): string {
    const mockedLog = log as unknown as Record<string, jest.Mock>;
    return ["error", "warn", "info", "debug"]
      .flatMap((level) => mockedLog[level].mock.calls)
      .map((call) => JSON.stringify(call))
      .join("\n");
  }

  describe("authz", () => {
    it("rejects unauthenticated callers with 401", async () => {
      mockedAuth.mockResolvedValueOnce({ userId: null } as Awaited<ReturnType<typeof auth>>);
      const response = await callRoute();
      expect(response.status).toBe(401);
      expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
    });

    it("returns 404 when the instance belongs to another user (ownership scoped lookup misses)", async () => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: null,
        error: { message: "not found" },
      });

      const response = await callRoute("inst_of_someone_else");
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual({ error: "Instance not found or unauthorized" });
      // Ownership is enforced in the query itself (id + user_id), so a miss
      // never reaches the credential-decrypting path.
      expect(mockReadinessEqId).toHaveBeenCalledWith("id", "inst_of_someone_else");
      expect(mockReadinessEqUser).toHaveBeenCalledWith("user_id", "user_123");
      expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
      expect(mockedFetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
    });

    it("returns 404 when the instance does not exist", async () => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: null,
        error: { message: "not found" },
      });
      const response = await callRoute("inst_missing");
      expect(response.status).toBe(404);
    });
  });

  describe("rate limiting", () => {
    it("is wired through the shared authenticated route limiter", async () => {
      await callRoute();
      expect(mockedEnforceRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          routeKey: "instances_mobile_chat_credentials_get",
          userId: "user_123",
          limit: expect.any(Number),
          windowMs: expect.any(Number),
        }),
      );
    });

    it("short-circuits with the limiter's 429 before touching the database", async () => {
      mockedEnforceRateLimit.mockReturnValueOnce(
        NextResponse.json({ success: false, error: "Too Many Requests" }, { status: 429 }),
      );

      const response = await callRoute();

      expect(response.status).toBe(429);
      expect(mockReadinessFrom).not.toHaveBeenCalled();
      expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
    });
  });

  describe("readiness gating", () => {
    it("returns 202 with Retry-After while the instance is still provisioning", async () => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: { status: "provisioning" },
        error: null,
      });

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual({
        kind: "pending",
        reason: "instance_not_ready",
        instanceStatus: "provisioning",
        retryAfterMs: 4000,
        message: expect.any(String),
      });
      expect(response.headers.get("retry-after")).toBe("4");
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
      expect(mockedGetSecureUserInstance).not.toHaveBeenCalled();
      expect(mockedFetchFirstReachableGatewayResponse).not.toHaveBeenCalled();
      expect(body.token).toBeUndefined();
    });

    it("returns 202 with Retry-After while the instance is redeploying", async () => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: { status: "redeploying" },
        error: null,
      });

      const response = await callRoute();

      expect(response.status).toBe(202);
      expect(response.headers.get("retry-after")).toBe("4");
    });

    it("returns 400 for a non-running instance", async () => {
      mockReadinessSingle.mockResolvedValueOnce({
        data: { status: "stopped" },
        error: null,
      });

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({
        error: "Instance is not currently running",
        instanceStatus: "stopped",
      });
      expect(body.token).toBeUndefined();
    });

    it("returns 202 pending when the chat lane rejects the bearer (key drift heals via the browser flow)", async () => {
      mockedFetchFirstReachableGatewayResponse.mockResolvedValueOnce({
        url: "https://agent.example.com/api/sessions",
        response: new Response("unauthorized", { status: 401 }),
      });

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body).toEqual({
        kind: "pending",
        reason: "chat_lane_not_ready",
        instanceStatus: "running",
        retryAfterMs: 4000,
        message: expect.any(String),
      });
      expect(response.headers.get("retry-after")).toBe("4");
      expect(body.token).toBeUndefined();
    });

    it("returns 202 pending when the chat lane is unreachable at the connection level", async () => {
      mockedFetchFirstReachableGatewayResponse.mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" }),
      );

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(202);
      expect(body.reason).toBe("chat_lane_not_ready");
      expect(response.headers.get("retry-after")).toBe("4");
      expect(body.token).toBeUndefined();
    });

    it("maps a missing gateway URL to 400", async () => {
      mockedGetSecureUserInstance.mockResolvedValueOnce({
        instance: null,
        apiServerKey: "",
        instanceIpv4: "",
        error: "Gateway URL not configured",
      });
      const response = await callRoute();
      expect(response.status).toBe(400);
    });

    it("maps a missing apiServerKey to 500 without leaking anything", async () => {
      mockedGetSecureUserInstance.mockResolvedValueOnce({
        instance: happyInstance().instance,
        apiServerKey: "",
        instanceIpv4: "",
        error: null,
      } as SecureUserInstanceResult);
      const response = await callRoute();
      expect(response.status).toBe(500);
    });
  });

  describe("happy path", () => {
    it("returns { host, token, wsPath, sessionsPath } for the direct WS lane", async () => {
      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({
        host: "agent.example.com",
        token: API_SERVER_KEY,
        wsPath: "/api/ws",
        sessionsPath: "/api/sessions",
      });
    });

    it("gates readiness on the authenticated chat lane, not /health", async () => {
      await callRoute();

      expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledTimes(1);
      expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://agent.example.com",
          pathname: "/api/sessions",
          instanceIpv4: "203.0.113.10",
          method: "GET",
          timeoutScope: "request",
          headers: expect.objectContaining({
            Authorization: `Bearer ${API_SERVER_KEY}`,
          }),
        }),
      );
    });

    it("sets no-store cache headers on the credential response", async () => {
      const response = await callRoute();
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
    });

    it("normalizes a stale http sslip gateway_url to its https host", async () => {
      mockedGetSecureUserInstance.mockResolvedValueOnce({
        ...happyInstance(),
        instance: {
          ...happyInstance().instance,
          gateway_url: "http://203-0-113-10.sslip.io/",
        },
      } as SecureUserInstanceResult);

      const response = await callRoute();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.host).toBe("203-0-113-10.sslip.io");
      expect(mockedFetchFirstReachableGatewayResponse).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: "https://203-0-113-10.sslip.io" }),
      );
    });
  });

  describe("token hygiene", () => {
    it("never logs the apiServerKey on the happy path", async () => {
      await callRoute();
      expect(allLoggedPayloads()).not.toContain(API_SERVER_KEY);
    });

    it("never logs the apiServerKey when the chat-lane probe fails", async () => {
      mockedFetchFirstReachableGatewayResponse.mockResolvedValueOnce({
        url: "https://agent.example.com/api/sessions",
        response: new Response("unauthorized", { status: 401 }),
      });
      await callRoute();
      expect(allLoggedPayloads()).not.toContain(API_SERVER_KEY);
    });

    it("never logs the apiServerKey when the probe throws", async () => {
      mockedFetchFirstReachableGatewayResponse.mockRejectedValueOnce(
        new Error("boom"),
      );
      await callRoute();
      expect(allLoggedPayloads()).not.toContain(API_SERVER_KEY);
    });

    it("never logs the apiServerKey when credentials are unavailable", async () => {
      mockedGetSecureUserInstance.mockResolvedValueOnce({
        instance: null,
        apiServerKey: "",
        instanceIpv4: "",
        error: "Failed to decrypt API key",
      });
      const response = await callRoute();
      expect(response.status).toBe(500);
      expect(allLoggedPayloads()).not.toContain(API_SERVER_KEY);
    });
  });
});
