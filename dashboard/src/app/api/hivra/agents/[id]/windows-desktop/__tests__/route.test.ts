import { NextRequest } from "next/server";

import { POST } from "../route";

const mockAuth = jest.fn();
const mockFrom = jest.fn();
const mockInspect = jest.fn();
const mockReadConfig = jest.fn();
const mockBuildToken = jest.fn();
const mockFetch = jest.fn();
const mockWarn = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/logger", () => ({ log: { warn: (...args: unknown[]) => mockWarn(...args) } }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: () => ({ success: true }), getIP: () => "127.0.0.1" }));
jest.mock("@/lib/remote-computers/capability-inspection", () => ({
  inspectRemoteDesktopCapability: (...args: unknown[]) => mockInspect(...args),
}));
jest.mock("@/lib/remote-computers/windows-rdp-gateway", () => ({
  readWindowsRdpGatewayConfig: () => mockReadConfig(),
  windowsDescriptorMatchesGateway: () => true,
  buildWindowsGatewayToken: (...args: unknown[]) => mockBuildToken(...args),
  guacamoleClientIdentifier: () => "client-id",
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));

const ID = "11111111-1111-4111-8111-111111111111";
const config = {
  version: 1, computerId: ID, guestPrivateIpv4: "10.240.20.98", gatewaySourceCidr: "10.240.20.96/32",
  gatewayOrigin: "https://windows-canary.hermesos.cloud", connectionName: "Hivra Windows Canary",
  rdpUsername: "hivra-desktop", rdpPassword: "secret-password-long-enough",
  certificateFingerprint: `sha256:${"a".repeat(64)}`, guacamoleSecretHex: "b".repeat(32),
};
const agent = {
  id: ID, user_id: "user_fixture", type: "linux-desktop", computer_profile: "windows",
  computer_substrate: "proxmox-kvm", status: "running", desired_state: "running",
  operation_id: null, operation_kind: null, ip: "10.240.20.98", infrastructure_binding_token_enforced: true,
};
const params = { params: Promise.resolve({ id: ID }) };

function loadAgent(overrides: Record<string, unknown>) {
  mockFrom.mockReturnValue({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { ...agent, ...overrides }, error: null }) });
}

function request(body: unknown = { streamingMode: "performance" }, origin = "https://canary.hermesos.cloud") {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/windows-desktop`, {
    method: "POST",
    headers: { host: "canary.hermesos.cloud", origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_fixture" });
  mockReadConfig.mockReturnValue(config);
  mockBuildToken.mockReturnValue("encrypted-token");
  mockFrom.mockReturnValue({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: agent, error: null }) });
  mockInspect.mockResolvedValue({ ok: true, windowsDescriptor: { protocol: "hivra-windows-rdp-prepared-v1" } });
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ authToken: "A".repeat(64) }), { status: 200 }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
});

it("returns only a short-lived gateway URL for the authenticated owner's prepared computer", async () => {
  const response = await POST(request(), params);
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload).toEqual({ success: true, data: {
    launchUrl: `https://windows-canary.hermesos.cloud/guacamole/#/client/client-id?token=${"A".repeat(64)}`,
    streamingMode: "performance",
  } });
  expect(mockBuildToken).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "user_fixture", streamingMode: "performance" }));
  expect(mockFetch).toHaveBeenCalledWith("https://windows-canary.hermesos.cloud/guacamole/api/tokens", expect.objectContaining({ method: "POST" }));
  expect(JSON.stringify(payload)).not.toContain(config.rdpPassword);
});

it.each(["hq", "qhd", "uhd"] as const)("passes the explicit %s profile to the Windows gateway", async (streamingMode) => {
  const response = await POST(request({ streamingMode }), params);
  expect(response.status).toBe(200);
  expect(mockBuildToken).toHaveBeenCalledWith(expect.objectContaining({ streamingMode }));
});

it("passes only validated panel geometry to the owner-bound handoff", async () => {
  const viewport = { width: 816, height: 617 };
  expect((await POST(request({ streamingMode: "hq", viewport }), params)).status).toBe(200);
  expect(mockBuildToken).toHaveBeenCalledWith(expect.objectContaining({ viewport }));
});

it.each([{ width: 0, height: 617 }, { width: 816.5, height: 617 }, { width: 16_385, height: 617 }, { width: 1, height: 1000 }, { width: 816, height: 617, scale: 2 }])("rejects invalid viewport %j before inspection or gateway authentication", async viewport => {
  expect((await POST(request({ streamingMode: "hq", viewport }), params)).status).toBe(400);
  expect(mockInspect).not.toHaveBeenCalled();
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("rejects unauthenticated, cross-origin, and unprepared requests before issuing a gateway token", async () => {
  mockAuth.mockResolvedValueOnce({ userId: null });
  expect((await POST(request(), params)).status).toBe(401);
  expect((await POST(request(undefined, "https://attacker.example"), params)).status).toBe(403);
  mockInspect.mockResolvedValueOnce({ ok: false,
    error: "Remote desktop capability could not be verified (guest_rdp_disabled)." });
  const unprepared = await POST(request(), params);
  expect(unprepared.status).toBe(409);
  expect(await unprepared.json()).toEqual({ success: false, code: "windows_prepare_required",
    error: "Windows RDP needs to be prepared again." });
  expect(mockBuildToken).not.toHaveBeenCalled();
});

it("requires normal preparation for a confirmed competing boot account, without issuing access", async () => {
  mockInspect.mockResolvedValueOnce({ ok: false,
    error: "Remote desktop capability could not be verified (guest_console_autologon_enabled)." });
  const response = await POST(request(), params);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ success: false, code: "windows_prepare_required",
    error: "Windows RDP needs to be prepared again." });
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each(["guest_console_autologon_invalid", "host_timeout", "host_ssh", "guest_remote_exit", "guest_inspection_failed", "guest_rdp_firewall_filter_association_unverified", "capability_marker_absent", "qga_dispatch", "qga_guest_exit_1", "host_phase_guest_exec", "host_remote_exit_255"])(
  "does not authorize preparation after an unconfirmed %s inspection", async failure => {
    mockInspect.mockResolvedValueOnce({ ok: false,
      error: `Remote desktop capability could not be verified (${failure}).` });
    const response = await POST(request(), params);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false,
      error: "Windows RDP inspection could not be confirmed. Try opening it again." });
    expect(mockBuildToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith("Windows desktop inspection unconfirmed", {
      source: "hivra/agents/[id]/windows-desktop", instanceId: ID, status: 503,
      failureType: "inspection_unconfirmed", phase: "capability_inspection", reason: failure,
    });
  },
);

it.each([
  "password=secret-password-long-enough token=encrypted-token",
  "Remote desktop capability could not be verified (guest_secret_password).",
  "Remote desktop capability could not be verified (host_timeout). token=encrypted-token",
  "Remote desktop capability could not be verified (qga_guest_exit_999).",
  "Remote desktop capability could not be verified (host_phase_secret).",
  "Remote desktop capability could not be verified (host_remote_exit_999).",
])("never logs unknown or raw inspection errors: %s", async error => {
  mockInspect.mockResolvedValueOnce({ ok: false, error });
  const response = await POST(request(), params);
  expect(response.status).toBe(503);
  expect(mockWarn).toHaveBeenCalledWith("Windows desktop inspection unconfirmed", expect.objectContaining({
    reason: "inspection_unknown", failureType: "inspection_unconfirmed", phase: "capability_inspection",
  }));
  const logged = JSON.stringify(mockWarn.mock.calls);
  expect(logged).not.toContain(error);
  expect(logged).not.toContain(config.rdpPassword);
  expect(logged).not.toContain("encrypted-token");
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  ["Remote desktop inspection authority is unavailable.", "inspection_authority_unavailable"],
  ["Remote desktop inspection failed.", "inspection_failed"],
])("logs a fixed reason for %s", async (error, reason) => {
  mockInspect.mockResolvedValueOnce({ ok: false, error });
  expect((await POST(request(), params)).status).toBe(503);
  expect(mockWarn).toHaveBeenCalledWith("Windows desktop inspection unconfirmed", expect.objectContaining({ reason }));
});

it("does not authorize preparation when a successful inspection has no Windows descriptor", async () => {
  mockInspect.mockResolvedValueOnce({ ok: true });
  const response = await POST(request(), params);
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBeUndefined();
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockWarn).toHaveBeenCalledWith("Windows desktop inspection unconfirmed", expect.objectContaining({
    reason: "windows_descriptor_missing",
  }));
});

it("requests owner preparation resumption before inspecting or issuing a handoff", async () => {
  loadAgent({ operation_id: ID, operation_kind: "desktop_prepare" });
  const response = await POST(request(), params);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("windows_prepare_resume_required");
  expect(mockInspect).not.toHaveBeenCalled();
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  { operation_id: ID, operation_kind: "restart" },
  { operation_id: ID, operation_kind: null },
  { operation_id: null, operation_kind: "desktop_prepare" },
  { operation_id: "invalid", operation_kind: "desktop_prepare" },
  { operation_id: ID, operation_kind: "desktop_prepare", desired_state: "deleted" },
  { operation_id: ID, operation_kind: "desktop_prepare", status: "stopped" },
  { operation_id: ID, operation_kind: "desktop_prepare", infrastructure_binding_token_enforced: false },
])("does not authorize preparation for an invalid lifecycle or operation: %j", async overrides => {
  loadAgent(overrides);
  const response = await POST(request(), params);
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBeUndefined();
  expect(mockInspect).not.toHaveBeenCalled();
  expect(mockBuildToken).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});
