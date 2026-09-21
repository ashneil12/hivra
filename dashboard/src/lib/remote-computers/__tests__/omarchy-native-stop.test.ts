jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { stopOmarchyNativeSession } from "../omarchy-native-stop";

const USER_ID = "user_fixture";
const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVATION_ID = "44444444-4444-4444-8444-444444444444";
const BOOT_ID = "55555555-5555-4555-8555-555555555555";
const GENERATION = "66666666-6666-4666-8666-666666666666";

const grant = {
  protocol: "hivra-omarchy-guardian-grant-v2",
  binding: { computerId: COMPUTER_ID, operationId: "22222222-2222-4222-8222-222222222222",
    vmid: 2099, ownerUid: 1000, guestPrivateIpv4: "10.240.20.99", waylandDisplay: "wayland-1" },
  ownerId: USER_ID, capabilityGeneration: GENERATION, observedRevision: "a".repeat(64),
  sessionId: SESSION_ID, leaseId: ACTIVATION_ID,
  clientId: "77777777-7777-4777-8777-777777777777",
  clientCertificatePem: "certificate", clientCertificateSha256: "b".repeat(64),
  guestBootId: BOOT_ID, expiresAtUnixMs: 1_788_847_440_000,
  deadlineBoottimeNs: 1_000_000_000_000, continuousDeadlineBoottimeNs: 44_000_000_000_000,
  runtimeMaxUsec: 60_000_000,
  sunshineSha256: "c".repeat(64), guardianSha256: "d".repeat(64),
  ownershipSha256: "e".repeat(64), preparedSha256: "f".repeat(64), unitSha256: "0".repeat(64),
};
const agent = {
  id: COMPUTER_ID, user_id: USER_ID, type: "linux-desktop", computer_profile: "omarchy",
  status: "running", desired_state: "running", operation_id: null, operation_kind: null,
  vmid: 2099, ip: "10.240.20.99", infrastructure_binding_token_enforced: true,
  infrastructure_binding_token_hash: "9".repeat(64),
};

function dependencies() {
  return {
    loadGrant: jest.fn().mockResolvedValue({ ok: true, guardianGrant: grant }),
    loadAgent: jest.fn().mockResolvedValue(agent),
    executeGuardian: jest.fn()
      .mockResolvedValueOnce({ ok: true, action: "revoke", result: {
        leaseId: ACTIVATION_ID, sessionId: SESSION_ID, reason: "control-plane-revoked",
        revocation: "requested", releasePending: true, desktopReady: false,
      } })
      .mockResolvedValueOnce({ ok: false, code: "transport_failed" })
      .mockResolvedValueOnce({ ok: true, action: "observe-stop", result: {
        leaseId: ACTIVATION_ID, sessionId: SESSION_ID, guestBootId: BOOT_ID,
        invocationId: "1".repeat(32), ownedProcessBoundaryStopped: true,
        releasePending: true, desktopReady: false,
      } })
      .mockResolvedValueOnce({ ok: true, action: "release-stop", result: {
        leaseId: ACTIVATION_ID, sessionId: SESSION_ID, guestBootId: BOOT_ID,
        invocationId: "1".repeat(32), ownedProcessBoundaryStopped: true,
        controllerReleased: true, releasePending: false, desktopReady: false,
      } }),
    revokeSession: jest.fn().mockResolvedValue({ ok: true, inputState: "released" }),
    wait: jest.fn().mockResolvedValue(undefined),
  };
}

it("revokes, observes, releases and closes one exact stored activation", async () => {
  const deps = dependencies();
  await expect(stopOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
  }, deps as never)).resolves.toEqual({
    ok: true, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
    controllerReleased: true, desktopReady: false,
  });
  expect(deps.executeGuardian.mock.calls.map(call => call[1])).toEqual([
    "revoke", "observe-stop", "observe-stop", "release-stop",
  ]);
  expect(deps.wait).toHaveBeenCalledTimes(1);
  expect(deps.revokeSession).toHaveBeenCalledWith({
    userId: USER_ID, sessionId: SESSION_ID, reason: "user_revoked",
  });
});

it("never dispatches a changed stored grant", async () => {
  const deps = dependencies();
  deps.loadGrant.mockResolvedValue({ ok: true, guardianGrant: {
    ...grant, binding: { ...grant.binding, computerId: "88888888-8888-4888-8888-888888888888" },
  } });
  await expect(stopOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
  }, deps as never)).resolves.toEqual({ ok: false, code: "stop_denied" });
  expect(deps.executeGuardian).not.toHaveBeenCalled();
});

it("holds an uncertain stop without releasing database authority", async () => {
  const deps = dependencies();
  deps.executeGuardian.mockReset().mockResolvedValue({ ok: false, code: "transport_failed" });
  await expect(stopOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
  }, deps as never)).resolves.toEqual({ ok: false, code: "stop_uncertain" });
  expect(deps.executeGuardian).toHaveBeenCalledTimes(1);
  expect(deps.revokeSession).not.toHaveBeenCalled();
});

it("recovers a lost final response from an already-released guest lease", async () => {
  const deps = dependencies();
  deps.executeGuardian.mockReset().mockResolvedValue({ ok: true, action: "revoke", result: {
    leaseId: ACTIVATION_ID, sessionId: SESSION_ID, reason: "control-plane-revoked",
    revocation: "requested", releasePending: false, desktopReady: false,
  } });
  await expect(stopOmarchyNativeSession(USER_ID, {
    computerId: COMPUTER_ID, sessionId: SESSION_ID, activationId: ACTIVATION_ID,
  }, deps as never)).resolves.toMatchObject({ ok: true, controllerReleased: true });
  expect(deps.executeGuardian).toHaveBeenCalledTimes(1);
  expect(deps.revokeSession).toHaveBeenCalledTimes(1);
});
