/** @jest-environment node */
import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockHandle = jest.fn();
jest.mock("@/lib/hivra/channel-wake/adapters/matrix-notify", () => ({ handleMatrixNotify: (...a: unknown[]) => mockHandle(...a) }));
const mockEnsure = jest.fn();
jest.mock("@/lib/hivra/agent-wake", () => ({ ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a) }));
const mockAfter = jest.fn();
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (fn: () => unknown) => mockAfter(fn) }));

import { GET, POST } from "../route";
import nextConfig from "../../../../../../../next.config";

const URL_ = "https://app.example.test/_matrix/push/v1/notify";
const post = (body: string) => new NextRequest(URL_, { method: "POST", headers: { "content-type": "application/json" }, body });

beforeEach(() => {
  mockHandle.mockReset();
  mockEnsure.mockReset();
  mockAfter.mockReset();
});

describe("Matrix push gateway route", () => {
  it("is reached from the fixed push gateway path", async () => {
    const rewrites = await nextConfig.rewrites!();
    const list = Array.isArray(rewrites) ? rewrites : [...(rewrites.beforeFiles ?? []), ...(rewrites.afterFiles ?? []), ...(rewrites.fallback ?? [])];
    expect(list).toContainEqual({ source: "/_matrix/push/v1/notify", destination: "/api/webhooks/channel-wake/matrix" });
  });

  it("answers 200 with the rejected pushkeys and wakes after the answer", async () => {
    mockHandle.mockImplementation(async (_body: unknown, deps: { wake: (id: string) => void }) => {
      deps.wake("agent-1");
      return { status: 200, rejected: ["k"], woke: ["agent-1"], deferred: [] };
    });
    const res = await POST(post(JSON.stringify({ notification: { devices: [] } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rejected: ["k"] });
    expect(mockHandle.mock.calls[0][0]).toEqual({ notification: { devices: [] } });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    await mockAfter.mock.calls[0][0]();
    expect(mockEnsure).toHaveBeenCalledWith("agent-1", expect.objectContaining({ trigger: "channel" }));
  });

  it("maps 401, 404 and 400, and passes a non-JSON body as null", async () => {
    mockHandle.mockResolvedValueOnce({ status: 401 });
    expect((await POST(post("{}"))).status).toBe(401);
    mockHandle.mockResolvedValueOnce({ status: 404 });
    const dark = await POST(post("{}"));
    expect(dark.status).toBe(404);
    expect(await dark.json()).toMatchObject({ errcode: "M_UNRECOGNIZED" });
    mockHandle.mockResolvedValueOnce({ status: 400 });
    expect((await POST(post("not json"))).status).toBe(400);
    expect(mockHandle.mock.calls[2][0]).toBeNull();
  });

  it("passes a body over 64 KB as null", async () => {
    mockHandle.mockResolvedValueOnce({ status: 400 });
    await POST(post(JSON.stringify({ pad: "x".repeat(70 * 1024) })));
    expect(mockHandle.mock.calls[0][0]).toBeNull();
  });

  it("is dark to GET without the secret", async () => {
    const saved = process.env.HIVRA_CHANNEL_WAKE_SECRET;
    delete process.env.HIVRA_CHANNEL_WAKE_SECRET;
    expect((await GET()).status).toBe(404);
    if (saved !== undefined) process.env.HIVRA_CHANNEL_WAKE_SECRET = saved;
  });
});
