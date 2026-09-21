import type { ProxmoxHostCapacityPolicy } from "./contracts";

export const DEFAULT_PROXMOX_HOST_CAPACITY_POLICY: ProxmoxHostCapacityPolicy = {
  mode: "observe",
  hostMemoryReserveMb: 2048,
  cpuCeilingDensity: 1,
  memoryCeilingDensity: 1,
};

export function resolveProxmoxHostCapacityPolicy(
  value: ProxmoxHostCapacityPolicy | null | undefined,
): ProxmoxHostCapacityPolicy {
  return value ?? DEFAULT_PROXMOX_HOST_CAPACITY_POLICY;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildHostCapacityAdmissionCommand(input: {
  provisionerDirectory: string;
  targetVmid?: number | null;
  floorMemoryMb: number;
  maximumMemoryMb: number;
  maximumCpu: number;
  policy: ProxmoxHostCapacityPolicy;
  allowReduction?: boolean;
}): string {
  const density = (value: number) => Math.round(value * 1000);
  return [
    "bash",
    quote(`${input.provisionerDirectory}/hivra-host-capacity-admission`),
    input.targetVmid == null ? "-" : String(input.targetVmid),
    String(Math.round(input.floorMemoryMb)),
    String(Math.round(input.maximumMemoryMb)),
    String(input.maximumCpu),
    String(input.policy.hostMemoryReserveMb),
    input.policy.mode === "enforce" ? "1" : "0",
    String(density(input.policy.cpuCeilingDensity)),
    String(density(input.policy.memoryCeilingDensity)),
    input.allowReduction ? "1" : "0",
  ].join(" ");
}
