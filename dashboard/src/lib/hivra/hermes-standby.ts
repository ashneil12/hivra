export const HERMES_STANDBY_PROVISIONER_VERSIONS: readonly string[] = ["2026.11.27.7", "2026.11.28.1", "2026.11.28.2", "2026.11.28.3"];
export const HERMES_STANDBY_CPU_UNITS = 100;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function isHermesStandbyGeneration(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

export function isHermesStandbyVmid(vmid: number): boolean {
  return Number.isSafeInteger(vmid) && vmid >= 9300 && vmid <= 9399 && vmid !== 9302;
}

export type HermesStandby = {
  host: string;
  generation: string;
  vmid: number;
  privateIp: string;
};

export function parseHermesStandbyIdentity(
  value: unknown,
  bounds: { host: string; subnetPrefix: string; ipLastOctetStart: number },
): HermesStandby | null {
  if (!value || typeof value !== "object") return null;
  const { generation, vmid, privateIp } = value as Record<string, unknown>;
  if (!isHermesStandbyGeneration(generation)
      || typeof vmid !== "number" || !isHermesStandbyVmid(vmid)
      || typeof privateIp !== "string" || !privateIp.startsWith(`${bounds.subnetPrefix}.`)) return null;
  const octet = Number(privateIp.slice(bounds.subnetPrefix.length + 1));
  if (!Number.isInteger(octet) || octet < Math.max(2, bounds.ipLastOctetStart) || octet > 254
      || privateIp !== `${bounds.subnetPrefix}.${octet}`) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(bounds.host)) return null;
  return { host: bounds.host, generation, vmid, privateIp };
}
