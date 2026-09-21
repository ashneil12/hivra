/** @jest-environment node */
jest.mock("server-only", () => ({}));

const mockRead = jest.fn();
const mockRpc = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: (...args: unknown[]) => mockRead(...args) };
const mockFrom = jest.fn((table: unknown) => { void table; return mockQuery; });
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (table: unknown) => mockFrom(table), rpc: (...args: unknown[]) => mockRpc(...args) },
}));

import {
  beginProviderResizeDispatch,
  beginProviderResizeShutdown,
  recordProviderResizeShutdown,
  cancelProviderResizeOperation,
  claimProviderResizeOperation,
  completeProviderResizeOperation,
  createProviderResizeQuoteRecord,
  failProviderResizeOperation,
  findActiveProviderResizeOperation,
  loadProviderResizeOperation,
  loadProviderResizeAuthority,
  recordProviderResizeAction,
  recordProviderResizeObservation,
  type ProviderResizeAuthority,
} from "../provider-agent-resize-store";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  PROVIDER_RESIZE_DOWNTIME_NOTICE,
  type ProviderResizeQuote,
} from "../provider-agent-resize-contract";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "../agent-authority";
import { receiverFixture } from "@/lib/infrastructure/__tests__/first-boot-receiver.fixtures";

const input = { userId: "owner", agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const connection = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const targetId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const orderId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const attempt = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const allocation = "11111111-1111-4111-8111-111111111111";
const now = "2026-09-04T14:00:00.000Z";

function originalQuote() {
  const original = structuredClone(receiverFixture().evidence.quote_snapshot);
  return {
    ...original, id: orderId, connectionId: connection, connectionRevision: 7, serverName: "hivra-owned",
    serverType: { ...original.serverType, id: 1, name: "cpx22", description: "CPX22",
      architecture: "x86" as const, cores: 2, memoryGb: 4, diskGb: 80 },
  };
}

function fixture() {
  const agent: ProviderResizeAuthority["agent"] = {
    id: input.agentId, user_id: input.userId, type: "codex", status: "provisioning", desired_state: "stopped",
    operation_id: input.operationId, operation_kind: "resize", operation_started_at: now, cpu: 2, ram: 4,
    computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null,
    proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL, infrastructure_connection_id: connection,
    infrastructure_connection_revision: 7, deployment_target_id: targetId, provider_capacity_order_id: orderId,
    provider_enrollment_attempt_id: attempt, provider_server_id: "42", allocation_operation_id: allocation,
    provider_install_outcome: "succeeded", provider_install_stopped_at: "2026-09-01T12:00:00.000Z",
  };
  const receipt: ProviderResizeAuthority["order"]["provider_creation_receipt"] = { version: 1, serverId: "42", primaryIpv4: { id: "43", ip: "203.0.113.10" },
    primaryIpv6: { id: "44", ip: "2001:db8::/64" }, action: { id: "45", command: "create_server", status: "success",
      resources: [{ id: "42", type: "server" }] }, nextActions: [] };
  const order: ProviderResizeAuthority["order"] = { id: orderId, user_id: input.userId, connection_id: connection, active_connection_id: connection,
    connection_revision: 7, provider: "hetzner-cloud", status: "created_off", server_name: "hivra-owned",
    provider_labels: { "hivra-managed": "true" }, quote_fingerprint_sha256: "c".repeat(64), quote_snapshot: originalQuote(),
    provider_resource_id: "42", provider_creation_receipt: receipt, cleanup_started_at: null,
    cleanup_finished_at: null, detached_at: null };
  const target: ProviderResizeAuthority["target"] = { id: targetId, user_id: input.userId, connection_id: connection, evidence_connection_revision: 7,
    external_id: "42", status: "ready", capacity: {}, supported_isolation_drivers: ["provider-vm"],
    isolation_class: "provider-vm", provider_capacity_order_id: orderId, provider_retired_at: null,
    last_preflight_at: "2026-09-01T12:00:00.000Z", capabilities: { kind: "provider-vm", provider: "hetzner-cloud",
      allocation: "exclusive-computer", capacityOrderId: orderId, enrollmentAttemptId: attempt, launchReady: true,
      provisioner: { configured: true, ready: true } } };
  const quote: ProviderResizeQuote = { operationId: input.operationId, quoteFingerprint: "d".repeat(64), agentId: input.agentId,
    providerServerId: "42", location: "fsn1", existingDiskGb: 80, upgradeDisk: false, observedAt: now,
    expiresAt: "2026-09-04T14:05:00.000Z", downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
    source: { serverTypeId: 1, serverType: "cpx22", architecture: "x86", cores: 2, memoryGb: 4, advertisedDiskGb: 80,
      cpuType: "shared", price: { currency: "EUR", hourlyGross: "0.02", monthlyGross: "5.95" } },
    target: { serverTypeId: 2, serverType: "cpx32", architecture: "x86", cores: 4, memoryGb: 8, advertisedDiskGb: 160,
      cpuType: "shared", price: { currency: "EUR", hourlyGross: "0.04", monthlyGross: "11.90" } } };
  const journal = { operation_id: input.operationId, agent_id: input.agentId, user_id: input.userId,
    connection_id: connection, connection_revision: 7, deployment_target_id: targetId, capacity_order_id: orderId,
    enrollment_attempt_id: attempt, allocation_operation_id: allocation, provider_server_id: "42",
    source_shape_fingerprint_sha256: "c".repeat(64), status: "dispatch_pending",
    plan_fingerprint_sha256: "e".repeat(64), quote_fingerprint_sha256: quote.quoteFingerprint,
    quote_snapshot: quote, quote_observed_at: quote.observedAt, quote_expires_at: quote.expiresAt,
    billing_confirmed_at: now, dispatch_not_after: "2026-09-04T14:00:45.000Z", provider_post_attempted_at: null,
    provider_action: null, shutdown_attempted_at: null, shutdown_action: null, provider_server_absent_at: null,
    shutdown_wait_started_at: null, shutdown_readiness: null,
    provider_observed_at: null, provider_observed_status: null,
    provider_observed_server_type_id: null, provider_observed_server_type: null, provider_observed_architecture: null,
    provider_observed_cores: null, provider_observed_memory_gb: null, provider_observed_advertised_disk_gb: null,
    provider_observed_cpu_type: null, provider_observed_disk_gb: null, completed_at: null, failure_code: null,
    created_at: now, updated_at: now };
  return { agent, order, target, quote, journal };
}

function reads(value = fixture()) {
  for (const data of [value.agent, value.order, value.target, value.journal]) mockRead.mockResolvedValueOnce({ data, error: null });
  return value;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockReset();
  mockRpc.mockReset();
});

it("reports an owned active installation as busy before requiring completed install evidence", async () => {
  const { agent } = fixture();
  mockRead.mockResolvedValueOnce({ data: { ...agent, operation_kind: "provision",
    provider_install_outcome: null, provider_install_stopped_at: null }, error: null });
  await expect(loadProviderResizeAuthority(input.userId, input.agentId))
    .rejects.toMatchObject({ code: "computer_busy" });
  expect(mockFrom.mock.calls.map((call) => call[0])).toEqual(["hivra_agents"]);
  expect(mockRpc).not.toHaveBeenCalled();
});

it.each(["resize", null])("does not exempt incomplete install evidence for operation kind %s", async (kind) => {
  const { agent } = fixture();
  mockRead.mockResolvedValueOnce({ data: { ...agent, operation_kind: kind,
    provider_install_outcome: null, provider_install_stopped_at: null }, error: null });
  await expect(loadProviderResizeAuthority(input.userId, input.agentId))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(mockRpc).not.toHaveBeenCalled();
});

it.each([
  { user_id: "foreign" },
  { id: input.operationId },
  { operation_id: null },
  { provider_server_id: "invalid" },
  { provider_install_outcome: "failed" },
])("does not classify malformed or foreign installation evidence as busy: %j", async (change) => {
  const { agent } = fixture();
  mockRead.mockResolvedValueOnce({ data: { ...agent, operation_kind: "provision",
    provider_install_outcome: null, provider_install_stopped_at: null, ...change }, error: null });
  await expect(loadProviderResizeAuthority(input.userId, input.agentId))
    .rejects.toMatchObject({ code: "unavailable" });
  expect(mockRpc).not.toHaveBeenCalled();
});

it("loads the exact owner, connection revision, target, original receipt, allocation, and operation without selecting secrets", async () => {
  const value = reads();
  await expect(loadProviderResizeOperation(input)).resolves.toMatchObject({
    input, stage: "dispatch_pending", sourceShapeFingerprint: "c".repeat(64), quote: value.quote,
    providerPostAttemptedAt: null,
    authority: { agent: { provider_server_id: "42" }, order: { provider_creation_receipt: { serverId: "42" } },
      target: { id: targetId } },
  });
  expect(mockFrom.mock.calls.map((call) => call[0])).toEqual([
    "hivra_agents", "infrastructure_capacity_orders", "deployment_targets", "hivra_provider_resize_operations",
  ]);
  for (const exact of [["user_id", input.userId], ["id", input.agentId], ["connection_revision", 7],
    ["provider_resource_id", "42"], ["external_id", "42"], ["operation_id", input.operationId]]) {
    expect(mockQuery.eq).toHaveBeenCalledWith(...exact);
  }
  expect(mockQuery.select.mock.calls.flat().join(",")).not.toMatch(/api_token|encrypted|private_key|llm_api_key/);
});

it("accepts equivalent PostgreSQL timestamp serialization for a saved quote", async () => {
  const value = fixture();
  value.journal.quote_observed_at = "2026-09-04T14:00:00+00:00";
  value.journal.quote_expires_at = "2026-09-04T15:05:00.000000+01:00";
  reads(value);
  await expect(loadProviderResizeOperation(input)).resolves.toMatchObject({ stage: "dispatch_pending" });
});

it.each(["2026-09-04T14:00:00.001Z", "2026-09-04T14:00:00.000001Z"])(
  "rejects a genuinely different quote observation time %s", async (observedAt) => {
    const value = fixture();
    value.journal.quote_observed_at = observedAt;
    reads(value);
    await expect(loadProviderResizeOperation(input)).rejects.toThrow("Provider resize store failed: conflict");
  },
);

it.each([
  ["agent owner", (f: ReturnType<typeof fixture>) => { f.agent.user_id = "foreign"; }],
  ["connection revision", (f: ReturnType<typeof fixture>) => { f.journal.connection_revision = 8; }],
  ["target", (f: ReturnType<typeof fixture>) => { f.journal.deployment_target_id = input.operationId; }],
  ["server receipt", (f: ReturnType<typeof fixture>) => { f.order.provider_creation_receipt.serverId = "43"; }],
  ["cleanup authority", (f: ReturnType<typeof fixture>) => { f.order.cleanup_started_at = now; }],
  ["disk policy", (f: ReturnType<typeof fixture>) => { f.quote.upgradeDisk = true as false; f.journal.quote_snapshot = f.quote; }],
])("rejects changed %s authority", async (_name, change) => {
  const value = fixture(); change(value); reads(value);
  await expect(loadProviderResizeOperation(input)).rejects.toThrow("Provider resize store failed");
});

it("accepts a delete intent while retaining the original active resize", async () => {
  const value = fixture(); value.agent.desired_state = "deleted"; reads(value);
  await expect(loadProviderResizeOperation(input)).resolves.toMatchObject({
    authority: { agent: { desired_state: "deleted" } }, stage: "dispatch_pending",
  });
});

it("retains removed-server evidence only after resize ownership is released for deletion", async () => {
  const value = fixture();
  Object.assign(value.agent, { status: "error", desired_state: "deleted", operation_id: null,
    operation_kind: null, operation_started_at: null });
  Object.assign(value.journal, { status: "removed", provider_post_attempted_at: now,
    provider_server_absent_at: now, completed_at: now, failure_code: "provider_server_absent" });
  reads(value);
  await expect(loadProviderResizeOperation(input)).resolves.toMatchObject({
    stage: "removed", serverAbsentAt: now, action: null,
    authority: { agent: { status: "error", desired_state: "deleted", cpu: 2, ram: 4 } },
  });
  value.agent.operation_id = input.operationId;
  reads(value);
  await expect(loadProviderResizeOperation(input)).rejects.toThrow("Provider resize store failed: conflict");
  value.agent.operation_id = null;
  value.journal.provider_server_absent_at = null;
  reads(value);
  await expect(loadProviderResizeOperation(input)).rejects.toThrow("Provider resize store failed: conflict");
});

it("recovers a succeeded resize only from its exact chained shape and released agent", async () => {
  const value = fixture();
  Object.assign(value.agent, { status: "stopped", desired_state: "stopped", operation_id: null,
    operation_kind: null, operation_started_at: null, cpu: 4, ram: 8 });
  Object.assign(value.journal, { status: "succeeded", provider_post_attempted_at: now,
    provider_observed_at: "2026-09-04T14:00:00+00:00", provider_observed_status: "off", provider_observed_server_type_id: 2,
    provider_observed_server_type: "cpx32", provider_observed_architecture: "x86",
    provider_observed_cores: 4, provider_observed_memory_gb: 8, provider_observed_advertised_disk_gb: 160,
    provider_observed_cpu_type: "shared", provider_observed_disk_gb: 80, completed_at: now });
  value.order.current_server_shape = {
    version: 1, provider: "hetzner-cloud", capacityOrderId: orderId, connectionId: connection,
    connectionRevision: 7, providerServerId: "42", resizeOperationId: input.operationId,
    resizeQuoteFingerprintSha256: value.quote.quoteFingerprint,
    previousShapeFingerprintSha256: value.journal.source_shape_fingerprint_sha256,
    serverType: { id: 2, name: "cpx32", architecture: "x86", cores: 4, memoryGb: 8,
      advertisedDiskGb: 160, cpuType: "shared" },
    primaryDiskGb: 80, observedAt: now,
  };
  value.order.current_server_shape_fingerprint_sha256 = "f".repeat(64);
  reads(value);
  await expect(loadProviderResizeOperation(input)).resolves.toMatchObject({
    stage: "succeeded", authority: { agent: { cpu: 4, ram: 8 } },
    sourceShapeFingerprint: "c".repeat(64),
  });

  value.order.current_server_shape.previousShapeFingerprintSha256 = "0".repeat(64);
  reads(value);
  await expect(loadProviderResizeOperation(input)).rejects.toThrow("Provider resize store failed: conflict");
});

it("finds only an owner-bound provider resize operation", async () => {
  mockRead.mockResolvedValueOnce({ data: { operation_id: input.operationId, operation_kind: "resize" }, error: null });
  await expect(findActiveProviderResizeOperation(input.userId, input.agentId)).resolves.toBe(input.operationId);
  expect(mockQuery.eq).toHaveBeenCalledWith("user_id", input.userId);
  expect(mockQuery.eq).toHaveBeenCalledWith("computer_substrate", "provider-vm");
});

it("passes the complete immutable binding and exact reviewed quote to the durable quote RPC", async () => {
  const value = fixture(); value.agent.status = "stopped"; value.agent.desired_state = "stopped";
  value.agent.operation_id = null; value.agent.operation_kind = null; value.agent.operation_started_at = null;
  mockRpc.mockResolvedValue({ data: "created", error: null });
  await expect(createProviderResizeQuoteRecord({ authority: { agent: value.agent, order: value.order, target: value.target },
    operationId: input.operationId, planFingerprint: "e".repeat(64), quote: value.quote })).resolves.toBe("created");
  expect(mockRpc).toHaveBeenCalledWith("create_hivra_provider_resize_quote", expect.objectContaining({
    p_user_id: input.userId, p_connection_id: connection, p_connection_revision: 7, p_target_id: targetId,
    p_capacity_order_id: orderId, p_enrollment_attempt_id: attempt, p_allocation_operation_id: allocation,
    p_provider_server_id: "42", p_quote_fingerprint: value.quote.quoteFingerprint, p_quote: value.quote,
  }));
});

it("uses typed one-use RPCs and never treats malformed persistence results as success", async () => {
  const action = { id: 701, command: "change_server_type" as const, status: "success" as const,
    resources: [{ id: 42, type: "server" as const }] };
  const observation = { observedAt: now, providerStatus: "off", serverTypeId: 2, serverType: "cpx32",
    architecture: "x86" as const, cores: 4, memoryGb: 8, advertisedDiskGb: 160,
    cpuType: "shared" as const, diskGb: 80 };
  mockRpc.mockResolvedValueOnce({ data: "dispatch", error: null });
  await expect(claimProviderResizeOperation(input, "d".repeat(64))).resolves.toBe("dispatch");
  expect(mockRpc).toHaveBeenLastCalledWith("claim_hivra_provider_resize_operation", expect.objectContaining({
    p_billing_confirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  }));
  mockRpc.mockResolvedValueOnce({ data: "dispatch", error: null });
  await expect(beginProviderResizeDispatch(input)).resolves.toBe("dispatch");
  expect(mockRpc).toHaveBeenLastCalledWith("begin_hivra_provider_resize_dispatch_v3", {
    p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
  });
  mockRpc.mockResolvedValueOnce({ data: "dispatch", error: null });
  await expect(beginProviderResizeShutdown(input, { version: 1, observedAt: now, bootId: targetId,
    powerHandlerPid: 649, hostFingerprintSha256: `SHA256:${"A".repeat(43)}` })).resolves.toBe("dispatch");
  expect(mockRpc).toHaveBeenLastCalledWith("begin_hivra_provider_resize_shutdown_v2", {
    p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
    p_readiness: { version: 1, observedAt: now, bootId: targetId,
      powerHandlerPid: 649, hostFingerprintSha256: `SHA256:${"A".repeat(43)}` },
  });
  for (const call of [
    () => recordProviderResizeAction(input, action),
    () => recordProviderResizeShutdown(input, { ...action, id: 702, command: "shutdown_server" }),
    () => recordProviderResizeObservation(input, observation, "provider_pending"),
    () => completeProviderResizeOperation(input, observation),
    () => failProviderResizeOperation(input, "provider_action_failed"),
    () => cancelProviderResizeOperation(input, "source_changed"),
  ]) {
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(call()).resolves.toBe(true);
  }
  mockRpc.mockResolvedValueOnce({ data: "true", error: null });
  await expect(beginProviderResizeDispatch(input)).rejects.toThrow("Invalid enum value");
});

it("rejects a shutdown receipt with another command or without the exact bound server marker", async () => {
  await expect(recordProviderResizeShutdown(input, { id: 702, command: "reboot_server", status: "success",
    resources: [{ id: 42, type: "server" }] })).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
  const value = fixture();
  value.journal.shutdown_action = { id: 702, command: "shutdown_server", status: "success",
    resources: [{ id: 43, type: "server" }] } as never;
  reads(value);
  await expect(loadProviderResizeOperation(input)).rejects.toThrow();
});

it("redacts persistence failures and rejects malformed caller identity before any RPC", async () => {
  mockRpc.mockResolvedValue({ data: null, error: { message: "private database detail" } });
  await expect(beginProviderResizeDispatch(input)).rejects.toThrow("Provider resize store failed: conflict");
  mockRpc.mockClear();
  await expect(cancelProviderResizeOperation({ ...input, userId: "" }, "source_changed")).rejects.toThrow();
  expect(mockRpc).not.toHaveBeenCalled();
});
