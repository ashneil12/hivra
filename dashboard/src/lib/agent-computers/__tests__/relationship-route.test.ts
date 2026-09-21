/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn() }));
jest.mock("@/lib/agent-computers/relationship-reader", () => ({ createCanonicalRelationshipReader: jest.fn() }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => Response.json({ success: true, data }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { auth } from "@clerk/nextjs/server";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { createCanonicalRelationshipReader } from "@/lib/agent-computers/relationship-reader";
import { GET } from "@/app/api/hivra/computers/[id]/relationships/route";

const id = "11111111-1111-4111-8111-111111111111";
const read = jest.fn();
const request = () => new NextRequest(`https://canary.hermesos.cloud/api/hivra/computers/${id}/relationships?ownerId=attacker`, {
  headers: { host: "canary.hermesos.cloud", "x-user-id": "attacker" },
});
const invoke = (computerId = id) => GET(request(), { params: Promise.resolve({ id: computerId }) });

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: "authenticated-owner" } as Awaited<ReturnType<typeof auth>>);
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(null);
  jest.mocked(createCanonicalRelationshipReader).mockReturnValue({ read });
});

it("uses only the authenticated owner and canonical computer ID, with no caching", async () => {
  read.mockResolvedValue({ computerId: id, bindings: [] });
  const response = await invoke();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).toHaveBeenCalledWith("authenticated-owner", id);
  expect(enforceAuthenticatedRouteRateLimit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "authenticated-owner" }));
  expect(await response.json()).toEqual({ success: true, data: { computerId: id, bindings: [] } });
});

it("rejects disabled surfaces and unauthenticated requests before storage", async () => {
  jest.mocked(isHivraApiAllowed).mockReturnValue(false);
  expect((await invoke()).status).toBe(404);
  expect(auth).not.toHaveBeenCalled();
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(auth).mockResolvedValue({ userId: null } as Awaited<ReturnType<typeof auth>>);
  const response = await invoke();
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(createCanonicalRelationshipReader).not.toHaveBeenCalled();
});

it("rejects legacy aliases and malformed IDs rather than widening the lookup", async () => {
  for (const invalid of [`x-${id}`, `h-${id}`, "../other", ""]) expect((await invoke(invalid)).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it("honors rate limiting before storage", async () => {
  jest.mocked(enforceAuthenticatedRouteRateLimit).mockReturnValue(Response.json({}, { status: 429 }) as never);
  const response = await invoke();
  expect(response.status).toBe(429);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(read).not.toHaveBeenCalled();
});

it("distinguishes missing or foreign computers from unavailable storage without leaking diagnostics", async () => {
  read.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("private database details"));
  const missing = await invoke();
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const failed = await invoke();
  expect(failed.status).toBe(503);
  expect(failed.headers.get("cache-control")).toBe("no-store");
  expect(await failed.text()).not.toContain("private database details");
});
