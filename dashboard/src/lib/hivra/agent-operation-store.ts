import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { cleanupHivraAgentAccess, HivraAgentDeleteCleanupError } from "./agent-delete-cleanup";

import type {
  HivraAgentDesiredState,
  HivraAgentOperationKind,
} from "./agent-authority";

type HivraAgentOperationStoreErrorCode =
  | "database_unavailable"
  | "database_error"
  | "conflict";

export class HivraAgentOperationStoreError extends Error {
  constructor(public readonly code: HivraAgentOperationStoreErrorCode) {
    super(`Hivra agent operation store failed: ${code}`);
    this.name = "HivraAgentOperationStoreError";
  }
}

type DatabaseError = { code?: unknown } | null | undefined;

function database() {
  if (!supabaseAdmin) {
    throw new HivraAgentOperationStoreError("database_unavailable");
  }
  return supabaseAdmin;
}

export function isHivraAgentAuthorityConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return ["23503", "23505", "23514", "55000", "55006"].includes(
    String((error as { code?: unknown }).code ?? ""),
  );
}

function operationError(error: DatabaseError): HivraAgentOperationStoreError {
  return new HivraAgentOperationStoreError(
    isHivraAgentAuthorityConflict(error) ? "conflict" : "database_error",
  );
}

async function operationRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const db = database();
  let response;
  try {
    response = await db.rpc(name, args);
  } catch {
    // A rejected transport is an unknown database outcome, not a lost claim.
    // Do not propagate URLs, request arguments, or private server details.
    throw new HivraAgentOperationStoreError("database_error");
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new HivraAgentOperationStoreError("database_error");
  }
  if (response.error) throw operationError(response.error);
  return response.data;
}

async function booleanRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const data = await operationRpc(name, args);
  if (typeof data !== "boolean") {
    throw new HivraAgentOperationStoreError("database_error");
  }
  return data;
}

export async function claimHivraAgentOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  operationKind: Exclude<HivraAgentOperationKind, "provision" | "delete">;
  desiredState: Exclude<HivraAgentDesiredState, "deleted">;
  operationPayload?:
    | { cpu: number; ram: number }
    | { snapshotId: string; providerSnapshotId: string }
    | null;
}): Promise<boolean> {
  return booleanRpc("claim_hivra_agent_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_operation_kind: input.operationKind,
    p_desired_state: input.desiredState,
    p_operation_payload: input.operationPayload ?? null,
  });
}

export async function beginHivraAgentSnapshot(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
  providerSnapshotId: string;
}): Promise<boolean> {
  return booleanRpc("begin_hivra_agent_snapshot", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
    p_provider_snapshot_id: input.providerSnapshotId,
  });
}

export async function completeHivraAgentSnapshot(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
  providerStatus: "running" | "stopped";
  snapshotConfigSha256: string;
}): Promise<boolean> {
  return booleanRpc("complete_hivra_agent_snapshot", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
    p_provider_status: input.providerStatus,
    p_snapshot_config_sha256: input.snapshotConfigSha256,
  });
}

export async function failHivraAgentSnapshot(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
  providerStatus: "running" | "stopped";
  error: string;
}): Promise<boolean> {
  return booleanRpc("fail_hivra_agent_snapshot", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
    p_provider_status: input.providerStatus,
    p_error: input.error,
  });
}

export async function beginHivraAgentSnapshotRestore(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
}): Promise<boolean> {
  return booleanRpc("begin_hivra_agent_snapshot_restore", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
  });
}

export async function completeHivraAgentSnapshotRestore(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
  snapshotConfigSha256: string;
}): Promise<boolean> {
  return booleanRpc("complete_hivra_agent_snapshot_restore", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
    p_snapshot_config_sha256: input.snapshotConfigSha256,
  });
}

export async function failHivraAgentSnapshotRestore(input: {
  userId: string;
  agentId: string;
  operationId: string;
  snapshotId: string;
  providerStatus: "running" | "stopped";
  error: string;
}): Promise<boolean> {
  return booleanRpc("fail_hivra_agent_snapshot_restore", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_snapshot_id: input.snapshotId,
    p_provider_status: input.providerStatus,
    p_error: input.error,
  });
}

export type HivraAgentDeleteRequestResult =
  | "claimed"
  | "pending"
  | "deleted"
  | "not_found";

export async function requestHivraAgentDelete(input: {
  userId: string;
  agentId: string;
  operationId: string;
}): Promise<HivraAgentDeleteRequestResult> {
  const data = await operationRpc("request_hivra_agent_delete", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
  });
  if (typeof data === "string" && ["claimed", "pending", "deleted", "not_found"].includes(data)) {
    return data as HivraAgentDeleteRequestResult;
  }
  throw new HivraAgentOperationStoreError("database_error");
}

export async function checkpointHivraAgentOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  expectedDesiredState: Exclude<HivraAgentDesiredState, "deleted">;
}): Promise<boolean> {
  return booleanRpc("checkpoint_hivra_agent_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_expected_desired_state: input.expectedDesiredState,
  });
}

export async function claimHivraAgentOperationRecovery(input: {
  userId: string;
  agentId: string;
  operationId: string;
  expectedOperationStartedAt: string;
  recoveredAt: string;
}): Promise<boolean> {
  return booleanRpc("claim_hivra_agent_operation_recovery", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_expected_operation_started_at: input.expectedOperationStartedAt,
    p_recovered_at: input.recoveredAt,
  });
}

export async function persistHivraAgentProvisionIdentity(input: {
  userId: string;
  agentId: string;
  operationId: string;
  vmid: number;
  ip: string | null;
}): Promise<boolean> {
  return booleanRpc("persist_hivra_agent_provision_identity", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_vmid: input.vmid,
    p_ip: input.ip,
  });
}

export async function completeHivraAgentOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  expectedDesiredState: Exclude<HivraAgentDesiredState, "deleted">;
  status: string;
  cpu?: number | null;
  ram?: number | null;
}): Promise<boolean> {
  return booleanRpc("complete_hivra_agent_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_expected_desired_state: input.expectedDesiredState,
    p_status: input.status,
    p_cpu: input.cpu ?? null,
    p_ram: input.ram ?? null,
  });
}

export async function continueHivraAgentOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  expectedDesiredState: Exclude<HivraAgentDesiredState, "deleted">;
  status: "provisioning";
  cpu?: number | null;
  ram?: number | null;
}): Promise<boolean> {
  return booleanRpc("continue_hivra_agent_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_expected_desired_state: input.expectedDesiredState,
    p_status: input.status,
    p_cpu: input.cpu ?? null,
    p_ram: input.ram ?? null,
  });
}

export async function continueHivraAgentResizeOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  expectedDesiredState: Exclude<HivraAgentDesiredState, "deleted">;
  status: "provisioning";
  cpu: number;
  ram: number;
  maximumCpu: number;
  maximumRam: number;
}): Promise<boolean> {
  return booleanRpc("continue_hivra_agent_resize_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_expected_desired_state: input.expectedDesiredState,
    p_status: input.status,
    p_cpu: input.cpu,
    p_ram: input.ram,
    p_cpu_max: input.maximumCpu,
    p_ram_max: input.maximumRam,
  });
}

export async function completeHivraAgentRunning(input: {
  userId: string;
  agentId: string;
  operationId: string;
  operationKind: Extract<
    HivraAgentOperationKind,
    "provision" | "start" | "restart" | "resize"
  >;
  chatUrl: string;
  ip: string | null;
  apiToken: string | null;
  provisionedAt: string;
}): Promise<boolean> {
  return booleanRpc("complete_hivra_agent_running", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_operation_kind: input.operationKind,
    p_chat_url: input.chatUrl,
    p_ip: input.ip,
    p_api_token: input.apiToken,
    p_provisioned_at: input.provisionedAt,
  });
}

export async function releaseHivraAgentOperation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  error?: string | null;
  markError?: boolean;
}): Promise<boolean> {
  return booleanRpc("release_hivra_agent_operation", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_error: input.error ?? null,
    p_mark_error: input.markError ?? false,
  });
}

/** Only the request that has not called the VM allocator may advance this stage. */
export async function beginHivraAgentVmAllocation(input: {
  userId: string;
  agentId: string;
  operationId: string;
}): Promise<boolean> {
  const { data, error } = await database().from("hivra_agents")
    .update({ operation_payload: null })
    .eq("user_id", input.userId).eq("id", input.agentId)
    .eq("operation_id", input.operationId).eq("operation_kind", "provision")
    .eq("desired_state", "running").eq("status", "provisioning")
    .is("vmid", null)
    .contains("operation_payload", { stage: "pre_allocation_access" })
    .select("id").maybeSingle();
  if (error) throw operationError(error);
  return Boolean(data);
}

/** Caller must first verify tunnel compensation and revoke the key it minted. */
export async function failHivraAgentBeforeAllocation(input: {
  userId: string;
  agentId: string;
  operationId: string;
  error: string;
}): Promise<boolean> {
  const { data, error } = await database().from("hivra_agents")
    .update({ status: "error", error: input.error.slice(0, 300), operation_id: null,
      operation_kind: null, operation_started_at: null, operation_payload: null })
    .eq("user_id", input.userId).eq("id", input.agentId)
    .eq("operation_id", input.operationId).eq("operation_kind", "provision")
    .eq("desired_state", "running").eq("status", "provisioning")
    .contains("operation_payload", { stage: "pre_allocation_access" })
    .is("vmid", null).is("cf_tunnel_id", null).is("cf_hostname", null)
    .select("id").maybeSingle();
  if (error) throw operationError(error);
  return Boolean(data);
}

export async function recordHivraAgentOperationFailure(input: {
  userId: string;
  agentId: string;
  operationId: string;
  error: string;
}): Promise<boolean> {
  return booleanRpc("record_hivra_agent_operation_failure", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
    p_error: input.error,
  });
}

export async function completeHivraAgentDelete(input: {
  userId: string;
  agentId: string;
  operationId: string;
}): Promise<boolean> {
  // Every finalizer, including abandoned-operation recovery and provision
  // compensation, must verify access/key cleanup before erasing resource IDs.
  const { data, error } = await database().from("hivra_agents")
    .select("cf_tunnel_id, cf_hostname, llm_config, computer_substrate")
    .eq("user_id", input.userId)
    .eq("id", input.agentId)
    .eq("operation_id", input.operationId)
    .eq("desired_state", "deleted")
    .in("operation_kind", ["delete", "provision"])
    .maybeSingle();
  if (error) throw operationError(error);
  if (!data) return false;
  if (data.computer_substrate === "provider-vm") {
    const verified = await booleanRpc("hivra_provider_cleanup_verified", {
      p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
    });
    // Do not revoke a live computer's access just because legacy recovery saw
    // no Proxmox VMID. SQL repeats this proof at the terminal update below.
    if (!verified) throw new HivraAgentOperationStoreError("conflict");
  } else if (data.computer_substrate != null && data.computer_substrate !== "proxmox-kvm") {
    throw new HivraAgentOperationStoreError("conflict");
  }
  try {
    await cleanupHivraAgentAccess({
      userId: input.userId,
      agentId: input.agentId,
      operationId: input.operationId,
      tunnelId: data.cf_tunnel_id,
      hostname: data.cf_hostname,
      llmConfig: data.llm_config,
    });
  } catch (cleanupError) {
    // Recovery retains the operation lease and retries the same identities.
    // The interactive API can release it to allow an immediate Delete retry.
    await recordHivraAgentOperationFailure({
      ...input,
      error: cleanupError instanceof HivraAgentDeleteCleanupError
        ? cleanupError.message : "Access cleanup could not be verified; deletion is incomplete.",
    }).catch(() => false);
    throw cleanupError;
  }
  return booleanRpc("complete_hivra_agent_delete", {
    p_user_id: input.userId,
    p_agent_id: input.agentId,
    p_operation_id: input.operationId,
  });
}
