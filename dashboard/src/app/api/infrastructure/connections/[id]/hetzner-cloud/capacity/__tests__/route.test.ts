import { NextRequest } from "next/server";

const mockCreateCapacity = jest.fn();
const mockCreatePrepared = jest.fn();
const mockDispatchedRequest = jest.fn();
const mockCallbackReachable = jest.fn();
const mockRateLimit = jest.fn<Response | null, [Request, Record<string, unknown>]>(() => null);

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/infrastructure/first-boot-callback-readiness", () => ({
  isFirstBootCallbackReachable: (...args: unknown[]) => mockCallbackReachable(...args),
}));
jest.mock("@/lib/infrastructure/hetzner-cloud-store", () => ({
  hasDispatchedHetznerCapacityRequest: (...args: unknown[]) => mockDispatchedRequest(...args),
}));
jest.mock("@/lib/authenticated-rate-limit", () => ({
  enforceAuthenticatedRouteRateLimit: (
    request: Request,
    options: Record<string, unknown>,
  ) => mockRateLimit(request, options),
}));
jest.mock("@/lib/infrastructure/connection-store", () => ({
  InfrastructureConnectionStoreError: class InfrastructureConnectionStoreError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
}));
jest.mock("@/lib/infrastructure/hetzner-cloud", () => ({
  HetznerCloudCapacityError: class HetznerCloudCapacityError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  createHetznerCloudCapacity: (...args: unknown[]) => mockCreateCapacity(...args),
  createPreparedHetznerCloudCapacity: (...args: unknown[]) => mockCreatePrepared(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HetznerCloudCapacityError } from "@/lib/infrastructure/hetzner-cloud";
import { POST } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const QUOTE_ID = "22222222-2222-4222-8222-222222222222";
const IDEMPOTENCY_KEY = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ id: CONNECTION_ID }) };
const body = {
  quoteId: QUOTE_ID,
  idempotencyKey: IDEMPOTENCY_KEY,
  spendingConfirmation: "Create server and start billing",
};

function request(rawBody = JSON.stringify(body), headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `https://hivra.test/api/infrastructure/connections/${CONNECTION_ID}/hetzner-cloud/capacity`,
    {
      method: "POST",
      headers: {
        origin: "https://hivra.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        ...headers,
      },
      body: rawBody,
    },
  );
}

describe("Hetzner Cloud capacity create route", () => {
  const originalOrigin = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => { if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = originalOrigin; });
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockDispatchedRequest.mockResolvedValue(false);
    mockCallbackReachable.mockResolvedValue(true);
    mockCreateCapacity.mockResolvedValue({
      operation: { status: "ambiguous", replayed: true },
      inventory: [],
    });
  });

  it("returns an idempotent non-terminal replay without claiming success", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(202);
    expect(mockCreateCapacity).toHaveBeenCalledWith("user_a", CONNECTION_ID, body);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        operation: expect.objectContaining({ status: "ambiguous", replayed: true }),
      }),
    }));
  });
  it("requires explicit preparation consent and uses only the configured callback origin", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hivra.test";
    mockCreatePrepared.mockResolvedValue({ operation: { status: "created_off" }, inventory: [] });
    const preparationConfirmation = "Prepare this computer for agent launch";
    expect((await POST(request(JSON.stringify({ ...body, preparationConfirmation })), context)).status).toBe(201);
    expect(mockCreatePrepared).toHaveBeenCalledWith("user_a", CONNECTION_ID, body, {
      confirmation: preparationConfirmation, callbackOrigin: "https://canary.hivra.test",
    });
    expect(mockCreateCapacity).not.toHaveBeenCalled();
    expect((await POST(request(JSON.stringify({ ...body, preparationConfirmation, callbackOrigin: "https://attacker.test" })), context)).status).toBe(400);
  });
  it.each([undefined, "http://localhost", "https://app.test/path", "https://user:secret@app.test"])("rejects invalid deployment callback %s before capacity mutation", async origin => {
    if (origin === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = origin;
    expect((await POST(request(JSON.stringify({ ...body, preparationConfirmation: "Prepare this computer for agent launch" })), context)).status).toBe(503);
    expect(mockCreatePrepared).not.toHaveBeenCalled(); expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("rejects an unreachable guided callback before any capacity mutation", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hivra.test";
    mockCallbackReachable.mockResolvedValue(false);
    const response = await POST(request(JSON.stringify({ ...body, preparationConfirmation: "Prepare this computer for agent launch" })), context);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("This attempt did not request a new server");
    expect(mockCallbackReachable).toHaveBeenCalledWith("https://canary.hivra.test");
    expect(mockCreatePrepared).not.toHaveBeenCalled();
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("keeps already-dispatched guided requests recoverable when the callback becomes unreachable", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hivra.test";
    mockDispatchedRequest.mockResolvedValue(true);
    mockCallbackReachable.mockResolvedValue(false);
    mockCreatePrepared.mockResolvedValue({ operation: { status: "created_off" }, inventory: [] });
    expect((await POST(request(JSON.stringify({ ...body, preparationConfirmation: "Prepare this computer for agent launch" })), context)).status).toBe(201);
    expect(mockCallbackReachable).not.toHaveBeenCalled();
    expect(mockCreatePrepared).toHaveBeenCalledTimes(1);
  });

  it("does not probe machine callbacks for capacity-only purchases", async () => {
    await POST(request(), context);
    expect(mockCallbackReachable).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before reading the body", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const untrusted = request(JSON.stringify({ padding: "x".repeat(5_000) }));
    untrusted.headers.delete("origin");
    untrusted.headers.delete("content-length");
    expect((await POST(untrusted, context)).status).toBe(401);
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it.each([
    ["missing origin", { origin: null, fetchSite: "same-origin" }],
    ["cross origin", { origin: "https://attacker.test", fetchSite: "same-origin" }],
    ["missing fetch metadata", { origin: "https://hivra.test", fetchSite: null }],
    ["cross-site fetch metadata", { origin: "https://hivra.test", fetchSite: "cross-site" }],
  ])("rejects %s", async (_label, headers) => {
    const untrusted = request();
    if (headers.origin === null) untrusted.headers.delete("origin");
    else untrusted.headers.set("origin", headers.origin);
    if (headers.fetchSite === null) untrusted.headers.delete("sec-fetch-site");
    else untrusted.headers.set("sec-fetch-site", headers.fetchSite);
    expect((await POST(untrusted, context)).status).toBe(403);
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("does not leak a cross-owner connection", async () => {
    mockCreateCapacity.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("not_found" as never),
    );
    expect((await POST(request(), context)).status).toBe(404);
  });

  it("uses a strict billable-route rate limit", async () => {
    await POST(request(), context);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(NextRequest),
      expect.objectContaining({ limit: 2, windowMs: 600_000 }),
    );
  });

  it("checks an already-dispatched original request without consuming the purchase limit", async () => {
    mockDispatchedRequest.mockResolvedValue(true);
    mockRateLimit.mockImplementation((_request, options) => options.routeKey === "hetzner_cloud_capacity_create"
      ? new Response("purchase limit reached", { status: 429 }) : null);
    for (let check = 0; check < 3; check++) expect((await POST(request(), context)).status).toBe(202);
    expect(mockDispatchedRequest).toHaveBeenCalledWith("user_a", CONNECTION_ID, QUOTE_ID, IDEMPOTENCY_KEY);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.any(NextRequest), expect.objectContaining({
      routeKey: "hetzner_cloud_capacity_reconcile", limit: 30, windowMs: 60_000,
    }));
    expect(mockRateLimit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ routeKey: "hetzner_cloud_capacity_create" }));
  });

  it("does not let an unknown or unsubmitted request bypass the original purchase limit", async () => {
    mockRateLimit.mockImplementation((_request, options) => options.routeKey === "hetzner_cloud_capacity_create"
      ? new Response("purchase limit reached", { status: 429 }) : null);
    expect((await POST(request(), context)).status).toBe(429);
    expect(mockDispatchedRequest).toHaveBeenCalled();
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("fails closed before provider calls when dispatch lookup fails", async () => {
    mockDispatchedRequest.mockRejectedValue(new Error("private database error"));
    const response = await POST(request(), context);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database error");
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("returns the durable per-account Canary capacity limit", async () => {
    mockCreateCapacity.mockRejectedValueOnce(
      new HetznerCloudCapacityError("canary_capacity_limit" as never),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "canary_capacity_limit",
    }));
  });

  it("requires the exact spending-confirmation value", async () => {
    const response = await POST(request(JSON.stringify({
      ...body,
      spendingConfirmation: "yes",
    })), context);
    expect(response.status).toBe(400);
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });

  it("fails closed for missing origin, wrong content type, and chunked oversized body", async () => {
    const missingOrigin = request();
    missingOrigin.headers.delete("origin");
    expect((await POST(missingOrigin, context)).status).toBe(403);

    expect((await POST(request(JSON.stringify(body), {
      "content-type": "application/json; charset=utf-8",
    }), context)).status).toBe(415);

    const oversized = request(JSON.stringify({ padding: "x".repeat(5_000) }));
    oversized.headers.delete("content-length");
    expect((await POST(oversized, context)).status).toBe(413);
    expect(mockCreateCapacity).not.toHaveBeenCalled();
  });
});
