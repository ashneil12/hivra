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
  archive_uri?: string | null;
  archive_sha256?: string | null;
  proxmox_vmid?: number | null;
}

export const LIVE_MUTATION_STATE_SELECT =
  "status,lifecycle_state,archive_uri,archive_sha256,proxmox_vmid";

// In addition to excluding the cold lifecycle states, bounded sweeps must
// exclude damaged failed+archive rows before LIMIT, or they can fill every
// batch forever and starve live computers waiting for their paid caps.
export const LIVE_MUTATION_NOT_FAILED_ARCHIVE_FILTER =
  "lifecycle_state.neq.failed,archive_uri.is.null,archive_sha256.is.null,proxmox_vmid.not.is.null";

export function blocksInstanceLiveMutation(row: InstanceLiveMutationState): boolean {
  return LIVE_MUTATION_BLOCKED_LIFECYCLES.some((state) => state === row.lifecycle_state)
    || row.status === "deleted"
    || row.status === "scheduled_for_deletion"
    // An earlier bad Start/update may have changed cold_archived to failed.
    // The dedicated VMID column is cleared on archive; config can retain the
    // old VMID and is deliberately not accepted as proof of a live guest.
    || (row.lifecycle_state === "failed" && !!row.archive_uri
      && !!row.archive_sha256 && row.proxmox_vmid == null);
}

/** Read at the mutation boundary: many callers carry a stale/projected row. */
export async function readInstanceLiveMutationBlock(
  supabase: SupabaseClient,
  instanceId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.from("hermes_instances")
      .select(LIVE_MUTATION_STATE_SELECT).eq("id", instanceId).maybeSingle();
    if (error || !data) return "Could not confirm the computer's current lifecycle state. Refresh before updating.";
    return blocksInstanceLiveMutation(data)
      ? "This computer must finish restoration or its current lifecycle operation before it can be updated."
      : null;
  } catch {
    return "Could not confirm the computer's current lifecycle state. Refresh before updating.";
  }
}
