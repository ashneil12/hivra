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
const mockConnectNetbird = jest.fn();
const mockObserveNetbird = jest.fn();
const mockReapply = jest.fn();
const mockRateLimit = jest.fn();
const mockWake = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
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
    connectHivraNetbird: (...args: unknown[]) => mockConnectNetbird(...args),
    observeHivraNetbird: (...args: unknown[]) => mockObserveNetbird(...args),
    reapplyHivraOutboundBlock: (...args: unknown[]) => mockReapply(...args),
    wakeHivraPrivateAccessComputer: (...args: unknown[]) => mockWake(...args),
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
    mockWake.mockResolvedValue({ ok: true });
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
    mockObserveNetbird.mockResolvedValue({ ok: true, connectionPresent: false, receipt: { state: "disconnected", sshEnabled: false,
      loginServer: "https://api.netbird.io", observedAt: "2026-09-15T12:00:00Z" } });
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

  // The reason lets Manage say "start this computer" to a stopped, eligible
  // Ubuntu computer instead of refusing it as if it could never connect.
  it.each([
    ["an eligible running computer", {}, true, null],
    ["a stopped computer", { status: "stopped", desired_state: "stopped" }, false, "not_running"],
    ["a computer with an operation in progress", { operation_id: "00000000-0000-4000-8000-000000001111", operation_kind: "resize" }, false, "operation_in_progress"],
    ["an older computer without ownership checks", { infrastructure_binding_token_enforced: false }, false, "not_bound"],
    ["an agent", { type: "codex", computer_profile: null }, false, "not_eligible"],
    ["a computer in the owner's own cloud", { computer_substrate: "provider-vm" }, false, "not_eligible"],
  ])("reports why private access is or isn't available for %s", async (_case, change, supported, reason) => {
    agent = { ...agent!, ...change };
    const response = await GET(new NextRequest(`https://canary.hermesos.cloud/x`, { headers: { host: "canary.hermesos.cloud" } }), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { supported, reason } });
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

  describe("hardening and private network v2", () => {
    const FLAG = "NEXT_PUBLIC_HIVRA_PRIVATE_NETWORK_V2";
    const saved = process.env[FLAG];
    afterEach(() => { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; });
    const stored = () => ({ authority: hivraPrivateAccessAuthority(agent as Parameters<typeof hivraPrivateAccessAuthority>[0]),
      state: "connected", machine_name: "box", magic_dns_name: null, tailnet_name: null,
      login_server: "https://controlplane.tailscale.com", ipv4: "100.64.0.7", ipv6: null,
      connected_at: "2026-09-15T12:00:00Z", observed_at: "2026-09-15T12:00:00Z", failure_code: null });

    it("explains a client that is too old in plain words and names the code", async () => {
      mockConnect.mockResolvedValue({ ok: false, receipt: { state: "disconnected", sshEnabled: false,
        loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:00:01Z", failureCode: "client_too_old" } });
      const response = await POST(request({ action: "connect", authKey: "opaque-key" }), params);
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.failureCode).toBe("client_too_old");
      expect(body.error).toContain("1.104.4");
    });

    it("does not offer NetBird while the flag is off", async () => {
      delete process.env[FLAG];
      const response = await POST(request({ action: "connect", provider: "netbird", authKey: "nb-key" }), params);
      expect(response.status).toBe(400);
      expect(mockConnectNetbird).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("still refuses to enrol over a saved connection while the flag is off", async () => {
      delete process.env[FLAG];
      connection = stored();
      const response = await POST(request({ action: "connect", authKey: "k" }), params);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "already_managed" });
      expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it("joins NetBird with its own address check, and refuses a non-https server", async () => {
      process.env[FLAG] = "1";
      mockConnectNetbird.mockResolvedValue({ ok: true, receipt: { state: "connected", provider: "netbird", sshEnabled: false,
        loginServer: "https://api.netbird.io", ipv4: "100.92.1.2", observedAt: "2026-09-15T12:00:01Z" } });
      const bad = await POST(request({ action: "connect", provider: "netbird", authKey: "k", loginServer: "http://nb.example.test" }), params);
      expect(bad.status).toBe(400);
      const ok = await POST(request({ action: "connect", provider: "netbird", authKey: "nb-key" }), params);
      expect(ok.status).toBe(200);
      expect(mockConnectNetbird).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), "nb-key", "https://api.netbird.io");
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it("switches network in one action: leaves the old one, then joins the new one", async () => {
      process.env[FLAG] = "1";
      connection = stored();
      mockConnectNetbird.mockResolvedValue({ ok: true, receipt: { state: "connected", provider: "netbird", sshEnabled: false,
        loginServer: "https://api.netbird.io", ipv4: "100.92.1.2", observedAt: "2026-09-15T12:00:02Z" } });
      const response = await POST(request({ action: "connect", provider: "netbird", authKey: "nb-key" }), params);
      expect(response.status).toBe(200);
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
      expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(mockConnectNetbird.mock.invocationCallOrder[0]);
      expect(mockRpc.mock.calls.map(call => call[0])).toEqual([
        "begin_hivra_private_access_operation", "dispatch_hivra_private_access_operation", "complete_hivra_private_access_operation",
        "begin_hivra_private_access_operation", "dispatch_hivra_private_access_operation", "complete_hivra_private_access_operation",
      ]);
      expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_action: "disconnect" });
      expect(mockRpc.mock.calls[3][1]).toMatchObject({ p_action: "connect", p_login_server: "https://api.netbird.io" });
    });

    it("does not join the new network when leaving the old one is not confirmed", async () => {
      process.env[FLAG] = "1";
      connection = stored();
      mockDisconnect.mockResolvedValue({ ok: false, receipt: { state: "unknown", sshEnabled: false,
        loginServer: "https://controlplane.tailscale.com", observedAt: "2026-09-15T12:01:00Z" } });
      const response = await POST(request({ action: "connect", provider: "netbird", authKey: "nb-key" }), params);
      expect(response.status).toBe(202);
      expect(mockConnectNetbird).not.toHaveBeenCalled();
      expect(mockConnect).not.toHaveBeenCalled();
    });
  });

  describe("saved extras and reapplying protection", () => {
    const savedConnection = (extra: Record<string, unknown> = {}) => ({
      authority: hivraPrivateAccessAuthority(agent as Parameters<typeof hivraPrivateAccessAuthority>[0]), state: "connected",
      machine_name: "box", magic_dns_name: null, tailnet_name: null, login_server: "https://controlplane.tailscale.com",
      ipv4: "100.64.0.7", ipv6: null, connected_at: "2026-09-15T12:00:00Z", observed_at: "2026-09-15T12:00:00Z",
      failure_code: null, ...extra });
    const liveReceipt = (extra: Record<string, unknown> = {}) => ({ state: "connected", provider: "tailscale", sshEnabled: false,
      loginServer: "https://controlplane.tailscale.com", ipv4: "100.64.0.7", observedAt: "2026-09-15T12:05:00Z", ...extra });

    it("returns the saved provider and the computer's own view on a plain read", async () => {
      connection = savedConnection({ provider: "netbird", can_see_other_devices: true, visible_peer_count: 2,
        tagged_hivra: null, block_present: false, client_version: "0.59.1" });
      const read = await GET(new NextRequest("https://canary.hermesos.cloud/x", { headers: { host: "canary.hermesos.cloud" } }), params);
      expect((await read.json()).data.connection).toMatchObject({ provider: "netbird", providerKind: "netbird",
        canSeeOtherDevices: true, visiblePeerCount: 2, blockPresent: false, clientVersion: "0.59.1" });
    });

    it("still reads a connection where the extra columns do not exist", async () => {
      const calls: string[] = [];
      mockFrom.mockImplementation((table: string) => {
        if (table !== "hivra_private_access_connections") return table === "hivra_agents" ? query(() => agent) : query(() => activeOperation);
        return { select: (columns: string) => { calls.push(columns);
          const failing = columns.includes("block_present");
          return { eq: () => ({ eq: () => ({ maybeSingle: async () => failing
            ? { data: null, error: { message: "column does not exist" } } : { data: savedConnection(), error: null } }) }) }; } };
      });
      const read = await GET(new NextRequest("https://canary.hermesos.cloud/x", { headers: { host: "canary.hermesos.cloud" } }), params);
      expect(read.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect((await read.json()).data.connection).toMatchObject({ ipv4: "100.64.0.7" });
    });

    it("reapplies the block on a connected computer without joining again", async () => {
      connection = savedConnection();
      mockObserve.mockResolvedValue({ ok: true, connectionPresent: true, receipt: liveReceipt({ blockPresent: false }) });
      mockReapply.mockResolvedValue({ ok: true, receipt: liveReceipt({ blockPresent: true }) });
      const response = await POST(request({ action: "reapply" }), params);
      expect(response.status).toBe(200);
      expect(mockReapply).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), "tailscale", "https://controlplane.tailscale.com");
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockRpc).toHaveBeenCalledWith("record_hivra_private_access_observation", expect.objectContaining({
        p_receipt: expect.objectContaining({ blockPresent: true }) }));
      expect(await response.json()).toMatchObject({ success: true, data: { connection: { blockPresent: true } } });
    });

    it("says so when the protection could not be confirmed", async () => {
      connection = savedConnection();
      mockObserve.mockResolvedValue({ ok: true, connectionPresent: true, receipt: liveReceipt({ blockPresent: false }) });
      mockReapply.mockResolvedValue({ ok: false, receipt: liveReceipt({ blockPresent: false, failureCode: "outbound_block_failed" }) });
      const response = await POST(request({ action: "reapply" }), params);
      expect(response.status).toBe(202);
      expect((await response.json()).failureCode).toBe("outbound_block_failed");
    });

    it("refuses to reapply when nothing is connected", async () => {
      connection = null;
      const response = await POST(request({ action: "reapply" }), params);
      expect(response.status).toBe(409);
      expect(mockReapply).not.toHaveBeenCalled();
    });
  });
  it("wakes a sleeping computer before it reads or changes the network on connect", async () => {
    const response = await POST(request({ action: "connect", authKey: "tskey-auth-abc" }), params);
    expect(response.status).toBe(200);
    expect(mockWake).toHaveBeenCalledWith(ID);
    expect(mockWake.mock.invocationCallOrder[0]).toBeLessThan(mockObserve.mock.invocationCallOrder[0]);
    expect(mockWake.mock.invocationCallOrder[0]).toBeLessThan(mockConnect.mock.invocationCallOrder[0]);
  });

  it("says the computer is still waking, and touches nothing, when the wake has not finished", async () => {
    mockWake.mockResolvedValue({ ok: false });
    const response = await POST(request({ action: "connect", authKey: "tskey-auth-abc" }), params);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ success: false, code: "computer_asleep" });
    expect(mockObserve).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("never wakes a computer just to read its status", async () => {
    await POST(request({ action: "refresh" }), params);
    expect(mockWake).not.toHaveBeenCalled();
  });
});
