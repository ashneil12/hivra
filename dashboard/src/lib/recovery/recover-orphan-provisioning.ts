/**
 * Recover-orphan-provisioning sweeper.
 *
 * The createInstance flow has a known failure mode: provisionProxmoxInstance
 * succeeds (VM running on Proxmox, Caddy site live) but the post-provision
 * UPDATE in instance-service.ts cannot persist the metadata. Causes seen:
 *   - Unique-key conflict on (proxmox_node, proxmox_vmid) that the inline
 *     recoverStaleProxmoxMetadataConflict path couldn't clear. The predicate
 *     widening on 2026-05-12 closes most of those, but races and DB blips
 *     still leak rows.
 *   - Vercel function timing out at 300s before the UPDATE statement fires.
 *     Phase 1 of provisioning is now async-via-nohup so this is rare, but
 *     account validation or pre-flight checks can still chew up the budget.
 *
 * Symptom: a row has missing Proxmox metadata (`proxmox_vmid IS NULL`,
 * `gateway_url IS NULL`, `ipv4_address IS NULL`, or a stale bearer), while a
 * matching VM exists on a Proxmox host. This can happen after a normal create
 * or after the targeted missing-VM recreate route succeeds provider-side but
 * loses the final database write to a stale unique-key conflict.
 *
 * Recovery: scan known Proxmox hosts for a VM whose name embeds this
 * instance's ID prefix (provisioner uses `hermes-<name>-<id-prefix>`
 * format). When found, lift the VMID, private IP, gateway FQDN, and the
 * Caddyfile bearer back into the DB row. The bearer is in the per-instance
 * Caddyfile inside the guest VM; we read it via the existing Proxmox host
 * → guest bastion pattern.
 *
 * Idempotent. Safe to run alongside the inline recovery in instance-service.
 *
 * Schedule: every 5 minutes via vercel.json.
 */

import { encryptApiKey } from "@/lib/crypto";
import { log } from "@/lib/logger";
import { isClearableStaleProxmoxMetadataRow } from "@/lib/proxmox-metadata-row";
import { reconcileSoulSeedAfterReady } from "@/lib/recovery/soul-seed-reconcile";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import type { ProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "recover-orphan-provisioning";
// 10 min grace so we don't race a legitimate in-flight provision whose
// Phase 1 SSH session is still alive. Phase 1 alone is ~30s; the budget
// here is wildly conservative to avoid undoing healthy work.
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
// Per-run cap. Each candidate fans out across known hosts; keep within
// the Vercel cron 300s ceiling.
const MAX_CANDIDATES_PER_RUN = 8;
const SAFE_PROXMOX_HOST_SLUG = /^[a-z][a-z0-9_]{0,62}$/;

function configuredFallbackProxmoxHostSlugs(env: NodeJS.ProcessEnv): string[] {
  const configuredList = env.HERMES_PROXMOX_TARGETS?.trim() || env.PROXMOX_TARGETS?.trim() || "";
  const singular =
    env.HERMES_PROXMOX_TARGET?.trim() ||
    env.PROXMOX_TARGET?.trim() ||
    env.PROXMOX_NODE?.trim() ||
    "";
  const slugs = (configuredList || singular)
    .split(/[,\s]+/)
    .map((slug) => slug.toLowerCase())
    .filter((slug, index, values) => SAFE_PROXMOX_HOST_SLUG.test(slug) && values.indexOf(slug) === index);
  for (const key of Object.keys(env)) {
    const match = key.match(/^PROXMOX_HOST_([A-Z0-9_]+)_SSH_HOST$/);
    const slug = match?.[1]?.toLowerCase();
    if (slug && SAFE_PROXMOX_HOST_SLUG.test(slug) && !slugs.includes(slug)) {
      slugs.push(slug);
    }
  }
  return slugs;
}

export type RecoverableProxmoxRow = {
  id: string;
  user_id: string;
  status?: string | null;
  lifecycle_state?: string | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  proxmox_template_vmid?: number | null;
  ipv4_address?: string | null;
  gateway_url?: string | null;
  api_server_key_encrypted?: string | null;
  config?: Record<string, unknown> | null;
  subdomain?: string | null;
  updated_at?: string | null;
};

type HostSearchResult = FoundProxmoxVm | "absent" | "present" | "inconclusive";

type FoundProxmoxVm = {
  hostSlug: string;
  vmid: number;
  privateIpv4: string;
  gatewayFqdn: string;
  // A stopped VM cannot be reached over guest SSH. When the database already
  // has its encrypted bearer, host-side discovery may still safely recover the
  // VM routing without replacing that secret.
  bearer?: string;
  vmStatus?: "running" | "stopped" | "unknown";
};

type ProxmoxMetadataConflictRow = {
  id?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  config?: Record<string, unknown> | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
};

export interface RecoverOrphanProvisioningSummary {
  candidates: number;
  recovered: number;
  notFound: number;
  errors: number;
}

export interface RecoverOrphanProvisioningOptions {
  instanceId?: string | null;
}

function configInfraNode(config: Record<string, unknown> | null | undefined): string | null {
  if (!config || typeof config !== "object") return null;
  const infra = (config as { infrastructure?: { node?: unknown } }).infrastructure;
  if (!infra || typeof infra !== "object") return null;
  const node = (infra as { node?: unknown }).node;
  return typeof node === "string" && node.trim() ? node.trim() : null;
}

/**
 * Build the discovery script that runs on a Proxmox host. Single composite
 * script keeps the SSH round-trips to one per (host, instance) probe.
 *
 * Output contract — first line is always one of:
 *   RESULT OK            (followed by VMID=, PRIVIP=, FQDN=, BEARER= lines)
 *   RESULT NOT_FOUND     (no VM matching this instance ID on this host)
 *   RESULT NO_IP         (VM exists but has no ipconfig0)
 *   RESULT NO_FQDN       (VM exists but no caddy site routes to its IP)
 *   RESULT NO_BEARER     (VM unreachable over SSH or Caddyfile bearer missing)
 *
 * Failures other than NOT_FOUND are diagnostic. One safe exception is a
 * NO_BEARER result for a row that already has an encrypted bearer: this is the
 * expected shape of a stopped VM, whose host-side routing can be restored
 * without guest SSH or secret replacement.
 */
function buildDiscoveryScript(instanceId: string): string {
  const idPrefix = instanceId.slice(0, 8);
  return `
set -uo pipefail

VMID=$(qm list 2>/dev/null | awk -v p="-${idPrefix}$" 'NR>1 && $2 ~ p {print $1; exit}')
if [ -z "$VMID" ]; then
  echo "RESULT NOT_FOUND"
  exit 0
fi

VMSTATUS=$(qm status "$VMID" 2>/dev/null | awk '{print $2}')

IPCFG=$(qm config "$VMID" 2>/dev/null | awk -F: '/^ipconfig0:/{$1=""; print $0}')
PRIVIP=$(echo "$IPCFG" | grep -oE 'ip=[0-9.]+' | head -1 | cut -d= -f2)
if [ -z "$PRIVIP" ]; then
  echo "RESULT NO_IP"
  echo "VMID=$VMID"
  echo "VMSTATUS=$VMSTATUS"
  exit 0
fi

FQDN=$(grep -lE "reverse_proxy[^#]*$PRIVIP" /etc/caddy/hermes.d/*.caddy 2>/dev/null | while IFS= read -r site; do
  if grep -q "${instanceId}" "$site" 2>/dev/null; then
    basename "$site" .caddy
    break
  fi
done)
if [ -z "$FQDN" ]; then
  echo "RESULT NO_FQDN"
  echo "VMID=$VMID"
  echo "VMSTATUS=$VMSTATUS"
  echo "PRIVIP=$PRIVIP"
  exit 0
fi

# Bastion into the guest and read the Caddyfile bearer. Hermes provisioner
# bakes the apiServerKey into the per-instance Caddyfile as Bearer <64 hex>.
# -n is required here: without it, nested guest SSH can consume the remaining
# host-side discovery script from stdin, leaving stdout empty and making a
# real VM look unrecoverable.
BEARER=$(ssh -n -i /etc/hivra/keys/vm-orchestrator -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -o BatchMode=yes "hermes@$PRIVIP" "sudo -n grep -oE 'Bearer [a-f0-9]{64}' /opt/hermes/instances/${instanceId}/Caddyfile 2>/dev/null | head -1 | cut -d' ' -f2" 2>/dev/null)
if [ -z "$BEARER" ]; then
  echo "RESULT NO_BEARER"
  echo "VMID=$VMID"
  echo "VMSTATUS=$VMSTATUS"
  echo "PRIVIP=$PRIVIP"
  echo "FQDN=$FQDN"
  exit 0
fi

echo "RESULT OK"
echo "VMID=$VMID"
echo "VMSTATUS=$VMSTATUS"
echo "PRIVIP=$PRIVIP"
echo "FQDN=$FQDN"
echo "BEARER=$BEARER"
`;
}

function parseDiscoveryStdout(stdout: string): {
  result: "OK" | "NOT_FOUND" | "NO_IP" | "NO_FQDN" | "NO_BEARER" | "UNKNOWN";
  vmid?: number;
  privip?: string;
  fqdn?: string;
  bearer?: string;
  vmStatus?: "running" | "stopped" | "unknown";
} {
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return { result: "UNKNOWN" };
  const head = lines[0]?.replace(/^RESULT\s+/, "");
  const result =
    head === "OK" || head === "NOT_FOUND" || head === "NO_IP" || head === "NO_FQDN" || head === "NO_BEARER"
      ? head
      : "UNKNOWN";
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const vmidNum = fields.VMID ? Number.parseInt(fields.VMID, 10) : Number.NaN;
  const vmStatus =
    fields.VMSTATUS === "running" || fields.VMSTATUS === "stopped"
      ? fields.VMSTATUS
      : "unknown";
  return {
    result,
    vmid: Number.isFinite(vmidNum) ? vmidNum : undefined,
    privip: fields.PRIVIP || undefined,
    fqdn: fields.FQDN || undefined,
    bearer: fields.BEARER || undefined,
    vmStatus,
  };
}

async function searchHost(hostSlug: string, instanceId: string): Promise<HostSearchResult> {
  // Host discovery must never inherit ambient PROXMOX_* credentials for a
  // different machine. An unconfigured host is inconclusive, not absent.
  const hostConfig: ProxmoxHostRoutingConfig = { hostSlug, failClosed: true };
  let env;
  try {
    env = resolveProxmoxHostEnv(hostConfig, process.env);
  } catch (resolveError) {
    log.warn("recover-orphan: host env unresolved, skipping", {
      source: SOURCE,
      failureType: "recover_orphan_host_env_unresolved",
      hostSlug,
      instanceId,
      errorMessage: resolveError instanceof Error ? resolveError.message : String(resolveError),
    });
    return "inconclusive";
  }

  const script = buildDiscoveryScript(instanceId);
  const result = await runProxmoxHostScript(script, env, 25_000);
  if (!result.ok) {
    log.info("recover-orphan: discovery script failed on host", {
      source: SOURCE,
      failureType: "recover_orphan_discovery_failed",
      hostSlug,
      instanceId,
      stderr: (result.stderr || "").slice(0, 200),
      error: (result.error || "").slice(0, 200),
    });
    return "inconclusive";
  }

  const parsed = parseDiscoveryStdout(result.stdout);
  if (parsed.result === "OK" && parsed.vmid && parsed.privip && parsed.fqdn && parsed.bearer) {
    return {
      hostSlug,
      vmid: parsed.vmid,
      privateIpv4: parsed.privip,
      gatewayFqdn: parsed.fqdn,
      bearer: parsed.bearer,
      vmStatus: parsed.vmStatus,
    };
  }

  // Host-side metadata remains authoritative while a stopped guest cannot be
  // reached for its bearer. The caller may adopt this partial hit only when it
  // already has an encrypted bearer to preserve.
  if (
    parsed.result === "NO_BEARER" &&
    parsed.vmid &&
    parsed.privip &&
    parsed.fqdn &&
    parsed.vmStatus === "stopped"
  ) {
    return {
      hostSlug,
      vmid: parsed.vmid,
      privateIpv4: parsed.privip,
      gatewayFqdn: parsed.fqdn,
      vmStatus: parsed.vmStatus,
    };
  }

  const logPayload = {
    source: SOURCE,
    failureType: "recover_orphan_discovery_unrecoverable",
    hostSlug,
    instanceId,
    discoveryResult: parsed.result,
    vmid: parsed.vmid ?? null,
    hasPrivateIpv4: Boolean(parsed.privip),
    hasGatewayFqdn: Boolean(parsed.fqdn),
    stdoutPreview: parsed.result === "UNKNOWN" ? result.stdout.slice(0, 200) : undefined,
  };
  if (parsed.result === "NOT_FOUND") {
    // No VM with this instance id on this host.
    log.debug("recover-orphan: discovery did not find VM on host", logPayload);
    return "absent";
  }
  if (parsed.result === "UNKNOWN") {
    log.warn("recover-orphan: discovery returned an unrecoverable result", logPayload);
    return "inconclusive";
  }
  // NO_IP / NO_FQDN / NO_BEARER (or an OK with a missing field): the VM EXISTS
  // on this host but isn't fully recoverable yet — it is NOT gone.
  log.warn("recover-orphan: discovery returned an unrecoverable result", logPayload);
  return "present";
}

/**
 * Live list of Proxmox host slugs to search, sourced from the proxmox_hosts
 * registry so newly-added hosts are covered automatically. Searches every
 * registered host regardless of status — an orphan VM can sit on a
 * draining/maintenance host too. If the registry is unreadable or empty, only
 * explicitly configured host identities are safe to probe; an invented static
 * fleet list could route credentials to the wrong machine.
 */
export async function loadKnownProxmoxHostSlugs(): Promise<string[]> {
  const configuredFallback = configuredFallbackProxmoxHostSlugs(process.env);
  if (!supabaseAdmin) return configuredFallback;
  try {
    const { data, error } = await supabaseAdmin.from("proxmox_hosts").select("id");
    if (error || !data || data.length === 0) {
      log.warn("recover-orphan: proxmox_hosts registry unreadable/empty; using configured fallback host list", {
        source: SOURCE,
        failureType: "recover_orphan_host_list_fallback",
        errorMessage: error?.message,
      });
      return configuredFallback;
    }
    const slugs = data
      .map((row) => (row as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
    return slugs.length > 0 ? slugs : configuredFallback;
  } catch (err) {
    log.warn("recover-orphan: proxmox_hosts registry query threw; using configured fallback host list", {
      source: SOURCE,
      failureType: "recover_orphan_host_list_threw",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return configuredFallback;
  }
}

async function searchAllHosts(
  row: RecoverableProxmoxRow,
  knownSlugs: string[],
  allowStopped = false,
): Promise<{ found: FoundProxmoxVm } | { found: null; gone: boolean }> {
  // Prefer hosts the row already names (config.infrastructure.node, then
  // proxmox_node column). Even though Vercel's UPDATE didn't persist these
  // for true orphans, sometimes they were partially populated.
  const preferred: string[] = [];
  const fromConfig = configInfraNode(row.config);
  if (fromConfig) preferred.push(fromConfig);
  if (row.proxmox_node && !preferred.includes(row.proxmox_node)) preferred.push(row.proxmox_node);
  const remaining = knownSlugs.filter((s) => !preferred.includes(s));
  const canRecover = (hit: FoundProxmoxVm) =>
    Boolean(hit.bearer) ||
    (allowStopped && hit.vmStatus === "stopped" && Boolean(row.api_server_key_encrypted));

  let sawPresent = false;
  let sawAbsent = false;
  let sawInconclusive = false;
  const tally = (r: "absent" | "present" | "inconclusive") => {
    if (r === "absent") sawAbsent = true;
    else if (r === "present") sawPresent = true;
    else sawInconclusive = true;
  };

  for (const slug of preferred) {
    const hit = await searchHost(slug, row.id);
    if (typeof hit === "object") {
      if (canRecover(hit)) return { found: hit };
      tally("present");
      continue;
    }
    tally(hit);
  }
  // Fan out across remaining hosts in parallel — first hit wins.
  const probes = remaining.map((slug) =>
    searchHost(slug, row.id).catch(() => "inconclusive" as const)
  );
  const results = await Promise.all(probes);
  for (const r of results) {
    if (typeof r === "object" && canRecover(r)) {
      return { found: r };
    }
  }
  for (const r of results) {
    if (typeof r === "object") tally("present");
    else tally(r);
  }

  // The VM is conclusively gone only when at least one host positively reported
  // NOT_FOUND and NO host saw the VM (present) or was inconclusive (env
  // unresolved, script/transport failure, UNKNOWN). This keeps DNS cleanup from
  // firing for a VM that still exists-but-unrecoverable (e.g. a phase-2 still
  // finishing) or that a transient error merely hid from us this run.
  const gone = sawAbsent && !sawPresent && !sawInconclusive;
  return { found: null, gone };
}

function isDuplicateProxmoxMetadataError(error: unknown): boolean {
  const raw = error as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  if (raw?.code === "23505") return true;

  const text = [raw?.message, raw?.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return Boolean(
    text &&
      (text.includes("proxmox_vmid") ||
        text.includes("proxmox_node") ||
        text.includes("ipv4_address") ||
        text.includes("gateway_url"))
  );
}

function stripInfrastructureWithMarker(
  config: Record<string, unknown> | null | undefined,
  reason: string,
): Record<string, unknown> {
  const next =
    config && typeof config === "object" && !Array.isArray(config)
      ? { ...config }
      : {};
  delete next.infrastructure;
  next.infrastructureReleased = {
    at: new Date().toISOString(),
    reason,
  };
  return next;
}

async function clearStaleMetadataConflict(params: {
  row: RecoverableProxmoxRow;
  found: FoundProxmoxVm;
}): Promise<{ cleared: boolean; error?: unknown; staleInstanceId?: string | null }> {
  if (!supabaseAdmin) return { cleared: false, error: "Database not configured" };

  const { row, found } = params;
  const { data: conflicts, error: conflictLookupError } = await supabaseAdmin
    .from("hermes_instances")
    .select("id,status,lifecycle_state,config,proxmox_node,proxmox_vmid")
    .eq("proxmox_node", found.hostSlug)
    .eq("proxmox_vmid", found.vmid)
    .neq("id", row.id)
    .limit(5);

  if (conflictLookupError) {
    return { cleared: false, error: conflictLookupError };
  }

  const staleConflict = ((conflicts ?? []) as ProxmoxMetadataConflictRow[])
    .find(isClearableStaleProxmoxMetadataRow);
  if (!staleConflict?.id) {
    return { cleared: false };
  }

  const { error: clearError } = await supabaseAdmin
    .from("hermes_instances")
    .update({
      gateway_url: null,
      ipv4_address: null,
      proxmox_node: null,
      proxmox_vmid: null,
      proxmox_template_vmid: null,
      config: stripInfrastructureWithMarker(
        staleConflict.config,
        "post_provision_stale_conflict",
      ),
      updated_at: new Date().toISOString(),
    })
    .eq("id", staleConflict.id)
    .eq("proxmox_node", found.hostSlug)
    .eq("proxmox_vmid", found.vmid);

  if (clearError) {
    return { cleared: false, error: clearError, staleInstanceId: staleConflict.id };
  }

  log.warn("recover-orphan: cleared stale Proxmox metadata conflict", {
    source: SOURCE,
    failureType: "recover_orphan_stale_metadata_conflict_cleared",
    instanceId: row.id,
    userId: row.user_id,
    staleInstanceId: staleConflict.id,
    hostSlug: found.hostSlug,
    vmid: found.vmid,
  });

  return { cleared: true, staleInstanceId: staleConflict.id };
}

async function reconcileRow(row: RecoverableProxmoxRow, found: FoundProxmoxVm): Promise<{ ok: boolean; error?: unknown }> {
  if (!supabaseAdmin) return { ok: false, error: "Database not configured" };

  const infrastructure = {
    provider: "proxmox" as const,
    node: found.hostSlug,
    hostSlug: found.hostSlug,
    vmid: found.vmid,
    privateIpv4: found.privateIpv4,
    gatewayHost: found.gatewayFqdn,
    hostEnvPrefix: `PROXMOX_${found.hostSlug.toUpperCase()}_`,
    ...(typeof row.proxmox_template_vmid === "number"
      ? { templateVmid: row.proxmox_template_vmid }
      : {}),
  };
  const baseConfig = row.config && typeof row.config === "object" ? row.config : {};
  const updatePayload: Record<string, unknown> = {
    proxmox_node: found.hostSlug,
    proxmox_vmid: found.vmid,
    ipv4_address: found.privateIpv4,
    gateway_url: `https://${found.gatewayFqdn}`,
    infrastructure_provider: "proxmox",
    deleted_at: null,
    scheduled_deletion_at: null,
    archived_at: null,
    proxmox_template_vmid: row.proxmox_template_vmid ?? null,
    config: { ...baseConfig, infrastructure },
    updated_at: new Date().toISOString(),
  };
  if (found.bearer) {
    updatePayload.api_server_key_encrypted = encryptApiKey(found.bearer);
  }
  if (found.vmStatus === "running") {
    updatePayload.status = "running";
    updatePayload.lifecycle_state = "active";
  }
  const reconcileMatch: Record<string, unknown> = row.updated_at
    ? { id: row.id, updated_at: row.updated_at }
    : {
        id: row.id,
        ...(row.status != null ? { status: row.status } : {}),
        ...(row.lifecycle_state != null
          ? { lifecycle_state: row.lifecycle_state }
          : {}),
      };

  const { data: firstUpdatedRow, error: firstUpdateError } = await supabaseAdmin
    .from("hermes_instances")
    .update(updatePayload)
    .match(reconcileMatch)
    .select("id")
    .maybeSingle();
  let error: unknown = firstUpdateError;
  if (!error && !firstUpdatedRow) {
    error = new Error("reconcile_row_changed_concurrently");
  }

  if (error && isDuplicateProxmoxMetadataError(error)) {
    const recovery = await clearStaleMetadataConflict({ row, found });
    if (recovery.cleared) {
      const { data: retryUpdatedRow, error: retryError } = await supabaseAdmin
        .from("hermes_instances")
        .update({ ...updatePayload, updated_at: new Date().toISOString() })
        .match(reconcileMatch)
        .select("id")
        .maybeSingle();
      error = retryError || (!retryUpdatedRow ? new Error("reconcile_row_changed_concurrently") : null);
    } else if (recovery.error) {
      error = recovery.error;
    }
  }

  return { ok: !error, error };
}

export type RecoverProxmoxAcrossFleetResult =
  | { status: "recovered"; found: FoundProxmoxVm; infrastructure: ProxmoxInfrastructure }
  | { status: "gone" }
  | { status: "inconclusive" }
  | { status: "error"; error: unknown };

/**
 * Resolve a suspected routing miss against the complete configured fleet.
 * Discovery binds both the VM-name UUID prefix and the full UUID in its Caddy
 * site before moving lifecycle metadata to a different host.
 */
export async function recoverProxmoxInstanceAcrossFleet(
  row: RecoverableProxmoxRow,
  options: { allowStopped?: boolean } = {},
): Promise<RecoverProxmoxAcrossFleetResult> {
  // Only an explicit Start action may recover a stopped VM without guest SSH.
  // Read/reconcile sweeps keep requiring a live bearer and must not mistake a
  // stopped VM for a ready runtime.
  const search = await searchAllHosts(
    row,
    await loadKnownProxmoxHostSlugs(),
    options.allowStopped === true,
  );
  if (!search.found) {
    return { status: search.gone ? "gone" : "inconclusive" };
  }

  const reconciled = await reconcileRow(row, search.found);
  if (!reconciled.ok) return { status: "error", error: reconciled.error };

  const found = search.found;
  return {
    status: "recovered",
    found,
    infrastructure: {
      provider: "proxmox",
      node: found.hostSlug,
      hostSlug: found.hostSlug,
      hostEnvPrefix: `PROXMOX_${found.hostSlug.toUpperCase()}_`,
      vmid: found.vmid,
      privateIpv4: found.privateIpv4,
      gatewayHost: found.gatewayFqdn,
      ...(typeof row.proxmox_template_vmid === "number"
        ? { templateVmid: row.proxmox_template_vmid }
        : {}),
    },
  };
}

export async function runRecoverOrphanProvisioningSweep(
  options: RecoverOrphanProvisioningOptions = {},
): Promise<RecoverOrphanProvisioningSummary> {
  if (!supabaseAdmin) {
    log.error("supabaseAdmin not configured", new Error("Database not configured"), {
      source: SOURCE,
      failureType: "recover_orphan_db_not_configured",
    });
    return { candidates: 0, recovered: 0, notFound: 0, errors: 1 };
  }

  const instanceId = options.instanceId?.trim() || null;
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();

  // Pull rows that look orphaned or partially reconciled. A failed targeted
  // recreate can leave status='running' while proxmox_vmid is null, so this is
  // broader than provisioning-state only.
  const baseQuery = supabaseAdmin
    .from("hermes_instances")
    .select(
      "id, user_id, status, lifecycle_state, proxmox_node, proxmox_vmid, proxmox_template_vmid, ipv4_address, gateway_url, api_server_key_encrypted, config, subdomain, updated_at"
    );

  const query = instanceId
    ? baseQuery.eq("id", instanceId).limit(1)
    : baseQuery
        .eq("infrastructure_provider", "proxmox")
        .is("deleted_at", null)
        .or(
          [
            "status.eq.provisioning",
            "lifecycle_state.eq.provisioning",
            "proxmox_vmid.is.null",
            "gateway_url.is.null",
            "ipv4_address.is.null",
            "api_server_key_encrypted.is.null",
          ].join(",")
        )
        .lt("created_at", cutoff)
        .limit(MAX_CANDIDATES_PER_RUN * 4);

  const { data, error } = await query;

  if (error) {
    log.error("recover-orphan: candidate query failed", new Error("supabase_query_failed"), {
      source: SOURCE,
      failureType: "recover_orphan_query_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { candidates: 0, recovered: 0, notFound: 0, errors: 1 };
  }

  const rows = (data ?? []) as RecoverableProxmoxRow[];
  const orphans = instanceId
    ? rows.slice(0, 1)
    : rows
        .filter(
          (row) =>
            !row.proxmox_vmid ||
            !row.gateway_url ||
            !row.api_server_key_encrypted ||
            !row.ipv4_address
        )
        .slice(0, MAX_CANDIDATES_PER_RUN);

  if (orphans.length === 0) {
    return { candidates: 0, recovered: 0, notFound: 0, errors: 0 };
  }

  log.info("recover-orphan: candidates identified", {
    source: SOURCE,
    candidates: orphans.length,
    instanceId,
    ids: orphans.map((row) => row.id),
  });

  let recovered = 0;
  let notFound = 0;
  let errors = 0;

  const knownSlugs = await loadKnownProxmoxHostSlugs();

  for (const row of orphans) {
    try {
      const search = await searchAllHosts(row, knownSlugs);
      if (!search.found) {
        notFound += 1;
        log.warn("recover-orphan: no matching VM across all hosts", {
          source: SOURCE,
          failureType: "recover_orphan_vm_not_found",
          instanceId: row.id,
          userId: row.user_id,
          vmConclusivelyGone: search.gone,
        });
        // When the VM is provably gone on every host (e.g. the async phase-2
        // bootstrap failed and its cleanup trap destroyed the VM), the DNS A
        // record minted back in phase 1 still dangles — pointing at a dead
        // target and eating Cloudflare zone quota. Best-effort clean it. Only
        // fires on conclusive absence; never for an exists-but-unrecoverable or
        // still-provisioning row.
        if (search.gone && row.subdomain) {
          await removeInstanceDnsBestEffort(row.subdomain, {
            source: SOURCE,
            instanceId: row.id,
            userId: row.user_id,
          });
        }
        continue;
      }
      const found = search.found;
      const result = await reconcileRow(row, found);
      if (!result.ok) {
        errors += 1;
        log.error("recover-orphan: DB update failed after discovery", new Error("db_update_failed"), {
          source: SOURCE,
          failureType: "recover_orphan_db_update_failed",
          instanceId: row.id,
          userId: row.user_id,
          hostSlug: found.hostSlug,
          vmid: found.vmid,
          errorName: result.error instanceof Error ? result.error.name : typeof result.error,
        });
        continue;
      }
      recovered += 1;
      log.info("recover-orphan: row reconciled with VM", {
        source: SOURCE,
        instanceId: row.id,
        userId: row.user_id,
        hostSlug: found.hostSlug,
        vmid: found.vmid,
        vmStatus: found.vmStatus ?? "unknown",
        gatewayHost: found.gatewayFqdn,
      });
      // Post-ready SOUL.md seed. An adopted orphan was provisioned long ago —
      // its agent wrote the factory-default SOUL.md ages before this adoption,
      // and the in-band seed never ran to completion (that's why it was an
      // orphan). Now that the row points at a provably-running VM, re-seed the
      // intended soul. Best-effort by contract (never throws).
      if (found.vmStatus === "running") {
        await reconcileSoulSeedAfterReady({
          instanceId: row.id,
          trigger: "recover_orphan_adopt",
        });
      }
    } catch (err) {
      errors += 1;
      log.error("recover-orphan: unexpected sweep error", err, {
        source: SOURCE,
        failureType: "recover_orphan_sweep_threw",
        instanceId: row.id,
        userId: row.user_id,
      });
    }
  }

  return { candidates: orphans.length, recovered, notFound, errors };
}
