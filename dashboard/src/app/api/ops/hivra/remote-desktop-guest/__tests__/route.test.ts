import { NextRequest } from "next/server";

const mockInstall = jest.fn();
const mockRestart = jest.fn();
const mockDiagnose = jest.fn();

jest.mock("@/lib/remote-computers/guest-installation", () => ({
  diagnoseRemoteDesktopGuestTransport: (...args: unknown[]) => mockDiagnose(...args),
  installRemoteDesktopOnHivraAgent: (...args: unknown[]) => mockInstall(...args),
  verifyRemoteDesktopRestartOnHivraAgent: (...args: unknown[]) => mockRestart(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { POST } from "../route";

const ORIGINAL_ENV = process.env;
const AGENT_ID = "00000000-0000-4000-8000-000000001041";
const CONTROL_BYPASS_SECRET = "canary_control_bypass_1234567890";

function request(body: unknown, token = "expected-secret") {
  return new NextRequest("http://localhost/api/ops/hivra/remote-desktop-guest", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ops/hivra/remote-desktop-guest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      CRON_SECRET: "expected-secret",
      NEXT_PUBLIC_APP_URL: "https://canary.hermesos.cloud",
      VERCEL_AUTOMATION_BYPASS_SECRET: CONTROL_BYPASS_SECRET,
      VERCEL_TARGET_ENV: "canary",
      HIVRA_MANAGED_PROVISIONER_CHANNEL: undefined,
    };
    mockInstall.mockResolvedValue({ ok: true, agentId: AGENT_ID, targetId: "fixturenode12", vmid: 1201 });
    mockRestart.mockResolvedValue({ ok: true, agentId: AGENT_ID, targetId: "fixturenode12", vmid: 1201 });
    mockDiagnose.mockResolvedValue({ ok: true, agentId: AGENT_ID, targetId: "fixturenode12", vmid: 1201, probes: [] });
  });

  afterAll(() => { process.env = ORIGINAL_ENV; });

  it("fails closed without operator authority", async () => {
    expect((await POST(request({ action: "install", agentId: AGENT_ID }, "wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await POST(request({ action: "install", agentId: AGENT_ID }))).status).toBe(500);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("rejects ambiguous actions and agent ids before guest access", async () => {
    expect((await POST(request({ action: "latest", agentId: AGENT_ID }))).status).toBe(400);
    expect((await POST(request({ action: "install", agentId: "latest" }))).status).toBe(400);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockDiagnose).not.toHaveBeenCalled();
  });

  it("pauses Canary installation before any guest mutation", async () => {
    const response = await POST(request({ action: "install", agentId: AGENT_ID }));
    expect(response.status).toBe(409);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockDiagnose).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining("temporarily paused on Canary") });
  });

  it("retains the installation hold in the dedicated Canary production slot", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    expect((await POST(request({ action: "install", agentId: AGENT_ID }))).status).toBe(409);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("fails closed before guest access with contradictory channel configuration", async () => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "default";
    expect((await POST(request({ action: "install", agentId: AGENT_ID }))).status).toBe(503);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
    expect(mockDiagnose).not.toHaveBeenCalled();
  });

  it("keeps the control-plane bypass optional for an unprotected deployment", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    const response = await POST(request({ action: "install", agentId: AGENT_ID }));
    expect(response.status).toBe(200);
    expect(mockInstall).toHaveBeenCalledWith(AGENT_ID, "https://canary.hermesos.cloud", {}, {
      controlBypassSecret: undefined,
      controlBypassRequired: false,
    });
  });

  it("restarts only the explicit bound agent", async () => {
    const response = await POST(request({ action: "restart", agentId: AGENT_ID }));
    expect(response.status).toBe(200);
    expect(mockRestart).toHaveBeenCalledWith(AGENT_ID);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("runs the bounded transport diagnostic only for the explicit bound agent", async () => {
    const response = await POST(request({ action: "diagnose", agentId: AGENT_ID }));
    expect(response.status).toBe(200);
    expect(mockDiagnose).toHaveBeenCalledWith(AGENT_ID);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it("returns the bounded service receipt on unavailable infrastructure", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    mockInstall.mockResolvedValue({
      ok: false,
      agentId: AGENT_ID,
      targetId: "fixturenode12",
      vmid: 1201,
      error: "The managed host runtime could not be prepared.",
    });
    const response = await POST(request({ action: "install", agentId: AGENT_ID }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "The managed host runtime could not be prepared.",
      data: { ok: false, agentId: AGENT_ID, targetId: "fixturenode12", vmid: 1201 },
    });
  });
});
