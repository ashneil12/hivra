import type { ProxmoxHostCapacityPolicy } from "./contracts";

export const CANARY_MEMORY_OVERCOMMIT_PROVISIONER = "2026.11.28.2";
export const CANARY_MEMORY_QA_CLONE_PROVISIONER = "2026.11.28.3";
export const CANARY_MEMORY_OVERCOMMIT_PROVISIONER_VERSIONS: readonly string[] = [
  CANARY_MEMORY_OVERCOMMIT_PROVISIONER,
  CANARY_MEMORY_QA_CLONE_PROVISIONER,
];
const CANARY_MEMORY_GUEST = /^([1-9][0-9]{2,8}):hivra-bind-[0-9a-f]{32}$/;
const CANARY_MEMORY_QA_CLONE = /^(93[0-9]{2}):hivra-qa-mem-[0-9a-f]{32}$/;
const PRESSURE_BASELINE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?::(?:0|[1-9][0-9]{0,15})){4}$/;
export const CANARY_MEMORY_HOST_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type CanaryMemoryOvercommit = {
  ratioMilli: number;
  validUntilEpoch: number;
  measuredGuests: string[];
  pressureBaseline: string;
  hostId: string;
  qaTemplateVmid: number | null;
};

export function parseCanaryMemoryOvercommit(data: unknown, expectedHost: string | null): CanaryMemoryOvercommit | null {
  if (!data || typeof data !== "object") return null;
  const { host_id, qa_template_vmid, ratio_milli, valid_until_epoch, measured_guests, pressure_baseline } = data as Record<string, unknown>;
  if (typeof host_id !== "string" || !CANARY_MEMORY_HOST_ID.test(host_id)
    || (expectedHost !== null && host_id !== expectedHost)
    || (expectedHost === null && qa_template_vmid === null)
    || (qa_template_vmid !== null && (typeof qa_template_vmid !== "number" || !Number.isInteger(qa_template_vmid)
      || qa_template_vmid < 100 || qa_template_vmid > 999999999 || (qa_template_vmid >= 9300 && qa_template_vmid <= 9399)))) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof ratio_milli !== "number" || !Number.isInteger(ratio_milli) || ratio_milli < 1001 || ratio_milli > 2000
    || typeof valid_until_epoch !== "number" || !Number.isInteger(valid_until_epoch)
    || valid_until_epoch <= now || valid_until_epoch > now + 90
    || !Array.isArray(measured_guests) || measured_guests.length > 64
    || typeof pressure_baseline !== "string" || !PRESSURE_BASELINE.test(pressure_baseline)) return null;
  const counters = pressure_baseline.split(":").slice(1).map(Number);
  if (!counters.every(Number.isSafeInteger) || counters[3] > 64) return null;
  const seen = new Set<string>();
  for (const entry of measured_guests) {
    const vmid = typeof entry === "string"
      ? (CANARY_MEMORY_GUEST.exec(entry) ?? CANARY_MEMORY_QA_CLONE.exec(entry))?.[1]
      : undefined;
    if (!vmid || vmid === "9302" || seen.has(vmid)) return null;
    seen.add(vmid);
  }
  return {
    ratioMilli: ratio_milli, validUntilEpoch: valid_until_epoch, measuredGuests: measured_guests,
    pressureBaseline: pressure_baseline, hostId: host_id, qaTemplateVmid: qa_template_vmid,
  };
}

export function canaryMemoryOvercommitShell(grant?: CanaryMemoryOvercommit | null): string {
  if (!grant) return "";
  const checked = parseCanaryMemoryOvercommit({
    host_id: grant.hostId,
    qa_template_vmid: grant.qaTemplateVmid,
    ratio_milli: grant.ratioMilli,
    valid_until_epoch: grant.validUntilEpoch,
    measured_guests: grant.measuredGuests,
    pressure_baseline: grant.pressureBaseline,
  }, grant.hostId);
  if (!checked) throw new Error("Invalid Canary memory overcommit grant");
  return `HIVRA_CAPACITY_CANARY_HOST_ID=${quote(checked.hostId)} HIVRA_CAPACITY_CANARY_OVERCOMMIT_MILLI=${checked.ratioMilli} HIVRA_CAPACITY_CANARY_OVERCOMMIT_UNTIL=${checked.validUntilEpoch} HIVRA_CAPACITY_CANARY_MEASURED_GUESTS=${quote(checked.measuredGuests.join("|"))} HIVRA_CAPACITY_CANARY_PRESSURE_BASELINE=${quote(checked.pressureBaseline)} `;
}

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
