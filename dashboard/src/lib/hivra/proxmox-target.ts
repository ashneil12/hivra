const DEFAULT_HIVRA_PROXMOX_HOST = "local";
const DEFAULT_HIVRA_MAX_TENANT_INSTANCES = 40;

type EnvLike = Record<string, string | undefined>;

function envInt(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveHivraProxmoxHost(
  value?: string | null,
  env: EnvLike = process.env,
): string {
  const explicit = value?.trim();
  if (explicit) return explicit;
  return env.HIVRA_PROXMOX_HOST?.trim() || DEFAULT_HIVRA_PROXMOX_HOST;
}

export function resolveHivraClaudeCodeProxmoxHost(env: EnvLike = process.env): string | null {
  const explicit = env.HIVRA_CLAUDE_CODE_PROXMOX_HOST?.trim();
  if (!explicit) return null;

  const normalized = explicit.toLowerCase();
  if (["auto", "any", "rotation", "none", "disabled", "off", "0", "false"].includes(normalized)) {
    return null;
  }

  return explicit;
}

export function resolveHivraSubnetPrefix(env: EnvLike): string {
  return env.PROXMOX_PRIVATE_SUBNET_PREFIX?.trim() || "10.250.20";
}

export function resolveHivraVmidStart(env: EnvLike): number {
  return envInt(env, "PROXMOX_VMID_START", 200);
}

export function resolveHivraVmidEnd(env: EnvLike, vmidStart: number): number {
  const configuredEnd = envInt(env, "PROXMOX_VMID_END", 0);
  if (configuredEnd > 0) return configuredEnd;

  const maxTenantInstances = envInt(
    env,
    "HERMES_PROXMOX_MAX_TENANT_INSTANCES",
    DEFAULT_HIVRA_MAX_TENANT_INSTANCES,
  );
  if (maxTenantInstances > 0) return vmidStart + maxTenantInstances - 1;

  return 399;
}

export function resolveHivraIpLastOctetStart(env: EnvLike): number {
  return envInt(env, "PROXMOX_IP_LAST_OCTET_START", 50);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function resolveHivraNetworkConfig(host: string, env: EnvLike): {
  subnetPrefix: string;
  gateway: string;
} {
  const explicitSubnetPrefix = env.PROXMOX_PRIVATE_SUBNET_PREFIX?.trim();
  const explicitGateway = env.PROXMOX_PRIVATE_GATEWAY?.trim();
  if (!explicitSubnetPrefix || !explicitGateway) {
    throw new Error(`Hivra Proxmox host ${host} is missing PROXMOX_PRIVATE_SUBNET_PREFIX or PROXMOX_PRIVATE_GATEWAY`);
  }

  return { subnetPrefix: explicitSubnetPrefix, gateway: explicitGateway };
}
