/** @jest-environment node */
import { inspectProviderDesktopCapability, loadProviderDesktopCapabilityContext, recordProviderDesktopCapability } from "../provider-desktop-capability";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";
import { REMOTE_DESKTOP_BUNDLE_REVISION, REMOTE_DESKTOP_CAPABILITY_TTL_MS } from "@/lib/remote-computers/capability-inspection";
import type { inspectProviderDesktopRuntime } from "@/lib/infrastructure/first-boot-ssh";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
const mockRead = jest.fn(), mockRpc = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), maybeSingle: () => mockRead() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => mockQuery, rpc: (...args: unknown[]) => mockRpc(...args) } }));
const h = desktopInstallFixture();
const ref = { userId: h.op.userId, agentId: h.op.agentId };
const access = { mode: "cloudflare-named" as const, hostname: h.context.hostname!, tunnelId: h.context.tunnelId! };
const context = { input: ref, identity: h.identity, access, scope: h.scope, targetId: h.context.targetId, ip: "93.184.216.34" };
function receipt() { return { protocol: "hivra-remote-desktop-capability-v1" as const, computerKind: "hivra-agent" as const,
  computerId: ref.agentId, capabilityGeneration: h.clock.bootId, observedRevision: REMOTE_DESKTOP_BUNDLE_REVISION,
  compositor: "x11" as const, installedTransports: ["selkies-websocket" as const], privateNetworkReachable: false,
  supportsInputTakeover: true, brokerOrigin: `https://${access.hostname}`, observedAt: new Date().toISOString() }; }
function row() { return { id: ref.agentId, user_id: ref.userId, type: "linux-desktop", computer_profile: "ubuntu-desktop",
  status: "running", desired_state: "running", operation_id: null, operation_kind: null, allocation_operation_id: h.op.operationId,
  computer_substrate: "provider-vm", deployment_mode: "self-managed", proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
  vmid: null, infrastructure_connection_id: h.f.binding.connectionId, infrastructure_connection_revision: h.f.binding.connectionRevision,
  deployment_target_id: context.targetId, provider_capacity_order_id: h.f.binding.orderId, provider_enrollment_attempt_id: h.f.binding.attemptId,
  provider_server_id: h.scope.providerServerId, provider_install_identity: h.identity, provider_install_desktop_access: access,
  provider_install_outcome: "succeeded", provider_install_stopped_at: new Date().toISOString(), cf_tunnel_id: access.tunnelId,
  cf_hostname: access.hostname, chat_url: `https://${access.hostname}`, ip: context.ip, api_token: null }; }
beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); mockRpc.mockReset(); });
it("loads only stable original running ownership without inventing a VM ID", async () => {
  mockRead.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: h.f.binding.quoteFingerprint }, error: null });
  expect(await loadProviderDesktopCapabilityContext(ref)).toEqual(context);
  expect(mockQuery.is).toHaveBeenCalledWith("operation_id", null); expect(mockQuery.eq).toHaveBeenCalledWith("user_id", ref.userId);
});
it.each(["owner", "operation", "vmid", "profile", "identity", "access", "scope", "token"])("rejects %s binding before SSH", async fault => {
  const value: Record<string, unknown> = row();
  if (fault === "owner") value.user_id = "other";
  if (fault === "operation") value.operation_id = h.op.operationId;
  if (fault === "vmid") value.vmid = 1115;
  if (fault === "profile") value.computer_profile = "omarchy";
  if (fault === "identity") value.allocation_operation_id = ref.agentId;
  if (fault === "access") value.cf_hostname = "other.example.test";
  if (fault === "scope") value.provider_server_id = "43";
  if (fault === "token") value.api_token = "private-fixture";
  mockRead.mockResolvedValueOnce({ data: value, error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: h.f.binding.quoteFingerprint }, error: null });
  await expect(loadProviderDesktopCapabilityContext(ref)).rejects.toThrow("Provider desktop capability could not be verified");
});
it("records only the checked original identity and capability through the stable SQL wrapper", async () => {
  mockRpc.mockResolvedValue({ data: { status: "ready" }, error: null });
  const observed = receipt(), expires = new Date(Date.now() + REMOTE_DESKTOP_CAPABILITY_TTL_MS).toISOString();
  expect(await recordProviderDesktopCapability(context, observed, expires)).toBe(true);
  expect(mockRpc).toHaveBeenCalledWith("record_hivra_provider_desktop_capability", { p_user_id: ref.userId, p_agent_id: ref.agentId,
    p_identity: context.identity, p_access: access, p_ip: context.ip, p_target_id: context.targetId, p_receipt: observed, p_expires_at: expires });
});
function deps() {
  let elapsed = 0;
  return { load: jest.fn(async () => structuredClone(context)), record: jest.fn<ReturnType<typeof recordProviderDesktopCapability>, Parameters<typeof recordProviderDesktopCapability>>(async () => true),
    boot: jest.fn(async () => ({ ...h.scope } as FirstBootOperation)),
    verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope: h.scope, address: context.ip,
      hostPublicKey: h.f.host.publicKey, hostFingerprintSha256: h.f.host.fingerprintSha256, capacityIdempotencyKey: h.f.stored.capacityIdempotencyKey,
      observedAt: new Date().toISOString(), powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
    bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
    inspect: jest.fn<ReturnType<typeof inspectProviderDesktopRuntime>, [unknown]>(async () => ({ hostVerified: true,
      administratorAuthenticated: true, hostFingerprintSha256: h.f.host.fingerprintSha256, receipt: receipt() })),
    publicReady: jest.fn(async () => true), monotonicNow: () => elapsed, now: () => new Date(),
    controlOrigin: () => "https://canary.hermesos.cloud", advance: () => { elapsed = 30001; } };
}
it("refreshes through pinned SSH/public ingress then the shared capability ledger", async () => {
  const before = Date.now();
  const d = deps(); expect(await inspectProviderDesktopCapability(ref, d)).toMatchObject({ ok: true, agentId: ref.agentId, vmid: null });
  const after = Date.now();
  expect(d.inspect).toHaveBeenCalledWith(expect.objectContaining({ identity: h.identity, access, address: context.ip,
    hostPublicKey: h.f.host.publicKey, administratorPrivateKey: "private-fixture", dispatchDeadlineMs: 30000 }), expect.any(Object));
  expect(d.record).toHaveBeenCalledTimes(1);
  const expiresAt = Date.parse(d.record.mock.calls[0][2]);
  expect(expiresAt).toBeGreaterThanOrEqual(before + REMOTE_DESKTOP_CAPABILITY_TTL_MS);
  expect(expiresAt).toBeLessThanOrEqual(after + REMOTE_DESKTOP_CAPABILITY_TTL_MS);
});
it.each(["provider-ip", "pin", "receipt", "public", "late-state", "deadline", "record"])("does not publish after %s failure", async fault => {
  const d = deps();
  if (fault === "provider-ip") d.verify.mockResolvedValue({ ...(await d.verify()), address: "10.252.216.35" });
  if (fault === "pin") d.inspect.mockResolvedValue({ ...(await d.inspect({})), hostFingerprintSha256: "wrong" });
  if (fault === "receipt") { const observed = await d.inspect({}); observed.receipt.computerId = h.op.operationId; d.inspect.mockResolvedValue(observed); }
  if (fault === "public") d.publicReady.mockResolvedValue(false);
  if (fault === "late-state") d.publicReady.mockImplementation(async () => { d.load.mockRejectedValue(new Error("private fixture")); return true; });
  if (fault === "deadline") d.publicReady.mockImplementation(async () => { d.advance(); return true; });
  if (fault === "record") d.record.mockResolvedValue(false);
  expect(await inspectProviderDesktopCapability(ref, d)).toMatchObject({ ok: false, vmid: null });
  expect(d.record).toHaveBeenCalledTimes(fault === "record" ? 1 : 0);
});
