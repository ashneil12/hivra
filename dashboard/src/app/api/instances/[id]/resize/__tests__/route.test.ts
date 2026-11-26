import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveEffectiveTierSpec } from "@/lib/services/tier-specs";
import { readManagedLaunchBridgeEpoch } from "@/lib/hivra/managed-launch-bridge";
import { readInstanceLiveMutationBlock } from "@/lib/services/instance-live-mutation";
import { resizeProxmoxVm } from "@/lib/services/proxmox-instance-service";
import { PATCH } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/hivra/managed-launch-bridge", () => ({
  readManagedLaunchBridgeEpoch: jest.fn(async () => null),
}));
jest.mock("@/lib/services/instance-live-mutation", () => ({
  readInstanceLiveMutationBlock: jest.fn(async () => null),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(),
    rpc: jest.fn(),
  },
}));

jest.mock("@/lib/logger", () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("@/lib/billing/venice-compute-boost", () => ({
  isVeniceBoostEligible: jest.fn().mockResolvedValue(false),
}));

jest.mock("@/lib/services/tier-change-service", () => ({
  applyTierChange: jest.fn(),
}));

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  getProxmoxInfrastructure: jest.fn(() => ({ vmid: 201, node: "fixturenode1" })),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  resizeProxmoxVm: jest.fn(),
  normalizeProxmoxTargetId: (id: string) => id,
  PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER: "HOST_CONFIG_APPLIED",
  isProxmoxResizePreflightRefusal: jest.requireActual("@/lib/services/proxmox-instance-service").isProxmoxResizePreflightRefusal,
}));

const TIER = "operator";
const SPEC = resolveEffectiveTierSpec(TIER, false);

function mockInstanceAndUpdate(updateResult: { error: { message: string } | null }, row = {}) {
  const updateChain = {
    eq: jest.fn(),
  };
  // .update().eq("id", ...).eq("user_id", ...) resolves to the write result.
  updateChain.eq.mockReturnValueOnce(updateChain).mockResolvedValueOnce(updateResult);
  const updateSpy = jest.fn(() => updateChain);

  const selectChain: Record<string, jest.Mock> = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.eq = jest.fn(() => selectChain);
  selectChain.neq = jest.fn(() => selectChain);
  selectChain.single = jest.fn(async () => ({
    data: {
      id: "inst-1",
      user_id: "user_1",
      resource_tier: TIER,
      config: { infrastructure: { vmid: 201, node: "fixturenode1" } },
      hetzner_server_id: null,
      host_id: "host-1",
      status: "running",
      lifecycle_state: "active",
      proxmox_node: "fixturenode1",
      proxmox_vmid: 201,
      ...row,
    },
    error: null,
  }));

  (supabaseAdmin!.from as jest.Mock).mockImplementation(() => ({
    select: selectChain.select,
    update: updateSpy,
  }));

  return { updateSpy, updateChain };
}

describe("PATCH /api/instances/[id]/resize", () => {
  beforeEach(() => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({ ok: true, stdout: "resized\n", stderr: "" });
  });

  it("records the resized caps on the row after the VM resize succeeds", async () => {
    const { updateSpy, updateChain } = mockInstanceAndUpdate({ error: null });

    const response = await PATCH(new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" }), {
      params: Promise.resolve({ id: "inst-1" }),
    });

    expect(response.status).toBe(200);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cpu_limit: SPEC.cpuLimit, ram_limit: SPEC.ramLimitMb }),
    );
    expect(updateChain.eq).toHaveBeenCalledWith("user_id", "user_1");
  });

  it("does not report success when the row write fails after the VM was resized", async () => {
    mockInstanceAndUpdate({ error: { message: "connection reset" } });

    const response = await PATCH(new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" }), {
      params: Promise.resolve({ id: "inst-1" }),
    });

    expect(response.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      "instance resize database update failed after VM resize",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({ failureType: "instance_resize_row_update_failed", instanceId: "inst-1" }),
    );
  });
});

describe("placement resize", () => {
  const patch = () => PATCH(new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" }), {
    params: Promise.resolve({ id: "inst-1" }),
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(auth).mockResolvedValue({ userId: "user_1" } as never);
    jest.mocked(readManagedLaunchBridgeEpoch).mockResolvedValueOnce("placement");
    jest.mocked(supabaseAdmin!.rpc).mockReset().mockResolvedValue({ data: true, error: null } as never);
    jest.mocked(readInstanceLiveMutationBlock).mockReset().mockResolvedValue(null);
    jest.mocked(resizeProxmoxVm).mockReset().mockResolvedValue({ ok: true, stdout: "resized", stderr: "" });
  });

  it("reserves then records the host receipt and finalizes with the same owner fence", async () => {
    const { updateSpy } = mockInstanceAndUpdate({ error: null });
    const rpc = jest.mocked(supabaseAdmin!.rpc);
    rpc.mockResolvedValueOnce({ data: { status: "claimed" }, error: null } as never);
    expect((await patch()).status).toBe(200);
    const calls = rpc.mock.calls;
    expect(calls.map(([name]) => name)).toEqual([
      "resize_hermes_instance_allocation",
      "mark_hermes_instance_resize_host_config_applied",
      "complete_hermes_instance_resize_allocation",
    ]);
    const fence = { p_instance_id: "inst-1", p_user_id: "user_1", p_operation_id: expect.any(String) };
    for (const [, args] of calls) expect(args).toMatchObject(fence);
    expect(calls[2][1]).toEqual(calls[1][1]);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it.each([false, true])("handles a pre-existing operation (applied=%s) without dispatching again", async hostConfigApplied => {
    const { updateSpy } = mockInstanceAndUpdate({ error: null }, {
      resize_operation_id: "previous-operation", resize_target_cpu: SPEC.cpuLimit, resize_target_ram_mb: SPEC.ramLimitMb,
    });
    const rpc = jest.mocked(supabaseAdmin!.rpc);
    rpc.mockResolvedValueOnce({ data: { status: "reused", hostConfigApplied }, error: null } as never);
    expect((await patch()).status).toBe(hostConfigApplied ? 200 : 409);
    expect(resizeProxmoxVm).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(hostConfigApplied
      ? ["resize_hermes_instance_allocation", "complete_hermes_instance_resize_allocation"]
      : ["resize_hermes_instance_allocation"]);
  });

  it.each([
    { stdout: "HIVRA_RESIZE_NOT_DISPATCHED\n", stderr: "missing VM", tail: ["rollback_hermes_instance_resize_allocation"] },
    { stdout: "", stderr: "failed", tail: [] },
    { stdout: "", stderr: "timeout", tail: [] },
    { stdout: "HOST_CONFIG_APPLIED", stderr: "guest repair failed", tail: [
      "mark_hermes_instance_resize_host_config_applied", "complete_hermes_instance_resize_allocation",
    ] },
  ])("handles negative and partial host acknowledgements: $stderr", async ({ stdout, stderr, tail }) => {
    const { updateSpy } = mockInstanceAndUpdate({ error: null });
    const rpc = jest.mocked(supabaseAdmin!.rpc);
    rpc.mockResolvedValueOnce({ data: { status: "claimed" }, error: null } as never);
    jest.mocked(resizeProxmoxVm).mockResolvedValueOnce({ ok: false, stdout, stderr });
    expect((await patch()).status).toBe(500);
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(["resize_hermes_instance_allocation", ...tail]);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rolls back only its own new claim when dispatch preflight fails", async () => {
    mockInstanceAndUpdate({ error: null });
    const rpc = jest.mocked(supabaseAdmin!.rpc);
    rpc.mockResolvedValueOnce({ data: { status: "claimed" }, error: null } as never);
    jest.mocked(readInstanceLiveMutationBlock).mockResolvedValueOnce(null).mockResolvedValueOnce("owner changed");
    expect((await patch()).status).toBe(409);
    expect(resizeProxmoxVm).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenLastCalledWith("rollback_hermes_instance_resize_allocation", expect.objectContaining({
      p_user_id: "user_1", p_instance_id: "inst-1",
    }));
  });
});
