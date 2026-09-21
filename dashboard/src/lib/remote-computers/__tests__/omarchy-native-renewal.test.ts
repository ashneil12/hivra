jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { buildOmarchyGuardianRenewal, renewOmarchyNativeSession } from "../omarchy-native-renewal";

const USER_ID = "user_fixture";
const COMPUTER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ACTIVATION_ID = "44444444-4444-4444-8444-444444444444";
const RENEWAL_ID = "88888888-8888-4888-8888-888888888888";
const GENERATION = "66666666-6666-4666-8666-666666666666";
const BOOT_ID = "55555555-5555-4555-8555-555555555555";
const initialExpiry = Date.parse("2026-09-08T10:04:00.000Z");
const grant = {
  protocol: "hivra-omarchy-guardian-grant-v2",
  binding: { computerId: COMPUTER_ID, operationId: "22222222-2222-4222-8222-222222222222",
    vmid: 2099, ownerUid: 1000, guestPrivateIpv4: "10.240.20.99", waylandDisplay: "wayland-1" },
  ownerId: USER_ID, capabilityGeneration: GENERATION, observedRevision: "a".repeat(64),
  sessionId: SESSION_ID, leaseId: ACTIVATION_ID,
  clientId: "77777777-7777-4777-8777-777777777777",
  clientCertificatePem: "certificate", clientCertificateSha256: "b".repeat(64),
  guestBootId: BOOT_ID, expiresAtUnixMs: initialExpiry,
  deadlineBoottimeNs: 1_000_000_000_000, continuousDeadlineBoottimeNs: 44_000_000_000_000,
  runtimeMaxUsec: 180_000_000, sunshineSha256: "c".repeat(64), guardianSha256: "d".repeat(64),
  ownershipSha256: "e".repeat(64), preparedSha256: "f".repeat(64), unitSha256: "0".repeat(64),
} as const;
const agent = { id: COMPUTER_ID, user_id: USER_ID, type: "linux-desktop", computer_profile: "omarchy",
  status: "running", desired_state: "running", operation_id: null, operation_kind: null,
  vmid: 2099, ip: "10.240.20.99", infrastructure_binding_token_enforced: true,
  infrastructure_binding_token_hash: "9".repeat(64) };
const expiresAt = "2026-09-08T10:06:00.000Z";
const observedAt = "2026-09-08T10:02:00.000Z";

function dependencies(overrides: Record<string, unknown> = {}) {
  const renewal = buildOmarchyGuardianRenewal({ grant, renewalId: RENEWAL_ID, renewalCount: 1, expiresAt });
  return {
    loadGrant: jest.fn().mockResolvedValue({ ok: true, guardianGrant: grant }),
    loadAgent: jest.fn().mockResolvedValue(agent),
    claimRenewal: jest.fn().mockResolvedValue({ ok: true, renewal: { sessionId: SESSION_ID,
      activationId: ACTIVATION_ID, renewalId: RENEWAL_ID, renewalCount: 1,
      previousExpiresAt: new Date(initialExpiry).toISOString(), expiresAt,
      continuousExpiresAt: "2026-09-08T21:59:59.000Z", guardianRenewal: null } }),
    recordRenewal: jest.fn().mockResolvedValue({ ok: true }),
    refreshCapability: jest.fn().mockResolvedValue({ ok: true }),
    now: jest.fn(() => new Date(observedAt)),
    executeRenewal: jest.fn()
      .mockResolvedValueOnce({ ok: true, action: "renew", result: { ...renewal, renewal: "accepted", desktopReady: true } })
      .mockResolvedValue({ ok: true, action: "observe-renew", result: { ...renewal, renewal: "applied", desktopReady: true } }),
    wait: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

it("extends the exact running guardian without replacing its process", async () => {
  const deps = dependencies();
  await expect(renewOmarchyNativeSession(USER_ID, { computerId: COMPUTER_ID, sessionId: SESSION_ID,
    activationId: ACTIVATION_ID, renewalId: RENEWAL_ID }, deps as never)).resolves.toMatchObject({
    ok: true, renewalCount: 1, expiresAt, desktopReady: true,
  });
  expect(deps.refreshCapability).toHaveBeenCalledWith(expect.objectContaining({
    userId: USER_ID, computerId: COMPUTER_ID, capabilityGeneration: GENERATION,
    observedRevision: grant.observedRevision, observedAt,
  }));
  expect(deps.recordRenewal).toHaveBeenCalledTimes(1);
  expect(deps.executeRenewal.mock.calls.map(call => call[1])).toEqual(["renew", "observe-renew"]);
});

it("replays the exact recorded renewal after a lost response", async () => {
  const stored = buildOmarchyGuardianRenewal({ grant, renewalId: RENEWAL_ID, renewalCount: 1, expiresAt })!;
  const deps = dependencies({ claimRenewal: jest.fn().mockResolvedValue({ ok: true, renewal: {
    sessionId: SESSION_ID, activationId: ACTIVATION_ID, renewalId: RENEWAL_ID, renewalCount: 1,
    previousExpiresAt: new Date(initialExpiry).toISOString(), expiresAt,
    continuousExpiresAt: "2026-09-08T21:59:59.000Z", guardianRenewal: stored,
  } }) });
  await expect(renewOmarchyNativeSession(USER_ID, { computerId: COMPUTER_ID, sessionId: SESSION_ID,
    activationId: ACTIVATION_ID, renewalId: RENEWAL_ID }, deps as never)).resolves.toMatchObject({ ok: true });
  expect(deps.refreshCapability).toHaveBeenCalledTimes(1);
  expect(deps.recordRenewal).not.toHaveBeenCalled();
  expect(deps.executeRenewal).toHaveBeenNthCalledWith(1, USER_ID, "renew", grant, stored, agent);
});

it("does not refresh capability before guardian evidence is applied", async () => {
  const deps = dependencies({ executeRenewal: jest.fn().mockResolvedValue({ ok: false, code: "transport_failed" }) });
  await expect(renewOmarchyNativeSession(USER_ID, { computerId: COMPUTER_ID, sessionId: SESSION_ID,
    activationId: ACTIVATION_ID, renewalId: RENEWAL_ID }, deps as never)).resolves.toEqual({
    ok: false, code: "renewal_uncertain",
  });
  expect(deps.recordRenewal).toHaveBeenCalledTimes(1);
  expect(deps.refreshCapability).not.toHaveBeenCalled();
});

it("reports uncertainty when refreshed authority cannot be persisted after guardian evidence", async () => {
  const deps = dependencies({ refreshCapability: jest.fn().mockResolvedValue({ ok: false }) });
  await expect(renewOmarchyNativeSession(USER_ID, { computerId: COMPUTER_ID, sessionId: SESSION_ID,
    activationId: ACTIVATION_ID, renewalId: RENEWAL_ID }, deps as never)).resolves.toEqual({
    ok: false, code: "renewal_uncertain",
  });
  expect(deps.executeRenewal.mock.calls.map(call => call[1])).toEqual(["renew", "observe-renew"]);
  expect(deps.refreshCapability).toHaveBeenCalledTimes(1);
});

it("holds the existing deadline when mutation acknowledgement is uncertain", async () => {
  const deps = dependencies({ executeRenewal: jest.fn().mockResolvedValue({ ok: false, code: "transport_failed" }) });
  await expect(renewOmarchyNativeSession(USER_ID, { computerId: COMPUTER_ID, sessionId: SESSION_ID,
    activationId: ACTIVATION_ID, renewalId: RENEWAL_ID }, deps as never)).resolves.toEqual({
    ok: false, code: "renewal_uncertain",
  });
  expect(deps.executeRenewal).toHaveBeenCalledTimes(1);
});
