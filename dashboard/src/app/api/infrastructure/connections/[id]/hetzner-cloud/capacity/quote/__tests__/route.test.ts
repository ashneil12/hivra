import { NextRequest } from "next/server";

const mockQuoteCapacity = jest.fn();
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
}));
jest.mock("@/lib/infrastructure/hetzner-cloud", () => ({
  HetznerCloudCapacityError: class HetznerCloudCapacityError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  quoteHetznerCloudCapacity: (...args: unknown[]) => mockQuoteCapacity(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { InfrastructureConnectionStoreError } from "@/lib/infrastructure/connection-store";
import { HetznerCloudCapacityError } from "@/lib/infrastructure/hetzner-cloud";
import { POST } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: CONNECTION_ID }) };
const body = { serverTypeId: 104, locationId: 1, imageId: 100 };

function request(input: {
  body?: string;
  origin?: string | null;
  fetchSite?: string | null;
  contentType?: string | null;
} = {}): NextRequest {
  const headers = new Headers();
  if (input.origin !== null) headers.set("origin", input.origin ?? "https://hivra.test");
  if (input.fetchSite !== null) headers.set("sec-fetch-site", input.fetchSite ?? "same-origin");
  if (input.contentType !== null) {
    headers.set("content-type", input.contentType ?? "application/json");
  }
  return new NextRequest(
    `https://hivra.test/api/infrastructure/connections/${CONNECTION_ID}/hetzner-cloud/capacity/quote`,
    { method: "POST", headers, body: input.body ?? JSON.stringify(body) },
  );
}

describe("Hetzner Cloud capacity quote route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockRateLimit.mockReturnValue(null);
    mockQuoteCapacity.mockResolvedValue({ id: "quote" });
  });

  it("authenticates, enforces same-origin JSON, and scopes the quote to the owner", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mockQuoteCapacity).toHaveBeenCalledWith("user_a", CONNECTION_ID, body);
  });

  it("rejects unauthenticated callers before reading the body", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    expect((await POST(request({ origin: null }), context)).status).toBe(401);
    expect(mockQuoteCapacity).not.toHaveBeenCalled();
  });

  it.each([
    ["missing origin", { origin: null }],
    ["cross origin", { origin: "https://attacker.test" }],
    ["missing fetch metadata", { fetchSite: null }],
  ])("rejects %s", async (_label, options) => {
    expect((await POST(request(options), context)).status).toBe(403);
    expect(mockQuoteCapacity).not.toHaveBeenCalled();
  });

  it("requires the exact JSON media type", async () => {
    expect((await POST(request({ contentType: "text/plain" }), context)).status).toBe(415);
    expect(mockQuoteCapacity).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even without Content-Length", async () => {
    const oversized = request({ body: JSON.stringify({ padding: "x".repeat(5_000) }) });
    oversized.headers.delete("content-length");
    expect((await POST(oversized, context)).status).toBe(413);
    expect(mockQuoteCapacity).not.toHaveBeenCalled();
  });

  it("does not leak a cross-owner connection", async () => {
    mockQuoteCapacity.mockRejectedValueOnce(
      new InfrastructureConnectionStoreError("not_found" as never),
    );
    expect((await POST(request(), context)).status).toBe(404);
  });

  it("returns a stable reconnect code for a legacy unbound token", async () => {
    mockQuoteCapacity.mockRejectedValueOnce(
      new HetznerCloudCapacityError("credential_reconnect_required" as never),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "credential_reconnect_required",
      error: expect.stringContaining("Disconnect and reconnect"),
    }));
  });

  it("returns a stable durable owner quote-limit code", async () => {
    mockQuoteCapacity.mockRejectedValueOnce(
      new HetznerCloudCapacityError("quote_rate_limited" as never),
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      code: "quote_rate_limited",
      error: expect.stringContaining("five active capacity quotes"),
    }));
  });
});
