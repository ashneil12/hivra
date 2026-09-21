jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import type { RemoteDesktopAgentRow } from "../guest-installation";
import { prepareOmarchyNativeOnHivraAgent } from "../omarchy-native-preparation";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user_fixture";

const stable: RemoteDesktopAgentRow = {
  id: ID,
  user_id: USER_ID,
  type: "linux-desktop",
  computer_profile: "omarchy",
  computer_substrate: "proxmox-kvm",
  deployment_mode: "hivra-managed",
  status: "running",
  desired_state: "running",
  operation_id: null,
  operation_kind: null,
  vmid: 2099,
  ip: "10.240.20.99",
  chat_url: "https://fixture.invalid",
  infrastructure_binding_token_hash: "9".repeat(64),
  infrastructure_binding_token_enforced: true,
};
const operation = { ...stable, operation_id: OPERATION_ID, operation_kind: "desktop_prepare" };

function descriptor() {
  return {
    protocol: "hivra-omarchy-native-prepared-v2" as const,
    computerId: ID,
    vmid: 2099,
    profile: "omarchy" as const,
    guestPrivateIpv4: "10.240.20.99",
    inspectionRevision: "2026.09.08.2",
    preparationOperationId: OPERATION_ID,
    serviceOwnerUid: 1000,
    waylandDisplay: "wayland-1",
    omarchyPackageVersion: "4.0.2-1",
    sunshineVersion: "2026.516.143833-4",
    guardianSha256: "6dec977b62db97dc3313c1e7e045c184332bca938a000d9193498883507a773b",
    ownershipSha256: "0f988ab03729e381531c923e835f0eaca80d23a77339cb1d13f234780b27f950",
    sunshineSha256: "a".repeat(64),
    preparedSha256: "b".repeat(64),
    guestBootId: "33333333-3333-4333-8333-333333333333",
    observedBoottimeNs: "123456789",
    compositor: "wayland-hyprland" as const,
    route: { status: "configured-proven" as const, publicIpv4: "198.51.100.11",
      tcpPorts: [47984, 47989, 48010] as [47984, 47989, 48010],
      udpPorts: [5353, 47998, 47999, 48000, 48002, 48010] as [5353, 47998, 47999, 48000, 48002, 48010], sourceCidrs: ["10.240.20.1/24"] },
    privateNetworkReachable: true as const,
    supportsInputTakeover: true as const,
    observedAt: new Date().toISOString(),
  };
}

function dependencies(loadAgent: jest.Mock) {
  return {
    loadAgent,
    beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "claimed", resumed: false }),
    dispatchPrepare: jest.fn().mockResolvedValue(true),
    cancelPrepare: jest.fn().mockResolvedValue(true),
    prepareGuest: jest.fn().mockResolvedValue({ ok: true, targetId: "node-b", vmid: 2099,
      binding: { computerId: ID, operationId: OPERATION_ID, vmid: 2099, guestPrivateIpv4: "10.240.20.99", ownerUid: 1000, waylandDisplay: "wayland-1" } }),
    inspectCapability: jest.fn().mockResolvedValue({ ok: true, agentId: ID, targetId: "node-b", vmid: 2099, nativeDescriptor: descriptor() }),
    completePrepare: jest.fn().mockResolvedValue(true),
    retainPrepare: jest.fn().mockResolvedValue(true),
  };
}

it("dispatches, proves, and completes one exact dormant Omarchy preparation", async () => {
  const loadAgent = jest.fn()
    .mockResolvedValueOnce(stable)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(stable);
  const deps = dependencies(loadAgent);
  const result = await prepareOmarchyNativeOnHivraAgent(ID, deps);

  expect(result).toMatchObject({ ok: true, targetId: "node-b", vmid: 2099, changed: true, accessReady: false });
  expect(deps.dispatchPrepare).toHaveBeenCalledWith(USER_ID, OPERATION_ID);
  expect(deps.prepareGuest).toHaveBeenCalledTimes(1);
  expect(deps.inspectCapability).toHaveBeenCalledWith(ID, expect.objectContaining({ loadAgent: expect.any(Function) }),
    { preparationOperationId: OPERATION_ID });
  expect(deps.completePrepare).toHaveBeenCalledWith(USER_ID, {
    version: 1, operationId: OPERATION_ID, computerId: ID, vmid: 2099, guestIp: "10.240.20.99",
    bindingTag: "hivra-bind-" + "9".repeat(32), bootId: "33333333-3333-4333-8333-333333333333", exitCode: 0,
  });
  expect(deps.retainPrepare).not.toHaveBeenCalled();
});

it("re-converges a dispatched operation before inspecting capability", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(operation).mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation).mockResolvedValueOnce(stable);
  const deps = dependencies(loadAgent);
  deps.beginPrepare.mockResolvedValue({ operationId: OPERATION_ID, phase: "dispatched", resumed: true });

  const result = await prepareOmarchyNativeOnHivraAgent(ID, deps);

  expect(result).toMatchObject({ ok: true, changed: false, accessReady: false });
  expect(deps.dispatchPrepare).not.toHaveBeenCalled();
  expect(deps.prepareGuest).toHaveBeenCalledTimes(1);
  expect(deps.inspectCapability).toHaveBeenCalledTimes(1);
  expect(deps.completePrepare).toHaveBeenCalledTimes(1);
});

it("retains uncertain guest dispatch and never retries it", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(stable).mockResolvedValueOnce(operation);
  const deps = dependencies(loadAgent);
  deps.prepareGuest.mockResolvedValue({ ok: false, code: "transport_failed", reason: "host_ssh" });

  const result = await prepareOmarchyNativeOnHivraAgent(ID, deps);

  expect(result).toMatchObject({ ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("guest_transport_failed_host_ssh") });
  expect(deps.prepareGuest).toHaveBeenCalledTimes(1);
  expect(deps.inspectCapability).not.toHaveBeenCalled();
  expect(deps.completePrepare).not.toHaveBeenCalled();
  expect(deps.cancelPrepare).not.toHaveBeenCalled();
  expect(deps.retainPrepare).toHaveBeenCalledTimes(1);
});

it("holds the operation when dormant capability evidence does not match", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(stable).mockResolvedValueOnce(operation).mockResolvedValueOnce(operation);
  const deps = dependencies(loadAgent);
  deps.inspectCapability.mockResolvedValue({ ok: true, agentId: ID, targetId: "node-b", vmid: 2099,
    nativeDescriptor: { ...descriptor(), preparationOperationId: "44444444-4444-4444-8444-444444444444" } });

  const result = await prepareOmarchyNativeOnHivraAgent(ID, deps);

  expect(result).toMatchObject({ ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("capability_unverified") });
  expect(deps.completePrepare).not.toHaveBeenCalled();
  expect(deps.retainPrepare).toHaveBeenCalledTimes(1);
});

it("requires stable final state after terminal completion", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(stable).mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation).mockResolvedValueOnce(operation);
  const deps = dependencies(loadAgent);
  const result = await prepareOmarchyNativeOnHivraAgent(ID, deps);
  expect(result).toMatchObject({ ok: false, code: "computer_not_ready", error: expect.stringContaining("finished") });
  expect(deps.completePrepare).toHaveBeenCalledTimes(1);
});
