/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/local-bridge/flag", () => ({ isLocalBridgeEnabled: jest.fn() }));
jest.mock("@/lib/hivra/after-response", () => ({ runAfterResponse: jest.fn() }));
jest.mock("@/lib/authenticated-rate-limit", () => ({ enforceAuthenticatedRouteRateLimit: jest.fn(() => null) }));
jest.mock("@/app/api/infrastructure/connections/request-security", () => ({
  hasStrictJsonContentType: () => true,
  isSameOriginMutationRequest: jest.fn(() => true),
  readBoundedJson: async (req: Request) => ({ ok: true, body: await req.json() }),
}));
jest.mock("@/app/api/hivra/managed-sessions/route-support", () => ({ noStore: (response: Response) => response }));
jest.mock("@/lib/agent-links/store", () => ({ loadOwnedRows: jest.fn(async () => [{ id: "a1", name: "Claude" }]) }));
jest.mock("@/lib/agent-links/kit-delivery", () => ({
  agentLinkEndpoint: (origin: string) => `${origin}/api/agent-link`, resyncOwnerKitsForBridge: jest.fn(async () => undefined),
}));
jest.mock("@/lib/local-bridge/store", () => ({
  loadComputers: jest.fn(async () => []), listRequests: jest.fn(async () => []), listAllowances: jest.fn(async () => []),
  purgeOldResults: jest.fn(async () => undefined),
}));
jest.mock("@/lib/local-bridge/service", () => ({
  allowanceActive: () => true, publicRequest: (row: unknown) => row, withoutOldResult: (row: unknown) => row,
  expireStale: async (rows: unknown[]) => rows, readResultForOwner: jest.fn(),
  decideRequest: jest.fn(), dispatchRequest: jest.fn(), enrollComputer: jest.fn(), revokeAllowance: jest.fn(), revokeComputer: jest.fn(),
}));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { auth } from "@clerk/nextjs/server";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { resyncOwnerKitsForBridge } from "@/lib/agent-links/kit-delivery";
import { decideRequest, enrollComputer, readResultForOwner, revokeComputer } from "@/lib/local-bridge/service";
import { purgeOldResults } from "@/lib/local-bridge/store";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { GET, POST } from "../route";

const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

function post(body: unknown) {
  return new NextRequest("https://canary.hermesos.cloud/api/hivra/bridge", {
    method: "POST", headers: { host: "canary.hermesos.cloud", "content-type": "application/json", origin: "https://canary.hermesos.cloud" }, body: JSON.stringify(body),
  });
}
const get = () => new NextRequest("https://canary.hermesos.cloud/api/hivra/bridge", { headers: { host: "canary.hermesos.cloud" } });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isLocalBridgeEnabled).mockReturnValue(true);
  jest.mocked(isSameOriginMutationRequest).mockReturnValue(true);
  jest.mocked(auth).mockResolvedValue({ userId: "user_owner" } as never);
});

describe("/api/hivra/bridge", () => {
  it("is 404 with the flag off", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await GET(get())).status).toBe(404);
    expect((await POST(post({ action: "decide", requestId: REQUEST_ID, decision: "approve" }))).status).toBe(404);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it("reads clear old output, then lists computers, agents and requests", async () => {
    const response = await GET(get());
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.agents).toEqual([{ id: "a1", name: "Claude" }]);
    expect(purgeOldResults).toHaveBeenCalledWith("user_owner");
  });

  it("serves one request's output on demand, only to its owner", async () => {
    jest.mocked(readResultForOwner).mockResolvedValue({ ok: false, status: 404, message: "That request was not found." });
    const other = new NextRequest(`https://canary.hermesos.cloud/api/hivra/bridge?request=${REQUEST_ID}`, { headers: { host: "canary.hermesos.cloud" } });
    expect((await GET(other)).status).toBe(404);
    expect(readResultForOwner).toHaveBeenCalledWith("user_owner", REQUEST_ID);
    jest.mocked(readResultForOwner).mockResolvedValue({ ok: true, value: { result: { stdout: "Darwin\n" } } });
    const response = await GET(other);
    expect((await response.json()).data.result.stdout).toBe("Darwin\n");
  });

  it("needs a signed-in owner and a same-origin request", async () => {
    jest.mocked(auth).mockResolvedValue({ userId: null } as never);
    expect((await POST(post({ action: "revoke", computerId: REQUEST_ID }))).status).toBe(401);
    jest.mocked(auth).mockResolvedValue({ userId: "user_owner" } as never);
    jest.mocked(isSameOriginMutationRequest).mockReturnValue(false);
    expect((await POST(post({ action: "revoke", computerId: REQUEST_ID }))).status).toBe(403);
    expect(revokeComputer).not.toHaveBeenCalled();
  });

  it("approval passes the signed-in owner, so another owner's request is a 404", async () => {
    jest.mocked(decideRequest).mockResolvedValue({ ok: false, status: 404, message: "That request was not found." });
    const response = await POST(post({ action: "decide", requestId: REQUEST_ID, decision: "approve" }));
    expect(response.status).toBe(404);
    expect(decideRequest).toHaveBeenCalledWith("user_owner", REQUEST_ID, "approve");
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  it("dispatches only after an approval and not after a denial", async () => {
    jest.mocked(decideRequest).mockResolvedValue({ ok: true, value: { request: { id: REQUEST_ID } as never, dispatchNow: false } });
    await POST(post({ action: "decide", requestId: REQUEST_ID, decision: "deny" }));
    expect(runAfterResponse).not.toHaveBeenCalled();
    jest.mocked(decideRequest).mockResolvedValue({ ok: true, value: { request: { id: REQUEST_ID } as never, dispatchNow: true } });
    await POST(post({ action: "decide", requestId: REQUEST_ID, decision: "allow_hour" }));
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
  });

  it("set up returns the one command and its expiry, never the settings", async () => {
    jest.mocked(enrollComputer).mockResolvedValue({
      ok: true, value: { computer: { id: "c1", label: "Mac" } as never, command: "curl -fsSL https://x.test/api/hivra/bridge/install | bash -s -- hvb_x", expiresAt: "2026-11-12T10:15:00Z" },
    } as never);
    const response = await POST(post({ action: "enroll", label: "Mac" }));
    const data = (await response.json()).data;
    expect(data).toEqual({ computer: { id: "c1", name: "Mac" }, command: expect.stringContaining("hvb_"), expiresAt: "2026-11-12T10:15:00Z" });
    expect(JSON.stringify(data)).not.toMatch(/bridgeKey|secret|config/);
  });

  it("re-syncs every agent's kit after an enroll and after a revoke", async () => {
    jest.mocked(enrollComputer).mockResolvedValue({ ok: true, value: { computer: { id: REQUEST_ID, label: "Mac" } as never, command: "x", expiresAt: "2026-11-12T10:15:00Z" } });
    jest.mocked(revokeComputer).mockResolvedValue({ ok: true, value: { generation: 2 } });
    for (const body of [{ action: "enroll", label: "Mac" }, { action: "revoke", computerId: REQUEST_ID }]) {
      jest.mocked(runAfterResponse).mockClear();
      jest.mocked(resyncOwnerKitsForBridge).mockClear();
      expect((await POST(post(body))).status).toBe(200);
      expect(runAfterResponse).toHaveBeenCalledTimes(1);
      await jest.mocked(runAfterResponse).mock.calls[0][0]();
      expect(resyncOwnerKitsForBridge).toHaveBeenCalledWith("user_owner", "https://canary.hermesos.cloud/api/agent-link");
    }
  });

  it("has no allow-forever decision", async () => {
    expect((await POST(post({ action: "decide", requestId: REQUEST_ID, decision: "allow_forever" }))).status).toBe(400);
    expect(decideRequest).not.toHaveBeenCalled();
  });
});
