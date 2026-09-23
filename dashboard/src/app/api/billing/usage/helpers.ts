export interface InstanceUsage {
  id: string;
  name: string;
  status: string;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  disk_size_gb?: number | null;
  disk_upgraded?: boolean | null;
  backups_enabled?: boolean | null;
  hetzner_server_id?: string | number | null;
  proxmox_node?: string | null;
  proxmox_vmid?: string | number | null;
  resource_tier?: string | null;
}

export interface HivraAgentUsage {
  id: string;
  name: string;
  status: string;
  cpu?: number | null;
  ram?: number | null;
  type?: string | null;
}

export function calculateUsage(instances: InstanceUsage[], hivraAgents: HivraAgentUsage[] = []) {
  const usedCpu = instances.reduce((acc, i) => acc + (i.cpu_limit || 0), 0);
  const usedRam = instances.reduce((acc, i) => acc + (i.ram_limit || 0), 0);
  // Match launch/resize admission: exempt runtimes consume a slot, not the
  // shared compute pool. Keep their actual size in the computer inventory.
  const usedHivraCpu = hivraAgents.reduce((acc, i) => acc + (isPoolExempt(String(i.type)) ? 0 : (i.cpu || 0)), 0);
  const usedHivraRam = hivraAgents.reduce((acc, i) => acc + (isPoolExempt(String(i.type)) ? 0 : (i.ram || 0) * 1024), 0);

  const mappedInstances = instances.map((i) => ({
    source: "hermes" as const,
    id: i.id,
    name: i.name,
    status: i.status,
    cpu: i.cpu_limit || 0,
    ram: i.ram_limit || 0,
    disk_size_gb: i.disk_size_gb || 40,
    disk_upgraded: i.disk_upgraded || false,
    backups_enabled: i.backups_enabled || false,
  }));

  const mappedHivraAgents = hivraAgents.map((i) => ({
    source: "hivra" as const,
    id: i.id,
    name: i.name,
    status: i.status,
    cpu: i.cpu || 0,
    ram: (i.ram || 0) * 1024,
    disk_size_gb: 0,
    disk_upgraded: false,
    backups_enabled: false,
    type: i.type ?? null,
  }));

  return {
    usedCpu: usedCpu + usedHivraCpu,
    usedRam: usedRam + usedHivraRam,
    instances: [...mappedInstances, ...mappedHivraAgents],
  };
}
import { isPoolExempt } from "@/lib/hivra/agent-catalog";

/**
 * Paid resource tiers whose Proxmox-hosted instances are backed up as part of
 * the plan. Keep in step with the backups flag the instance detail API
 * reports (api/instances/[id]/route.ts), which uses the same rule.
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

/** True when this instance's backups come with its plan (no add-on to buy). */
export function backupsIncludedWithInstance(instance: InstanceUsage): boolean {
  return Boolean(
    instance.proxmox_node &&
      instance.proxmox_vmid &&
      BACKUP_INCLUDED_RESOURCE_TIERS.includes(String(instance.resource_tier ?? ""))
  );
}

export interface BackupAddonAvailability {
  /** True when the $10/mo add-on can be bought right now (instanceIds is not empty). */
  purchasable: boolean;
  /** The instances POST /api/billing/backup-addon would accept, in list order. */
  instanceIds: string[];
  /** True when at least one active instance is backed up as part of its plan. */
  includedWithPlan: boolean;
}

/**
 * Whether the daily-backup add-on can actually be sold, using the same checks
 * POST /api/billing/backup-addon makes before it charges: a live Stripe
 * subscription for a paid plan, and a Hetzner-backed Hermes instance that is
 * not already backed up. Token, Free, Apple and manual plans, Proxmox
 * machines and Hivra agents can't take it, so the page must not offer it.
 */
export function resolveBackupAddon(
  sub: { source: string; plan: string; canChangePlanInPlace: boolean },
  activeInstances: InstanceUsage[]
): BackupAddonAvailability {
  const includedWithPlan = activeInstances.some(backupsIncludedWithInstance);
  const liveCardSubscription = sub.source === "stripe" && sub.plan !== "free" && sub.canChangePlanInPlace;
  const instanceIds = liveCardSubscription
    ? activeInstances
        .filter(
          (instance) =>
            Boolean(instance.hetzner_server_id) &&
            !instance.backups_enabled &&
            !backupsIncludedWithInstance(instance)
        )
        .map((instance) => instance.id)
    : [];
  return {
    purchasable: instanceIds.length > 0,
    instanceIds,
    includedWithPlan,
  };
}
