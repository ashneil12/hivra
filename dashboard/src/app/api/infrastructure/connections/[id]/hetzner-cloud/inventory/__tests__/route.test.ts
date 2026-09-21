import { NextRequest } from "next/server";

const mockGetInventory = jest.fn();
const mockRefreshInventory = jest.fn();
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
  HetznerCloudConnectionError: class HetznerCloudConnectionError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  getHetznerCloudInventory: (...args: unknown[]) => mockGetInventory(...args),
  refreshHetznerCloudInventory: (...args: unknown[]) => mockRefreshInventory(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { HetznerCloudConnectionError } from "@/lib/infrastructure/hetzner-cloud";
import { GET, POST } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: CONNECTION_ID }) };
function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://hivra.test/inventory", {
    method: "POST",
    headers: {
      origin: "https://hivra.test",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

describe("Hetzner Cloud inventory route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetInventory.mockResolvedValue([]);
    mockRefreshInventory.mockResolvedValue([]);
    mockRateLimit.mockReturnValue(null);
  });

  it("reads only the authenticated owner's persisted inventory", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockGetInventory).toHaveBeenCalledWith("user_a", CONNECTION_ID);
  });

  it("rate-limits provider refresh and scopes it to the authenticated owner", async () => {
    const mutationRequest = request();
    const response = await POST(mutationRequest, context);
    expect(response.status).toBe(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      mutationRequest,
      expect.objectContaining({
        routeKey: "hetzner_cloud_inventory_refresh",
        userId: "user_a",
      }),
    );
    expect(mockRefreshInventory).toHaveBeenCalledWith("user_a", CONNECTION_ID);
  });

  it("does not expose inventory to an unauthenticated caller", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const response = await GET(request(), context);
    expect(response.status).toBe(401);
    expect(mockGetInventory).not.toHaveBeenCalled();
  });

  it("returns the sanitized provider observation code to the owner", async () => {
    mockRefreshInventory.mockRejectedValueOnce(
      new HetznerCloudConnectionError("invalid_credentials" as never),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      success: false,
      code: "invalid_credentials",
    }));
  });

  it("rejects cross-origin inventory refresh before contacting the provider", async () => {
    const response = await POST(request({ origin: "https://attacker.test" }), context);
    expect(response.status).toBe(403);
    expect(mockRefreshInventory).not.toHaveBeenCalled();
  });
});
