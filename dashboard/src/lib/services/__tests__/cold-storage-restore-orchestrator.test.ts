/**
 * Regression test for cold-storage-restore-orchestrator.
 *
 * Specifically guards against re-introducing the "double-resolve env" bug:
 * the orchestrator used to call resolveProxmoxHostEnv internally and pass
 * the flattened env to restoreInstance as deps.env. restoreInstance then
 * called resolveProxmoxHostEnv again with the destinationHostSlug, but the
 * flattened env no longer had PROXMOX_<HOST>_* keys, so resolution found 0
 * matches and threw "Proxmox host routing config for <host> has no
 * matching environment overrides" before any work began.
 *
 * The fix: orchestrator passes the restore options only; restoreInstance
 * handles env resolution natively from process.env. This test enforces
 * that contract by asserting restoreInstance is invoked with NO deps arg
 * (or one without `env`).
 */

import { orchestrateColdRestore } from "../cold-storage-restore-orchestrator";

const PROVISION_ENV = {
  PROXMOX_NODE: "fixturenode1",
  PROXMOX_HOST_SLUG: "fixturenode1",
  PROXMOX_PRIVATE_SUBNET_PREFIX: "10.250.20",
  PROXMOX_PRIVATE_GATEWAY: "10.250.20.1",
  PROXMOX_TEMPLATE_ID: "9004",
  PROXMOX_IP_LAST_OCTET_START: "10",
} as unknown as NodeJS.ProcessEnv;

const mockSelectTarget = jest.fn();
const mockGetVmidAvailability = jest.fn();
const mockRestoreInstance = jest.fn();
const mockApplyRestoreRouting = jest.fn();

jest.mock("../proxmox-instance-service", () => {
  const actual = jest.requireActual("../proxmox-instance-service");
  return {
    ...actual,
    getProxmoxVmidAvailability: (...args: unknown[]) => mockGetVmidAvailability(...args),
  };
});

jest.mock("../instance-service", () => ({
  selectAvailableProxmoxProvisionTarget: (...args: unknown[]) => mockSelectTarget(...args),
}));

jest.mock("../cold-storage-service", () => ({
  restoreInstance: (...args: unknown[]) => mockRestoreInstance(...args),
}));

jest.mock("../cold-storage-restore-routing", () => ({
  applyRestoreRouting: (...args: unknown[]) => mockApplyRestoreRouting(...args),
}));

beforeEach(() => {
  mockSelectTarget.mockReset();
  mockGetVmidAvailability.mockReset();
  mockRestoreInstance.mockReset();
  mockApplyRestoreRouting.mockReset();
  mockApplyRestoreRouting.mockResolvedValue({
    hostCaddy: { ok: true },
    oldHostCaddyCleanup: { ok: true, skipped: true, reason: "no_old_host_slug" },
    cloudflareDns: { ok: true, outcome: "created" },
  });
});

const fakeSupabase = {} as never;

const instanceInput = {
  instance: {
    id: "00000000-0000-0000-0000-00000000abcd",
    user_id: "user-1",
    resource_tier: "credit_base",
    cpu_limit: 1,
    ram_limit: 1024,
    disk_size_gb: 30,
    proxmox_node: null,
  },
};

describe("orchestrateColdRestore — env handoff to restoreInstance", () => {
  it("does not pre-resolve env; restoreInstance handles its own env resolution", async () => {
    mockSelectTarget.mockResolvedValue({
      ok: true,
      targetId: "fixturenode1",
      env: PROVISION_ENV,
    });
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids: [310], // single vmid → randomized pick still lands here
      vmidStart: 300,
      vmidEnd: 399,
    });
    mockRestoreInstance.mockResolvedValue({
      ok: true,
      instanceId: instanceInput.instance.id,
      newVmid: 310,
      newPveHost: "fixturenode1",
      newIpv4: "10.250.20.20",
      restoredAt: new Date().toISOString(),
    });

    const result = await orchestrateColdRestore(fakeSupabase, instanceInput);

    expect(result.ok).toBe(true);

    // restoreInstance must be invoked exactly once with three positional
    // args: (supabase, instanceId, options). NO fourth `deps` arg, OR a
    // deps arg without `env`. Passing a pre-resolved env here would cause
    // restoreInstance's internal resolveProxmoxHostEnv call to throw
    // "no matching environment overrides" because PROXMOX_<HOST>_*
    // keys would have been flattened away in the pre-resolve.
    expect(mockRestoreInstance).toHaveBeenCalledTimes(1);
    const callArgs = mockRestoreInstance.mock.calls[0]!;
    expect(callArgs[0]).toBe(fakeSupabase);
    expect(callArgs[1]).toBe(instanceInput.instance.id);
    expect(callArgs[2]).toMatchObject({
      destinationHostSlug: "fixturenode1",
      destinationVmid: 310,
      destinationIp: "10.250.20.20",
      destinationGateway: "10.250.20.1",
      templateVmid: 9004,
    });
    // Critical: either no deps argument, or deps without `env`.
    const depsArg = callArgs[3];
    if (depsArg !== undefined) {
      expect((depsArg as { env?: unknown }).env).toBeUndefined();
    }
  });

  it("randomizes VMID pick to spread concurrent restores across the free pool", async () => {
    mockSelectTarget.mockResolvedValue({
      ok: true,
      targetId: "fixturenode1",
      env: PROVISION_ENV,
    });
    const freeVmids = [310, 311, 312, 313, 314, 315, 316, 317, 318, 319];
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids,
      vmidStart: 300,
      vmidEnd: 399,
    });
    mockRestoreInstance.mockImplementation(async (_s, id, opts) => ({
      ok: true,
      instanceId: id,
      newVmid: (opts as { destinationVmid: number }).destinationVmid,
      newPveHost: "fixturenode1",
      newIpv4: "10.250.20.50",
      restoredAt: new Date().toISOString(),
    }));

    // 30 calls — under uniform random with pool=10, hitting all 10 distinct
    // VMIDs is overwhelmingly likely (P(any one missed)≈10*(9/10)^30≈0.4).
    // We just assert >=4 distinct picks, which is statistically a near-1
    // outcome and proves randomization happens (no-randomization would
    // always pick freeVmids[0]=310).
    const picked = new Set<number>();
    for (let i = 0; i < 30; i++) {
      await orchestrateColdRestore(fakeSupabase, instanceInput);
      const call = mockRestoreInstance.mock.calls[i]!;
      const vmid = (call[2] as { destinationVmid: number }).destinationVmid;
      expect(freeVmids).toContain(vmid);
      picked.add(vmid);
    }
    expect(picked.size).toBeGreaterThanOrEqual(4);
  });

  it("returns no_capacity when allocator finds none", async () => {
    mockSelectTarget.mockResolvedValue({
      ok: false,
      status: 503,
      message: "no host has capacity",
    });

    const result = await orchestrateColdRestore(fakeSupabase, instanceInput);

    expect(result.ok).toBe(false);
    expect(mockRestoreInstance).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.reason).toBe("no_capacity");
    }
  });

  it("calls applyRestoreRouting after a successful restore with the right host context", async () => {
    mockSelectTarget.mockResolvedValue({ ok: true, targetId: "fixturenode7", env: PROVISION_ENV });
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids: [727],
      vmidStart: 700,
      vmidEnd: 749,
    });
    mockRestoreInstance.mockResolvedValue({
      ok: true,
      instanceId: instanceInput.instance.id,
      newVmid: 727,
      newPveHost: "fixturenode7",
      newIpv4: "10.250.20.77",
      restoredAt: new Date().toISOString(),
    });

    const result = await orchestrateColdRestore(fakeSupabase, {
      instance: {
        ...instanceInput.instance,
        proxmox_node: "fixturenode1",
        gateway_host: "abc.agents.hermesos.cloud",
      },
    });

    expect(result.ok).toBe(true);
    expect(mockApplyRestoreRouting).toHaveBeenCalledTimes(1);
    expect(mockApplyRestoreRouting.mock.calls[0]![0]).toMatchObject({
      instanceId: instanceInput.instance.id,
      gatewayHost: "abc.agents.hermesos.cloud",
      newPrivateIp: "10.250.20.77",
      newHostSlug: "fixturenode7",
      oldHostSlug: "fixturenode1",
    });
  });

  it("skips applyRestoreRouting when gateway_host is missing (legacy/pre-DNS rows)", async () => {
    mockSelectTarget.mockResolvedValue({ ok: true, targetId: "fixturenode1", env: PROVISION_ENV });
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids: [310],
      vmidStart: 300,
      vmidEnd: 399,
    });
    mockRestoreInstance.mockResolvedValue({
      ok: true,
      instanceId: instanceInput.instance.id,
      newVmid: 310,
      newPveHost: "fixturenode1",
      newIpv4: "10.250.20.20",
      restoredAt: new Date().toISOString(),
    });

    await orchestrateColdRestore(fakeSupabase, instanceInput);

    expect(mockApplyRestoreRouting).not.toHaveBeenCalled();
  });

  it("applies routing for a health_pending result (VM is live) and passes it through", async () => {
    // health_pending is not a failure — the VM is up, so the routing pass must
    // run (using the coords carried on the result) so the gateway becomes
    // reachable for the recover-stuck-restoring sweep to promote the row.
    mockSelectTarget.mockResolvedValue({ ok: true, targetId: "fixturenode7", env: PROVISION_ENV });
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids: [728],
      vmidStart: 700,
      vmidEnd: 749,
    });
    mockRestoreInstance.mockResolvedValue({
      ok: false,
      reason: "health_pending",
      message: "gateway not healthy yet; parked",
      instanceId: instanceInput.instance.id,
      retryable: false,
      newVmid: 728,
      newPveHost: "fixturenode7",
      newIpv4: "10.250.20.78",
    });

    const result = await orchestrateColdRestore(fakeSupabase, {
      instance: {
        ...instanceInput.instance,
        proxmox_node: "fixturenode1",
        gateway_host: "abc.agents.hermesos.cloud",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("health_pending");
    }
    expect(mockApplyRestoreRouting).toHaveBeenCalledTimes(1);
    expect(mockApplyRestoreRouting.mock.calls[0]![0]).toMatchObject({
      instanceId: instanceInput.instance.id,
      gatewayHost: "abc.agents.hermesos.cloud",
      newPrivateIp: "10.250.20.78",
      newHostSlug: "fixturenode7",
      oldHostSlug: "fixturenode1",
    });
  });

  it("does not call applyRestoreRouting when restoreInstance fails", async () => {
    mockSelectTarget.mockResolvedValue({ ok: true, targetId: "fixturenode1", env: PROVISION_ENV });
    mockGetVmidAvailability.mockResolvedValue({
      ok: true,
      freeVmids: [310],
      vmidStart: 300,
      vmidEnd: 399,
    });
    mockRestoreInstance.mockResolvedValue({
      ok: false,
      reason: "host_script_failed",
      message: "restore-vm-cold.sh failed",
      instanceId: instanceInput.instance.id,
      retryable: true,
    });

    const result = await orchestrateColdRestore(fakeSupabase, {
      instance: { ...instanceInput.instance, gateway_host: "abc.agents.hermesos.cloud" },
    });

    expect(result.ok).toBe(false);
    expect(mockApplyRestoreRouting).not.toHaveBeenCalled();
  });
});
