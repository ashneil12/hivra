import type { SupabaseClient } from "@supabase/supabase-js";

/** These rows have no live guest, or another lifecycle operation owns it. */
export const LIVE_MUTATION_BLOCKED_LIFECYCLES = [
  "cold_archived", "pending_deletion", "archiving", "restoring", "deleting", "deleted",
] as const;
export const LIVE_MUTATION_BLOCKED_LIFECYCLE_IN_LIST =
  `("${LIVE_MUTATION_BLOCKED_LIFECYCLES.join('","')}")`;

export interface InstanceLiveMutationState {
  status?: string | null;
  lifecycle_state?: string | null;
  lifecycle_substate?: string | null;
  archive_uri?: string | null;
  archive_sha256?: string | null;
  proxmox_vmid?: number | null;
}

export interface InstanceLiveMutationCoordinates {
  config?: unknown;
  proxmox_vmid?: number | null;
  proxmox_node?: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
}

export interface InstanceLiveMutationResizeClaim {
  operationId: string;
  cpu: number;
  ramMb: number;
}

export const LIVE_MUTATION_STATE_SELECT =
  "status,lifecycle_state,lifecycle_substate,archive_uri,archive_sha256,proxmox_vmid,proxmox_node,host_id,hetzner_server_id,ipv4_address,config";

// In addition to excluding the cold lifecycle states, bounded sweeps must
// exclude damaged failed+archive rows before LIMIT, or they can fill every
// batch forever and starve live computers waiting for their paid caps.
export const LIVE_MUTATION_NOT_FAILED_ARCHIVE_FILTER =
  "lifecycle_state.neq.failed,archive_uri.is.null,archive_sha256.is.null,proxmox_vmid.not.is.null";

export function blocksInstanceLiveMutation(row: InstanceLiveMutationState): boolean {
  return LIVE_MUTATION_BLOCKED_LIFECYCLES.some((state) => state === row.lifecycle_state)
    || row.lifecycle_substate === "classic_start"
    || row.status === "deleted"
    || row.status === "scheduled_for_deletion"
    // An earlier bad Start/update may have changed cold_archived to failed.
    // The dedicated VMID column is cleared on archive; config can retain the
    // old VMID and is deliberately not accepted as proof of a live guest.
    || (row.lifecycle_state === "failed" && !!row.archive_uri
      && !!row.archive_sha256 && row.proxmox_vmid == null);
}

function infrastructure(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object") return {};
  const value = (config as Record<string, unknown>).infrastructure;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Compare only coordinates the caller actually loaded, including explicit nulls. */
export function instanceLiveMutationCoordinatesChanged(
  expected: InstanceLiveMutationCoordinates,
  current: InstanceLiveMutationCoordinates,
): boolean {
  for (const key of ["proxmox_vmid", "proxmox_node", "host_id", "hetzner_server_id", "ipv4_address"] as const) {
    if (expected[key] !== undefined && expected[key] !== current[key]) return true;
  }
  const before = infrastructure(expected.config);
  const after = infrastructure(current.config);
  if (expected.config !== undefined && Object.keys(before).length === 0
    && Object.keys(after).length > 0) return true;
  for (const key of ["provider", "vmid", "node", "hostSlug", "hostId", "hostEnvPrefix", "privateIpv4"]) {
    if (before[key] !== undefined && before[key] !== after[key]) return true;
  }
  return false;
}

/** Read at the mutation boundary: many callers carry a stale/projected row. */
export async function readInstanceLiveMutationBlock(
  supabase: SupabaseClient,
  instanceId: string,
  expectedCoordinates?: InstanceLiveMutationCoordinates,
  holderAllocation?: { cpu: number; ramMb: number },
  resizeClaim?: InstanceLiveMutationResizeClaim,
  expectedOwner?: string,
): Promise<string | null> {
  try {
    const resizeColumns = ",seat_funding,cpu_limit,ram_limit,resize_operation_id,resize_target_cpu,resize_target_ram_mb";
    const columns = holderAllocation || resizeClaim ? LIVE_MUTATION_STATE_SELECT + resizeColumns : LIVE_MUTATION_STATE_SELECT;
    const query = supabase.from("hermes_instances").select(columns).eq("id", instanceId);
    const { data: result, error } = await (expectedOwner ? query.eq("user_id", expectedOwner) : query).maybeSingle();
    const data = result as (InstanceLiveMutationState & InstanceLiveMutationCoordinates & {
      seat_funding?: string; cpu_limit?: number; ram_limit?: number;
      resize_operation_id?: string | null;
      resize_target_cpu?: number | string | null;
      resize_target_ram_mb?: number | string | null;
    }) | null;
    if (error || !data) return "Could not confirm the computer's current lifecycle state. Refresh before updating.";
    if (holderAllocation && (data.seat_funding !== "holder" || data.status !== "running" || data.lifecycle_state !== "active"
      || (!resizeClaim && (data.cpu_limit !== holderAllocation.cpu || data.ram_limit !== holderAllocation.ramMb)))) {
      return "The holder allocation or power state changed. Refresh before resizing.";
    }
    if (resizeClaim && (
      data.resize_operation_id !== resizeClaim.operationId
      || Number(data.resize_target_cpu) !== resizeClaim.cpu
      || Number(data.resize_target_ram_mb) !== resizeClaim.ramMb
    )) {
      return "This resize operation was superseded. Refresh before resizing.";
    }
    if (blocksInstanceLiveMutation(data)) {
      return "This computer must finish restoration or its current lifecycle operation before it can be updated.";
    }
    if (expectedCoordinates && instanceLiveMutationCoordinatesChanged(expectedCoordinates, data)) {
      return "This computer moved or was restored since it was loaded. Refresh before updating.";
    }
    return null;
  } catch {
    return "Could not confirm the computer's current lifecycle state. Refresh before updating.";
  }
}
