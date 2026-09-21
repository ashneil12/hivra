import { publishPreparedProviderComputer, retireUnusedPreparedProviderComputer } from "../provider-computer-preparation";
import { parseProviderGuestDiscoveryOutput } from "../host-discovery";
import { providerGuestBundleScopeSha256, type ProviderGuestBundleReceipt } from "../provider-guest-bundle";
import { PORTABLE_HIVRA_PROVISIONER_VERSION } from "../portable-provisioner-contract";
import { receiverFixture, firstBootNow } from "./first-boot-receiver.fixtures";
import { guestDiscoveryOutput } from "./provider-guest-discovery.fixtures";
import { providerVmTarget } from "./provider-vm-target.fixtures";

const mockRpc = jest.fn();
const mockGetTarget = jest.fn();
jest.mock("../connection-store", () => ({ getInfrastructureDeploymentTarget: (...args: unknown[]) => mockGetTarget(...args) }));
const mockQuery = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args), from: jest.fn(() => mockQuery),
} }));

function fixture() {
  const f = receiverFixture(), scope = { binding: f.binding, providerServerId: "42" };
  const lease = { ...scope, leaseId: "55555555-5555-4555-8555-555555555555" };
  const snapshot = parseProviderGuestDiscoveryOutput({ output: guestDiscoveryOutput(),
    discoveryId: lease.leaseId, connectionId: f.binding.connectionId, connectionRevision: f.binding.connectionRevision,
    providerServerId: "42", capacityOrderId: f.binding.orderId, enrollmentAttemptId: f.binding.attemptId,
    normalizedHostFingerprint: f.host.fingerprintSha256, observedAt: firstBootNow });
  const receipt: ProviderGuestBundleReceipt = { version: 1, state: "bundle_installed",
    provisionerVersion: PORTABLE_HIVRA_PROVISIONER_VERSION, bundleSha256: "b".repeat(64),
    scopeSha256: providerGuestBundleScopeSha256(scope) };
  const powerOnAction = { id: 603, command: "start_server" as const, status: "success" as const,
    resources: [{ id: 42, type: "server" as const }] };
  const target = providerVmTarget();
  Object.assign(target, { connectionId: f.binding.connectionId, evidenceConnectionRevision: f.binding.connectionRevision });
  Object.assign(target.capabilities, { capacityOrderId: f.binding.orderId, enrollmentAttemptId: f.binding.attemptId,
    hostIdentityDigest: snapshot.hostIdentityDigest });
  Object.assign(target.capabilities.provisioner, { ready: true, scopeSha256: receipt.scopeSha256 });
  const ready = structuredClone(target);
  ready.status = "ready"; ready.lastErrorCode = null; ready.capabilities.launchReady = true;
  mockRpc.mockImplementation(async name => ({ data: name === "admit_prepared_provider_computer" ? true : target, error: null }));
  mockGetTarget.mockResolvedValue(ready);
  return { input: { lease, snapshot, receipt, powerOnAction }, target, ready, f };
}

beforeEach(() => {
  mockRpc.mockReset(); mockGetTarget.mockReset(); mockQuery.select.mockReset().mockReturnValue(mockQuery);
  mockQuery.eq.mockReset().mockReturnValue(mockQuery); mockQuery.maybeSingle.mockReset();
});

it("publishes exact same-lease evidence, admits the adapter and reads back actual readiness", async () => {
  const h = fixture(), b = h.f.binding;
  await expect(publishPreparedProviderComputer(h.input)).resolves.toEqual(h.ready);
  expect(mockRpc).toHaveBeenCalledWith("publish_prepared_provider_computer", {
    p_user_id: b.userId, p_connection_id: b.connectionId, p_revision: b.connectionRevision,
    p_order_id: b.orderId, p_attempt_id: b.attemptId, p_quote: b.quoteFingerprint,
    p_server: "42", p_lease_id: h.input.lease.leaseId, p_snapshot: h.input.snapshot,
    p_receipt: h.input.receipt, p_power_action: h.input.powerOnAction,
  });
  expect(h.target.status).toBe("unavailable"); expect(h.target.capabilities.launchReady).toBe(false);
  expect(mockRpc).toHaveBeenNthCalledWith(2, "admit_prepared_provider_computer", {
    p_user_id: b.userId, p_connection_id: b.connectionId, p_revision: b.connectionRevision,
    p_order_id: b.orderId, p_attempt_id: b.attemptId, p_server: "42",
    p_lease_id: h.input.lease.leaseId, p_target_id: h.target.id, p_receipt: h.input.receipt,
  });
  expect(mockGetTarget).toHaveBeenCalledWith(b.userId, h.target.id);
});

it.each(["false", "error", "transport"])("does not claim readiness after %s admission", async kind => {
  const h = fixture();
  mockRpc.mockImplementation(async name => {
    if (name !== "admit_prepared_provider_computer") return { data: h.target, error: null };
    if (kind === "transport") throw new Error("private database detail");
    return { data: kind === "error" ? null : false, error: kind === "error" ? {} : null };
  });
  await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "checkpoint_failed" });
  expect(mockGetTarget).not.toHaveBeenCalled();
});

it.each(["unavailable", "foreign", "changed_bundle", "missing"])("rejects %s readback after admission", async kind => {
  const h = fixture();
  if (kind === "unavailable") mockGetTarget.mockResolvedValue(h.target);
  if (kind === "foreign") h.ready.id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  if (kind === "changed_bundle") h.ready.capabilities.provisioner.bundleSha256 = "f".repeat(64);
  if (kind === "missing") mockGetTarget.mockResolvedValue(null);
  await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "checkpoint_failed" });
});

it.each(["discoveryId", "connectionId", "connectionRevision", "capacityOrderId", "enrollmentAttemptId", "providerServerId"])(
  "rejects mismatched discovery %s before publication", async field => {
    const h = fixture(); Object.assign(h.input.snapshot, { [field]: field === "connectionRevision" ? 8
      : field === "providerServerId" ? "43" : "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "invalid_evidence" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

it.each(["bundleSha256", "scopeSha256", "provisionerVersion", "state"])("rejects invalid receipt %s before publication", async field => {
  const h = fixture(); Object.assign(h.input.receipt, { [field]: "invalid" });
  await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "invalid_evidence" });
  expect(mockRpc).not.toHaveBeenCalled();
});

it.each(["connection", "revision", "server", "order", "attempt", "host", "scope", "bundle", "launch"])(
  "does not accept unrelated or overclaimed returned %s evidence", async field => {
    const h = fixture(), other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    if (field === "connection") h.target.connectionId = other;
    if (field === "revision") h.target.evidenceConnectionRevision++;
    if (field === "server") h.target.externalId = "43";
    if (field === "order") h.target.capabilities.capacityOrderId = other;
    if (field === "attempt") h.target.capabilities.enrollmentAttemptId = other;
    if (field === "host") h.target.capabilities.hostIdentityDigest = "f".repeat(64);
    if (field === "scope") h.target.capabilities.provisioner.scopeSha256 = "f".repeat(64);
    if (field === "bundle") h.target.capabilities.provisioner.bundleSha256 = "f".repeat(64);
    if (field === "launch") Object.assign(h.target.capabilities, { launchReady: true });
    await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "checkpoint_failed" });
  });

it("requires observed successful power-on, not inferred running state", async () => {
  const h = fixture(); Object.assign(h.input.powerOnAction, { status: "running" });
  await expect(publishPreparedProviderComputer(h.input)).rejects.toMatchObject({ code: "invalid_evidence" });
  expect(mockRpc).not.toHaveBeenCalled();
});

it.each(["missing", "error", "transport"])("does not turn %s database evidence into success or expose raw errors", async kind => {
  const h = fixture();
  if (kind === "transport") mockRpc.mockRejectedValue(new Error("private database detail"));
  else mockRpc.mockResolvedValue({ data: null, error: kind === "error" ? { message: "private database detail" } : null });
  await expect(publishPreparedProviderComputer(h.input)).rejects.toThrow("Provider computer preparation failed: checkpoint_failed");
});

it("retires only the exact owned unused computer, leaving agent ownership to the SQL boundary", async () => {
  const h = fixture(), b = h.f.binding;
  mockQuery.maybeSingle.mockResolvedValue({ data: { id: h.target.id }, error: null });
  mockRpc.mockResolvedValue({ data: false, error: null });
  await expect(retireUnusedPreparedProviderComputer({ userId: b.userId, connectionId: b.connectionId,
    expectedRevision: b.connectionRevision, orderId: b.orderId, providerServerId: "42" })).resolves.toBe(false);
  expect(mockQuery.eq.mock.calls).toEqual([["user_id", b.userId], ["connection_id", b.connectionId],
    ["evidence_connection_revision", b.connectionRevision], ["provider_capacity_order_id", b.orderId], ["external_id", "42"]]);
  expect(mockRpc).toHaveBeenCalledWith("retire_hivra_provider_target", expect.objectContaining({
    p_target_id: h.target.id, p_agent_id: null, p_operation_id: null,
  }));
});
