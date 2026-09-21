import { NextRequest } from "next/server";

const mockInspect = jest.fn();

jest.mock("@/lib/remote-computers/capability-inspection", () => ({
  inspectRemoteDesktopCapability: (...args: unknown[]) => mockInspect(...args),
}));

import { POST } from "../route";

const ORIGINAL_ENV = process.env;
const AGENT_ID = "00000000-0000-4000-8000-000000001041";

function request(body: unknown, token = "expected-secret") {
  return new NextRequest("http://localhost/api/ops/hivra/remote-desktop-capability", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ops/hivra/remote-desktop-capability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "expected-secret" };
    mockInspect.mockResolvedValue({
      ok: true,
      agentId: AGENT_ID,
      targetId: "fixturenode11",
      vmid: 1112,
      receipt: { observedRevision: "a".repeat(64) },
    });
  });

  afterAll(() => { process.env = ORIGINAL_ENV; });

  it("fails closed without the operator secret", async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(request({ agentId: AGENT_ID }))).status).toBe(500);
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it("rejects unauthorized callers and non-explicit ids", async () => {
    expect((await POST(request({ agentId: AGENT_ID }, "wrong"))).status).toBe(401);
    expect((await POST(request({ agentId: "latest" }))).status).toBe(400);
    expect(mockInspect).not.toHaveBeenCalled();
  });

  it("inspects only one explicit agent and returns safe evidence", async () => {
    const response = await POST(request({ agentId: AGENT_ID }));
    expect(response.status).toBe(200);
    expect(mockInspect).toHaveBeenCalledWith(AGENT_ID);
    expect((await response.json()).data).toMatchObject({ ok: true, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112 });
  });

  it("maps failed proof to unavailable without exposing host output", async () => {
    mockInspect.mockResolvedValue({ ok: false, agentId: AGENT_ID, targetId: "fixturenode11", vmid: 1112, error: "Remote desktop capability could not be verified." });
    const response = await POST(request({ agentId: AGENT_ID }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "Remote desktop capability could not be verified." });
  });
});
