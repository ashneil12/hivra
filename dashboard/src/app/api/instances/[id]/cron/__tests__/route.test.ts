import { NextRequest, NextResponse } from "next/server";

import { DELETE, GET, POST, PUT } from "../route";
import { auth } from "@clerk/nextjs/server";
import { getSecureUserInstance } from "@/lib/services/instance-security";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/services/instance-security", () => ({
  getSecureUserInstance: jest.fn(),
}));

jest.mock("@/lib/agent-gateway", () => ({
  fetchFirstReachableGatewayResponse: jest.fn(),
}));

jest.mock("@/lib/billing/pro-tier", () => ({
  isProTierUser: jest.fn(),
}));

jest.mock("@/lib/authenticated-rate-limit", () => ({
  RATE_LIMIT_PRESETS: { scheduledTaskWrite: { limit: 20, windowMs: 60_000 } },
  enforceAuthenticatedRouteRateLimit: jest.fn(),
}));

describe("/api/instances/[id]/cron", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedGetSecureUserInstance = getSecureUserInstance as jest.MockedFunction<
    typeof getSecureUserInstance
  >;
  const mockedFetchGateway = fetchFirstReachableGatewayResponse as jest.MockedFunction<
    typeof fetchFirstReachableGatewayResponse
  >;
  const mockedIsProTierUser = isProTierUser as jest.MockedFunction<typeof isProTierUser>;
  const mockedRateLimit = enforceAuthenticatedRouteRateLimit as jest.MockedFunction<
    typeof enforceAuthenticatedRouteRateLimit
  >;
  const signedInAuth = { userId: "user_123" } as Awaited<ReturnType<typeof auth>>;
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  const secureOk = {
    instance: {
      id: "inst-123",
      gateway_url: "https://gw.example.com",
      user_id: "user_123",
      status: "running",
    },
    apiServerKey: "a".repeat(64),
    instanceIpv4: "203.0.113.10",
    error: null,
  } as unknown as Awaited<ReturnType<typeof getSecureUserInstance>>;

  function gatewayJson(body: unknown, status = 200) {
    return {
      response: new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      url: "https://gw.example.com/_sidecar/api/cron/jobs",
    };
  }

  function jsonRequest(method: string, body?: unknown, query = "") {
    return new NextRequest(`http://localhost/api/instances/inst-123/cron${query}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockedAuth.mockResolvedValue(signedInAuth);
    mockedGetSecureUserInstance.mockResolvedValue(secureOk);
    mockedIsProTierUser.mockResolvedValue({ ok: true, tier: "operator" });
    mockedRateLimit.mockReturnValue(null);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe("GET (list)", () => {
    it("is open to any owner — Free users can see the locked feature", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      mockedFetchGateway.mockResolvedValue(
        gatewayJson([{ id: "job-1", name: "Daily digest", schedule_display: "Daily at 9:00 AM", enabled: true }]),
      );

      const res = await GET(jsonRequest("GET", undefined, "?profile=all"), {
        params: Promise.resolve({ id: "inst-123" }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      // The list never consults the Pro gate.
      expect(mockedIsProTierUser).not.toHaveBeenCalled();
      expect(Array.isArray(data)).toBe(true);
      expect(data[0].name).toBe("Daily digest");
      // /_sidecar path is passed through to the gateway untouched.
      expect(mockedFetchGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://gw.example.com",
          pathname: "/_sidecar/api/cron/jobs?profile=all",
          method: "GET",
          instanceIpv4: "203.0.113.10",
        }),
      );
    });

    it("returns 401 when unauthenticated", async () => {
      mockedAuth.mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);
      const res = await GET(jsonRequest("GET"), { params: Promise.resolve({ id: "inst-123" }) });
      expect(res.status).toBe(401);
      expect(mockedFetchGateway).not.toHaveBeenCalled();
    });
  });

  describe("POST (create) — Free keeps one standing task + field mapping", () => {
    it("lets a Free user create their FIRST task when they have 0 jobs", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      // 1st call = the count-existing-jobs list (empty), 2nd = the create.
      mockedFetchGateway
        .mockResolvedValueOnce(gatewayJson([]))
        .mockResolvedValueOnce(gatewayJson({ id: "job-1", name: "Inbox digest" }));

      const res = await POST(
        jsonRequest("POST", { prompt: "Summarize the inbox", schedule: "0 9 * * *", name: "Inbox digest" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.id).toBe("job-1");
      // It listed first (profile=all), then created.
      expect(mockedFetchGateway).toHaveBeenCalledTimes(2);
      expect(mockedFetchGateway.mock.calls[0][0].pathname).toBe("/_sidecar/api/cron/jobs?profile=all");
      expect(mockedFetchGateway.mock.calls[0][0].method).toBe("GET");
      expect(mockedFetchGateway.mock.calls[1][0].method).toBe("POST");
    });

    it("blocks a Free user's SECOND create with a 403 and never creates on the box", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      // The existing-jobs list already has one job → at the free limit.
      mockedFetchGateway.mockResolvedValueOnce(gatewayJson([{ id: "job-existing", name: "Daily digest" }]));

      const res = await POST(
        jsonRequest("POST", { prompt: "Another job", schedule: "0 9 * * *", name: "Second" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.error).toMatch(/one standing task/i);
      expect(data.failureType).toBe("scheduled_task_tier_required");
      // Only the list call happened; no create was forwarded.
      expect(mockedFetchGateway).toHaveBeenCalledTimes(1);
      expect(mockedFetchGateway.mock.calls[0][0].method).toBe("GET");
    });

    it("fails closed (no create) for a Free user if the existing-jobs list can't be read", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      mockedFetchGateway.mockResolvedValueOnce(gatewayJson("box-down", 500));

      const res = await POST(
        jsonRequest("POST", { prompt: "x", schedule: "0 9 * * *" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );

      expect(res.status).toBe(502);
      // The list was attempted but no create was forwarded.
      expect(mockedFetchGateway).toHaveBeenCalledTimes(1);
      expect(mockedFetchGateway.mock.calls[0][0].method).toBe("GET");
    });

    it("lets a Pro user create without the existing-jobs round-trip", async () => {
      // Pro by default in beforeEach; only the create call should fire.
      mockedFetchGateway.mockResolvedValueOnce(gatewayJson({ id: "job-pro", name: "Unlimited" }));

      const res = await POST(
        jsonRequest("POST", { prompt: "x", schedule: "0 9 * * *" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );

      expect(res.status).toBe(200);
      // No list round-trip for Pro — exactly one (the create) gateway call.
      expect(mockedFetchGateway).toHaveBeenCalledTimes(1);
      expect(mockedFetchGateway.mock.calls[0][0].method).toBe("POST");
    });

    it("returns 429 when the scheduledTaskWrite rate limit is exceeded", async () => {
      mockedRateLimit.mockReturnValue(
        NextResponse.json({ success: false, error: "Too Many Requests" }, { status: 429 }),
      );

      const res = await POST(
        jsonRequest("POST", { prompt: "x", schedule: "0 9 * * *" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );

      expect(res.status).toBe(429);
      expect(mockedRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ routeKey: "scheduledTaskWrite", userId: "user_123", limit: 20, windowMs: 60_000 }),
      );
      expect(mockedIsProTierUser).not.toHaveBeenCalled();
      expect(mockedFetchGateway).not.toHaveBeenCalled();
    });

    it("sends the box the RAW cron schedule + prompt for Pro users", async () => {
      mockedFetchGateway.mockResolvedValue(gatewayJson({ id: "job-9", name: "Inbox digest" }));

      const res = await POST(
        jsonRequest(
          "POST",
          { prompt: "Summarize the inbox", schedule: "0 9 * * *", name: "Inbox digest" },
          "?profile=default",
        ),
        { params: Promise.resolve({ id: "inst-123" }) },
      );
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.id).toBe("job-9");
      expect(mockedFetchGateway).toHaveBeenCalledTimes(1);

      const call = mockedFetchGateway.mock.calls[0][0];
      expect(call.method).toBe("POST");
      expect(call.pathname).toBe("/_sidecar/api/cron/jobs?profile=default");
      const sentBody = JSON.parse(call.body as string);
      expect(sentBody).toEqual({
        prompt: "Summarize the inbox",
        schedule: "0 9 * * *", // RAW cron string, not a parsed dict
        name: "Inbox digest",
        deliver: "local",
      });
      // Signed headers carry the bearer + HMAC signature.
      const headers = call.headers as Headers;
      expect(headers.get("Authorization")).toBe(`Bearer ${"a".repeat(64)}`);
      expect(headers.get("X-Hermes-Signature")).toBeTruthy();
    });

    it("rejects an empty prompt before contacting the box", async () => {
      const res = await POST(
        jsonRequest("POST", { prompt: "", schedule: "0 9 * * *" }),
        { params: Promise.resolve({ id: "inst-123" }) },
      );
      expect(res.status).toBe(400);
      expect(mockedFetchGateway).not.toHaveBeenCalled();
    });

    it("runs a lifecycle action via ?action=trigger", async () => {
      mockedFetchGateway.mockResolvedValue(gatewayJson({ id: "job-9", last_status: "running" }));

      const res = await POST(jsonRequest("POST", undefined, "?action=trigger&jobId=job-9"), {
        params: Promise.resolve({ id: "inst-123" }),
      });

      expect(res.status).toBe(200);
      expect(mockedFetchGateway.mock.calls[0][0].pathname).toBe(
        "/_sidecar/api/cron/jobs/job-9/trigger",
      );
    });

    it("lets a Free user pause/resume/trigger an existing job (no Pro gate, no list)", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      mockedFetchGateway.mockResolvedValue(gatewayJson({ id: "job-9", state: "paused" }));

      const res = await POST(jsonRequest("POST", undefined, "?action=pause&jobId=job-9"), {
        params: Promise.resolve({ id: "inst-123" }),
      });

      expect(res.status).toBe(200);
      // Lifecycle is open to the owner — the create gate (Pro check + list) never runs.
      expect(mockedIsProTierUser).not.toHaveBeenCalled();
      expect(mockedFetchGateway).toHaveBeenCalledTimes(1);
      expect(mockedFetchGateway.mock.calls[0][0].pathname).toBe(
        "/_sidecar/api/cron/jobs/job-9/pause",
      );
    });
  });

  describe("PUT (update) — open to owners + updates wrapper", () => {
    it("lets a Free user edit their existing task (managing what they already own)", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      mockedFetchGateway.mockResolvedValue(gatewayJson({ id: "job-9", name: "Renamed" }));

      const res = await PUT(
        jsonRequest("PUT", { jobId: "job-9", updates: { enabled: false } }, "?profile=default"),
        { params: Promise.resolve({ id: "inst-123" }) },
      );

      expect(res.status).toBe(200);
      // The Pro gate is not consulted on an edit (no extra task is created).
      expect(mockedIsProTierUser).not.toHaveBeenCalled();
      const call = mockedFetchGateway.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(call.pathname).toBe("/_sidecar/api/cron/jobs/job-9?profile=default");
    });

    it("wraps the changed fields under updates and maps the raw schedule", async () => {
      mockedFetchGateway.mockResolvedValue(gatewayJson({ id: "job-9", name: "Renamed" }));

      const res = await PUT(
        jsonRequest(
          "PUT",
          { jobId: "job-9", updates: { name: "Renamed", schedule: "30 8 * * 1-5", prompt: "Do it", enabled: true } },
          "?profile=default",
        ),
        { params: Promise.resolve({ id: "inst-123" }) },
      );

      expect(res.status).toBe(200);
      const call = mockedFetchGateway.mock.calls[0][0];
      expect(call.method).toBe("PUT");
      expect(call.pathname).toBe("/_sidecar/api/cron/jobs/job-9?profile=default");
      expect(JSON.parse(call.body as string)).toEqual({
        updates: { name: "Renamed", schedule: "30 8 * * 1-5", prompt: "Do it", enabled: true },
      });
    });
  });

  describe("DELETE — open to owners", () => {
    it("lets a Free user delete their existing task (frees their single slot)", async () => {
      mockedIsProTierUser.mockResolvedValue({ ok: false, tier: "credit_base", reason: "tier_below_pro" });
      mockedFetchGateway.mockResolvedValue(gatewayJson({ ok: true }));

      const res = await DELETE(jsonRequest("DELETE", undefined, "?jobId=job-9"), {
        params: Promise.resolve({ id: "inst-123" }),
      });

      expect(res.status).toBe(200);
      // The Pro gate is not consulted on a delete.
      expect(mockedIsProTierUser).not.toHaveBeenCalled();
      const call = mockedFetchGateway.mock.calls[0][0];
      expect(call.method).toBe("DELETE");
      expect(call.pathname).toBe("/_sidecar/api/cron/jobs/job-9");
    });

    it("forwards a DELETE for Pro users", async () => {
      mockedFetchGateway.mockResolvedValue(gatewayJson({ ok: true }));

      const res = await DELETE(jsonRequest("DELETE", undefined, "?jobId=job-9&profile=default"), {
        params: Promise.resolve({ id: "inst-123" }),
      });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data).toEqual({ ok: true });
      const call = mockedFetchGateway.mock.calls[0][0];
      expect(call.method).toBe("DELETE");
      expect(call.pathname).toBe("/_sidecar/api/cron/jobs/job-9?profile=default");
    });

    it("rejects a missing jobId before contacting the box", async () => {
      const res = await DELETE(jsonRequest("DELETE"), { params: Promise.resolve({ id: "inst-123" }) });
      expect(res.status).toBe(400);
      expect(mockedFetchGateway).not.toHaveBeenCalled();
    });
  });

  it("does not leak raw box error bodies on a rejected create", async () => {
    mockedFetchGateway.mockResolvedValue(gatewayJson("cron-secret-leak", 500));

    const res = await POST(
      jsonRequest("POST", { prompt: "x", schedule: "0 9 * * *" }),
      { params: Promise.resolve({ id: "inst-123" }) },
    );
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toBe("Scheduled task request failed");
    expect(JSON.stringify(data)).not.toContain("cron-secret-leak");
  });
});
