import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { GET } from "../route";
import { loadHetznerCloudCapacitySlot } from "@/lib/infrastructure/hetzner-cloud-store";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

jest.mock("server-only", () => ({}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/infrastructure/hetzner-cloud-store", () => ({ loadHetznerCloudCapacitySlot: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn(() => null) }));

const url = "https://hivra.test/api/infrastructure/hetzner-cloud/capacity-slot";

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "owner" });
  (loadHetznerCloudCapacitySlot as jest.Mock).mockResolvedValue({ held: true, serverName: "hivra-a1b2c3d4", connectionId: null, status: "created_off" });
});

it("reports the owner's slot without caching", async () => {
  const response = await GET(new NextRequest(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(loadHetznerCloudCapacitySlot).toHaveBeenCalledWith("owner");
  expect((await response.json()).data.slot).toMatchObject({ held: true, serverName: "hivra-a1b2c3d4" });
});

it("requires a signed-in owner and honours the rate limit", async () => {
  (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
  expect((await GET(new NextRequest(url))).status).toBe(401);
  (enforceAuthenticatedRouteRateLimit as jest.Mock).mockReturnValueOnce(new Response(null, { status: 429 }));
  expect((await GET(new NextRequest(url))).status).toBe(429);
  expect(loadHetznerCloudCapacitySlot).not.toHaveBeenCalled();
});

it("fails without claiming the slot is free", async () => {
  (loadHetznerCloudCapacitySlot as jest.Mock).mockRejectedValueOnce(new Error("db"));
  const response = await GET(new NextRequest(url));
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("\"held\":false");
});
