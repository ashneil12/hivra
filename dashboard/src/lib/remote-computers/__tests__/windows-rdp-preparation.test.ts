jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import type { RemoteDesktopAgentRow } from "../guest-installation";
import { prepareWindowsRdpOnHivraAgent } from "../windows-rdp-preparation";

const ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "user_fixture";

const stable: RemoteDesktopAgentRow = {
  id: ID,
  user_id: USER_ID,
  type: "linux-desktop",
  computer_profile: "windows",
  computer_substrate: "proxmox-kvm",
  deployment_mode: "hivra-managed",
  status: "running",
  desired_state: "running",
  operation_id: null,
  operation_kind: null,
  vmid: 2098,
  ip: "10.240.20.98",
  chat_url: "https://fixture.invalid",
  infrastructure_binding_token_hash: "9".repeat(64),
  infrastructure_binding_token_enforced: true,
};
const operation = { ...stable, operation_id: OPERATION_ID, operation_kind: "desktop_prepare" };

function descriptor() {
  return {
    protocol: "hivra-windows-rdp-prepared-v1" as const,
    computerId: ID,
    vmid: 2098,
    profile: "windows" as const,
    guestPrivateIpv4: "10.240.20.98",
    inspectionRevision: "a".repeat(64),
    machineIdentitySha256: "b".repeat(64),
    bootIdentitySha256: "c".repeat(64),
    lastBootAt: new Date(Date.now() - 60_000).toISOString(),
    windowsCaption: "Microsoft Windows 11 Pro",
    windowsVersion: "10.0.26100",
    windowsBuild: "26100",
    licenseStatus: "licensed" as const,
    rdpServiceState: "running" as const,
    rdpServiceStartMode: "auto" as const,
    rdpPort: 3389 as const,
    nla: true as const,
    listenerVerified: true as const,
    certificateFingerprint: `sha256:${"d".repeat(64)}`,
    route: { status: "configured-not-proven" as const, sourceCidrs: ["10.240.20.1/32"], exclusive: true as const },
    privateNetworkReachable: false as const,
    observedAt: new Date().toISOString(),
  };
}

function dependencies(loadAgent: jest.Mock) {
  return {
    loadAgent,
    beginPrepare: jest.fn().mockResolvedValue({ operationId: OPERATION_ID, phase: "claimed", resumed: false }),
    dispatchPrepare: jest.fn().mockResolvedValue(true),
    cancelPrepare: jest.fn().mockResolvedValue(true),
    prepareGuest: jest.fn().mockResolvedValue({ ok: true, targetId: "node-b", vmid: 2098, changed: true, accessReady: false }),
    inspectCapability: jest.fn().mockResolvedValue({ ok: true, agentId: ID, targetId: "node-b", vmid: 2098, windowsDescriptor: descriptor() }),
    completePrepare: jest.fn().mockResolvedValue(true),
    retainPrepare: jest.fn().mockResolvedValue(true),
    gatewaySourceCidr: jest.fn().mockReturnValue("10.240.20.1/32"),
  };
}

it("prepares and verifies Windows RDP for only the VM bridge gateway", async () => {
  const loadAgent = jest.fn()
    .mockResolvedValueOnce(stable)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(stable);
  const deps = dependencies(loadAgent);

  await expect(prepareWindowsRdpOnHivraAgent(ID, deps)).resolves.toMatchObject({
    ok: true, targetId: "node-b", vmid: 2098, changed: true, accessReady: false,
  });
  expect(deps.prepareGuest).toHaveBeenCalledWith(USER_ID, operation, {
    computerId: ID,
    operationId: OPERATION_ID,
    vmid: 2098,
    guestPrivateIpv4: "10.240.20.98",
    gatewaySourceCidrs: ["10.240.20.1/32"],
  });
  expect(deps.completePrepare).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
    bootId: "c".repeat(64),
  }));
  expect(deps.retainPrepare).not.toHaveBeenCalled();
});

it("uses the configured private gateway for the exact Windows computer", async () => {
  const loadAgent = jest.fn()
    .mockResolvedValueOnce(stable)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(stable);
  const deps = dependencies(loadAgent);
  deps.gatewaySourceCidr = jest.fn().mockReturnValue("10.240.20.96/32");
  deps.inspectCapability.mockResolvedValue({ ok: true, agentId: ID, targetId: "node-b", vmid: 2098,
    windowsDescriptor: { ...descriptor(), route: { ...descriptor().route, sourceCidrs: ["10.240.20.96/32"] } } });

  await expect(prepareWindowsRdpOnHivraAgent(ID, deps)).resolves.toMatchObject({ ok: true });
  expect(deps.prepareGuest).toHaveBeenCalledWith(USER_ID, operation, expect.objectContaining({
    gatewaySourceCidrs: ["10.240.20.96/32"],
  }));
});

it("does not replay a dispatched Windows preparation", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(operation).mockResolvedValueOnce(operation)
    .mockResolvedValueOnce(operation).mockResolvedValueOnce(stable);
  const deps = dependencies(loadAgent);
  deps.beginPrepare.mockResolvedValue({ operationId: OPERATION_ID, phase: "dispatched", resumed: true });

  await expect(prepareWindowsRdpOnHivraAgent(ID, deps)).resolves.toMatchObject({
    ok: true, changed: false, accessReady: false,
  });
  expect(deps.dispatchPrepare).not.toHaveBeenCalled();
  expect(deps.prepareGuest).not.toHaveBeenCalled();
  expect(deps.inspectCapability).toHaveBeenCalledTimes(1);
});

it("holds an uncertain guest dispatch for observation", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(stable).mockResolvedValueOnce(operation);
  const deps = dependencies(loadAgent);
  deps.prepareGuest.mockResolvedValue({ ok: false, code: "transport_failed" });

  await expect(prepareWindowsRdpOnHivraAgent(ID, deps)).resolves.toMatchObject({
    ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("guest_transport_failed"),
  });
  expect(deps.prepareGuest).toHaveBeenCalledTimes(1);
  expect(deps.inspectCapability).not.toHaveBeenCalled();
  expect(deps.retainPrepare).toHaveBeenCalledTimes(1);
});

it("refuses a descriptor with a wider RDP source", async () => {
  const loadAgent = jest.fn().mockResolvedValueOnce(stable).mockResolvedValueOnce(operation).mockResolvedValueOnce(operation);
  const deps = dependencies(loadAgent);
  deps.inspectCapability.mockResolvedValue({ ok: true, agentId: ID, targetId: "node-b", vmid: 2098,
    windowsDescriptor: { ...descriptor(), route: { ...descriptor().route, sourceCidrs: ["10.240.20.1/24"] } } });

  await expect(prepareWindowsRdpOnHivraAgent(ID, deps)).resolves.toMatchObject({
    ok: false, code: "desktop_prepare_pending", error: expect.stringContaining("capability_unverified"),
  });
  expect(deps.completePrepare).not.toHaveBeenCalled();
});
