import { NextRequest } from "next/server";

const mockForceForget = jest.fn();
const mockRateLimit = jest.fn<Response | null, [Request, Record<string, unknown>]>(() => null);

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
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
  forceForgetHetznerCloudConnection: (...args: unknown[]) => mockForceForget(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION } from "@/lib/infrastructure/contracts";
import { POST } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: CONNECTION_ID }) };
const body = { confirmation: HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION };

function request(rawBody = JSON.stringify(body), headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `https://hivra.test/api/infrastructure/connections/${CONNECTION_ID}/hetzner-cloud/capacity/force-forget`,
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

describe("Hetzner Cloud capacity force-forget route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockForceForget.mockResolvedValue(undefined);
  });

  it("wipes only Hivra access and reports that provider cleanup did not happen", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(mockForceForget).toHaveBeenCalledWith("user_a", CONNECTION_ID);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: true,
      data: {
        connectionDeleted: true,
        localCredentialsWiped: true,
        providerCleanupPerformed: false,
        canarySlotHeld: true,
      },
    }));
  });

  it("requires authentication before reading the body", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const untrusted = request(JSON.stringify({ padding: "x".repeat(5_000) }));
    untrusted.headers.delete("origin");
    untrusted.headers.delete("content-length");

    expect((await POST(untrusted, context)).status).toBe(401);
    expect(mockForceForget).not.toHaveBeenCalled();
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
    expect(mockForceForget).not.toHaveBeenCalled();
  });

  it("requires strict JSON, a bounded body, and the exact typed confirmation", async () => {
    expect((await POST(request(JSON.stringify(body), {
      "content-type": "text/plain",
    }), context)).status).toBe(415);

    const oversized = request(JSON.stringify({ padding: "x".repeat(5_000) }));
    oversized.headers.delete("content-length");
    expect((await POST(oversized, context)).status).toBe(413);

    expect((await POST(request(JSON.stringify({ confirmation: "forget" })), context)).status)
      .toBe(400);
    expect(mockForceForget).not.toHaveBeenCalled();
  });

  it.each([
    ["capacity_busy", "capacity_busy"],
    ["force_forget_not_available", "force_forget_not_available"],
  ] as const)("returns the stable %s boundary", async (storeCode, publicCode) => {
    mockForceForget.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError(storeCode),
    );

    const response = await POST(request(), context);
    const responseBody = await response.json();

    expect(response.status).toBe(409);
    expect(responseBody.code).toBe(publicCode);
  });

  it("does not disclose a cross-owner connection", async () => {
    mockForceForget.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("not_found"),
    );
    expect((await POST(request(), context)).status).toBe(404);
  });

  it("uses the strict destructive-operation rate limit", async () => {
    await POST(request(), context);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.any(NextRequest),
      expect.objectContaining({ limit: 2, windowMs: 600_000 }),
    );
  });
});
