/** @jest-environment node */
import { loadProviderAgentSeedContext, runProviderAgentGuestScript } from "../provider-guest-seed";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";
import { providerGuestBundleScopeSha256 } from "@/lib/infrastructure/provider-guest-bundle";
import type { FirstBootOperation } from "@/lib/infrastructure/first-boot-operations";
import type { runProviderGuestSeed } from "@/lib/infrastructure/first-boot-ssh";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";

const mockRead = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), maybeSingle: () => mockRead() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => mockQuery } }));

const f = receiverFixture();
const scope = { binding: f.binding, providerServerId: "42" };
const ref = { userId: f.binding.userId, agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const operationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = { version: 1 as const, agentId: ref.agentId, operationId, bundle: { version: 1 as const, state: "bundle_installed" as const,
  provisionerVersion: "2026.08.28.1" as const, scopeSha256: providerGuestBundleScopeSha256(scope), bundleSha256: "a".repeat(64) } };
const IP = "203.0.113.10";
const context = { input: ref, identity, scope, accessMode: "cloudflare-named" as const, targetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ip: IP };
const SCRIPT = "set -e\necho HIVRA_SEED_OK\n";

function row(): Record<string, unknown> {
  return { id: ref.agentId, user_id: ref.userId, type: "codex", status: "running", desired_state: "running", operation_id: null, operation_kind: null,
    allocation_operation_id: operationId, computer_substrate: "provider-vm", deployment_mode: "self-managed",
    proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, vmid: null, infrastructure_connection_id: f.binding.connectionId,
    infrastructure_connection_revision: f.binding.connectionRevision, deployment_target_id: context.targetId,
    provider_capacity_order_id: f.binding.orderId, provider_enrollment_attempt_id: f.binding.attemptId, provider_server_id: "42",
    provider_install_identity: identity, provider_install_outcome: "succeeded", provider_install_stopped_at: new Date().toISOString(),
    cf_tunnel_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", cf_hostname: "fixture.hivra.test", chat_url: "https://fixture.hivra.test", ip: IP };
}

beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); });

describe("loadProviderAgentSeedContext", () => {
  it("loads only a stable running Claude Code or Codex agent with its original enrollment", async () => {
    // A server created before first boot armed at Start setup keeps its recipe,
    // and the scope digest is computed with it (not today's recipe).
    mockRead.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: f.binding.quoteFingerprint }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: f.binding.recipeVersion }, error: null });
    expect(await loadProviderAgentSeedContext(ref)).toEqual(context);
    expect(mockQuery.is).toHaveBeenCalledWith("operation_id", null);
    expect(mockQuery.eq).toHaveBeenCalledWith("user_id", ref.userId);
    expect(mockQuery.eq).toHaveBeenCalledWith("status", "running");
  });

  it("loads a server on the current first-boot recipe with that recipe's scope", async () => {
    const current = receiverFixture("armed");
    const currentScope = { binding: current.binding, providerServerId: "42" };
    const currentIdentity = { ...identity, bundle: { ...identity.bundle, scopeSha256: providerGuestBundleScopeSha256(currentScope) } };
    mockRead.mockResolvedValueOnce({ data: { ...row(), provider_install_identity: currentIdentity }, error: null })
      .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: current.binding.quoteFingerprint }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: current.binding.recipeVersion }, error: null });
    expect(await loadProviderAgentSeedContext(ref)).toEqual({ ...context, identity: currentIdentity, scope: currentScope });
  });

  it("refuses when the attempt's first-boot recipe can't be read", async () => {
    mockRead.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: f.binding.quoteFingerprint }, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    await expect(loadProviderAgentSeedContext(ref)).rejects.toThrow("Provider guest seed could not be verified");
  });

  it.each(["owner", "operation", "runtime", "installer", "identity", "scope", "access"])("refuses a row whose %s doesn't match", async (fault) => {
    const value = row();
    if (fault === "owner") value.user_id = "someone-else";
    if (fault === "operation") value.operation_id = operationId;
    if (fault === "runtime") value.type = "openclaw";
    if (fault === "installer") value.provider_install_outcome = "failed";
    if (fault === "identity") value.allocation_operation_id = ref.agentId;
    if (fault === "scope") value.provider_server_id = "43";
    if (fault === "access") { value.cf_tunnel_id = null; value.cf_hostname = null; }
    mockRead.mockResolvedValueOnce({ data: value, error: null }).mockResolvedValueOnce({ data: { quote_fingerprint_sha256: f.binding.quoteFingerprint }, error: null })
      .mockResolvedValueOnce({ data: { recipe_version: f.binding.recipeVersion }, error: null });
    await expect(loadProviderAgentSeedContext(ref)).rejects.toThrow("Provider guest seed could not be verified");
  });
});

describe("runProviderAgentGuestScript (ATT-05)", () => {
  function deps() {
    let elapsed = 0;
    return {
      load: jest.fn(async () => structuredClone(context)),
      boot: jest.fn(async () => ({ ...scope } as unknown as FirstBootOperation)),
      verify: jest.fn(async () => ({ stage: "provider_verified" as const, scope, address: IP, hostPublicKey: f.host.publicKey,
        hostFingerprintSha256: f.host.fingerprintSha256, capacityIdempotencyKey: f.stored.capacityIdempotencyKey, observedAt: new Date().toISOString(),
        powerOnAction: { id: 603, command: "start_server" as const, status: "success" as const, resources: [{ id: 42, type: "server" as const }] } })),
      bootstrap: jest.fn(async () => ({ publicKeyOpenSsh: "public-fixture", privateKeyOpenSsh: "private-fixture" }) as Awaited<ReturnType<typeof import("@/lib/infrastructure/hetzner-cloud-store").loadHetznerCloudCapacityBootstrap>>),
      run: jest.fn<ReturnType<typeof runProviderGuestSeed>, Parameters<typeof runProviderGuestSeed>>(async () => ({ hostVerified: true as const,
        administratorAuthenticated: true as const, hostFingerprintSha256: f.host.fingerprintSha256, output: "HIVRA_SEED_OK\n" })),
      monotonicNow: () => elapsed, advance: (value: number) => { elapsed = value; },
    };
  }

  it("runs the script over the enrolled pin with the generated administrator key, after a current-state reread", async () => {
    const d = deps();
    expect(await runProviderAgentGuestScript(ref, SCRIPT, d)).toEqual({ ok: true, stdout: "HIVRA_SEED_OK\n" });
    expect(d.run).toHaveBeenCalledWith({ script: SCRIPT, address: IP, hostPublicKey: f.host.publicKey, administratorPublicKey: "public-fixture",
      administratorPrivateKey: "private-fixture", dispatchDeadlineMs: 30_000 }, expect.any(Object));
    expect(d.verify).toHaveBeenCalledWith(expect.not.objectContaining({ requireDirectHttps: true }), expect.any(Object));
    expect(d.load).toHaveBeenCalledTimes(2);
  });

  it("sends nothing for an agent that isn't a stable running provider agent", async () => {
    const d = deps();
    d.load.mockRejectedValueOnce(new Error("not running"));
    expect(await runProviderAgentGuestScript(ref, SCRIPT, d)).toEqual({ ok: false, error: "not_eligible" });
    expect(d.verify).not.toHaveBeenCalled();
    expect(d.run).not.toHaveBeenCalled();
  });

  it.each(["waiting", "address", "changed", "pin", "deadline", "transport"])("reports %s as unreachable without claiming anything", async (fault) => {
    const d = deps();
    if (fault === "waiting") d.verify.mockResolvedValueOnce({ stage: "waiting_for_provider" } as never);
    if (fault === "address") d.verify.mockResolvedValueOnce({ ...(await d.verify()), address: "198.51.100.7" });
    if (fault === "changed") d.load.mockResolvedValueOnce(structuredClone(context)).mockResolvedValueOnce({ ...structuredClone(context), ip: "198.51.100.7" });
    if (fault === "pin") d.run.mockResolvedValueOnce({ hostVerified: true, administratorAuthenticated: true, hostFingerprintSha256: "foreign", output: "" });
    if (fault === "deadline") d.bootstrap.mockImplementationOnce(async () => { d.advance(30_001); return { publicKeyOpenSsh: "p", privateKeyOpenSsh: "k" } as never; });
    if (fault === "transport") d.run.mockRejectedValueOnce(new Error("command_failed"));
    expect(await runProviderAgentGuestScript(ref, SCRIPT, d)).toEqual({ ok: false, error: "unreachable" });
    if (["waiting", "address", "changed", "deadline"].includes(fault)) expect(d.run).not.toHaveBeenCalled();
  });

  it("asks the provider for direct HTTPS evidence when the computer uses its own address", async () => {
    const d = deps();
    d.load.mockResolvedValue({ ...structuredClone(context), accessMode: "direct-https" as never });
    await runProviderAgentGuestScript(ref, SCRIPT, d);
    expect(d.verify).toHaveBeenCalledWith(expect.objectContaining({ requireDirectHttps: true }), expect.any(Object));
  });
});
