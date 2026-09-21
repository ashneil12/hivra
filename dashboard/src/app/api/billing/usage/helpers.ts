export interface InstanceUsage {
  id: string;
  name: string;
  status: string;
  cpu_limit?: number | null;
  ram_limit?: number | null;
  disk_size_gb?: number | null;
  disk_upgraded?: boolean | null;
  backups_enabled?: boolean | null;
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
