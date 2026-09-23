/**
 * Paid resource tiers whose Proxmox-hosted instances are backed up as part of
 * the plan. The billing usage API (backup add-on offer) and the instance
 * detail API (backups flag) both read this one rule so they cannot drift.
 */
export const BACKUP_INCLUDED_RESOURCE_TIERS: readonly string[] = [
  "operator",
  "fleet",
  "command",
  "ws_cloud_pro",
  "ws_cloud_power",
  "credit_pro",
  "credit_power",
  "paid",
  "pro",
  "power",
];

export interface BackupCoverageInstance {
  proxmox_node?: string | null;
  proxmox_vmid?: number | string | null;
  resource_tier?: string | null;
}

/** True when this instance's backups come with its plan (no add-on to buy). */
export function backupsIncludedWithInstance(instance: BackupCoverageInstance): boolean {
  return Boolean(
    instance.proxmox_node &&
      instance.proxmox_vmid &&
      BACKUP_INCLUDED_RESOURCE_TIERS.includes(String(instance.resource_tier ?? ""))
  );
}
