jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { activateOmarchyNativeSession } from "../omarchy-native-activation";
import {
  OMARCHY_NATIVE_GUARDIAN_SHA256,
  OMARCHY_NATIVE_INSPECTION_REVISION,
  OMARCHY_NATIVE_OWNERSHIP_SHA256,
  OMARCHY_DESKTOP_SESSION_REVISION,
} from "../omarchy-native-capability";

const USER_ID = "user_fixture";
const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVATION_ID = "44444444-4444-4444-8444-444444444444";
const GENERATION = "66666666-6666-4666-8666-666666666666";
const SERVER_CERTIFICATE = "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n";

const agent = {
  id: COMPUTER_ID, user_id: USER_ID, type: "linux-desktop", computer_profile: "omarchy",
  status: "running", desired_state: "running", operation_id: null, operation_kind: null,
  vmid: 2099, ip: "10.240.20.99", infrastructure_binding_token_enforced: true,
  infrastructure_binding_token_hash: "9".repeat(64),
};
const descriptor = {
  protocol: "hivra-omarchy-native-prepared-v2", computerId: COMPUTER_ID, vmid: 2099,
  profile: "omarchy", guestPrivateIpv4: "10.240.20.99",
  inspectionRevision: OMARCHY_NATIVE_INSPECTION_REVISION,
  preparationOperationId: "22222222-2222-4222-8222-222222222222", serviceOwnerUid: 1000,
  waylandDisplay: "wayland-1", omarchyPackageVersion: "4.0.2-1",
  sunshineVersion: "2026.516.143833-4", guardianSha256: OMARCHY_NATIVE_GUARDIAN_SHA256,
  ownershipSha256: OMARCHY_NATIVE_OWNERSHIP_SHA256, sunshineSha256: "c".repeat(64),
  preparedSha256: "d".repeat(64), guestBootId: "55555555-5555-4555-8555-555555555555",
  observedBoottimeNs: "1000000000000", compositor: "wayland-hyprland",
  route: { status: "configured-proven", publicIpv4: "198.51.100.11", tcpPorts: [47984, 47989, 48010],
    udpPorts: [5353, 47998, 47999, 48000, 48002, 48010], sourceCidrs: ["10.240.20.1/32"] },
  privateNetworkReachable: true, supportsInputTakeover: true,
  observedAt: new Date().toISOString(),
};

function dependencies(overrides: Record<string, unknown> = {}) {
  const claim = {
    activationId: ACTIVATION_ID, sessionId: SESSION_ID, ownerId: USER_ID,
    computerId: COMPUTER_ID, capabilityGeneration: GENERATION,
    observedRevision: OMARCHY_DESKTOP_SESSION_REVISION,
    clientId: "77777777-7777-4777-8777-777777777777",
    clientCertificatePem: "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
    clientCertificateSha256: "b".repeat(64), streamingMode: "hq",
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    continuousExpiresAt: new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
  };
  return {
    loadAgent: jest.fn().mockResolvedValue(agent),
    inspectCapability: jest.fn().mockResolvedValue({
      ok: true, receipt: { capabilityGeneration: GENERATION }, nativeDescriptor: descriptor,
    }),
    claimActivation: jest.fn().mockResolvedValue({ ok: true, claim }),
    recordGrant: jest.fn().mockResolvedValue({ ok: true }),
    executeGuardian: jest.fn()
      .mockResolvedValueOnce({
        ok: true, action: "activate", result: { sessionId: SESSION_ID, leaseId: ACTIVATION_ID,
          activation: "started", desktopReady: false },
      })
      .mockResolvedValue({
        ok: true, action: "observe-ready", result: {
          sessionId: SESSION_ID, leaseId: ACTIVATION_ID,
          guestBootId: descriptor.guestBootId, capabilityGeneration: GENERATION,
          observedRevision: OMARCHY_DESKTOP_SESSION_REVISION, serverId: COMPUTER_ID,
          guestPrivateIpv4: descriptor.guestPrivateIpv4,
          serverCertificatePem: SERVER_CERTIFICATE, serverCertificateSha256: "8".repeat(64),
          pairingVerified: true, desktopReady: true,
        },
      }),
    activationId: jest.fn(() => ACTIVATION_ID),
    wait: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

it("claims and dispatches one exact freshly inspected guardian grant", async () => {
  const deps = dependencies();
  await expect(activateOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, sessionToken: `hrs1_${"t".repeat(43)}`,
  }, deps as never)).resolves.toEqual({
    ok: true, sessionId: SESSION_ID, activationId: ACTIVATION_ID, streamingMode: "hq",
    desktopReady: true, pairingVerified: true, guestBootId: descriptor.guestBootId,
    serverId: COMPUTER_ID, guestPrivateIpv4: descriptor.guestPrivateIpv4,
    connectionIpv4: descriptor.route.publicIpv4,
    serverCertificatePem: SERVER_CERTIFICATE, serverCertificateSha256: "8".repeat(64),
  });
  expect(deps.inspectCapability).toHaveBeenCalledWith(COMPUTER_ID, expect.anything(), { persistReceipt: false });
  expect(deps.claimActivation).toHaveBeenCalledTimes(1);
  expect(deps.recordGrant).toHaveBeenCalledWith({
    userId: USER_ID, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
    guardianGrant: expect.objectContaining({ sessionId: SESSION_ID, leaseId: ACTIVATION_ID }),
  });
  expect(deps.loadAgent).toHaveBeenCalledTimes(2);
  expect(deps.executeGuardian).toHaveBeenNthCalledWith(
    1,
    USER_ID, "activate",
    expect.objectContaining({ sessionId: SESSION_ID, leaseId: ACTIVATION_ID,
      capabilityGeneration: GENERATION, unitSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    agent,
  );
  expect(deps.executeGuardian).toHaveBeenNthCalledWith(
    2, USER_ID, "observe-ready", expect.objectContaining({ leaseId: ACTIVATION_ID }), agent,
  );
});

it("does not dispatch when the exact grant cannot be persisted", async () => {
  const deps = dependencies({
    recordGrant: jest.fn().mockResolvedValue({ ok: false, code: "activation_grant_denied" }),
  });
  await expect(activateOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, sessionToken: `hrs1_${"t".repeat(43)}`,
  }, deps as never)).resolves.toEqual({ ok: false, code: "activation_denied" });
  expect(deps.executeGuardian).not.toHaveBeenCalled();
});

it("refuses a capability generation mismatch before guest dispatch", async () => {
  const deps = dependencies({ inspectCapability: jest.fn().mockResolvedValue({
    ok: true, receipt: { capabilityGeneration: "88888888-8888-4888-8888-888888888888" },
    nativeDescriptor: descriptor,
  }) });
  await expect(activateOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, sessionToken: `hrs1_${"t".repeat(43)}`,
  }, deps as never)).resolves.toEqual({ ok: false, code: "activation_denied" });
  expect(deps.executeGuardian).not.toHaveBeenCalled();
});

it("reports an uncertain dispatch once without retrying", async () => {
  const deps = dependencies({ executeGuardian: jest.fn().mockResolvedValue({ ok: false, code: "transport_failed" }) });
  await expect(activateOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, sessionToken: `hrs1_${"t".repeat(43)}`,
  }, deps as never)).resolves.toEqual({ ok: false, code: "activation_uncertain" });
  expect(deps.executeGuardian).toHaveBeenCalledTimes(1);
});

it("polls only the read-only observer while startup is pending", async () => {
  const deps = dependencies();
  deps.executeGuardian
    .mockReset()
    .mockResolvedValueOnce({ ok: true, action: "activate", result: {
      sessionId: SESSION_ID, leaseId: ACTIVATION_ID, activation: "started", desktopReady: false,
    } })
    .mockResolvedValueOnce({ ok: false, code: "transport_failed" })
    .mockResolvedValueOnce({ ok: true, action: "observe-ready", result: {
      sessionId: SESSION_ID, leaseId: ACTIVATION_ID, guestBootId: descriptor.guestBootId,
      capabilityGeneration: GENERATION, observedRevision: OMARCHY_DESKTOP_SESSION_REVISION,
      serverId: COMPUTER_ID, guestPrivateIpv4: descriptor.guestPrivateIpv4,
      serverCertificatePem: SERVER_CERTIFICATE, serverCertificateSha256: "8".repeat(64),
      pairingVerified: true, desktopReady: true,
    } });
  await expect(activateOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, sessionToken: `hrs1_${"t".repeat(43)}`,
  }, deps as never)).resolves.toMatchObject({ ok: true, desktopReady: true });
  expect(deps.executeGuardian.mock.calls.map(call => call[1])).toEqual([
    "activate", "observe-ready", "observe-ready",
  ]);
  expect(deps.wait).toHaveBeenCalledTimes(1);
});
