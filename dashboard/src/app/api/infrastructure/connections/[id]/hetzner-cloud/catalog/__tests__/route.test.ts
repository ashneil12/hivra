import type { NextRequest } from "next/server";

const mockGetCatalog = jest.fn();
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
  getHetznerCloudOfferCatalog: (...args: unknown[]) => mockGetCatalog(...args),
}));

import { auth } from "@clerk/nextjs/server";
import { GET } from "../route";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id: CONNECTION_ID }) };
const request = new Request("http://localhost/catalog") as NextRequest;

describe("Hetzner Cloud offer catalog route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    mockGetCatalog.mockResolvedValue({ fetchedAt: "2026-08-26T15:00:00.000Z" });
    mockRateLimit.mockReturnValue(null);
  });

  it("loads the live project catalog under owner and rate-limit boundaries", async () => {
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockGetCatalog).toHaveBeenCalledWith("user_a", CONNECTION_ID);
    expect(mockRateLimit).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        routeKey: "hetzner_cloud_offer_catalog",
        userId: "user_a",
      }),
    );
  });

  it("does not call the provider for unauthenticated requests", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    const response = await GET(request, context);
    expect(response.status).toBe(401);
    expect(mockGetCatalog).not.toHaveBeenCalled();
  });
});
