/**
 * Shared domain-row factories.
 *
 * Test files hand-build `hermes_instances` row literals with the same seventeen
 * columns in the same order. These factories produce that canonical shape so a
 * test only states the fields it actually asserts on.
 *
 * Column names match the real table (proxmox_vmid, ipv4_address,
 * infrastructure_provider) -- not a tidied-up version of it -- so the literals
 * stay assignable to the row types callers pass around.
 */
export interface InstanceRowSeed {
  id?: string;
  user_id?: string;
  name?: string;
  status?: string;
  backend?: string;
  provider?: string;
  infrastructure_provider?: string;
  subdomain?: string;
  host_id?: string | null;
  proxmox_vmid?: number | null;
  ipv4_address?: string | null;
  gateway_url?: string | null;
  hetzner_server_id?: string | null;
  api_key_encrypted?: string | null;
  api_server_key_encrypted?: string | null;
  honcho_api_key_encrypted?: string | null;
  config?: Record<string, unknown> | null;
  cpu_limit?: number;
  ram_limit?: number;
  [key: string]: unknown;
}

/** A hermes_instances row with every commonly-asserted column populated. */
export function makeInstanceRow(overrides: InstanceRowSeed = {}) {
  const id = overrides.id ?? "inst-123";
  return {
    id,
    user_id: "user_123",
    name: "Test Instance",
    status: "running",
    backend: "webui",
    provider: "crof",
    infrastructure_provider: "proxmox",
    subdomain: id,
    host_id: null,
    proxmox_vmid: 318,
    ipv4_address: null,
    gateway_url: `https://${id}.example.com`,
    hetzner_server_id: null,
    api_key_encrypted: "encrypted-provider",
    api_server_key_encrypted: "encrypted-server",
    honcho_api_key_encrypted: null,
    config: {},
    cpu_limit: 1,
    ram_limit: 1024,
    ...overrides,
  };
}

/** N rows derived from one seed, with ids suffixed -1..-N and per-row overrides. */
export function makeInstanceRows(count: number, overrides: InstanceRowSeed = {}) {
  return Array.from({ length: count }, (_, i) =>
    makeInstanceRow({ id: `inst-${i + 1}`, subdomain: `inst-${i + 1}`, ...overrides }),
  );
}
