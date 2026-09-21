type InstanceStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "error"
  | "deleted"
  | "redeploying";

export type InstanceLifecycleState =
  | "pending"
  | "provisioning"
  | "active"
  | "paused"
  | "suspended"
  | "deleting"
  | "deleted"
  | "failed";

export type InstanceBackend = "gateway" | "webui";

/**
 * The backends that provision the WEBFREE stack — the official-dashboard
 * container + the PUBLIC /webchat and /dash file_server shells (built by
 * buildWebUICaddyfile), reached by users through the cross-origin workspace
 * iframe, with the gateway agent on :8642 behind it.
 *
 * Phase-2 of the webui-retirement collapsed "gateway" and "webui" onto the SAME
 * webfree stack: the webfree builders take NO `backend` argument, so both values
 * produce a byte-identical box. The legacy no-public-shell stack
 * (buildAgentCaddyfile → catch-all → agent gateway :8642 → 404 in the iframe) is
 * retired: no backend value routes to it anymore.
 *
 * SINGLE SOURCE OF TRUTH: every deploy / redeploy / handoff / readiness /
 * control-plane / cron branch that historically keyed on `backend === "webui"`
 * MUST route through isWebfreeBackend so a "gateway" box gets identical webfree
 * treatment. The 2026-06-15 incident was a box that built the webfree stack but
 * was treated as legacy on ONE branch (or vice-versa) — this predicate prevents
 * that drift class. NOTE: agentPortsForBackend is deliberately NOT keyed on this
 * (the webfree stack binds 8642 = LEGACY_AGENT_PORTS; WEBUI_AGENT_PORTS=8787
 * matches nothing it runs). See reference: gateway-default-iframe-404-incident.
 */
export const WEBFREE_BACKENDS = ["webui", "gateway"] as const;

export function isWebfreeBackend(backend: string | null | undefined): boolean {
  return backend === "webui" || backend === "gateway";
}

/**
 * The docker-compose service that hosts the Hermes gateway on a webfree box.
 *
 * Legacy boxes provisioned as backend='webui' run a `webui` compose service.
 * Every modern webfree box (backend='gateway' — the Phase-2 default, see
 * WEBFREE_BACKENDS) runs a `gateway` service and has NO `webui` service, so a
 * hard-coded `docker compose … webui` aborts with `service "webui" is not
 * running`. Treat anything that isn't the explicit legacy 'webui' value as the
 * gateway service so a 'gateway' (or any future webfree) box restarts correctly.
 */
export function resolveWebfreeGatewayService(
  backend: string | null | undefined
): "gateway" | "webui" {
  return backend === "webui" ? "webui" : "gateway";
}

export interface Host {
  id: string;
  user_id: string;
  hetzner_server_id: number | null;
  name: string;
  total_cpu: number;
  total_ram: number;
  status: InstanceStatus;
  created_at: string;
  updated_at: string;
}

export interface Instance {
  id: string;
  user_id: string;
  name: string;
  subdomain: string | null;
  status: InstanceStatus;
  lifecycle_state?: InstanceLifecycleState;
  host_id?: string | null;
  cpu_limit?: number;
  ram_limit?: number;
  disk_size_gb?: number | null;
  resource_tier?: string | null;
  infrastructure_provider?: "hetzner" | "proxmox" | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  entitlement_state?: string | null;
  entitlement_reason?: string | null;
  entitlement_grace_started_at?: string | null;
  entitlement_grace_ends_at?: string | null;
  entitlement_suspended_at?: string | null;
  deleted_at?: string | null;
  last_lifecycle_transition_at?: string | null;
  hetzner_server_id: number | null;
  gateway_url: string | null;
  provider: string;
  backend?: InstanceBackend;
  honcho_api_key_encrypted?: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
