/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: jest.fn() }));
jest.mock("@/lib/local-bridge/flag", () => ({ isLocalBridgeEnabled: jest.fn() }));
jest.mock("@/lib/hivra/after-response", () => ({ runAfterResponse: jest.fn() }));
jest.mock("@/lib/agent-links/store", () => ({ findAgentByKey: jest.fn(), loadOwnedRow: jest.fn() }));
jest.mock("@/lib/local-bridge/store", () => ({ loadComputers: jest.fn(async () => []) }));
jest.mock("@/lib/local-bridge/service", () => ({
  LIMITS: { timeoutMax: 120, outputMax: 1048576, argLength: 4096, argvItems: 64 },
  submitRequest: jest.fn(), readRequestForAgent: jest.fn(), dispatchRequest: jest.fn(),
  publicRequest: (row: { id: string; status: string }) => ({ id: row.id, status: row.status }),
}));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown, status = 200) => Response.json({ success: true, data }, { status }),
  apiError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));

import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";
import { runAfterResponse } from "@/lib/hivra/after-response";
import { findAgentByKey, loadOwnedRow } from "@/lib/agent-links/store";
import { readRequestForAgent, submitRequest } from "@/lib/local-bridge/service";
import { GET, POST } from "../route";

const OWNER = "user_owner";
const AGENT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: OWNER };
const COMPUTER = "11111111-1111-4111-8111-111111111111";
const KEY = `hvl_${"e".repeat(64)}`;

function request(method: "GET" | "POST", body?: unknown, key: string | null = KEY, query = "") {
  return new NextRequest(`https://canary.hermesos.cloud/api/agent-bridge${query}`, {
    method, headers: { host: "canary.hermesos.cloud", "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isHivraApiAllowed).mockReturnValue(true);
  jest.mocked(isLocalBridgeEnabled).mockReturnValue(true);
  jest.mocked(findAgentByKey).mockResolvedValue({ agentId: AGENT.id, userId: OWNER });
  jest.mocked(loadOwnedRow).mockResolvedValue(AGENT as never);
});

describe("/api/agent-bridge", () => {
  it("is 404 while the flag is off, before any key lookup", async () => {
    jest.mocked(isLocalBridgeEnabled).mockReturnValue(false);
    expect((await GET(request("GET"))).status).toBe(404);
    expect((await POST(request("POST", { computer: COMPUTER, argv: ["uname"] }))).status).toBe(404);
    expect(findAgentByKey).not.toHaveBeenCalled();
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it("refuses a missing or unknown key", async () => {
    expect((await POST(request("POST", { computer: COMPUTER, argv: ["uname"] }, null))).status).toBe(401);
    jest.mocked(findAgentByKey).mockResolvedValue(null);
    expect((await POST(request("POST", { computer: COMPUTER, argv: ["uname"] }))).status).toBe(401);
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it("files a pending request and does not dispatch it", async () => {
    jest.mocked(submitRequest).mockResolvedValue({ ok: true, value: { request: { id: "r1", status: "pending" } as never, dispatchNow: false } });
    const response = await POST(request("POST", { computer: COMPUTER, argv: ["uname", "-s"] }));
    expect(response.status).toBe(202);
    expect(submitRequest).toHaveBeenCalledWith(OWNER, AGENT.id, COMPUTER, expect.objectContaining({ argv: ["uname", "-s"] }));
    expect(runAfterResponse).not.toHaveBeenCalled();
  });

  it("dispatches only when the service says an allowance already approved it", async () => {
    jest.mocked(submitRequest).mockResolvedValue({ ok: true, value: { request: { id: "r1", status: "approved" } as never, dispatchNow: true } });
    await POST(request("POST", { computer: COMPUTER, argv: ["uname"] }));
    expect(runAfterResponse).toHaveBeenCalledTimes(1);
  });

  it("says plainly when the bridge is off", async () => {
    jest.mocked(submitRequest).mockResolvedValue({ ok: false, status: 409, message: "The bridge on your computer is off." });
    const response = await POST(request("POST", { computer: COMPUTER, argv: ["uname"] }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("The bridge on your computer is off.");
  });

  it("rejects a shell string, extra fields and out-of-range limits", async () => {
    for (const body of [
      { computer: COMPUTER, argv: "uname -s" },
      { computer: COMPUTER, argv: [] },
      { computer: COMPUTER, argv: ["a\0b"] },
      { computer: COMPUTER, argv: ["uname"], shell: true },
      { computer: COMPUTER, argv: ["uname"], timeoutSeconds: 121 },
      { computer: COMPUTER, argv: ["uname"], maxOutputBytes: 1048577 },
      { computer: "not-a-uuid", argv: ["uname"] },
    ]) {
      expect((await POST(request("POST", body))).status).toBe(400);
    }
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it("polls only this agent's own request", async () => {
    jest.mocked(readRequestForAgent).mockResolvedValue({ ok: false, status: 404, message: "That request was not found." });
    expect((await GET(request("GET", undefined, KEY, "?id=22222222-2222-4222-8222-222222222222"))).status).toBe(404);
    jest.mocked(readRequestForAgent).mockResolvedValue({ ok: true, value: { id: "r1", status: "done" } as never });
    const response = await GET(request("GET", undefined, KEY, "?id=22222222-2222-4222-8222-222222222222"));
    expect((await response.json()).data.request.status).toBe("done");
    expect(readRequestForAgent).toHaveBeenLastCalledWith(OWNER, AGENT.id, "22222222-2222-4222-8222-222222222222");
  });
});
