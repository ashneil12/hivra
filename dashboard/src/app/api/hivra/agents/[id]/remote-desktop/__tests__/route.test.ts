import { NextRequest } from "next/server";

import { POST } from "../route";

const mockAuth = jest.fn();
const mockFrom = jest.fn();
const mockInstall = jest.fn();
const mockPrepareOmarchy = jest.fn();
const mockPrepareWindows = jest.fn();
const mockInspect = jest.fn();
const mockRateLimit = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  getIP: () => "127.0.0.1",
}));
jest.mock("@/lib/remote-computers/guest-installation", () => ({
  installRemoteDesktopOnHivraAgent: (...args: unknown[]) => mockInstall(...args),
}));
jest.mock("@/lib/remote-computers/omarchy-native-preparation", () => ({
  prepareOmarchyNativeOnHivraAgent: (...args: unknown[]) => mockPrepareOmarchy(...args),
}));
jest.mock("@/lib/remote-computers/windows-rdp-preparation", () => ({
  prepareWindowsRdpOnHivraAgent: (...args: unknown[]) => mockPrepareWindows(...args),
}));
jest.mock("@/lib/remote-computers/capability-inspection", () => ({
  inspectRemoteDesktopCapability: (...args: unknown[]) => mockInspect(...args),
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const ID = "00000000-0000-4000-8000-000000001022";
const CONTROL_BYPASS_SECRET = "canary_control_bypass_1234567890";
const params = { params: Promise.resolve({ id: ID }) };
let agent: Record<string, unknown> | null;

function request(body: unknown = { action: "prepare" }, headers: Record<string, string> = {}) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/remote-desktop`, {
    method: "POST",
    headers: {
      host: "canary.hermesos.cloud",
      origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hivra/agents/[id]/remote-desktop", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hermesos.cloud";
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = CONTROL_BYPASS_SECRET;
    process.env.VERCEL_TARGET_ENV = "canary";
    delete process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL;
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockRateLimit.mockReturnValue({ success: true });
    agent = {
      id: ID,
      user_id: "user-1",
      type: "linux-desktop",
      computer_profile: "ubuntu-desktop",
      status: "running",
      desired_state: "running",
      operation_id: null,
      operation_kind: null,
      vmid: 1112,
      ip: "10.250.20.62",
      chat_url: "https://box.example.test",
      computer_substrate: "proxmox-kvm",
      deployment_mode: "hivra-managed",
      infrastructure_binding_token_enforced: true,
    };
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(async () => ({ data: agent, error: null })),
    }));
    mockInspect.mockResolvedValue({ ok: false, agentId: ID, targetId: "fixturenode11", vmid: 1112, error: "Capability missing." });
    mockInstall.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112, changed: true });
    mockPrepareOmarchy.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112,
      changed: true, accessReady: false, nativeDescriptor: { protocol: "hivra-omarchy-native-prepared-v2" } });
    mockPrepareWindows.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112,
      changed: true, accessReady: false, windowsDescriptor: { protocol: "hivra-windows-rdp-prepared-v1" } });
  });

  it("uses isolated Canary delivery in the dedicated production slot", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "canary";
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { prepared: true } });
    expect(mockInstall).toHaveBeenCalledWith(ID, "https://canary.hermesos.cloud", expect.any(Object), {
      controlBypassSecret: CONTROL_BYPASS_SECRET,
      controlBypassRequired: true,
    });
  });

  it("fails closed before guest access with invalid channel configuration", async () => {
    process.env.HIVRA_MANAGED_PROVISIONER_CHANNEL = "default";
    expect((await POST(request(), params)).status).toBe(503);
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("prepares only the authenticated owner's exact row", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ success: true, data: { prepared: true } });
    expect(mockInstall).toHaveBeenCalledWith(ID, "https://canary.hermesos.cloud", expect.objectContaining({
      loadAgent: expect.any(Function),
    }), { controlBypassSecret: undefined, controlBypassRequired: false });
    const loadAgent = mockInstall.mock.calls[0][2].loadAgent as (id: string) => Promise<unknown>;
    await expect(loadAgent(ID)).resolves.toBe(agent);
    agent = { ...agent, vmid: 1113 };
    await expect(loadAgent(ID)).resolves.toMatchObject({ vmid: 1113 });
    await expect(loadAgent("018f6d3c-1d91-7c65-9d86-37fc915b8377")).resolves.toBeNull();
  });

  it("refreshes current capability proof without running the installer", async () => {
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112 });
    const response = await POST(request({ action: "refresh" }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { prepared: true } });
    expect(mockInspect).toHaveBeenCalledWith(ID, expect.objectContaining({ loadAgent: expect.any(Function) }));
    expect(mockInstall).not.toHaveBeenCalled();
    const loadAgent = mockInspect.mock.calls[0][1].loadAgent as (id: string) => Promise<unknown>;
    await expect(loadAgent(ID)).resolves.toBe(agent);
    await expect(loadAgent("018f6d3c-1d91-7c65-9d86-37fc915b8377")).resolves.toBeNull();
  });

  it("refreshes provider Ubuntu using enrollment authority rather than Proxmox binding flags", async () => {
    agent = { ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, infrastructure_binding_token_enforced: false };
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, vmid: null });
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ success: true, data: { prepared: true } });
    expect(mockInspect).toHaveBeenCalledWith(ID, expect.objectContaining({ loadAgent: expect.any(Function) }));
    expect(mockInstall).not.toHaveBeenCalled();
  });
  it("cannot reinstall a provider desktop through Prepare or claim a failed refresh ready", async () => {
    agent = { ...agent, computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null };
    expect((await POST(request(), params)).status).toBe(409); expect(mockInspect).not.toHaveBeenCalled();
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "provider_desktop_unverified" });
    expect(mockInstall).not.toHaveBeenCalled();
  });
  it("keeps a proved predecessor available and reports only an optional upgrade", async () => {
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, runtimeVersion: "2026.09.05.2", upgradeAvailable: true });
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { prepared: true, runtimeVersion: "2026.09.05.2", upgradeAvailable: true } });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("reports missing folder identity as a controlled upgrade requirement without installing", async () => {
    mockInspect.mockResolvedValue({ ok: false, agentId: ID, code: "desktop_upgrade_required",
      error: "This desktop needs an update to establish its shared-folder identity. This check did not install or change anything." });
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, code: "desktop_upgrade_required",
      error: "This desktop needs an update to establish its shared-folder identity. This check did not install or change anything." });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("uses a verified read-only inspection as the prepare fast path", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112 });
    const response = await POST(request(), params);

    expect(response.status).toBe(200);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it.each([true, false])("routes Canary Prepare through isolated delivery when current capability is %s", async current => {
    mockInspect.mockResolvedValue({ ok: current, agentId: ID, targetId: "fixturenode11", vmid: 1112 });
    const response = await POST(request(), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { prepared: true } });
    expect(mockInstall).toHaveBeenCalledWith(ID, "https://canary.hermesos.cloud", expect.any(Object), {
      controlBypassSecret: CONTROL_BYPASS_SECRET,
      controlBypassRequired: true,
    });
  });

  it("does not place the project-wide Canary bypass on self-managed infrastructure", async () => {
    agent = { ...agent, deployment_mode: "self-managed" };
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, targetId: "owner-target", vmid: 1112 });

    const response = await POST(request(), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "protected_control_unavailable",
    });
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("does not install when an automatic capability refresh cannot prove the runtime", async () => {
    const response = await POST(request({ action: "refresh" }), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: "capability_refresh_failed" });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it.each(["ubuntu-desktop", "omarchy", "windows"])("preserves deletion intent for %s on refresh and opening", async profile => {
    agent = { ...agent, computer_profile: profile, desired_state: "deleted" };
    for (const action of ["refresh", "prepare"]) {
      const result = await POST(request({ action }), params);
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: "computer_lifecycle_blocked", error: expect.stringContaining("marked for deletion") });
    }
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockPrepareOmarchy).not.toHaveBeenCalled();
    expect(mockPrepareWindows).not.toHaveBeenCalled();
  });

  it.each([
    [{ desired_state: "stopped" }, "computer_lifecycle_blocked"],
    [{ status: "starting" }, "computer_lifecycle_blocked"],
    [{ operation_id: ID, operation_kind: "update" }, "computer_operation_blocked"],
    [{ operation_id: null, operation_kind: "desktop_prepare" }, "computer_operation_blocked"],
  ])("classifies blocked lifecycle before guest access: %j", async (state, code) => {
    agent = { ...agent, ...state };
    const result = await POST(request({ action: "refresh" }), params);
    expect(await result.json()).toMatchObject({ code });
    expect(mockInspect).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("preserves exact desktop preparation resumption", async () => {
    agent = { ...agent, operation_id: ID, operation_kind: "desktop_prepare" };
    expect((await POST(request(), params)).status).toBe(200);
    expect(mockInstall).toHaveBeenCalled();
  });

  it("isolates each computer's refresh quota and reserves room for opening plus scheduled checks", async () => {
    const otherId = "00000000-0000-4000-8000-000000001023";
    const counts = new Map<string, number>();
    mockRateLimit.mockImplementation((key: string, { limit }: { limit: number }) => {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit };
    });
    for (let check = 0; check < 10; check += 1) {
      for (const id of [ID, otherId]) {
        const result = await POST(request({ action: "refresh" }), { params: Promise.resolve({ id }) });
        expect(result.status).not.toBe(429);
      }
    }
    expect(counts.size).toBe(2);
    expect(mockRateLimit).toHaveBeenCalledWith(expect.stringContaining(`:${ID}`), { limit: 12, windowMs: 15 * 60_000 });
    for (let check = 0; check < 3; check += 1) await POST(request({ action: "refresh" }), params);
    expect((await POST(request({ action: "refresh" }), params)).status).toBe(429);
  });

  it("refuses legacy unbound preparation and provider reinstallation before guest mutation", async () => {
    agent = { ...agent, infrastructure_binding_token_enforced: false };
    let response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: "legacy_identity_unbound" });
    agent = { ...agent, infrastructure_binding_token_enforced: true, computer_substrate: "provider-vm" };
    response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: "provider_desktop_refresh_required" });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("uses dedicated preparation paths and never applies the Ubuntu installer to Omarchy or Windows", async () => {
    agent = { ...agent, computer_profile: "omarchy" };
    let response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { prepared: true, accessReady: false } });
    expect(mockInspect).toHaveBeenCalledTimes(1);
    expect(mockPrepareOmarchy).toHaveBeenCalledWith(ID, expect.objectContaining({ loadAgent: expect.any(Function) }));
    expect(mockInstall).not.toHaveBeenCalled();

    mockInspect.mockClear();
    agent = { ...agent, computer_profile: "windows" };
    response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { prepared: true, accessReady: false } });
    expect(mockInspect).toHaveBeenCalledTimes(1);
    expect(mockPrepareOmarchy).toHaveBeenCalledTimes(1);
    expect(mockPrepareWindows).toHaveBeenCalledWith(ID, expect.objectContaining({ loadAgent: expect.any(Function) }));
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("allows protected Canary to prepare Omarchy without touching the shared Ubuntu bundle", async () => {
    agent = { ...agent, computer_profile: "omarchy" };
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect(mockPrepareOmarchy).toHaveBeenCalledTimes(1);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("returns the exact pending Omarchy operation without replaying it in the route", async () => {
    agent = { ...agent, computer_profile: "omarchy" };
    mockPrepareOmarchy.mockResolvedValue({ ok: false, agentId: ID, targetId: "fixturenode11", vmid: 1112,
      code: "desktop_prepare_pending", error: "Desktop preparation is still unconfirmed." });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ success: false, code: "desktop_prepare_pending",
      error: "Desktop preparation is still unconfirmed." });
    expect(mockPrepareOmarchy).toHaveBeenCalledTimes(1);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("returns only a non-launchable descriptor after exact Omarchy refresh evidence", async () => {
    const nativeDescriptor = {
      protocol: "hivra-omarchy-native-prepared-v1",
      computerId: ID,
      vmid: 1112,
      route: { status: "configured-not-proven" },
      privateNetworkReachable: false,
      supportsInputTakeover: false,
    };
    agent = { ...agent, computer_profile: "omarchy" };
    mockInspect.mockResolvedValue({
      ok: true,
      agentId: ID,
      targetId: "fixturenode11",
      vmid: 1112,
      nativeDescriptor,
    });

    const response = await POST(request({ action: "refresh" }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { prepared: true, accessReady: false, nativeDescriptor },
    });
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockPrepareOmarchy).not.toHaveBeenCalled();
  });

  it("does not call Omarchy prepared when the inspection omits its descriptor", async () => {
    agent = { ...agent, computer_profile: "omarchy" };
    mockInspect.mockResolvedValue({ ok: true, agentId: ID, targetId: "fixturenode11", vmid: 1112 });

    const response = await POST(request({ action: "refresh" }), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "capability_refresh_failed",
    });
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("returns only a non-launchable descriptor after exact Windows refresh evidence", async () => {
    const windowsDescriptor = {
      protocol: "hivra-windows-rdp-prepared-v1",
      computerId: ID,
      vmid: 1112,
      route: { status: "configured-not-proven" },
      privateNetworkReachable: false,
    };
    agent = { ...agent, computer_profile: "windows" };
    mockInspect.mockResolvedValue({
      ok: true,
      agentId: ID,
      targetId: "fixturenode11",
      vmid: 1112,
      windowsDescriptor,
    });

    const response = await POST(request({ action: "refresh" }), params);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { prepared: true, accessReady: false, windowsDescriptor },
    });
    expect(mockInstall).not.toHaveBeenCalled();
    expect(mockPrepareOmarchy).not.toHaveBeenCalled();
  });

  it("does not disclose or mutate a computer outside the owner query", async () => {
    agent = null;
    const response = await POST(request(), params);
    expect(response.status).toBe(404);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, cross-origin, malformed and rate-limited requests", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await POST(request(), params)).status).toBe(401);
    expect((await POST(request(undefined, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    expect((await POST(request({ action: "restart" }), params)).status).toBe(400);
    mockRateLimit.mockReturnValueOnce({ success: false });
    expect((await POST(request(), params)).status).toBe(429);
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("returns a retryable state without forwarding provider output", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    mockInstall.mockResolvedValue({
      ok: false,
      agentId: ID,
      targetId: "fixturenode11",
      vmid: 1112,
      error: "Remote desktop guest installation could not be verified (host_timeout).",
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: "Hivra could not verify the desktop installation. Inspect Desktop before retrying; the installer may have changed its runtime configuration.",
      code: "desktop_prepare_failed",
    });
  });

  it("returns a retained preparation lease as pending, not a retryable failed installation", async () => {
    process.env.VERCEL_TARGET_ENV = "production";
    mockInstall.mockResolvedValue({ ok: false, agentId: ID, code: "desktop_prepare_pending", error: "Preparation is unconfirmed; conflicting changes remain paused." });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ success: false, code: "desktop_prepare_pending",
      error: "Preparation is unconfirmed; conflicting changes remain paused." });
  });
});
