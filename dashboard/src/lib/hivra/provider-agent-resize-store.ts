import "server-only";

import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { HetznerCreationReceiptSchema } from "@/lib/infrastructure/hetzner-creation-receipt";
import { HetznerCloudCapacityQuoteDtoSchema } from "@/lib/infrastructure/contracts";
import {
  HetznerCurrentServerShapeSchema,
  parseHetznerCurrentServerShapeEvidence,
} from "@/lib/infrastructure/hetzner-current-server-shape";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  ProviderResizeQuoteSchema,
  ProviderResizeStageSchema,
  type ProviderResizeQuote,
  type ProviderResizeStage,
} from "./provider-agent-resize-contract";
import type { HetznerAction } from "@/lib/hetzner/client";

const Uuid = z.string().uuid();
const Time = z.string().datetime({ offset: true });
// PostgreSQL returns timestamptz with +00:00 while JSON quotes retain Z.
// Compare instants without discarding sub-millisecond precision at this boundary.
function sameTimestamp(left: string, right: string): boolean {
  const fraction = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/)?.[1] ?? "")
    .replace(/0+$/, "");
  return Date.parse(left) === Date.parse(right) && fraction(left) === fraction(right);
}
const ServerId = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const OperationInput = z.object({
  userId: z.string().trim().min(1).max(256),
  agentId: Uuid,
  operationId: Uuid,
}).strict();

const AgentAuthorityRow = z.object({
  id: Uuid,
  user_id: z.string(),
  type: z.string().min(1).max(64),
  status: z.enum(["running", "stopped", "provisioning", "error"]),
  desired_state: z.enum(["running", "stopped", "deleted"]),
  operation_id: Uuid.nullable(),
  operation_kind: z.string().nullable(),
  operation_started_at: Time.nullable(),
  cpu: z.number().positive(),
  ram: z.number().positive(),
  computer_substrate: z.literal("provider-vm"),
  deployment_mode: z.literal("self-managed"),
  vmid: z.null(),
  proxmox_host: z.literal(SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL),
  infrastructure_connection_id: Uuid,
  infrastructure_connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid,
  provider_capacity_order_id: Uuid,
  provider_enrollment_attempt_id: Uuid,
  provider_server_id: ServerId,
  allocation_operation_id: Uuid,
  provider_install_outcome: z.literal("succeeded"),
  provider_install_stopped_at: Time,
}).strict();

// Classification only: this schema cannot authorize a resize. An installation
// in flight has no successful installer receipt yet, but is not a saved resize.
const InstallingAgentRow = AgentAuthorityRow.extend({
  status: z.literal("provisioning"),
  operation_id: Uuid,
  operation_kind: z.literal("provision"),
  provider_install_outcome: z.null(),
  provider_install_stopped_at: z.null(),
});

const CapacityOrderRow = z.object({
  id: Uuid,
  user_id: z.string(),
  connection_id: Uuid,
  active_connection_id: Uuid,
  connection_revision: z.number().int().positive().safe(),
  provider: z.literal("hetzner-cloud"),
  status: z.literal("created_off"),
  server_name: z.string().min(1).max(128),
  provider_labels: z.record(z.string(), z.string()),
  quote_fingerprint_sha256: Digest,
  quote_snapshot: HetznerCloudCapacityQuoteDtoSchema,
  provider_resource_id: ServerId,
  provider_creation_receipt: HetznerCreationReceiptSchema,
  current_server_shape: HetznerCurrentServerShapeSchema.nullable().optional(),
  current_server_shape_fingerprint_sha256: Digest.nullable().optional(),
  cleanup_started_at: Time.nullable(),
  cleanup_finished_at: Time.nullable(),
  detached_at: Time.nullable(),
}).strict();

const TargetRow = z.object({
  id: Uuid,
  user_id: z.string(),
  connection_id: Uuid,
  evidence_connection_revision: z.number().int().positive().safe(),
  external_id: ServerId,
  status: z.literal("ready"),
  capacity: z.record(z.string(), z.unknown()),
  capabilities: z.record(z.string(), z.unknown()),
  supported_isolation_drivers: z.array(z.string()),
  isolation_class: z.literal("provider-vm"),
  provider_capacity_order_id: Uuid,
  provider_retired_at: Time.nullable(),
  last_preflight_at: Time,
}).strict();

const ProviderAction = z.object({
  id: z.number().int().positive().safe(),
  command: z.literal("change_server_type"),
  status: z.enum(["running", "success", "error"]),
  resources: z.tuple([z.object({
    id: z.number().int().positive().safe(),
    type: z.literal("server"),
  }).strict()]),
}).strict();

const Observation = z.object({
  observedAt: Time,
  providerStatus: z.string().trim().min(1).max(64),
  serverTypeId: z.number().int().positive().safe(),
  serverType: z.string().trim().min(1).max(64),
  architecture: z.enum(["x86", "arm"]),
  cores: z.number().int().positive().max(1_024),
  memoryGb: z.number().int().positive().max(65_536),
  advertisedDiskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cpuType: z.enum(["shared", "dedicated"]),
  diskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

const ShutdownAction = ProviderAction.extend({ command: z.literal("shutdown_server") });
const ProviderResizeReadinessSchema = z.object({ version: z.literal(1), observedAt: Time,
  bootId: Uuid, powerHandlerPid: z.number().int().positive().max(2_147_483_647),
  hostFingerprintSha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/) }).strict();
export type ProviderResizeReadiness = z.infer<typeof ProviderResizeReadinessSchema>;

const JournalRow = z.object({
  operation_id: Uuid,
  agent_id: Uuid,
  user_id: z.string(),
  connection_id: Uuid,
  connection_revision: z.number().int().positive().safe(),
  deployment_target_id: Uuid,
  capacity_order_id: Uuid,
  enrollment_attempt_id: Uuid,
  allocation_operation_id: Uuid,
  provider_server_id: ServerId,
  source_shape_fingerprint_sha256: Digest,
  status: ProviderResizeStageSchema,
  plan_fingerprint_sha256: Digest,
  quote_fingerprint_sha256: Digest,
  quote_snapshot: ProviderResizeQuoteSchema,
  quote_observed_at: Time,
  quote_expires_at: Time,
  billing_confirmed_at: Time.nullable(),
  dispatch_not_after: Time.nullable(),
  provider_post_attempted_at: Time.nullable(),
  provider_action: ProviderAction.nullable(),
  shutdown_attempted_at: Time.nullable(),
  shutdown_action: ShutdownAction.nullable(),
  shutdown_wait_started_at: Time.nullable(),
  shutdown_readiness: ProviderResizeReadinessSchema.nullable(),
  provider_server_absent_at: Time.nullable(),
  provider_observed_at: Time.nullable(),
  provider_observed_status: z.string().min(1).max(64).nullable(),
  provider_observed_server_type_id: z.number().int().positive().safe().nullable(),
  provider_observed_server_type: z.string().min(1).max(64).nullable(),
  provider_observed_architecture: z.enum(["x86", "arm"]).nullable(),
  provider_observed_cores: z.number().int().positive().nullable(),
  provider_observed_memory_gb: z.number().int().positive().nullable(),
  provider_observed_advertised_disk_gb: z.number().int().positive().nullable(),
  provider_observed_cpu_type: z.enum(["shared", "dedicated"]).nullable(),
  provider_observed_disk_gb: z.number().int().positive().nullable(),
  completed_at: Time.nullable(),
  failure_code: z.string().min(1).max(64).nullable(),
  created_at: Time,
  updated_at: Time,
}).strict();

export type ProviderResizeAuthority = {
  agent: z.infer<typeof AgentAuthorityRow>;
  order: z.infer<typeof CapacityOrderRow>;
  target: z.infer<typeof TargetRow>;
};

export type ProviderResizeOperationInput = z.infer<typeof OperationInput>;
export type ProviderResizeObservation = z.infer<typeof Observation>;
export type StoredProviderResizeOperation = {
  input: ProviderResizeOperationInput;
  authority: ProviderResizeAuthority;
  stage: ProviderResizeStage;
  sourceShapeFingerprint: string;
  planFingerprint: string;
  quote: ProviderResizeQuote;
  billingConfirmedAt: string | null;
  dispatchNotAfter: string | null;
  providerPostAttemptedAt: string | null;
  action: HetznerAction | null;
  shutdownAttemptedAt: string | null;
  shutdownAction: HetznerAction | null;
  shutdownWaitStartedAt: string | null;
  shutdownReadiness: ProviderResizeReadiness | null;
  serverAbsentAt: string | null;
  observation: ProviderResizeObservation | null;
  completedAt: string | null;
  failureCode: string | null;
};

export class ProviderAgentResizeStoreError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "unavailable" | "computer_busy" = "unavailable") {
    super(`Provider resize store failed: ${code}`);
    this.name = "ProviderAgentResizeStoreError";
  }
}

function database() {
  if (!supabaseAdmin) throw new ProviderAgentResizeStoreError("unavailable");
  return supabaseAdmin;
}

const AGENT_SELECT = Object.keys(AgentAuthorityRow.shape).join(",");
const ORDER_SELECT = Object.keys(CapacityOrderRow.shape).join(",");
const TARGET_SELECT = Object.keys(TargetRow.shape).join(",");
const JOURNAL_SELECT = Object.keys(JournalRow.shape).join(",");

/** Loads only public provider identity and immutable receipts. Connection
 * credentials and administrator keys are deliberately absent from every
 * select in this module. */
export async function loadProviderResizeAuthority(
  userId: string,
  agentId: string,
): Promise<ProviderResizeAuthority> {
  try {
    const owner = z.object({ userId: z.string().trim().min(1).max(256), agentId: Uuid }).parse({ userId, agentId });
    const db = database();
    const { data: rawAgent, error: agentError } = await db.from("hivra_agents")
      .select(AGENT_SELECT).eq("user_id", owner.userId).eq("id", owner.agentId)
      .eq("computer_substrate", "provider-vm").maybeSingle();
    if (agentError || !rawAgent) throw new ProviderAgentResizeStoreError("not_found");
    const installing = InstallingAgentRow.safeParse(rawAgent);
    if (installing.success && installing.data.id === owner.agentId && installing.data.user_id === owner.userId) {
      throw new ProviderAgentResizeStoreError("computer_busy");
    }
    const agent = AgentAuthorityRow.parse(rawAgent);
    const { data: rawOrder, error: orderError } = await db.from("infrastructure_capacity_orders")
      .select(ORDER_SELECT).eq("id", agent.provider_capacity_order_id).eq("user_id", owner.userId)
      .eq("connection_id", agent.infrastructure_connection_id).eq("active_connection_id", agent.infrastructure_connection_id)
      .eq("connection_revision", agent.infrastructure_connection_revision).eq("provider_resource_id", agent.provider_server_id)
      .maybeSingle();
    if (orderError || !rawOrder) throw new ProviderAgentResizeStoreError("conflict");
    const order = CapacityOrderRow.parse(rawOrder);
    const { data: rawTarget, error: targetError } = await db.from("deployment_targets")
      .select(TARGET_SELECT).eq("id", agent.deployment_target_id).eq("user_id", owner.userId)
      .eq("connection_id", agent.infrastructure_connection_id).eq("evidence_connection_revision", agent.infrastructure_connection_revision)
      .eq("provider_capacity_order_id", agent.provider_capacity_order_id).eq("external_id", agent.provider_server_id)
      .maybeSingle();
    if (targetError || !rawTarget) throw new ProviderAgentResizeStoreError("conflict");
    const target = TargetRow.parse(rawTarget);
    const caps = target.capabilities;
    const provisioner = caps.provisioner && typeof caps.provisioner === "object" && !Array.isArray(caps.provisioner)
      ? caps.provisioner as Record<string, unknown> : null;
    parseHetznerCurrentServerShapeEvidence({
      shape: order.current_server_shape,
      fingerprintSha256: order.current_server_shape_fingerprint_sha256,
      capacityOrderId: order.id,
      connectionId: order.connection_id,
      connectionRevision: order.connection_revision,
      providerServerId: order.provider_resource_id,
    });
    if (
      agent.user_id !== owner.userId
      || order.user_id !== owner.userId
      || order.provider_creation_receipt.serverId !== agent.provider_server_id
      || order.detached_at !== null
      || order.cleanup_started_at !== null
      || order.cleanup_finished_at !== null
      || target.provider_retired_at !== null
      || target.supported_isolation_drivers.length !== 1
      || target.supported_isolation_drivers[0] !== "provider-vm"
      || caps.kind !== "provider-vm"
      || caps.provider !== "hetzner-cloud"
      || caps.allocation !== "exclusive-computer"
      || caps.capacityOrderId !== order.id
      || caps.enrollmentAttemptId !== agent.provider_enrollment_attempt_id
      || caps.launchReady !== true
      || !provisioner
      || provisioner.configured !== true
      || provisioner.ready !== true
    ) throw new ProviderAgentResizeStoreError("conflict");
    return { agent, order, target };
  } catch (error) {
    if (error instanceof ProviderAgentResizeStoreError) throw error;
    throw new ProviderAgentResizeStoreError("unavailable");
  }
}

function parseOperation(
  raw: unknown,
  input: ProviderResizeOperationInput,
  authority: ProviderResizeAuthority,
): StoredProviderResizeOperation {
  const row = JournalRow.parse(raw);
  const { agent, order, target } = authority;
  if (
    row.operation_id !== input.operationId
    || row.agent_id !== input.agentId
    || row.user_id !== input.userId
    || row.connection_id !== agent.infrastructure_connection_id
    || row.connection_revision !== agent.infrastructure_connection_revision
    || row.deployment_target_id !== target.id
    || row.capacity_order_id !== order.id
    || row.enrollment_attempt_id !== agent.provider_enrollment_attempt_id
    || row.allocation_operation_id !== agent.allocation_operation_id
    || row.provider_server_id !== agent.provider_server_id
    || row.quote_fingerprint_sha256 !== row.quote_snapshot.quoteFingerprint
    || !sameTimestamp(row.quote_observed_at, row.quote_snapshot.observedAt)
    || !sameTimestamp(row.quote_expires_at, row.quote_snapshot.expiresAt)
  ) throw new ProviderAgentResizeStoreError("conflict");
  const active = ["dispatch_pending", "request_uncertain", "action_pending", "provider_pending", "manual_attention"].includes(row.status);
  if ((row.status === "removed") !== (row.provider_server_absent_at !== null)
    || (row.status === "removed" && (agent.desired_state !== "deleted"
      || agent.operation_id === row.operation_id || row.failure_code !== "provider_server_absent"))) {
    throw new ProviderAgentResizeStoreError("conflict");
  }
  if (row.shutdown_action !== null && (row.shutdown_attempted_at === null
    || String(row.shutdown_action.resources[0].id) !== row.provider_server_id)) {
    throw new ProviderAgentResizeStoreError("conflict");
  }
  if (row.shutdown_readiness !== null && row.shutdown_wait_started_at === null) {
    throw new ProviderAgentResizeStoreError("conflict");
  }
  if (active && (
    agent.operation_id !== row.operation_id
    || agent.operation_kind !== "resize"
    || agent.status !== "provisioning"
    || !["stopped", "deleted"].includes(agent.desired_state)
  )) throw new ProviderAgentResizeStoreError("conflict");
  if (row.status === "quoted" && agent.operation_id === row.operation_id) {
    throw new ProviderAgentResizeStoreError("conflict");
  }
  const currentShape = parseHetznerCurrentServerShapeEvidence({
    shape: order.current_server_shape,
    fingerprintSha256: order.current_server_shape_fingerprint_sha256,
    capacityOrderId: order.id,
    connectionId: order.connection_id,
    connectionRevision: order.connection_revision,
    providerServerId: order.provider_resource_id,
  });
  if (row.status === "succeeded") {
    if (
      currentShape === null
      || currentShape.shape.resizeOperationId !== row.operation_id
      || currentShape.shape.resizeQuoteFingerprintSha256 !== row.quote_fingerprint_sha256
      || currentShape.shape.previousShapeFingerprintSha256 !== row.source_shape_fingerprint_sha256
      || row.provider_observed_at === null
      || !sameTimestamp(currentShape.shape.observedAt, row.provider_observed_at)
      || currentShape.shape.serverType.id !== row.quote_snapshot.target.serverTypeId
      || currentShape.shape.serverType.name !== row.quote_snapshot.target.serverType
      || currentShape.shape.serverType.architecture !== row.quote_snapshot.target.architecture
      || currentShape.shape.serverType.cores !== row.quote_snapshot.target.cores
      || currentShape.shape.serverType.memoryGb !== row.quote_snapshot.target.memoryGb
      || currentShape.shape.serverType.advertisedDiskGb !== row.quote_snapshot.target.advertisedDiskGb
      || currentShape.shape.serverType.cpuType !== row.quote_snapshot.target.cpuType
      || currentShape.shape.primaryDiskGb !== row.quote_snapshot.existingDiskGb
      || agent.status !== "stopped"
      || !["stopped", "deleted"].includes(agent.desired_state)
      || agent.operation_id !== null
      || agent.operation_kind !== null
      || agent.operation_started_at !== null
      || agent.cpu !== row.quote_snapshot.target.cores
      || agent.ram !== row.quote_snapshot.target.memoryGb
    ) throw new ProviderAgentResizeStoreError("conflict");
  } else if ((currentShape?.fingerprintSha256 ?? order.quote_fingerprint_sha256) !== row.source_shape_fingerprint_sha256) {
    throw new ProviderAgentResizeStoreError("conflict");
  }
  const observedFields = [row.provider_observed_at, row.provider_observed_status, row.provider_observed_server_type_id,
    row.provider_observed_server_type, row.provider_observed_architecture, row.provider_observed_cores,
    row.provider_observed_memory_gb, row.provider_observed_advertised_disk_gb, row.provider_observed_cpu_type,
    row.provider_observed_disk_gb];
  const observation = observedFields.every((value) => value !== null)
    ? Observation.parse({ observedAt: row.provider_observed_at, providerStatus: row.provider_observed_status,
      serverTypeId: row.provider_observed_server_type_id, serverType: row.provider_observed_server_type,
      architecture: row.provider_observed_architecture, cores: row.provider_observed_cores,
      memoryGb: row.provider_observed_memory_gb, advertisedDiskGb: row.provider_observed_advertised_disk_gb,
      cpuType: row.provider_observed_cpu_type, diskGb: row.provider_observed_disk_gb })
    : null;
  if (!observation && observedFields.some((value) => value !== null)) throw new ProviderAgentResizeStoreError("conflict");
  return {
    input,
    authority,
    stage: row.status,
    sourceShapeFingerprint: row.source_shape_fingerprint_sha256,
    planFingerprint: row.plan_fingerprint_sha256,
    quote: row.quote_snapshot,
    billingConfirmedAt: row.billing_confirmed_at,
    dispatchNotAfter: row.dispatch_not_after,
    providerPostAttemptedAt: row.provider_post_attempted_at,
    action: row.provider_action,
    shutdownAttemptedAt: row.shutdown_attempted_at,
    shutdownAction: row.shutdown_action,
    shutdownWaitStartedAt: row.shutdown_wait_started_at,
    shutdownReadiness: row.shutdown_readiness,
    serverAbsentAt: row.provider_server_absent_at,
    observation,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
  };
}

export async function loadProviderResizeOperation(raw: ProviderResizeOperationInput): Promise<StoredProviderResizeOperation> {
  const input = OperationInput.parse(structuredClone(raw));
  const authority = await loadProviderResizeAuthority(input.userId, input.agentId);
  try {
    const { data, error } = await database().from("hivra_provider_resize_operations")
      .select(JOURNAL_SELECT).eq("operation_id", input.operationId).eq("agent_id", input.agentId)
      .eq("user_id", input.userId).maybeSingle();
    if (error || !data) throw new ProviderAgentResizeStoreError("not_found");
    return parseOperation(data, input, authority);
  } catch (error) {
    if (error instanceof ProviderAgentResizeStoreError) throw error;
    throw new ProviderAgentResizeStoreError("unavailable");
  }
}

export async function findActiveProviderResizeOperation(userId: string, agentId: string): Promise<string | null> {
  try {
    const owner = z.object({ userId: z.string().trim().min(1).max(256), agentId: Uuid }).parse({ userId, agentId });
    const { data, error } = await database().from("hivra_agents").select("operation_id,operation_kind")
      .eq("id", owner.agentId).eq("user_id", owner.userId).eq("computer_substrate", "provider-vm").maybeSingle();
    if (error || !data) return null;
    return data.operation_kind === "resize" ? Uuid.parse(data.operation_id) : null;
  } catch { throw new ProviderAgentResizeStoreError("unavailable"); }
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await database().rpc(name, args);
  if (error) throw new ProviderAgentResizeStoreError("conflict");
  return data;
}

export async function createProviderResizeQuoteRecord(input: {
  authority: ProviderResizeAuthority;
  operationId: string;
  planFingerprint: string;
  quote: ProviderResizeQuote;
}): Promise<"created" | "replay" | "conflict"> {
  const operationId = Uuid.parse(input.operationId);
  const planFingerprint = Digest.parse(input.planFingerprint);
  const quote = ProviderResizeQuoteSchema.parse(input.quote);
  const { agent, order, target } = input.authority;
  return z.enum(["created", "replay", "conflict"]).parse(await rpc("create_hivra_provider_resize_quote", {
    p_user_id: agent.user_id,
    p_agent_id: agent.id,
    p_operation_id: operationId,
    p_connection_id: agent.infrastructure_connection_id,
    p_connection_revision: agent.infrastructure_connection_revision,
    p_target_id: target.id,
    p_capacity_order_id: order.id,
    p_enrollment_attempt_id: agent.provider_enrollment_attempt_id,
    p_allocation_operation_id: agent.allocation_operation_id,
    p_provider_server_id: agent.provider_server_id,
    p_plan_fingerprint: planFingerprint,
    p_quote_fingerprint: quote.quoteFingerprint,
    p_quote: quote,
    p_quote_observed_at: quote.observedAt,
    p_quote_expires_at: quote.expiresAt,
  }));
}

export async function claimProviderResizeOperation(input: ProviderResizeOperationInput, quoteFingerprint: string) {
  const operation = OperationInput.parse(input);
  return z.enum(["dispatch", "observe", "expired", "rejected"]).parse(await rpc("claim_hivra_provider_resize_operation", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_quote_fingerprint: Digest.parse(quoteFingerprint),
    p_billing_confirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  }));
}

export async function beginProviderResizeDispatch(input: ProviderResizeOperationInput) {
  const operation = OperationInput.parse(input);
  return z.enum(["dispatch", "observe", "rejected"]).parse(await rpc("begin_hivra_provider_resize_dispatch_v3", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
  }));
}

export async function recordProviderResizeAction(input: ProviderResizeOperationInput, action: HetznerAction) {
  const operation = OperationInput.parse(input);
  const checked = ProviderAction.parse(action);
  return z.boolean().parse(await rpc("record_hivra_provider_resize_action", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_action: checked,
  }));
}

export async function recordProviderResizeReadiness(input: ProviderResizeOperationInput, readiness: ProviderResizeReadiness | null) {
  const operation = OperationInput.parse(input);
  return z.boolean().parse(await rpc("record_hivra_provider_resize_readiness", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
    p_readiness: readiness === null ? null : ProviderResizeReadinessSchema.parse(readiness),
  }));
}

export async function beginProviderResizeShutdown(input: ProviderResizeOperationInput, readiness: ProviderResizeReadiness) {
  const operation = OperationInput.parse(input);
  return z.enum(["dispatch", "observe", "rejected"]).parse(await rpc("begin_hivra_provider_resize_shutdown_v2", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
    p_readiness: ProviderResizeReadinessSchema.parse(readiness),
  }));
}

export async function recordProviderResizeServerAbsent(input: ProviderResizeOperationInput, serverId: string, observedAt: string) {
  const operation = OperationInput.parse(input);
  return z.boolean().parse(await rpc("record_hivra_provider_resize_server_absent", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
    p_server_id: ServerId.parse(serverId), p_observed_at: Time.parse(observedAt),
  }));
}

export async function recordProviderResizeShutdown(input: ProviderResizeOperationInput, action: HetznerAction) {
  const operation = OperationInput.parse(input);
  return z.boolean().parse(await rpc("record_hivra_provider_resize_shutdown", {
    p_user_id: operation.userId, p_agent_id: operation.agentId, p_operation_id: operation.operationId,
    p_action: ShutdownAction.parse(action),
  }));
}

export async function recordProviderResizeObservation(
  input: ProviderResizeOperationInput,
  raw: ProviderResizeObservation,
  stage: "request_uncertain" | "action_pending" | "provider_pending" | "manual_attention",
) {
  const operation = OperationInput.parse(input);
  const observation = Observation.parse(raw);
  return z.boolean().parse(await rpc("record_hivra_provider_resize_observation", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_observed_at: observation.observedAt,
    p_provider_status: observation.providerStatus,
    p_server_type_id: observation.serverTypeId,
    p_server_type: observation.serverType,
    p_architecture: observation.architecture,
    p_cores: observation.cores,
    p_memory_gb: observation.memoryGb,
    p_advertised_disk_gb: observation.advertisedDiskGb,
    p_cpu_type: observation.cpuType,
    p_disk_gb: observation.diskGb,
    p_stage: z.enum(["request_uncertain", "action_pending", "provider_pending", "manual_attention"]).parse(stage),
  }));
}

export async function completeProviderResizeOperation(input: ProviderResizeOperationInput, observation: ProviderResizeObservation) {
  const operation = OperationInput.parse(input), checked = Observation.parse(observation);
  return z.boolean().parse(await rpc("complete_hivra_provider_resize_operation", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_observed_at: checked.observedAt,
  }));
}

export async function failProviderResizeOperation(input: ProviderResizeOperationInput, code: string) {
  const operation = OperationInput.parse(input);
  const failureCode = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/).parse(code);
  return z.boolean().parse(await rpc("fail_hivra_provider_resize_operation", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_failure_code: failureCode,
  }));
}

export async function cancelProviderResizeOperation(input: ProviderResizeOperationInput, code: string) {
  const operation = OperationInput.parse(input);
  const failureCode = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/).parse(code);
  return z.boolean().parse(await rpc("cancel_hivra_provider_resize_operation", {
    p_user_id: operation.userId,
    p_agent_id: operation.agentId,
    p_operation_id: operation.operationId,
    p_failure_code: failureCode,
  }));
}
