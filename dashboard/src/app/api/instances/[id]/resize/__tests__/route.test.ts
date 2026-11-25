import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveEffectiveTierSpec } from "@/lib/services/tier-specs";
import { resizeProxmoxVm, PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER } from "@/lib/services/proxmox-instance-service";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import { PATCH } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(), rpc: jest.fn(),
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
  ...jest.requireActual("@/lib/services/proxmox-instance-service"),
  getProxmoxInfrastructure: jest.fn(() => ({ vmid: 201, node: "fixturenode1" })),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER: "HIVRA_RESIZE_VM_CONFIG_APPLIED",
  resizeProxmoxVm: jest.fn(),
}));

const TIER = "operator";
const SPEC = resolveEffectiveTierSpec(TIER, false);

let currentInstanceData: Record<string, unknown> | null = null;

function rpcMockImplementation(holderValid = true) {
  return async (name: string, args?: { p_operation_id?: string; p_cpu?: number; p_ram_mb?: number }) => {
    if (name === "holder_seat_funding_valid") return { data: holderValid, error: null };
    if (currentInstanceData) {
      if (name === "resize_hermes_instance_allocation") {
        const existingOperationId = typeof currentInstanceData.resize_operation_id === "string"
          ? currentInstanceData.resize_operation_id
          : null;
        if (existingOperationId) {
          const targetMatches = existingOperationId === args?.p_operation_id
            && Number(currentInstanceData.resize_target_cpu) === Number(args?.p_cpu)
            && Number(currentInstanceData.resize_target_ram_mb) === Number(args?.p_ram_mb);
          if (!targetMatches) {
            return {
              data: null,
              error: { code: "P0058", message: "instance resize operation already in progress" },
            };
          }
          return {
            data: {
              status: "reused",
              operationId: existingOperationId,
              hostConfigApplied: currentInstanceData.resize_host_config_applied_at != null,
            },
            error: null,
          };
        }
        const cpu = args?.p_cpu ?? null;
        const ramMb = args?.p_ram_mb ?? null;
        currentInstanceData = {
          ...currentInstanceData,
          resize_operation_id: args?.p_operation_id ?? null,
          resize_operation_started_at: "2026-11-25T00:00:00.000Z",
          resize_previous_cpu: currentInstanceData.cpu_limit ?? null,
          resize_previous_ram_mb: currentInstanceData.ram_limit ?? null,
          resize_target_cpu: cpu,
          resize_target_ram_mb: ramMb,
          resize_host_config_applied_at: null,
          cpu_limit: cpu == null ? currentInstanceData.cpu_limit : Math.max(Number(currentInstanceData.cpu_limit ?? cpu), cpu),
          ram_limit: ramMb == null ? currentInstanceData.ram_limit : Math.max(Number(currentInstanceData.ram_limit ?? ramMb), ramMb),
        };
        return {
          data: { status: "claimed", operationId: args?.p_operation_id ?? null, hostConfigApplied: false },
          error: null,
        };
      }
      if (name === "mark_hermes_instance_resize_host_config_applied") {
        if (currentInstanceData.resize_operation_id !== args?.p_operation_id) return { data: false, error: null };
        currentInstanceData = {
          ...currentInstanceData,
          resize_host_config_applied_at: "2026-11-25T00:00:01.000Z",
        };
        return { data: true, error: null };
      }
      if (name === "complete_hermes_instance_resize_allocation" || name === "rollback_hermes_instance_resize_allocation") {
        if (currentInstanceData.resize_operation_id !== args?.p_operation_id) return { data: false, error: null };
        const completing = name === "complete_hermes_instance_resize_allocation";
        currentInstanceData = {
          ...currentInstanceData,
          cpu_limit: completing
            ? currentInstanceData.resize_target_cpu ?? currentInstanceData.cpu_limit
            : currentInstanceData.resize_previous_cpu ?? currentInstanceData.cpu_limit,
          ram_limit: completing
            ? currentInstanceData.resize_target_ram_mb ?? currentInstanceData.ram_limit
            : currentInstanceData.resize_previous_ram_mb ?? currentInstanceData.ram_limit,
          resize_operation_id: null,
          resize_operation_started_at: null,
          resize_previous_cpu: null,
          resize_previous_ram_mb: null,
          resize_target_cpu: null,
          resize_target_ram_mb: null,
          resize_host_config_applied_at: null,
        };
        return { data: true, error: null };
      }
    }
    if (name === "resize_hermes_instance_allocation") {
      return {
        data: { status: "claimed", operationId: args?.p_operation_id ?? null, hostConfigApplied: false },
        error: null,
      };
    }
    if (name === "mark_hermes_instance_resize_host_config_applied") return { data: true, error: null };
    if (name === "complete_hermes_instance_resize_allocation") return { data: true, error: null };
    if (name === "rollback_hermes_instance_resize_allocation") return { data: true, error: null };
    throw new Error(`unexpected rpc ${name}`);
  };
}

function mockInstance(fields: Record<string, unknown> = {}) {
  const updateSpy = jest.fn();
  const selectChain: Record<string, jest.Mock> = {};
  selectChain.select = jest.fn(() => selectChain);
  selectChain.eq = jest.fn(() => selectChain);
  selectChain.neq = jest.fn(() => selectChain);
  const baseInstance = {
    id: "inst-1",
    user_id: "user_1",
    resource_tier: TIER,
    seat_funding: "paid",
    cpu_limit: SPEC.cpuLimit,
    ram_limit: SPEC.ramLimitMb,
    config: { infrastructure: { vmid: 201, node: "fixturenode1" } },
    hetzner_server_id: null,
    host_id: "host-1",
    status: "running", lifecycle_state: "active",
    ...fields,
  };
  currentInstanceData = baseInstance;
  selectChain.single = jest.fn(async () => ({
    data: currentInstanceData,
    error: null,
  }));
  selectChain.maybeSingle = selectChain.single;

  (supabaseAdmin!.from as jest.Mock).mockImplementation(() => ({
    select: selectChain.select,
    update: updateSpy,
  }));
  (supabaseAdmin!.rpc as jest.Mock).mockImplementation(rpcMockImplementation());

  return { updateSpy };
}

function request() {
  return new NextRequest("http://localhost/api/instances/inst-1/resize", { method: "PATCH" });
}
const params = { params: Promise.resolve({ id: "inst-1" }) };

describe("PATCH /api/instances/[id]/resize", () => {
  beforeEach(() => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({ ok: true, stdout: `${PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER}\n`, stderr: "" });
  });

  it("reserves the allocation and completes the same operation after host confirmation", async () => {
    const { updateSpy } = mockInstance();

    const response = await PATCH(request(), params);

    expect(response.status).toBe(200);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    const rpcCalls = (supabaseAdmin!.rpc as jest.Mock).mock.calls;
    const begin = rpcCalls.find(([name]) => name === "resize_hermes_instance_allocation");
    const complete = rpcCalls.find(([name]) => name === "complete_hermes_instance_resize_allocation");
    expect(begin?.[1]).toEqual(expect.objectContaining({
      p_instance_id: "inst-1", p_user_id: "user_1", p_cpu: SPEC.cpuLimit, p_ram_mb: SPEC.ramLimitMb,
      p_operation_id: expect.any(String),
    }));
    expect(complete?.[1]).toEqual({
      p_instance_id: "inst-1", p_user_id: "user_1", p_operation_id: begin?.[1].p_operation_id,
    });
    expect(rpcCalls.some(([name]) => name === "rollback_hermes_instance_resize_allocation")).toBe(false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("rolls back only the fenced operation when the host mutation is not confirmed", async () => {
    mockInstance();
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({ ok: false, stdout: "", stderr: "qm set failed", error: "qm set failed" });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(500);
    const rpcCalls = (supabaseAdmin!.rpc as jest.Mock).mock.calls;
    const begin = rpcCalls.find(([name]) => name === "resize_hermes_instance_allocation");
    const rollback = rpcCalls.find(([name]) => name === "rollback_hermes_instance_resize_allocation");
    expect(rollback?.[1]).toEqual({
      p_instance_id: "inst-1", p_user_id: "user_1", p_operation_id: begin?.[1].p_operation_id,
    });
    expect(rpcCalls.some(([name]) => name === "complete_hermes_instance_resize_allocation")).toBe(false);
  });

  it("keeps the confirmed larger allocation when qm set applied but the reboot tail failed", async () => {
    mockInstance();
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: `${PROXMOX_RESIZE_VM_CONFIG_APPLIED_MARKER}\n[resize] graceful reboot failed\n`,
      stderr: "reboot failed",
      error: "reboot failed",
    });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(500);
    const rpcCalls = (supabaseAdmin!.rpc as jest.Mock).mock.calls;
    expect(rpcCalls.some(([name]) => name === "complete_hermes_instance_resize_allocation")).toBe(true);
    expect(rpcCalls.some(([name]) => name === "rollback_hermes_instance_resize_allocation")).toBe(false);
  });

  it("retains the qualified boost when repairing a paid seat", async () => {
    mockInstance();
    (isVeniceBoostEligible as jest.Mock).mockResolvedValueOnce(true);
    const response = await PATCH(request(), params);
    expect(response.status).toBe(200);
    expect(resizeProxmoxVm).toHaveBeenCalledWith(expect.objectContaining({ cpuLimit: 3, memoryMb: 6144 }), expect.anything());
  });

  it.each([true, false])("rechecks the saved holder allocation before a manual VM repair (admitted=%s)", async (valid) => {
    mockInstance({
      seat_funding: "holder", resource_tier: "command", cpu_limit: 1, ram_limit: 2048,
    });
    (supabaseAdmin!.rpc as jest.Mock).mockImplementation(rpcMockImplementation(valid));
    (resizeProxmoxVm as jest.Mock).mockClear();
    const response = await PATCH(request(), params);
    expect(response.status).toBe(valid ? 200 : 409);
    expect(isVeniceBoostEligible).not.toHaveBeenCalled();
    if (valid) expect(resizeProxmoxVm).toHaveBeenCalledWith(
      expect.objectContaining({ cpuLimit: 1, memoryMb: 2048 }), expect.anything(),
    );
    else expect(resizeProxmoxVm).not.toHaveBeenCalled();
    expect((supabaseAdmin!.rpc as jest.Mock).mock.calls.some(([name]) => name === "resize_hermes_instance_allocation")).toBe(false);
  });

  it("does not report success when allocation completion fails after the VM was resized", async () => {
    mockInstance();
    (supabaseAdmin!.rpc as jest.Mock).mockImplementation(async (name: string, args?: { p_operation_id?: string; p_cpu?: number; p_ram_mb?: number }) => {
      if (name === "complete_hermes_instance_resize_allocation") return { data: null, error: { message: "connection reset" } };
      return rpcMockImplementation()(name, args);
    });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      "instance resize allocation completion failed",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({ failureType: "instance_resize_allocation_completion_failed", instanceId: "inst-1" }),
    );
  });

  it("reuses the same fenced operation when a finalization failure is retried", async () => {
    mockInstance();
    (resizeProxmoxVm as jest.Mock).mockClear();
    const operationIds: string[] = [];
    let completionAttempts = 0;
    const realisticRpc = rpcMockImplementation();
    (supabaseAdmin!.rpc as jest.Mock).mockImplementation(async (name: string, args: { p_operation_id?: string }) => {
      if (name === "resize_hermes_instance_allocation") {
        operationIds.push(args.p_operation_id as string);
      }
      if (name === "complete_hermes_instance_resize_allocation") {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          return { data: null, error: { message: "connection reset" } };
        }
      }
      return realisticRpc(name, args);
    });

    const first = await PATCH(request(), params);
    const second = await PATCH(request(), params);

    expect(first.status).toBe(500);
    expect(second.status).toBe(200);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(operationIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    const completionOperationIds = (supabaseAdmin!.rpc as jest.Mock).mock.calls
      .filter(([name]) => name === "complete_hermes_instance_resize_allocation")
      .map(([, args]) => args.p_operation_id);
    expect(completionOperationIds).toEqual([operationIds[0], operationIds[0]]);
  });

  it("mints a fresh operation generation after the prior operation completes", async () => {
    mockInstance();

    const first = await PATCH(request(), params);
    const second = await PATCH(request(), params);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const operationIds = (supabaseAdmin!.rpc as jest.Mock).mock.calls
      .filter(([name]) => name === "resize_hermes_instance_allocation")
      .map(([, args]) => args.p_operation_id);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).not.toBe(operationIds[0]);
  });

  it("treats a missing remote exit status as indeterminate", async () => {
    mockInstance();
    (resizeProxmoxVm as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "Remote bash exited with code undefined",
      error: "Remote bash exited with code undefined",
    });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(500);
    const rpcNames = (supabaseAdmin!.rpc as jest.Mock).mock.calls.map(([name]) => name);
    expect(rpcNames).not.toContain("complete_hermes_instance_resize_allocation");
    expect(rpcNames).not.toContain("rollback_hermes_instance_resize_allocation");
  });

  it("refuses to dispatch against a different stored resize target", async () => {
    mockInstance({
      resize_operation_id: "existing-operation",
      resize_target_cpu: 0.5,
      resize_target_ram_mb: 1024,
    });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(409);
    expect(resizeProxmoxVm).not.toHaveBeenCalled();
    expect((supabaseAdmin!.rpc as jest.Mock).mock.calls.some(([name]) => name === "resize_hermes_instance_allocation")).toBe(false);
  });

  it("redispatches a matching stored operation when host application was not recorded", async () => {
    const operationId = "11111111-1111-4111-8111-111111111111";
    mockInstance({
      resize_operation_id: operationId,
      resize_target_cpu: SPEC.cpuLimit,
      resize_target_ram_mb: SPEC.ramLimitMb,
    });
    (resizeProxmoxVm as jest.Mock).mockClear();

    const response = await PATCH(request(), params);

    expect(response.status).toBe(200);
    expect(resizeProxmoxVm).toHaveBeenCalledTimes(1);
    const begin = (supabaseAdmin!.rpc as jest.Mock).mock.calls
      .find(([name]) => name === "resize_hermes_instance_allocation");
    expect(begin?.[1].p_operation_id).toBe(operationId);
  });

  it("retains the reserved allocation when the SSH outcome is indeterminate", async () => {
    mockInstance();
    (resizeProxmoxVm as jest.Mock).mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "",
      error: "SSH connection reset before remote output was lost",
    });

    const response = await PATCH(request(), params);

    expect(response.status).toBe(500);
    const rpcNames = (supabaseAdmin!.rpc as jest.Mock).mock.calls.map(([name]) => name);
    expect(rpcNames).not.toContain("complete_hermes_instance_resize_allocation");
    expect(rpcNames).not.toContain("rollback_hermes_instance_resize_allocation");
    expect(log.error).toHaveBeenCalledWith(
      "instance resize outcome is indeterminate; allocation remains reserved",
      expect.objectContaining({ message: "SSH connection reset before remote output was lost" }),
      expect.objectContaining({ failureType: "instance_resize_outcome_indeterminate", instanceId: "inst-1" }),
    );
  });
});
