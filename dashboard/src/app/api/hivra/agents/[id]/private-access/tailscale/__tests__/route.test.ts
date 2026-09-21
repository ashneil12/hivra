/** @jest-environment node */
jest.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { GET, POST } from "../route";
import { hivraPrivateAccessAuthority } from "@/lib/hivra/tailscale-private-access";

const mockAuth = jest.fn();
const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockObserve = jest.fn();
const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockRateLimit = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args), getIP: () => "127.0.0.1",
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args), rpc: (...args: unknown[]) => mockRpc(...args) },
}));
jest.mock("@/lib/hivra/tailscale-private-access", () => {
  const actual = jest.requireActual("@/lib/hivra/tailscale-private-access");
  return { ...actual,
    observeHivraTailscale: (...args: unknown[]) => mockObserve(...args),
    connectHivraTailscale: (...args: unknown[]) => mockConnect(...args),
    disconnectHivraTailscale: (...args: unknown[]) => mockDisconnect(...args),
  };
});

const ID = "00000000-0000-4000-8000-000000001599";
const params = { params: Promise.resolve({ id: ID }) };
const authorityHash = "a".repeat(64);
let agent: Record<string, unknown> | null;
let connection: Record<string, unknown> | null;
let activeOperation: Record<string, unknown> | null;

function request(body: unknown) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/private-access/tailscale`, {
    method: "POST",
    headers: { host: "canary.hermesos.cloud", origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function query(data: () => unknown) {
  return { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(async () => ({ data: data(), error: null })) };
}

describe("Hivra Tailscale private access route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "owner" });
    mockRateLimit.mockReturnValue({ success: true });
    agent = { id: ID, user_id: "owner", type: "linux-desktop", computer_profile: "ubuntu-desktop",
      status: "running", desired_state: "running", operation_id: null, operation_kind: null,
      vmid: 1113, ip: "10.250.20.63", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
      proxmox_host: "node-b", infrastructure_binding_token_hash: authorityHash,
      infrastructure_binding_token_enforced: true, managed_provisioner_channel: "canary" };
    connection = null;
    activeOperation = null;
    mockFrom.mockImplementation((table: string) => table === "hivra_agents" ? query(() => agent)
      : table === "hivra_private_access_connections" ? query(() => connection) : query(() => activeOperation));
    mockRpc.mockResolvedValue({ data: true, error: null });
    mockObserve.mockResolvedValue({ ok: true, connectionPresent: false, receipt: { state: "disconnected", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:00:00Z" } });
    mockConnect.mockResolvedValue({ ok: true, receipt: { state: "connected", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", ipv4: "100.64.0.7",
      observedAt: "2026-09-15T12:00:01Z", connectedAt: "2026-09-15T12:00:01Z" } });
    mockDisconnect.mockResolvedValue({ ok: true, receipt: { state: "disconnected", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:01:00Z" } });
  });

  it("requires authentication and an exact owner row", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await GET(new NextRequest(`https://canary.hermesos.cloud/x`, { headers: { host: "canary.hermesos.cloud" } }), params)).status).toBe(401);
    agent = null;
    expect((await POST(request({ action: "refresh" }), params)).status).toBe(404);
    expect(mockObserve).not.toHaveBeenCalled();
  });

  it("blocks unsupported or lifecycle-busy computers before guest access", async () => {
    agent = { ...agent!, operation_id: "00000000-0000-4000-8000-000000001111", operation_kind: "resize" };
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(409);
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses to take over an existing guest connection without owner-bound state", async () => {
    mockObserve.mockResolvedValue({ ok: true, receipt: { state: "connected", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", ipv4: "100.64.0.8", observedAt: "2026-09-15T12:00:00Z" } });
    const response = await POST(request({ action: "connect", authKey: "opaque-key" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "unmanaged_connection" });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("refuses takeover when a network is present but strict owned preferences are unverified", async () => {
    mockObserve.mockResolvedValue({ ok: false, connectionPresent: true, receipt: { state: "unknown", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:00:00Z",
      failureCode: "unmanaged_connection" } });
    const response = await POST(request({ action: "connect", authKey: "opaque-key" }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "unmanaged_connection" });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("keeps refresh traffic in a separate rate-limit bucket from writes", async () => {
    await POST(request({ action: "refresh" }), params);
    await POST(request({ action: "connect", authKey: "opaque-key" }), params);
    expect(mockRateLimit.mock.calls[0][0]).toContain("hivra_private_access:read:");
    expect(mockRateLimit.mock.calls[1][0]).toContain("hivra_private_access:write:");
    expect(mockRateLimit.mock.calls[0][0]).not.toBe(mockRateLimit.mock.calls[1][0]);
  });

  it("leases, dispatches, and persists a sanitized connect receipt without forwarding the key to SQL", async () => {
    const secret = "opaque-headscale-key";
    const response = await POST(request({ action: "connect", authKey: secret, loginServer: "https://headscale.example.test:8443" }), params);
    expect(response.status).toBe(200);
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ id: ID, user_id: "owner" }), secret, "https://headscale.example.test:8443");
    expect(mockRpc.mock.calls.map(call => JSON.stringify(call))).not.toEqual(expect.arrayContaining([expect.stringContaining(secret)]));
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(mockRpc.mock.calls.map(call => call[0])).toEqual([
      "begin_hivra_private_access_operation", "dispatch_hivra_private_access_operation", "complete_hivra_private_access_operation",
    ]);
  });

  it("persists timeout uncertainty and requires refresh instead of claiming success", async () => {
    mockConnect.mockResolvedValue({ ok: false, receipt: { state: "unknown", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:00:01Z", failureCode: "host_timeout" } });
    const response = await POST(request({ action: "connect", authKey: "opaque-key" }), params);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: false, data: { connection: { state: "unknown" } } });
    expect(mockRpc).toHaveBeenLastCalledWith("complete_hivra_private_access_operation",
      expect.objectContaining({ p_success: false, p_receipt: expect.objectContaining({ state: "unknown", failureCode: "host_timeout" }) }));
  });

  it("reads back and disconnects only the exact owner-bound saved connection", async () => {
    connection = { authority: hivraPrivateAccessAuthority(agent as Parameters<typeof hivraPrivateAccessAuthority>[0]), state: "connected",
      machine_name: "box", magic_dns_name: "box.example.ts.net", tailnet_name: "example",
      login_server: "https://controlplane.tailscale.com", ipv4: "100.64.0.7", ipv6: null,
      connected_at: "2026-09-15T12:00:00Z", observed_at: "2026-09-15T12:00:00Z", failure_code: null };
    const read = await GET(new NextRequest(`https://canary.hermesos.cloud/x`, { headers: { host: "canary.hermesos.cloud" } }), params);
    expect(await read.json()).toMatchObject({ success: true, data: { connection: { ipv4: "100.64.0.7", sshEnabled: false } } });
    const disconnected = await POST(request({ action: "disconnect" }), params);
    expect(disconnected.status).toBe(200);
    expect(mockDisconnect).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), "https://controlplane.tailscale.com");
    expect(await disconnected.json()).toMatchObject({ success: true, data: { connection: null } });
  });

  it("reconciles a dispatched timeout from a fresh exact-guest observation", async () => {
    const operationId = "00000000-0000-4000-8000-000000001511";
    agent = { ...agent!, operation_id: operationId, operation_kind: "private_access" };
    const authority = hivraPrivateAccessAuthority(agent as Parameters<typeof hivraPrivateAccessAuthority>[0]);
    activeOperation = { id: operationId, action: "connect", login_server: "https://headscale.example.test:8443",
      authority, phase: "dispatched" };
    mockObserve.mockResolvedValue({ ok: true, receipt: { state: "connected", sshEnabled: false,
      loginServer: "https://headscale.example.test:8443", ipv4: "100.64.0.9", observedAt: "2026-09-15T12:02:00Z" } });
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(200);
    expect(mockObserve).toHaveBeenCalledWith(expect.objectContaining({ operation_kind: "private_access" }), "https://headscale.example.test:8443");
    expect(mockRpc).toHaveBeenCalledWith("complete_hivra_private_access_operation",
      expect.objectContaining({ p_operation_id: operationId, p_success: true }));
  });

  it("rate limits pending-operation reconciliation before touching the guest", async () => {
    agent = { ...agent!, operation_id: "00000000-0000-4000-8000-000000001511", operation_kind: "private_access" };
    mockRateLimit.mockReturnValue({ success: false });
    const response = await POST(request({ action: "refresh" }), params);
    expect(response.status).toBe(429);
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
