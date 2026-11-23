import type { SupabaseClient } from "@supabase/supabase-js";
import { isColdArchiveUriForInstance } from "@/lib/cold-storage/manifest";
import { buildClearedArchivePointerPatch } from "@/lib/instance-lifecycle";
import { locateProxmoxInstanceAcrossFleet, type RecoverableProxmoxRow } from "@/lib/recovery/recover-orphan-provisioning";
import { stripProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import { resolveProxmoxHostEnv, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { buildOwnerColdStorageDeleteCommand, COLD_DELETE_STORAGE_RECEIPT } from "./cold-storage-delete-command";

const OWNER_ARCHIVE_DELETE = "owner_archive_delete";

type ArchiveDeleteRow = RecoverableProxmoxRow & {
  archive_uri?: string | null;
  archive_sha256?: string | null;
  lifecycle_substate?: string | null;
  last_lifecycle_transition_at?: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
};

type DeleteArchivedInstanceResult =
  | { kind: "deleted"; finalized: boolean }
  | { kind: "archive_invalid" | "instance_changed" | "runtime_present" | "runtime_unverified" }
  | { kind: "claim_failed" | "storage_failed" | "record_failed"; error: unknown };

export function isArchivedInstanceDelete(row: ArchiveDeleteRow): boolean {
  return row.lifecycle_state === "cold_archived"
    || row.lifecycle_state === "pending_deletion"
    // A `failed` archive that still owns a Proxmox VM belongs to the runtime
    // teardown path, not this archive-only helper: the helper never destroys a
    // guest, and its runtime-field guard would 409 the delete forever while the
    // VM keeps running. With `proxmox_vmid` still set the row falls through to
    // the resolved lifecycle target, which verifies teardown before the
    // tombstone. (Mirrors the Start route's `isColdLifecycleRow` gate.)
    || (row.lifecycle_state === "failed" && Boolean(row.archive_uri) && row.proxmox_vmid == null)
    || (row.lifecycle_state === "deleting" && (
      row.lifecycle_substate === OWNER_ARCHIVE_DELETE || Boolean(row.archive_uri)
    ));
}

export async function deleteArchivedInstance(
  db: SupabaseClient,
  row: ArchiveDeleteRow,
): Promise<DeleteArchivedInstanceResult> {
  const { id, archive_uri: uri, archive_sha256: checksum } = row;
  if (!uri || !isColdArchiveUriForInstance(uri, id) || checksum?.length !== 64 || !/^[a-f0-9]{64}$/i.test(checksum)) {
    return { kind: "archive_invalid" };
  }

  const resuming = row.lifecycle_state === "deleting" && row.lifecycle_substate === OWNER_ARCHIVE_DELETE;
  if (
    (!resuming && (row.lifecycle_state === "deleting" || row.lifecycle_substate != null))
    || row.proxmox_vmid != null || row.proxmox_node != null || row.ipv4_address != null
    || row.host_id != null || row.hetzner_server_id != null
  ) {
    return { kind: "instance_changed" };
  }

  // A cold archive and its old config can coexist with a VM whose removal
  // failed. Probe the actual fleet without trying to recover or destroy a guest.
  const runtime = await locateProxmoxInstanceAcrossFleet(row).catch(() => ({ status: "inconclusive" }));
  if (runtime.status === "found") return { kind: "runtime_present" };
  if (runtime.status !== "gone") return { kind: "runtime_unverified" };

  let hostEnv: ReturnType<typeof resolveProxmoxHostEnv>;
  try {
    const hostSlug = process.env.COLD_STORAGE_PURGE_HOST?.trim() || process.env.COLD_STORAGE_AUDIT_HOST?.trim();
    if (!hostSlug) return { kind: "storage_failed", error: new Error("A cold storage purge host is not configured") };
    hostEnv = resolveProxmoxHostEnv({ hostSlug, failClosed: true }, process.env);
  } catch (error) {
    return { kind: "storage_failed", error };
  }

  const claimAt = resuming ? row.last_lifecycle_transition_at : new Date().toISOString();
  if (!claimAt) return { kind: "instance_changed" };

  if (!resuming) {
    const requestedFrom = row.lifecycle_state;
    if (
      requestedFrom !== "cold_archived"
      && requestedFrom !== "pending_deletion"
      && requestedFrom !== "failed"
    ) return { kind: "instance_changed" };

    const claim = db.from("hermes_instances")
      .update({
        lifecycle_state: "deleting",
        lifecycle_substate: OWNER_ARCHIVE_DELETE,
        last_lifecycle_transition_at: claimAt,
        updated_at: claimAt,
      })
      .eq("id", id)
      .eq("user_id", row.user_id)
      .eq("lifecycle_state", requestedFrom)
      .is("lifecycle_substate", null)
      .is("deleted_at", null)
      .eq("archive_uri", uri)
      .eq("archive_sha256", checksum)
      .is("proxmox_vmid", null)
      .is("proxmox_node", null)
      .is("ipv4_address", null)
      .is("host_id", null)
      .is("hetzner_server_id", null);
    const locked = await (row.last_lifecycle_transition_at
      ? claim.eq("last_lifecycle_transition_at", row.last_lifecycle_transition_at)
      : claim.is("last_lifecycle_transition_at", null))
      .select("id")
      .maybeSingle();
    if (locked.error) return { kind: "claim_failed", error: locked.error };
    if (!locked.data) return { kind: "instance_changed" };
  } else {
    const current = await db.from("hermes_instances")
      .select("id")
      .eq("id", id)
      .eq("user_id", row.user_id)
      .eq("lifecycle_state", "deleting")
      .eq("lifecycle_substate", OWNER_ARCHIVE_DELETE)
      .eq("last_lifecycle_transition_at", claimAt)
      .eq("archive_uri", uri)
      .eq("archive_sha256", checksum)
      .is("deleted_at", null)
      .is("proxmox_node", null)
      .is("proxmox_vmid", null)
      .is("ipv4_address", null)
      .is("host_id", null)
      .is("hetzner_server_id", null)
      .maybeSingle();
    if (current.error) return { kind: "claim_failed", error: current.error };
    if (!current.data) return { kind: "instance_changed" };
  }

  // After a claim, even a failed request may have partly erased the archive.
  // Keep restore blocked and let a confirmed retry remove the same fixed paths.
  try {
    const result = await runProxmoxHostScript(buildOwnerColdStorageDeleteCommand(id), hostEnv, 120_000);
    if (!result.ok || !result.stdout.split(/\r?\n/).includes(COLD_DELETE_STORAGE_RECEIPT)) {
      return {
        kind: "storage_failed",
        error: new Error(result.error || result.stderr || "Storage host did not confirm absence"),
      };
    }
  } catch (error) {
    return { kind: "storage_failed", error };
  }

  const now = new Date().toISOString();
  const tombstone = await db.from("hermes_instances")
    .update({
      ...buildClearedArchivePointerPatch(),
      status: "deleted",
      lifecycle_state: "deleted",
      lifecycle_substate: null,
      deleted_at: now,
      updated_at: now,
      last_lifecycle_transition_at: now,
      scheduled_deletion_at: null,
      paused_reason: null,
      gateway_url: null,
      config: stripProxmoxInfrastructure(row.config, "vm_missing_across_fleet"),
    })
    .eq("id", id)
    .eq("user_id", row.user_id)
    .eq("lifecycle_state", "deleting")
    .eq("lifecycle_substate", OWNER_ARCHIVE_DELETE)
    .eq("last_lifecycle_transition_at", claimAt)
    .eq("archive_uri", uri)
    .eq("archive_sha256", checksum)
    .is("deleted_at", null)
    .is("proxmox_node", null)
    .is("proxmox_vmid", null)
    .is("ipv4_address", null)
    .is("host_id", null)
    .is("hetzner_server_id", null)
    .select("id")
    .maybeSingle();
  if (tombstone.error) return { kind: "record_failed", error: tombstone.error };
  if (tombstone.data) return { kind: "deleted", finalized: true };

  const alreadyDeleted = await db.from("hermes_instances")
    .select("id")
    .eq("id", id)
    .eq("user_id", row.user_id)
    .eq("lifecycle_state", "deleted")
    .eq("status", "deleted")
    .is("archive_uri", null)
    .not("deleted_at", "is", null)
    .maybeSingle();
  return alreadyDeleted.data
    ? { kind: "deleted", finalized: false }
    : { kind: "record_failed", error: alreadyDeleted.error ?? new Error("The deletion claim changed") };
}
