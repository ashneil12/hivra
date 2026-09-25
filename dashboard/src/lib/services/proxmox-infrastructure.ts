export interface ProxmoxInfrastructure {
  provider: "proxmox";
  node?: string;
  vmid: number;
  privateIpv4: string;
  gatewayHost: string;
  templateVmid?: number;
  /** Non-secret owner metadata used to route future lifecycle calls to the same Proxmox host. */
  hostId?: string;
  hostSlug?: string;
  hostEnvPrefix?: string;
}

export interface ProxmoxHostRoutingConfig {
  hostId?: string | null;
  hostSlug?: string | null;
  envPrefix?: string | null;
  failClosed?: boolean;
}

function normalizeProxmoxHostSlug(value: string | null | undefined): string | null {
  const slug = value?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || null;
}

export function getProxmoxInfrastructure(config: unknown): ProxmoxInfrastructure | null {
  const rawConfig =
    typeof config === "object" && config ? (config as Record<string, unknown>) : {};
  const infrastructure = rawConfig.infrastructure;
  if (typeof infrastructure !== "object" || !infrastructure) return null;

  const raw = infrastructure as Record<string, unknown>;
  if (raw.provider !== "proxmox") return null;
  if (typeof raw.vmid !== "number" || !Number.isFinite(raw.vmid)) return null;
  if (typeof raw.privateIpv4 !== "string" || !raw.privateIpv4.trim()) return null;
  if (typeof raw.gatewayHost !== "string" || !raw.gatewayHost.trim()) return null;

  const templateVmid =
    typeof raw.templateVmid === "number" && Number.isFinite(raw.templateVmid)
      ? raw.templateVmid
      : undefined;
  const node =
    typeof raw.node === "string" && raw.node.trim()
      ? normalizeProxmoxHostSlug(raw.node)
      : typeof raw.proxmoxNode === "string" && raw.proxmoxNode.trim()
        ? normalizeProxmoxHostSlug(raw.proxmoxNode)
        : undefined;
  const hostId = typeof raw.hostId === "string" && raw.hostId.trim() ? raw.hostId.trim() : undefined;
  const hostSlug = typeof raw.hostSlug === "string" && raw.hostSlug.trim() ? raw.hostSlug.trim() : undefined;
  const hostEnvPrefix =
    typeof raw.hostEnvPrefix === "string" && raw.hostEnvPrefix.trim() ? raw.hostEnvPrefix.trim() : undefined;

  return {
    provider: "proxmox",
    ...(node ? { node } : {}),
    vmid: raw.vmid,
    privateIpv4: raw.privateIpv4,
    gatewayHost: raw.gatewayHost,
    ...(templateVmid ? { templateVmid } : {}),
    ...(hostId ? { hostId } : {}),
    ...(hostSlug ? { hostSlug } : {}),
    ...(hostEnvPrefix ? { hostEnvPrefix } : {}),
  };
}

/**
 * Reason the lifecycle handle was deliberately released. Recorded on
 * `config.infrastructureReleased` so the DELETE / force-delete / account-delete
 * guards can distinguish why a handle moved. The reason must still be checked:
 * not every marker is authoritative teardown evidence.
 */
export type ProxmoxInfrastructureReleaseReason =
  | "vm_missing_on_routed_host"
  | "vm_missing_across_fleet"
  | "post_provision_stale_conflict"
  | "dormant_reclaim"
  /** Stamped by a one-shot backfill migration for rows stripped before the
   *  marker existed (config.infrastructure already null + proxmox_vmid null
   *  + infrastructure_provider still 'proxmox', making them undeletable). */
  | "legacy_backfill"
  /** Stamped after the post-provision rollback path destroys a freshly
   *  cloned VM because the row's metadata UPDATE failed. Without this
   *  marker the row keeps `infrastructure_provider='proxmox'` while the
   *  VM is verifiably gone, and the DELETE handler refuses (no handle to
   *  teardown, no proof teardown already happened). See instance-service
   *  rollback in provisionInstance. */
  | "post_provision_rollback";

export interface ProxmoxInfrastructureReleaseMarker {
  at: string;
  reason: ProxmoxInfrastructureReleaseReason;
}

/**
 * Remove `config.infrastructure` from an instance row's config blob, releasing
 * the row's pointer to a specific Proxmox VM, and stamp `config.infrastructureReleased`
 * with the reason so downstream delete paths know the VM teardown is already
 * resolved (vs. a legacy row that never had a handle). Pair this with nulling
 * the `proxmox_vmid` / `proxmox_node` / `ipv4_address` / `gateway_url` columns
 * when the row should no longer claim a VM (e.g. vmMissing detection,
 * post-provision stale-conflict recovery). Without stripping the config,
 * `resolveProxmoxLifecycleTarget` keeps returning the stale handle and a later
 * delete can teardown a vmid that has since been recycled to a different
 * user's row.
 */
export function stripProxmoxInfrastructure(
  config: Record<string, unknown> | null | undefined,
  reason: ProxmoxInfrastructureReleaseReason,
): Record<string, unknown> {
  const next = config && typeof config === "object" && !Array.isArray(config) ? { ...config } : {};
  delete next.infrastructure;
  next.infrastructureReleased = {
    at: new Date().toISOString(),
    reason,
  } satisfies ProxmoxInfrastructureReleaseMarker;
  return next;
}

/**
 * Returns the release marker if the row's Proxmox handle was deliberately
 * stripped (vmMissing or post-provision conflict). Pair with `isProxmoxBackedInstanceRow`
 * in delete guards: a row that LOOKS Proxmox-backed but has a release marker
 * may be safe to mark deleted without provider teardown. Call
 * `isProxmoxReleaseSafeForDbOnlyDelete` before treating it as proof; a
 * single-routed-host miss and a legacy backfill deliberately fail closed.
 */
export function getReleasedProxmoxInfrastructure(
  config: unknown,
): ProxmoxInfrastructureReleaseMarker | null {
  if (typeof config !== "object" || !config) return null;
  const raw = (config as Record<string, unknown>).infrastructureReleased;
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const at = typeof data.at === "string" && data.at.trim() ? data.at : null;
  const reason =
    data.reason === "vm_missing_on_routed_host" ||
    data.reason === "vm_missing_across_fleet" ||
    data.reason === "post_provision_stale_conflict" ||
    data.reason === "dormant_reclaim" ||
    data.reason === "legacy_backfill" ||
    data.reason === "post_provision_rollback"
      ? (data.reason as ProxmoxInfrastructureReleaseReason)
      : null;
  if (!at || !reason) return null;
  return { at, reason };
}

/**
 * Only markers backed by provider teardown or a conclusive fleet-wide absence
 * may authorize a database-only delete. A miss on one routed host is routing
 * evidence, not teardown evidence: the VM may still be running elsewhere.
 * Legacy backfill markers are likewise not provider receipts.
 */
export function isProxmoxReleaseSafeForDbOnlyDelete(
  marker: ProxmoxInfrastructureReleaseMarker | null | undefined,
): boolean {
  if (!marker) return false;
  return (
    marker.reason === "vm_missing_across_fleet" ||
    marker.reason === "post_provision_stale_conflict" ||
    marker.reason === "dormant_reclaim" ||
    marker.reason === "post_provision_rollback"
  );
}

export function getProxmoxHostRoutingConfigFromInfrastructure(
  infrastructure: Pick<ProxmoxInfrastructure, "hostId" | "hostSlug" | "hostEnvPrefix" | "node"> | null | undefined,
  row?: { host_id?: string | null } | null
): ProxmoxHostRoutingConfig | null {
  const hostId = infrastructure?.hostId ?? row?.host_id ?? null;
  const hostSlug = infrastructure?.hostSlug ?? infrastructure?.node ?? null;
  const envPrefix = infrastructure?.hostEnvPrefix ?? null;
  if (!hostId && !hostSlug && !envPrefix) return null;
  return {
    hostId,
    hostSlug,
    envPrefix,
    failClosed: true,
  };
}

/**
 * The `sshExec` target for a Hermes instance row: the host it lives on, its
 * stored VMID and its id, so the Proxmox host binds SSH to that VM and checks
 * the VM is still this instance's. Null for a row with no Proxmox handle
 * (Hetzner boxes), which sshExec reaches directly.
 *
 * Every guest command for an instance should pass this. The guest IP is not an
 * identity: hosts share a private prefix and number guests from the same
 * start, so the same IP is a different tenant's VM on another host.
 */
export function getHermesGuestSshTarget(
  row: (Omit<ProxmoxLifecycleRow, "infrastructure_provider"> & { id?: string | null }) | null | undefined,
): (ProxmoxHostRoutingConfig & { vmid: number; instanceId: string }) | null {
  if (!row?.id) return null;
  const infrastructure = resolveProxmoxLifecycleTarget(row);
  if (!infrastructure) return null;
  return {
    ...(getProxmoxHostRoutingConfigFromInfrastructure(infrastructure, row) ?? { failClosed: true }),
    vmid: infrastructure.vmid,
    instanceId: row.id,
  };
}

/**
 * Subset of `hermes_instances` columns needed to derive a `ProxmoxInfrastructure`
 * for lifecycle (delete/shutdown/etc) operations when `config.infrastructure` is
 * incomplete or stale.
 */
export interface ProxmoxLifecycleRow {
  config?: unknown;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  ipv4_address?: string | null;
  gateway_url?: string | null;
  subdomain?: string | null;
  infrastructure_provider?: "hetzner" | "proxmox" | null;
  host_id?: string | null;
}

function parseGatewayHostFromUrl(gatewayUrl: string | null | undefined): string | null {
  if (!gatewayUrl || typeof gatewayUrl !== "string") return null;
  const trimmed = gatewayUrl.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).host || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Proxmox lifecycle target from any available signal: `config.infrastructure`
 * first, then DB columns (`proxmox_vmid`, `proxmox_node`, `gateway_url`, `ipv4_address`)
 * as the fallback. Returns null only when there is genuinely no Proxmox handle to act on.
 *
 * Use this before any teardown (delete / force-delete / purge / account-deletion) to
 * avoid the silent fall-through that left the dashboard marking rows deleted while
 * the underlying VM kept running for days. (See the 2026-05-08 zombie incident:
 * three fixturenodea VMs running for 2-7 days with their DB rows already marked deleted.)
 */
export function resolveProxmoxLifecycleTarget(
  row: ProxmoxLifecycleRow | null | undefined,
): ProxmoxInfrastructure | null {
  if (!row) return null;

  const fromConfig = getProxmoxInfrastructure(row.config);
  if (fromConfig) return fromConfig;

  const vmid = typeof row.proxmox_vmid === "number" && Number.isFinite(row.proxmox_vmid)
    ? row.proxmox_vmid
    : null;
  if (vmid === null) return null;

  const privateIpv4 =
    typeof row.ipv4_address === "string" && row.ipv4_address.trim()
      ? row.ipv4_address.trim()
      : null;
  if (!privateIpv4) return null;

  const gatewayHost = parseGatewayHostFromUrl(row.gateway_url);
  if (!gatewayHost) return null;

  const node =
    typeof row.proxmox_node === "string" && row.proxmox_node.trim()
      ? normalizeProxmoxHostSlug(row.proxmox_node) ?? undefined
      : undefined;

  return {
    provider: "proxmox",
    ...(node ? { node } : {}),
    vmid,
    privateIpv4,
    gatewayHost,
  };
}

/**
 * Returns true when the row LOOKS Proxmox-backed regardless of whether we can
 * build a complete lifecycle target. Use this as a guard against silently
 * marking a row deleted when no provider teardown was attempted.
 */
export function isProxmoxBackedInstanceRow(
  row: ProxmoxLifecycleRow | null | undefined,
): boolean {
  if (!row) return false;
  if (row.infrastructure_provider === "proxmox") return true;
  if (typeof row.proxmox_vmid === "number" && Number.isFinite(row.proxmox_vmid)) return true;
  return Boolean(getProxmoxInfrastructure(row.config));
}
