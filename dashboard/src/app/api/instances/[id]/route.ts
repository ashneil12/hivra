import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  getHetznerInstanceStatus,
  deleteHetznerServer,
  resolveGatewayConfiguration,
  buildAgentDeployScript,
  buildAutoUpdateTimerProvisioningScript,
} from "@/lib/services/hetzner-instance-service";
import {
  deleteProxmoxInstance,
  discoverProxmoxInfrastructureForInstance,
  getProxmoxInstanceStatus,
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getReleasedProxmoxInfrastructure,
  isProxmoxBackedInstanceRow,
  isProxmoxVmMissingResult,
  resolveProxmoxGatewayUrlFromSubdomain,
  resolveProxmoxLifecycleTarget,
  startProxmoxInstance,
  stripProxmoxInfrastructure,
  shutdownProxmoxInstance,
  rebootProxmoxInstance,
} from "@/lib/services/proxmox-instance-service";
import {
  getHermesGuestSshTarget,
  isProxmoxReleaseSafeForDbOnlyDelete,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-infrastructure";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";
import {
  acquireHostWakeSlot,
  normalizeWakeRamMb,
  releaseHostWakeSlot,
} from "@/lib/proxmox/wake-admission";
import { captureWakeEvent, type WakeTelemetrySource } from "@/lib/telemetry/wake-events";
import { deriveDnsDomainFromGatewayUrl, removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import { buildResolveAgentContainerScript } from "@/lib/services/agent-container";
import { discoverContainerName } from "@/lib/services/console-helpers";
import {
  getHonchoSettingsFromInstance,
  resolveInstanceIpv4,
  applyLiveUpdate,
} from "@/lib/services/instance-orchestrator";
import { USER_LIVE_UPDATE } from "@/lib/services/live-update-initiator";
import {
  powerOnServer,
  shutdownServer,
  getServer,
  type HetznerServer,
} from "@/lib/hetzner/client";
import { ensureManagedHostFingerprint, sshExec, type ProxmoxSshHostConfig } from "@/lib/hetzner/ssh";
import { isSshWarmupError, SSH_WARMUP_MESSAGE } from "@/lib/ssh-warmup";
import { decryptApiKey, encryptApiKey } from "@/lib/crypto";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import {
  CODEX_DEFAULT_MODEL,
  type CodexVaultBundle,
  formatStoredProviderSecretPreview,
} from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";
import {
  isCodexAuthProvider,
  isNousAuthProvider,
  resolveDeploymentApiKey,
  resolveProviderDeploymentSecret,
  supportsHermesAuthProvider,
} from "@/lib/provider-deployment-auth";
import {
  getPublicInstanceConfig,
  getRuntimeAgentSettings,
  getAutoUpdateConfig,
  decryptMemorySystemSecrets,
  buildAdvancedInstanceConfigPayload,
  type MemorySystemConfig,
} from "@/lib/instance-settings";
import { buildHostTimeSyncRepairScript } from "@/lib/services/hetzner-instance-builders";
import { orchestrateColdRestore } from "@/lib/services/cold-storage-restore-orchestrator";
import { loadGlobalHermesSettingsForUser } from "@/lib/clerk-hermes-settings";
import { recordInstanceUserActivity } from "@/lib/instance-activity";
import { buildInstanceLifecyclePatch } from "@/lib/instance-lifecycle";
import { getPlan } from "@/lib/subscription";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { normalizeModelValue } from "@/lib/models";
import { getProfileDeploymentState } from "@/lib/profile-deployment";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import {
  getLatestInstanceFailureAlerts,
  suppressFailureAlertsResolvedByLifecycle,
} from "@/lib/instance-failure-alerts";
import { getLatestFailedInstanceUpdateAlerts } from "@/lib/update-alerts";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { resolveProviderFallbackModel } from "@/lib/services/provider-config";
import {
  BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
  isBrowserSidecarDeploymentGateEnabled,
} from "@/lib/browser-sidecar/deployment-gate";
import { validateProviderKeyShape } from "@/lib/provider-key-shape";
import { buildVeniceByokStoredInstanceConfig } from "@/lib/venice/managed-webui-enable";
import { isRealVeniceByokKey } from "@/lib/venice/byok-classification";
import { normalizeWelcomeLaunchCapture } from "@/lib/welcome-personalization";
import { isWebfreeBackend } from "@/lib/types/instance";
import { scheduleSoulSeedReconcileAfterResponse } from "@/lib/recovery/soul-seed-reconcile";
import { backupsIncludedWithInstance } from "@/lib/billing/backup-coverage";
// Gateway-restart shell builders live in ./gateway-restart-command so this
// route file stays focused on request handling. Re-exported/imported below;
// GATEWAY_RESTART_SSH_TIMEOUT_MS is also used by the restart_gateway action.
import {
  GATEWAY_RESTART_SSH_TIMEOUT_MS,
  buildGatewayRestartCommand,
  buildWebUIRuntimeRestartCommand,
} from "./gateway-restart-command";


// The POST handler's cold-restore-on-Start path (action=start on a
// cold_archived/pending_deletion row) runs restore-vm-cold.sh synchronously:
// qmrestore from the Storage Box + Docker cold-pull + ACME on a fresh sub +
// up to a 300s health probe. That can exceed Vercel's default 60s function
// budget and leave the row stranded in lifecycle_state='restoring' when the
// platform kills the invocation mid-restore. 800s gives the slow path real
// headroom; the restore-vm-cold.sh runHostScript timeout is 15min (900s), so
// the function ceiling sits just under it. The stuck-'restoring' recovery
// sweep (recover-stuck-instances) is the backstop for any restore the
// function ceiling still truncates.
export const maxDuration = 800;

// ── Zod schemas ───────────────────────────────────────────────────────────────

const UpdateInstanceSettingsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  vaultKeyId: z.string().optional(),
  honchoVaultKeyId: z.string().optional(),
  apply: z.boolean().optional().default(false),
  honcho: z
    .object({
      enabled: z.boolean().optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional(),
      baseUrl: z.string().optional(),
      peerName: z.string().optional(),
      aiPeer: z.string().optional(),
      memoryMode: z.enum(["hybrid", "honcho"]).optional(),
      recallMode: z.enum(["hybrid", "context", "tools"]).optional(),
    })
    .optional(),
  agentSettings: z
    .object({
      runtimeMode: z.enum(["managed", "developer"]).optional(),
      maxIterations: z.number().min(1).max(100000).optional(),
      toolProgressMode: z.enum(["off", "new", "all", "verbose"]).optional(),
      compressionThreshold: z.number().min(0.5).max(0.95).optional(),
      sessionResetMode: z.enum(["both", "inactivity", "daily", "never"]).optional(),
      showToolCallsInChat: z.boolean().optional(),
      autoApproveToolCalls: z.boolean().optional(),
      browserProvider: z.enum(["local", "browserbase", "browser_use"]).optional(),
      // Pro-tier-gated. PATCH handler verifies tier before persisting `true`.
      // The orchestrator re-checks tier on every redeploy as Layer 1.
      browserSidecarEnabled: z.boolean().optional(),
      enableSearxng: z.boolean().optional(),

      browserbaseApiKey: z.string().optional(),
      clearBrowserbaseApiKey: z.boolean().optional(),
      browserbaseProjectId: z.string().optional(),
      browserUseApiKey: z.string().optional(),
      clearBrowserUseApiKey: z.boolean().optional(),
      tavilyApiKey: z.string().optional(),
      clearTavilyApiKey: z.boolean().optional(),
      exaApiKey: z.string().optional(),
      clearExaApiKey: z.boolean().optional(),
      firecrawlApiKey: z.string().optional(),
      clearFirecrawlApiKey: z.boolean().optional(),
      webUseGateway: z.boolean().optional(),
      imageGenUseGateway: z.boolean().optional(),
      ttsUseGateway: z.boolean().optional(),
      browserUseGateway: z.boolean().optional(),
      fallbackModels: z.string().optional(),
      subagentProvider: z.string().max(255).optional(),
      subagentVaultKeyId: z.string().optional(),
      subagentModel: z.string().max(255).optional(),
      subagentApiKey: z.string().max(1024).optional(),
      clearSubagentApiKey: z.boolean().optional(),
      // Auxiliary compression model (cheap model for context summarization) and
      // the context engine choice. Both empty/omitted = inherit the main model /
      // the agent default. See auxiliary.compression.{provider,model} + context.engine.
      compressionProvider: z.string().max(255).optional(),
      compressionModel: z.string().max(255).optional(),
      contextEngine: z.enum(["compressor", "sliding"]).optional(),
      mountPersistentSource: z.boolean().optional(),
      enableRootAccess: z.boolean().optional(),
      terminalBackend: z.enum(["local", "docker", "modal", "daytona"]).optional(),
      systemPrompt: z.string().max(12000).optional(),
      // Proxy fields
      browserProxyHost: z.string().max(255).optional(),
      browserProxyPort: z.string().max(10).optional(),
      browserProxyUsername: z.string().max(255).optional(),
      browserProxyPassword: z.string().max(1024).optional(),
      clearBrowserProxyPassword: z.boolean().optional(),
      daytonaApiKey: z.string().max(1024).optional(),
      clearDaytonaApiKey: z.boolean().optional(),
      customLlmBaseUrl: z.string().max(1024).optional(),
      })
      .optional(),
    autoUpdate: z
      .object({
        enabled: z.boolean().optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
      })
      .optional(),
    a2a: z
      .object({
        enableAcp: z.boolean().optional(),
        enableMcp: z.boolean().optional(),
      })
      .optional(),
    // Floor matches the create schema (CreateInstanceSchema) and the free tier's
    // real size: 0.5 vCPU is a legitimate box, and it's also what a user splitting
    // a small pool across several agents needs. A min of 1 here made the resize
    // lane unable to express sizes the create lane happily provisions.
    cpuLimit: z.number().min(0.5).max(8).optional(),
    ramLimit: z.number().min(1024).max(16384).optional(),
    configMode: z.enum(["simple", "advanced"]).optional(),
    heartbeatModel: z.string().max(255).optional(),
    backupsEnabled: z.boolean().optional(),
    memorySystem: z.record(z.unknown()).optional(),
    // Launch personalization captured by the welcome flow (Wave 1.2). Persisted
    // to the hermes_instances goal/first_task/context columns so the lifecycle-
    // email sweep can reference the user's stated job. The schema maxes are
    // generous payload-size bounds; the real column-fit clamp happens in
    // normalizeWelcomeLaunchCapture (so slightly-over input is trimmed, not
    // 400'd). The systemPrompt the same PATCH carries is the runtime source of
    // truth for the agent.
    goal: z.string().max(256).optional(),
    firstTask: z.string().max(4000).optional(),
    context: z.string().max(8000).optional(),
});

// One-click churn reasons surfaced in the delete modal. Optional and
// non-blocking: an unknown/missing value is simply not recorded. 'other'
// carries a free-text note in deleteReasonNote.
const DELETE_REASON_VALUES = [
  "too_slow",
  "didnt_work",
  "too_expensive",
  "just_testing",
  "other",
] as const;

// Only the confirmation is required + gating. The reason fields are parsed
// SEPARATELY (and leniently) so a malformed/unknown reason can never turn a
// valid delete into a 400 — "reason never blocks delete".
const DeleteInstanceConfirmationSchema = z.object({
  confirmation: z.string(),
});

type DeleteReasonValue = (typeof DELETE_REASON_VALUES)[number];

interface DeleteInstanceConfirmation {
  confirmation: string;
  deleteReason: DeleteReasonValue | null;
  deleteReasonNote: string | null;
}

function readOptionalDeleteReason(payload: unknown): DeleteReasonValue | null {
  const raw = readPlainRecord(payload)?.deleteReason;
  return typeof raw === "string" && (DELETE_REASON_VALUES as readonly string[]).includes(raw)
    ? (raw as DeleteReasonValue)
    : null;
}

function readOptionalDeleteReasonNote(payload: unknown): string | null {
  const raw = readPlainRecord(payload)?.deleteReasonNote;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().slice(0, 2000);
  return trimmed.length > 0 ? trimmed : null;
}

async function readDeleteInstanceConfirmation(
  req: NextRequest
): Promise<DeleteInstanceConfirmation | null> {
  try {
    const payload = await req.json();
    const parsed = DeleteInstanceConfirmationSchema.safeParse(payload);
    if (!parsed.success) return null;
    const confirmation = parsed.data.confirmation.trim();
    if (confirmation.length === 0) return null;
    return {
      confirmation,
      deleteReason: readOptionalDeleteReason(payload),
      deleteReasonNote: readOptionalDeleteReasonNote(payload),
    };
  } catch {
    return null;
  }
}

// ── DB row types ──────────────────────────────────────────────────────────────

export interface HermesInstanceRow {
  id: string;
  user_id: string;
  name: string;
  status: string;
  backend?: "gateway" | "webui" | null;
  provider: string;
  subdomain?: string | null;
  hetzner_server_id?: number | null;
  gateway_url?: string | null;
  api_key_encrypted: string;
  api_key_preview?: string | null;
  api_server_key_encrypted?: string | null;
  honcho_api_key_encrypted?: string | null;
  config?: Record<string, unknown>;
  host_id?: string | null;
  ipv4_address?: string | null;
  cpu_limit?: number;
  ram_limit?: number;
  infrastructure_provider?: "hetzner" | "proxmox" | null;
  proxmox_node?: string | null;
  proxmox_vmid?: number | null;
  proxmox_template_vmid?: number | null;
  lifecycle_state?: string | null;
  deleted_at?: string | null;
  entitlement_state?: string | null;
  entitlement_reason?: string | null;
  entitlement_grace_started_at?: string | null;
  entitlement_grace_ends_at?: string | null;
  entitlement_suspended_at?: string | null;
  entitlement_last_resumed_at?: string | null;
  paused_reason?: string | null;
  resource_tier?: string | null;
  disk_size_gb?: number | null;
  archive_uri?: string | null;
  archived_at?: string | null;
  archive_size_bytes?: number | null;
  archive_sha256?: string | null;
  archive_count?: number | null;
  lifecycle_substate?: string | null;
  notifications_sent?: Record<string, unknown> | null;
  backups_enabled?: boolean | null;
  created_at: string;
  updated_at?: string;
  last_lifecycle_transition_at?: string | null;
}

/**
 * Privileged customer control is only safe when the runtime is inside a VM
 * dedicated to that customer. A Proxmox-backed instance is always its own VM.
 * A direct Hetzner server is also isolated when it is not attached to a
 * multi-agent host. Unknown and legacy shared-host layouts fail closed.
 */
export function isAdvancedCloudAccessEligible(
  instance: Pick<
    HermesInstanceRow,
    | "config"
    | "host_id"
    | "hetzner_server_id"
    | "infrastructure_provider"
    | "proxmox_vmid"
  >
): boolean {
  if (isProxmoxBackedInstanceRow(instance)) return true;
  return !instance.host_id && typeof instance.hetzner_server_id === "number";
}

interface HermesHostRow {
  id: string;
  hetzner_server_id: number | null;
  name: string;
  total_cpu: number;
  total_ram: number;
  status: string;
}

type HostRecordStatus =
  | "provisioning"
  | "running"
  | "stopped"
  | "failed"
  | "error"
  | "deleted";

// ── Shared helpers ────────────────────────────────────────────────────────────

const INSTANCE_GATEWAY_PROBE_TIMEOUT_MS = 5_000;
const INSTANCE_FINGERPRINT_PRIME_TIMEOUT_MS = 15_000;
const INSTANCE_SSH_READY_TIMEOUT_MS = 15_000;
const RUNTIME_STARTUP_MESSAGE = "Instance runtime is still starting. Try again in a moment.";
const INSTANCE_UPDATE_FAILURE_MESSAGE = "Update failed. Check the instance logs and try again.";
const INSTANCE_ACTION_FAILURE_MESSAGE = "Failed to perform instance action.";
const LEGACY_CREDIT_SUSPENSION_REASON = "insufficient_credits";
const LEGACY_CREDIT_SUSPENSION_CLEARED_REASON = "credit_compute_gate_disabled";
const ENTITLEMENT_GATED_INSTANCE_ACTIONS = new Set([
  "start",
  "reboot",
  "update",
  "restart",
  "restart_gateway",
  "redeploy",
  "repair_runtime",
  "rebuild_runtime",
]);

function formatSshActionFailure(prefix: string): string {
  return `${prefix}. Check the instance logs and try again.`;
}

function readPlainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readConfigModel(config: unknown): string | null {
  const record = readPlainRecord(config);
  if (!record) return null;

  if (typeof record.model === "string" && record.model.trim()) {
    return record.model.trim();
  }

  const nestedModel = readPlainRecord(record.model);
  if (typeof nestedModel?.default === "string" && nestedModel.default.trim()) {
    return nestedModel.default.trim();
  }

  return null;
}

function isManagedVeniceConfig(config: unknown): boolean {
  const managedVenice = readPlainRecord(readPlainRecord(config)?.managedVenice);
  return managedVenice?.enabled === true;
}


function normalizeRetryableInstanceActionError(
  message: string | null | undefined
): string | null {
  const normalized = message?.toLowerCase() ?? "";

  if (isSshWarmupError(message)) {
    return SSH_WARMUP_MESSAGE;
  }

  if (normalized.includes("did not start before runtime patching")) {
    return RUNTIME_STARTUP_MESSAGE;
  }

  return null;
}

function isMissingInstanceHostError(message: string | null | undefined): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return (
    normalized.includes("no route to host") ||
    normalized.includes("vm no longer exists") ||
    (normalized.includes("vmid") && normalized.includes("does not exist"))
  );
}

function missingInstanceHostErrorOptions(action: string, hostIp?: string | null) {
  return {
    source: "instance-actions",
    route: "/api/instances/[id]",
    metadata: {
      action,
      failureOwner: "hypervisor",
      failurePhase: "provisioning",
      failureType: "instance_host_missing",
      recoveryAction: "contact_support",
      ...(hostIp ? { hostIp } : {}),
    },
  } as const;
}

function buildReadinessProbeOptions(params: {
  backend?: "gateway" | "webui" | null;
  apiServerKey?: string | null;
}) {
  // Modern webfree box (backend='gateway'): probe the CHAT lane, not the
  // dashboard shell. The box Caddyfile routes '/health' to the
  // official-dashboard web server only, which comes up seconds (idle canary)
  // to minutes (loaded prod host) BEFORE the gateway api_server that actually
  // answers chat — measured on a fresh canary box 2026-07-10 (audit run
  // fixturecase04): '/health' 200'd and the row flipped 'running' 8s before the
  // box accepted its first WS upgrade; prod run fixturecase05 showed the same gap
  // stretched past 190s, so a new user's workspace painted while their first
  // message died. '/api/sessions' with the instance bearer traverses
  // caddy → dashboard-sidecar → official-dashboard → gateway and flips 200
  // in the same probe window as the WS upgrade, so 'running' (and the
  // workspace it unlocks) means "you can chat". Keyless rows keep the legacy
  // '/health' probe rather than never promoting (fail-open; the apiServerKey
  // self-heal backfills the key). Legacy backend='webui' boxes don't serve
  // the sessions route and keep '/health' too.
  if (params.backend === "gateway" && params.apiServerKey) {
    return {
      pathname: "/api/sessions",
      headers: {
        Authorization: `Bearer ${params.apiServerKey}`,
      } as Record<string, string>,
    };
  }

  if (isWebfreeBackend(params.backend)) {
    return {
      pathname: "/health",
      headers: {} as Record<string, string>,
    };
  }

  return {
    pathname: "/v1/models",
    headers: params.apiServerKey
      ? { Authorization: `Bearer ${params.apiServerKey}` }
      : ({} as Record<string, string>),
  };
}

async function runMirroredStatusWriteWithRetry(
  execute: () => PromiseLike<{ error: { message?: string } | null }>
) {
  // Status writes are idempotent, so one bounded retry is safe for transient DB failures.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { error } = await execute();
    if (!error) return;

    if (attempt === 1) {
      throw new Error(error.message || "Failed to persist mirrored status");
    }
  }
}

async function updateInstanceAndHostStatus(params: {
  instanceId: string;
  instanceStatus: string;
  hostId?: string | null;
  // Shared-host power actions should keep the host mirror row aligned.
  hostStatus?: HostRecordStatus;
}) {
  if (!supabaseAdmin) return;

  const { instanceId, instanceStatus, hostId, hostStatus } = params;
  const updatedAt = new Date().toISOString();
  const instancePatch = buildInstanceLifecyclePatch(instanceStatus, { now: updatedAt });

  if (hostId && hostStatus) {
    try {
      await runMirroredStatusWriteWithRetry(() =>
        supabaseAdmin!
          .from("hermes_hosts")
          .update({ status: hostStatus, updated_at: updatedAt })
          .eq("id", hostId)
      );
    } catch (error) {
      log.error("failed to sync host status", error, {
        source: "instances",
        route: "/api/instances/[id]",
        method: "POST",
        instanceId,
        failureType: "host_status_update_failed",
        hostId,
      });
      throw error;
    }
  }

  try {
    // F055: scope the instance status mirror to the TARGET instance only.
    // On a shared Hetzner host (multiple tenants/instances per server),
    // scoping by host_id flipped every sibling row's status when one user
    // stopped/started/rebooted their own agent. The host mirror row
    // (hermes_hosts, updated above) tracks the shared box; individual
    // hermes_instances rows must reflect only their own power state. The
    // hostId branch keeps the deleted/scheduled guard (harmless for a single
    // row, defensive against resurrecting a soft-deleted instance).
    await runMirroredStatusWriteWithRetry(() =>
      hostId
        ? supabaseAdmin!
            .from("hermes_instances")
            .update(instancePatch)
            .eq("id", instanceId)
            .not("status", "in", '("deleted","scheduled_for_deletion")')
        : supabaseAdmin!
            .from("hermes_instances")
            .update(instancePatch)
            .eq("id", instanceId)
    );
  } catch (error) {
    log.error("failed to sync instance row", error, {
      source: "instances",
      route: "/api/instances/[id]",
      method: "POST",
      instanceId,
      failureType: "instance_status_update_failed",
      hostId: hostId ?? null,
    });
    throw error;
  }
}

async function getInstanceOrError(id: string, userId: string) {
  if (!supabaseAdmin)
    return { instance: null, err: apiError("Database not configured", 500) };

  const { data: instance, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<HermesInstanceRow>();

  if (error || !instance)
    return { instance: null, err: apiError("Instance not found", 404) };
  return { instance, err: null };
}

async function clearLegacyCreditSuspensionBeforeAction(
  instance: HermesInstanceRow,
  userId: string,
  action: string
) {
  const now = new Date().toISOString();
  const patch = {
    entitlement_state: "ok",
    entitlement_reason: LEGACY_CREDIT_SUSPENSION_CLEARED_REASON,
    entitlement_grace_started_at: null,
    entitlement_grace_ends_at: null,
    entitlement_suspended_at: null,
    entitlement_last_resumed_at: now,
    updated_at: now,
  };

  const { error } = await supabaseAdmin!
    .from("hermes_instances")
    .update(patch)
    .eq("id", instance.id)
    .eq("user_id", userId);

  if (error) {
    log.error("failed to clear stale credit entitlement suspension", error, {
      source: "instances",
      route: "/api/instances/[id]",
      method: "POST",
      instanceId: instance.id,
      userId,
      action,
      failureType: "legacy_credit_suspension_clear_failed",
      errorCode: error.code,
      entitlementReason: instance.entitlement_reason ?? null,
    });
    return apiError("Could not clear stale compute suspension", 500, {
      failureType: "legacy_credit_suspension_clear_failed",
      retryable: true,
      errorCode: error.code,
    });
  }

  Object.assign(instance, patch);

  log.info("cleared stale credit entitlement suspension before instance action", {
    source: "instances",
    route: "/api/instances/[id]",
    method: "POST",
    instanceId: instance.id,
    userId,
    action,
    failureType: "legacy_credit_suspension_cleared",
    entitlementReason: LEGACY_CREDIT_SUSPENSION_REASON,
  });

  return null;
}

type ProxmoxActionTarget = {
  vmid: number;
  node?: string;
  hostId?: string;
  hostSlug?: string;
  hostEnvPrefix?: string;
};

function toProxmoxRecoveryCandidate(instance: HermesInstanceRow) {
  return {
    id: instance.id,
    user_id: instance.user_id,
    status: instance.status ?? null,
    lifecycle_state: instance.lifecycle_state ?? null,
    proxmox_node: instance.proxmox_node ?? null,
    proxmox_vmid: instance.proxmox_vmid ?? null,
    proxmox_template_vmid: instance.proxmox_template_vmid ?? null,
    ipv4_address: instance.ipv4_address ?? null,
    gateway_url: instance.gateway_url ?? null,
    api_server_key_encrypted: instance.api_server_key_encrypted ?? null,
    config: instance.config ?? null,
    subdomain: instance.subdomain ?? null,
    updated_at: instance.updated_at ?? null,
  };
}

function readStoredProxmoxActionTarget(instance: HermesInstanceRow): ProxmoxActionTarget | null {
  const storedVmid = instance.proxmox_vmid;
  if (
    instance.infrastructure_provider !== "proxmox" &&
    (typeof storedVmid !== "number" || !Number.isFinite(storedVmid))
  ) {
    return null;
  }

  if (typeof storedVmid !== "number" || !Number.isFinite(storedVmid)) {
    return null;
  }

  const node = typeof instance.proxmox_node === "string" && instance.proxmox_node.trim()
    ? instance.proxmox_node.trim()
    : undefined;
  const hostId = typeof instance.host_id === "string" && instance.host_id.trim()
    ? instance.host_id.trim()
    : undefined;

  return {
    vmid: storedVmid,
    ...(node ? { node } : {}),
    ...(hostId ? { hostId } : {}),
  };
}

type RuntimeRepairAction = "redeploy" | "repair_runtime" | "rebuild_runtime";

function buildRuntimeRecoveryPreamble(
  instanceId: string,
  action: RuntimeRepairAction
): string {
  if (action === "redeploy") {
    return "";
  }

  const readableManagedFiles = [
    "config.yaml",
    "sidecar_server.js",
    "Caddyfile",
    "docker-compose.yml",
    ".managed-env-keys",
    "a2a_bridge.py",
    "Dockerfile.agent-memory",
    "Dockerfile.camofox-vnc",
    "nginx.vnc.conf",
  ].join(" ");
  const executableManagedFiles = [
    "root-mode-entrypoint.sh",
    "entrypoint-vnc.sh",
  ].join(" ");
  const allManagedFiles = [
    ".env",
    "auth.json.inject",
    readableManagedFiles,
    executableManagedFiles,
  ].join(" ");

  const rebuildOnlyScript = action === "rebuild_runtime"
    ? `
# Clear disposable runtime state without touching memories, sessions, profiles, or source data.
rm -f .managed-env-keys auth.json.inject Dockerfile.agent-memory Dockerfile.camofox-vnc entrypoint-vnc.sh nginx.vnc.conf 2>/dev/null || true
rm -rf hindsight 2>/dev/null || true
docker run --rm --user root -v "${instanceId}_agent-logs:/target" --entrypoint sh ghcr.io/ashneil12/vanilla-hermes-agent:latest -lc 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +' >/dev/null 2>&1 || true
`
    : "";

  return `
mkdir -p /opt/hermes/instances/${instanceId}
cd /opt/hermes/instances/${instanceId}

# Stop the stack first so we can safely repair bind-mounted runtime files.
docker compose down --remove-orphans >/dev/null 2>&1 || true

# Normalize permissions on dashboard-managed runtime files when they exist.
for managed_file in ${allManagedFiles}; do
  [ -e "$managed_file" ] || continue
  chown root:root "$managed_file" 2>/dev/null || true
done
[ -d hindsight ] && chown -R root:root hindsight 2>/dev/null || true
chmod 600 .env auth.json.inject 2>/dev/null || true
chmod 644 ${readableManagedFiles} 2>/dev/null || true
chmod 755 ${executableManagedFiles} 2>/dev/null || true
${rebuildOnlyScript}`;
}

async function buildRuntimeDeployScript(params: {
  instance: HermesInstanceRow;
  instanceId: string;
  ipv4: string;
  userId: string;
}): Promise<{ gatewayUrl: string; script: string }> {
  const { instance, instanceId, ipv4, userId } = params;
  const { profileRoutes, profilesToRestore } = await getProfileDeploymentState(
    supabaseAdmin!,
    instanceId,
    userId
  );

  await supabaseAdmin!
    .from(instance.host_id ? "hermes_hosts" : "hermes_instances")
    .update({ ipv4_address: ipv4, updated_at: new Date().toISOString() })
    .eq("id", instance.host_id ?? instanceId);

  const decryptedSecret = decryptApiKey(instance.api_key_encrypted);
  const providerDeploymentSecret = resolveProviderDeploymentSecret(
    instance.provider,
    decryptedSecret
  );
  const apiServerKey = instance.api_server_key_encrypted
    ? decryptApiKey(instance.api_server_key_encrypted)
    : "";
  const model = (instance.config?.model as string) ?? "";
  // Re-derive the FQDN from whatever the instance is already running on.
  // If `gateway_url` is on the configured Cloudflare domain, pass that
  // through so the rebuilt agent script keeps the same FQDN as before;
  // otherwise the resolver falls back to sslip.
  const { fqdn, gatewayUrl } = resolveGatewayConfiguration({
    subdomain: instance.subdomain ?? null,
    ipv4,
    dnsDomain: deriveDnsDomainFromGatewayUrl(
      instance.gateway_url,
      instance.subdomain ?? null,
    ),
  });

  const globalSettings = await loadGlobalHermesSettingsForUser(userId, {
    instanceId,
  });

  const script = buildAgentDeployScript({
    instanceId: instance.id,
    containerName: `agent-${instance.id}`,
    apiServerKey,
    provider: instance.provider,
    apiKey: resolveDeploymentApiKey(decryptedSecret, providerDeploymentSecret),
    model,
    fqdn,
    cpuLimit: instance.cpu_limit ?? 1,
    ramLimit: instance.ram_limit ?? 2048,
    codexAuthBundle:
      isCodexAuthProvider(instance.provider)
        ? (providerDeploymentSecret.authBundle as CodexVaultBundle | undefined)
        : undefined,
    nousAuthBundle:
      isNousAuthProvider(instance.provider)
        ? (providerDeploymentSecret.authBundle as NousVaultBundle | undefined)
        : undefined,
    honchoSettings: getHonchoSettingsFromInstance(instance),
    agentSettings: getRuntimeAgentSettings(instance.config),
    autoUpdate: getAutoUpdateConfig(instance.config),
    memorySystem: decryptMemorySystemSecrets(
      instance.config?.memorySystem as MemorySystemConfig | undefined
    ),
    globalSettings,
    profileRoutes,
    profilesToRestore,
  });

  return { gatewayUrl, script };
}

/**
 * The sshExec target for a guest command in an action handler: the routed
 * host plus the VMID being acted on and this instance's id, so the host binds
 * SSH to that VM and checks it is still this instance's.
 */
function guestSshTargetFor(
  proxmoxInfra: { vmid: number } | null | undefined,
  hostConfig: ProxmoxHostRoutingConfig | null | undefined,
  instanceId: string,
): ProxmoxSshHostConfig | null {
  if (!proxmoxInfra) return null;
  return { ...(hostConfig ?? { failClosed: true }), vmid: proxmoxInfra.vmid, instanceId };
}

async function syncAutoUpdateSchedule(params: {
  instance: HermesInstanceRow;
}): Promise<{ applied: boolean; error: string | null }> {
  const { instance } = params;

  if (!instance.host_id && !instance.hetzner_server_id) {
    return {
      applied: false,
      error: "Settings were saved, but this instance has no host yet so the auto-update schedule was not installed.",
    };
  }

  if (instance.status === "stopped") {
    return {
      applied: false,
      error: "Settings were saved, but the instance is not running so the auto-update schedule was not installed yet.",
    };
  }

  const ipv4 = await resolveInstanceIpv4(instance, supabaseAdmin!);
  if (!ipv4) {
    return {
      applied: false,
      error: "Settings were saved, but the host IP is not ready yet so the auto-update schedule was not installed.",
    };
  }

  const script = buildAutoUpdateTimerProvisioningScript({
    instanceId: instance.id,
    containerName: `agent-${instance.id}`,
    autoUpdate: getAutoUpdateConfig(instance.config),
    agentSettings: getRuntimeAgentSettings(instance.config),
    apiServerKey: instance.api_server_key_encrypted
      ? decryptApiKey(instance.api_server_key_encrypted)
      : "",
    memorySystem: decryptMemorySystemSecrets(
      instance.config?.memorySystem as MemorySystemConfig | undefined
    ),
    // Build-mode selector (NOT a type coercion): "webui" emits the webfree
    // auto-update body that re-seeds the agent-source volume; "gateway" emits the
    // legacy compose-recreate body. Post gateway≡webfree collapse a gateway-DB box
    // runs the webfree stack, so it must get the webfree body — mirror the literal
    // "webui" the webfree provisioning path passes (hetzner-instance-service.ts).
    backend: isWebfreeBackend(instance.backend) ? "webui" : "gateway",
  });
  const guestTarget = getHermesGuestSshTarget(instance);
  const result = await sshExec(ipv4, script, guestTarget ? { proxmoxHostConfig: guestTarget } : {});

  if (!result.ok) {
    const detail = result.stderr?.trim() || result.error?.trim() || "";
    return {
      applied: false,
      error:
        normalizeRetryableInstanceActionError(detail) ??
        "Settings were saved, but the auto-update schedule could not be synced to the host yet.",
    };
  }

  return { applied: true, error: null };
}


// ── Route handlers ────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const [instanceResult, subResult] = await Promise.all([
      getInstanceOrError(id, userId),
      supabaseAdmin!
        .from("hermes_subscriptions")
        .select("plan")
        .eq("user_id", userId)
        .maybeSingle()
    ]);

    const { instance, err } = instanceResult;
    if (err) return err;

    const searchParams = _req.nextUrl?.searchParams ?? new URL(_req.url).searchParams;
    const noSync = searchParams.get("no_sync") === "true";

    const { data: sub } = subResult;
    const planData = getPlan(sub?.plan || "operator");
    const planLimits = {
      maxCpu: planData.maxCpuPerAgent,
      maxRam: planData.maxRamPerAgent,
      name: planData.name,
    };

    let status = instance!.status;
    let lastLifecycleTransitionAt = instance!.last_lifecycle_transition_at ?? null;
    let gatewayUrl = instance!.gateway_url ?? null;
    let publicIpv4 =
      typeof instance!.ipv4_address === "string" && instance!.ipv4_address.trim()
        ? instance!.ipv4_address.trim()
        : null;
    let responseConfig = instance!.config;
    let proxmoxInfrastructure = getProxmoxInfrastructure(responseConfig);

    if (instance!.host_id) {
      const { data: host } = await supabaseAdmin!
        .from("hermes_hosts")
        .select("ipv4_address")
        .eq("id", instance!.host_id)
        .single<{ ipv4_address?: string | null }>();
      if (host?.ipv4_address?.trim()) {
        publicIpv4 = host.ipv4_address.trim();
      }
    }

    if (
      !noSync &&
      !proxmoxInfrastructure &&
      instance!.infrastructure_provider === "proxmox" &&
      ["provisioning", "running", "redeploying", "error"].includes(status)
    ) {
      const recoveryHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(null, { host_id: instance!.host_id ?? null });
      const recoveredInfrastructure = await discoverProxmoxInfrastructureForInstance({
        instanceId: id,
        instanceName: instance!.name,
        subdomain: instance!.subdomain ?? null,
      }, {
        hostConfig: recoveryHostConfig,
      });

      if (recoveredInfrastructure) {
        proxmoxInfrastructure = recoveredInfrastructure;
        responseConfig = {
          ...(responseConfig ?? {}),
          infrastructure: recoveredInfrastructure,
        };
        // Derive the canonical gateway_url from the subdomain + the host's
        // gateway domain (identical env-resolution inputs to discovery's own
        // fqdn derivation), NOT straight from infrastructure.gatewayHost.
        // Guards the 2026-06-30 bridge-IP incident class: a recovered/restored
        // infra whose gatewayHost is a NAT bridge IP (https://10.250.20.1) must
        // never reach gateway_url. Falls back to the freshly-discovered host
        // only when the derive can't resolve the host env — discovery's
        // gatewayHost is itself resolveProxmoxGatewayConfiguration output, so
        // the fallback is a proper FQDN, never a bare IP.
        gatewayUrl =
          resolveProxmoxGatewayUrlFromSubdomain({
            subdomain: instance!.subdomain ?? null,
            hostConfig: recoveryHostConfig,
          }) ?? `https://${recoveredInfrastructure.gatewayHost}`;
        publicIpv4 = recoveredInfrastructure.privateIpv4;

        await supabaseAdmin!
          .from("hermes_instances")
          .update({
            gateway_url: gatewayUrl,
            ipv4_address: publicIpv4,
            infrastructure_provider: "proxmox",
            proxmox_node: recoveredInfrastructure.node ?? null,
            proxmox_vmid: recoveredInfrastructure.vmid,
            config: responseConfig,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
      }
    }

    // Orphan sweeper for Proxmox provisions that never produced
    // infrastructure metadata. The L823 sweeper below requires a recovered
    // proxmoxInfrastructure to flip a stale row to 'error' — but rows where
    // Phase 1 SSH/clone never ran (Vercel-killed before the early-finish
    // marker, or the kickoff bash never reached the printf) have no vmid
    // for discoverProxmoxInfrastructureForInstance to find. Without this,
    // those rows stay in 'provisioning' forever and the boot UI spins
    // until the user gives up. After the same 25min ceiling, flip to
    // 'error' so the dashboard surfaces "Agent Offline" and the user can
    // delete and retry.
    const PROXMOX_ORPHAN_PROVISIONING_STALE_MS = 25 * 60 * 1000;
    if (
      !noSync &&
      !proxmoxInfrastructure &&
      instance!.infrastructure_provider === "proxmox" &&
      status === "provisioning" &&
      instance!.created_at &&
      Date.now() - new Date(instance!.created_at).getTime() >
        PROXMOX_ORPHAN_PROVISIONING_STALE_MS
    ) {
      const now = new Date().toISOString();
      status = "error";
      lastLifecycleTransitionAt = now;
      await supabaseAdmin!
        .from("hermes_instances")
        .update(buildInstanceLifecyclePatch(status, { now }))
        .eq("id", id);
    }

    if (
      !noSync &&
      status === "error" &&
      gatewayUrl &&
      (isWebfreeBackend(instance!.backend) || instance!.api_server_key_encrypted)
    ) {
      try {
        const apiServerKey = instance!.api_server_key_encrypted
          ? decryptApiKey(instance!.api_server_key_encrypted)
          : null;
        const probeOptions = buildReadinessProbeOptions({
          backend: instance!.backend,
          apiServerKey,
        });
        const { response } = await fetchFirstReachableGatewayResponse({
          baseUrl: gatewayUrl,
          pathname: probeOptions.pathname,
          instanceIpv4: publicIpv4 ?? undefined,
          headers: probeOptions.headers,
          timeoutMs: 5_000,
        });

        await response.text().catch(() => {});

        if (response.ok) {
          status = "running";
          const now = new Date().toISOString();
          lastLifecycleTransitionAt = now;
          await supabaseAdmin!
            .from("hermes_instances")
            .update(buildInstanceLifecyclePatch(status, { now }))
            .eq("id", id);
          // Post-ready SOUL.md seed. This error→running self-heal is exactly
          // how a >25-min slow provision resurfaces (stale-sweeper flipped it
          // to error; the box finally answered) — the in-band seed lost the
          // race to the agent's own factory-default write on such boxes, so
          // re-seed now that the agent is provably up. Deferred until after
          // the response; guarded + idempotent; never blocks the promotion.
          if (isWebfreeBackend(instance!.backend)) {
            scheduleSoulSeedReconcileAfterResponse({
              instanceId: id,
              trigger: "poll_error_recovery_promote",
            });
          }
        }
      } catch {
        // Keep the stored error state when the gateway still isn't reachable.
      }
    }

    if (!noSync && ["provisioning", "running", "redeploying"].includes(status)) {
      // For 'redeploying' (triggered by the Update button), the Hetzner VM stays online
      // the whole time — only the Docker container is being replaced. Syncing from
      // Hetzner would immediately overwrite 'redeploying' back to 'running'.
      // Instead, probe the gateway health endpoint to detect when the new container is ready.
      if (status === "redeploying" && gatewayUrl) {
        try {
          // Same chat-lane rule as fresh provisions (buildReadinessProbeOptions):
          // after a redeploy the official-dashboard shell answers '/health'
          // before the replaced gateway container accepts chat, so a shell-only
          // probe would flip 'running' into the same dead-first-message window.
          let redeployKey: string | null = null;
          if (instance!.api_server_key_encrypted) {
            try {
              redeployKey = decryptApiKey(instance!.api_server_key_encrypted);
            } catch {
              // Fall back to the public /health probe below.
            }
          }
          const redeployProbe = buildReadinessProbeOptions({
            backend: instance!.backend,
            apiServerKey: redeployKey,
          });
          const healthUrl = `${gatewayUrl.replace(/\/$/, "")}${redeployProbe.pathname}`;
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5_000);
          const hr = await fetch(healthUrl, { headers: redeployProbe.headers, signal: ctrl.signal }).catch(() => null);
          clearTimeout(t);
          if (hr && hr.ok) {
            status = "running";
            const now = new Date().toISOString();
            lastLifecycleTransitionAt = now;
            await supabaseAdmin!
              .from("hermes_instances")
              .update(buildInstanceLifecyclePatch(status, { now }))
              .eq("id", id);
            // Post-ready SOUL.md seed: a config redeploy re-runs bootstrap in
            // update mode, whose in-band seed has the same timing exposure as
            // provisioning. Re-seed now that the new container answered.
            if (isWebfreeBackend(instance!.backend)) {
              scheduleSoulSeedReconcileAfterResponse({
                instanceId: id,
                trigger: "poll_redeploy_complete",
              });
            }
          }
        } catch {
          // Gateway not yet ready — keep status as redeploying
        }
      } else if (proxmoxInfrastructure) {
        // Proxmox-backed instances have no hetzner_server_id, so the Hetzner
        // sync branch below would skip them entirely — leaving the chat
        // workspace stuck on "Provisioning server" forever even after the
        // VM and agent are fully up. Mirror the LIST endpoint's Proxmox
        // path: take liveness from `qm status`, then probe the right
        // backend health endpoint to flip provisioning → running.
        let nextStatus = status;
        publicIpv4 = proxmoxInfrastructure.privateIpv4;
        const proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfrastructure, { host_id: instance!.host_id ?? null });
        if (!gatewayUrl) {
          // Recovery for a row that lost its gateway_url. Derive it from the
          // subdomain + the host's gateway domain — NEVER from the stored
          // infrastructure.gatewayHost, which on a restored/recovered row can
          // be a NAT bridge IP (the 2026-06-30 https://10.250.20.1 incident).
          // On an underivable host env we leave gateway_url unset rather than
          // persist the untrusted stored host. The `!gatewayUrl` guard is
          // load-bearing: an EXISTING (already-canonical, often Cloudflare)
          // gateway_url must never be re-derived here, or a healthy box would
          // be flipped onto the per-host sslip domain fleet-wide.
          gatewayUrl = resolveProxmoxGatewayUrlFromSubdomain({
            subdomain: instance!.subdomain ?? null,
            hostConfig: proxmoxHostConfig,
          });
        }

        const ps = await getProxmoxInstanceStatus(proxmoxInfrastructure, {
          hostConfig: proxmoxHostConfig,
        });
        if (ps.status === "stopped" || ps.status === "error") {
          nextStatus = ps.status;
        } else if (
          ["provisioning", "running"].includes(status) &&
          ps.status === "running" &&
          gatewayUrl &&
          (isWebfreeBackend(instance!.backend) || instance!.api_server_key_encrypted)
        ) {
          let apiServerKey: string | null = null;
          if (instance!.api_server_key_encrypted) {
            try {
              apiServerKey = decryptApiKey(instance!.api_server_key_encrypted);
            } catch {
              // Fall through — webfree falls back to /health, gateway-backend
              // probes will likely 401; both surface as provisioning.
            }
          }
          const probeOptions = buildReadinessProbeOptions({
            backend: instance!.backend,
            apiServerKey,
          });
          try {
            const { response } = await fetchFirstReachableGatewayResponse({
              baseUrl: gatewayUrl,
              pathname: probeOptions.pathname,
              instanceIpv4: publicIpv4 ?? undefined,
              headers: probeOptions.headers,
              timeoutMs: INSTANCE_GATEWAY_PROBE_TIMEOUT_MS,
            });
            await response.text().catch(() => {});
            // A single readiness-probe miss must NOT demote an already-running
            // instance. The VM is confirmed running (qm status above); a non-OK
            // probe here is a transient blip (gateway restarting) or a Vercel-side
            // reachability gap (e.g. a grey-cloud box whose raw host IP the
            // dashboard probe can't reach) — demoting to "provisioning" feeds the
            // 25-min stale-sweeper below and HARD-ERRORS a healthy box. Running-box
            // health is owned by the recover-unhealthy-active cron (retries +
            // repair); only a not-yet-running instance may stay provisioning.
            if (response.ok) {
              nextStatus = "running";
            } else if (status !== "running") {
              nextStatus = "provisioning";
            }
          } catch {
            // Probe UNREACHABLE (network error / timeout) — same rule: never
            // demote an already-running instance we simply could not reach.
            if (status !== "running") {
              nextStatus = "provisioning";
            }
          }
        }

        // Stale-row sweeper. Proxmox provisioning is async (Phase 2 runs
        // detached on the host, 3-7 min nominal). The happy path: Phase
        // 2 succeeds → /health answers 200 → status flips to 'running'.
        // The sad paths:
        //   (a) Phase 2 errored → its trap runs `qm destroy` → qm status
        //       returns "missing" → we already mapped that to 'stopped'
        //       above; user sees "Agent Offline" and can delete.
        //   (b) Phase 2 silently died (host reboot mid-bootstrap, kernel
        //       panic, etc.) → VM stays alive but agent never comes up →
        //       /health never answers → status would stay 'provisioning'
        //       forever. This sweeper covers (b).
        //
        // Threshold tuned 2026-04-30 from 15min → 25min after a real
        // provision took 16 minutes (slow apt mirror + cold Docker
        // pull + Caddy ACME for a fresh subdomain) and tripped the
        // 15-min ceiling by ~1 minute, flipping a perfectly healthy
        // boot to status='error' for ~10 seconds before the recovery
        // probe at line 644 self-healed it. UX: "Agent Offline / agent
        // is error" flash followed by sudden recovery looked broken
        // and made the user worry that something was wrong. 25min is
        // still a safe ceiling above Phase 2's nominal worst case
        // (~6min SSH-ready + ~2min backend-ready + ~5min apt/docker
        // + ~3min ACME on a cold sub) while leaving headroom for slow
        // mirrors and ACME hiccups.
        const PROXMOX_PROVISIONING_STALE_MS = 25 * 60 * 1000;
        if (
          nextStatus === "provisioning" &&
          instance!.created_at &&
          Date.now() - new Date(instance!.created_at).getTime() >
            PROXMOX_PROVISIONING_STALE_MS
        ) {
          nextStatus = "error";
        }

        const metadataPatch: Record<string, unknown> =
          gatewayUrl !== instance!.gateway_url || publicIpv4 !== instance!.ipv4_address
            ? {
                gateway_url: gatewayUrl,
                ipv4_address: publicIpv4,
              }
            : {};

        // qm status returned "missing". Two scenarios produce this:
        //   1. Phase 2 cleanup actually destroyed the VM (legitimate).
        //   2. The row's proxmox_node points at a host where this VMID
        //      doesn't exist — i.e. routing data is wrong but the VM is
        //      still alive on a different host.
        //
        // The Fixture Customer A / Fixture Customer B incident (2026-05-07) was scenario 2: 15 rows
        // tagged proxmox_node="fixturelegacy" but with VMIDs in fixturenodea's range,
        // so every dashboard load probed the wrong host, got vmMissing,
        // and silently auto-deleted the user's row even though the VM
        // (and the user's data) was fine.
        //
        // A single-host miss is not proof of teardown. Search every configured
        // host using the instance UUID before releasing any handle. This also
        // repairs wrong-host routing automatically when the VM is found.
        if (ps.vmMissing) {
          const recovery = await recoverProxmoxInstanceAcrossFleet(instance!);
          if (recovery.status === "recovered") {
            nextStatus = "running";
            delete metadataPatch.gateway_url;
            delete metadataPatch.ipv4_address;
            log.warn("proxmox routing miss self-healed from fleet identity scan", {
              source: "instances",
              route: "/api/instances/[id]",
              method: "GET",
              instanceId: id,
              userId,
              failureType: "proxmox_vm_routing_recovered",
              recoveredHost: recovery.found.hostSlug,
              recoveredVmid: recovery.found.vmid,
            });
          } else {
            nextStatus = "error";
            // Only a conclusive NOT_FOUND from every configured host releases
            // the VMID. Inconclusive scans preserve the handle and fail closed.
            if (recovery.status === "gone") {
              metadataPatch.proxmox_vmid = null;
              metadataPatch.config = stripProxmoxInfrastructure(
                instance!.config,
                "vm_missing_across_fleet",
              );
            }
            log.warn("proxmox vm missing on routed host; fleet recovery did not recover it", {
              source: "instances",
              route: "/api/instances/[id]",
              method: "GET",
              instanceId: id,
              userId,
              failureType: "proxmox_vm_missing_on_routed_host",
              proxmoxNode: instance!.proxmox_node ?? null,
              proxmoxVmid: instance!.proxmox_vmid ?? null,
              fleetRecoveryStatus: recovery.status,
            });
          }
        }

        // Captured BEFORE `status = nextStatus` below: the provisioning→running
        // promotion is the moment the box is first OBSERVED ready — the only
        // point a SOUL.md seed is guaranteed to land after the agent's own
        // factory-default write (the in-band provision seed races it and loses
        // on slow provisions; see soul-seed-reconcile.ts).
        const promotedToRunning = nextStatus === "running" && status !== "running";
        if (nextStatus !== status || Object.keys(metadataPatch).length > 0) {
          const now = new Date().toISOString();
          const statusPatch =
            nextStatus !== status
              ? buildInstanceLifecyclePatch(nextStatus, { now })
              : { updated_at: now };
          if (nextStatus !== status) {
            lastLifecycleTransitionAt = now;
          }
          status = nextStatus;
          await supabaseAdmin!
            .from("hermes_instances")
            .update({
              ...statusPatch,
              // When Proxmox reports the VM missing, terminal metadata must
              // win over the stopped/status lifecycle patch so stale rows do
              // not keep occupying a free-tier/proxmox_vmid slot.
              ...metadataPatch,
            })
            .eq("id", id);
        }
        if (promotedToRunning && isWebfreeBackend(instance!.backend)) {
          scheduleSoulSeedReconcileAfterResponse({
            instanceId: id,
            trigger: "poll_provision_promote",
          });
        }
      } else if (instance!.hetzner_server_id) {
        // Standard Hetzner-level sync for provisioning / running states
        const hs = await getHetznerInstanceStatus(instance!.hetzner_server_id);
        if (hs.ipv4) {
          publicIpv4 = hs.ipv4;
          await supabaseAdmin!
            .from(instance!.host_id ? "hermes_hosts" : "hermes_instances")
            .update({ ipv4_address: hs.ipv4, updated_at: new Date().toISOString() })
            .eq("id", instance!.host_id ?? id);
          const canonicalGateway = resolveGatewayConfiguration({
            subdomain: instance!.subdomain ?? null,
            ipv4: hs.ipv4,
            dnsDomain: deriveDnsDomainFromGatewayUrl(
              gatewayUrl,
              instance!.subdomain ?? null,
            ),
          }).gatewayUrl;
          if (canonicalGateway !== gatewayUrl) {
            gatewayUrl = canonicalGateway;
            await supabaseAdmin!
              .from("hermes_instances")
              .update({ gateway_url: gatewayUrl, updated_at: new Date().toISOString() })
              .eq("id", id);
          }
        }

        let nextStatus = hs.status;
        if (
          ["provisioning", "running"].includes(status) &&
          hs.status === "running" &&
          gatewayUrl &&
          (isWebfreeBackend(instance!.backend) || instance!.api_server_key_encrypted)
        ) {
          try {
            const apiServerKey = instance!.api_server_key_encrypted
              ? decryptApiKey(instance!.api_server_key_encrypted)
              : null;
            const probeOptions = buildReadinessProbeOptions({
              backend: instance!.backend,
              apiServerKey,
            });
            const { response } = await fetchFirstReachableGatewayResponse({
              baseUrl: gatewayUrl,
              pathname: probeOptions.pathname,
              instanceIpv4: publicIpv4 ?? undefined,
              headers: probeOptions.headers,
              timeoutMs: INSTANCE_GATEWAY_PROBE_TIMEOUT_MS,
            });
            const fingerprintPrimePromise = publicIpv4
              ? ensureManagedHostFingerprint(publicIpv4, {}, INSTANCE_FINGERPRINT_PRIME_TIMEOUT_MS).catch((error) => {
                  log.warn(
                    "failed to prime managed SSH fingerprint",
                    {
                      source: "instances",
                      route: "/api/instances/[id]",
                      method: "GET",
                      instanceId: id,
                      failureType: "ssh_fingerprint_prime_failed",
                      hostIp: publicIpv4,
                      redactedError: redactSensitiveCommandOutput(
                        error instanceof Error ? error.message : String(error),
                        600,
                      ),
                    },
                    error,
                  );
                  return null;
                })
              : Promise.resolve(null);

            await response.text().catch(() => {});
            await fingerprintPrimePromise;
            if (response.ok && publicIpv4 && status === "provisioning") {
              const sshReadyResult = await sshExec(publicIpv4, "true", {
                timeoutMs: INSTANCE_SSH_READY_TIMEOUT_MS,
              });
              nextStatus = sshReadyResult.ok ? "running" : "provisioning";
            } else if (response.ok) {
              nextStatus = "running";
            } else {
              nextStatus = "provisioning";
            }
          } catch {
            nextStatus = "provisioning";
          }
        }

        if (nextStatus !== status) {
          const promotedToRunning = nextStatus === "running";
          status = nextStatus;
          const now = new Date().toISOString();
          lastLifecycleTransitionAt = now;
          await supabaseAdmin!
            .from("hermes_instances")
            .update({
              ...buildInstanceLifecyclePatch(status, { now }),
              gateway_url: gatewayUrl,
            })
            .eq("id", id);
          // Post-ready SOUL.md seed on the Hetzner promotion path — same race,
          // same fix as the Proxmox branch above.
          if (promotedToRunning && isWebfreeBackend(instance!.backend)) {
            scheduleSoulSeedReconcileAfterResponse({
              instanceId: id,
              trigger: "poll_provision_promote",
            });
          }
        }
      }
    }
    // Backups status from the cached `backups_enabled` column. The
    // backup-addon endpoint (POST /api/billing/backup-addon) sets it
    // atomically when it enables Hetzner's native daily backups, so it's the
    // authoritative flag for Hetzner instances; Proxmox-backed paid tiers get
    // backups by tier. This previously made a live Hetzner getServer() call
    // here (150-500ms, up to a 15s timeout) on EVERY single-instance GET just
    // to re-derive this boolean — a blocking external round-trip on a
    // user-facing hot path. Reading the already-fetched column removes it.
    const backupsEnabled =
      backupsIncludedWithInstance(instance!) || Boolean(instance!.backups_enabled);
    const [updateAlerts, rawFailureAlerts] = await Promise.all([
      getLatestFailedInstanceUpdateAlerts([id]),
      getLatestInstanceFailureAlerts([id]),
    ]);
    const failureAlerts = suppressFailureAlertsResolvedByLifecycle(rawFailureAlerts, [
      { id, status, last_lifecycle_transition_at: lastLifecycleTransitionAt },
    ]);
    const updateAlert = updateAlerts[id] ?? null;
    const failureAlert = failureAlerts[id] ?? null;

    return apiSuccess({
      ...instance,
      status,
      gateway_url: gatewayUrl,
      public_ipv4: publicIpv4,
      config: getPublicInstanceConfig(responseConfig),
      advanced_cloud_access_eligible: isAdvancedCloudAccessEligible(instance!),
      api_server_key_encrypted: undefined,
      honcho_api_key_encrypted: undefined,
      has_honcho_api_key: Boolean(instance!.honcho_api_key_encrypted),
      plan_limits: planLimits,
      backups_enabled: backupsEnabled,
      updateAlert,
      failureAlert,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const { instance, err } = await getInstanceOrError(id, userId);
    if (err) return err;

    const requestBody = await req.json();
    const parsed = UpdateInstanceSettingsSchema.safeParse(requestBody);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const rawAgentSettings = readPlainRecord(readPlainRecord(requestBody)?.agentSettings);
    const parsedAgentSettings = readPlainRecord(parsed.data.agentSettings) || {};
    const ignoredAgentSettings = rawAgentSettings
      ? Object.keys(rawAgentSettings).filter((key) => !(key in parsedAgentSettings))
      : [];
    if (ignoredAgentSettings.length > 0) {
      log.warn("ignored unknown instance agent settings", {
        source: "instances",
        route: "/api/instances/[id]",
        method: "PATCH",
        instanceId: id,
        userId,
        failureType: "instance_settings_unknown_agent_settings",
        ignoredAgentSettings,
      });
    }

    const {
      provider,
      model,
      apiKey,
      vaultKeyId,
      apply,
      honcho,
      agentSettings,
      autoUpdate,
      a2a,
      cpuLimit,
      ramLimit,
      honchoVaultKeyId,
      configMode,
      heartbeatModel,
      backupsEnabled,
      memorySystem,
      goal,
      firstTask,
      context,
    } = parsed.data;

    // Hetzner native backups are a paid add-on. Turning them on only goes
    // through POST /api/billing/backup-addon, which checks the subscription
    // and adds the Stripe line item; this settings PATCH must not enable them
    // for free. Turning them off stays allowed here.
    if (backupsEnabled === true) {
      return apiError(
        "Backups are a paid add-on. Enable them from Billing.",
        403,
        { failureType: "backups_require_addon" }
      );
    }

    // Root plus the Docker socket is intentionally an owner-controlled escape
    // hatch, but it must never be offered on a layout where that socket could
    // see sibling tenants. Disabling is always allowed; enabling fails closed
    // unless this row proves it is backed by an isolated customer VM.
    if (
      agentSettings?.enableRootAccess === true &&
      !isAdvancedCloudAccessEligible(instance!)
    ) {
      return apiError(
        "Advanced cloud access is only available on isolated customer VMs.",
        403,
        { failureType: "advanced_cloud_access_requires_isolated_vm" }
      );
    }

    // Browser-sidecar is special-purpose: the deployment must opt in globally
    // before a user-level opt-in can pass the normal tier guard.
    if (agentSettings?.browserSidecarEnabled === true) {
      if (!isBrowserSidecarDeploymentGateEnabled()) {
        return apiError(
          "Browser sidecar is only enabled for explicitly configured deployments.",
          403,
          {
            failureType: "browser_sidecar_deploy_gate_disabled",
            envVar: BROWSER_SIDECAR_DEPLOY_ENABLED_ENV,
          }
        );
      }

      const tierCheck = await isProTierUser(userId);
      if (!tierCheck.ok) {
        return apiError(
          "Browser sidecar is a Pro-tier feature. Upgrade your plan to enable it.",
          403,
          { failureType: "browser_sidecar_tier_required", tier: tierCheck.tier ?? "none", reason: tierCheck.reason }
        );
      }
    }

    const nextProvider = provider?.trim() || instance!.provider;
    let nextApiKey = apiKey?.trim();
    const providedApiKey = apiKey?.trim();
    let savedVaultKeyId: string | undefined;

    if (vaultKeyId === 'ALL_KEYS') {
      const { data: vks } = await supabaseAdmin!
        .from("user_api_keys")
        .select("*")
        .eq("provider", nextProvider)
        .eq("user_id", userId);
        
      if (!vks || vks.length === 0) return apiError("No valid API keys found for provider", 404);
      
      const extracted = vks.map(vk => {
        const dec = decryptApiKey(vk.encrypted_key || vk.key_encrypted);
        try {
          const p = JSON.parse(dec);
          p.id = vk.id;
          return p;
        } catch {
          return { id: vk.id, access_token: dec };
        }
      }).filter(k => k.access_token);
      
      nextApiKey = JSON.stringify(extracted);
    } else if (vaultKeyId) {
      const { data: vk } = await supabaseAdmin!
        .from("user_api_keys")
        .select("*")
        .eq("id", vaultKeyId)
        .eq("user_id", userId)
        .single();
      if (!vk) return apiError("Provider API Key not found in Vault", 404);
      const vkEncrypted = vk.encrypted_key || vk.key_encrypted;
      if (vkEncrypted) nextApiKey = decryptApiKey(vkEncrypted) || nextApiKey;
    }

    const isProviderSwitch = !!(provider && provider !== instance!.provider);
    const resolvedProviderSecret = resolveProviderDeploymentSecret(
      nextProvider,
      nextApiKey || ""
    );

    if (nextProvider === "codex" && nextApiKey && !resolvedProviderSecret.authBundle) {
      return apiError(
        "Codex agents now require a reusable OAuth session from the Vault. Reconnect Codex from the Vault page and select that saved session.",
        400
      );
    }

    if (isProviderSwitch && !nextApiKey && !supportsHermesAuthProvider(nextProvider)) {
      return apiError(
        `Switching providers requires a new API key. Enter one below or select a saved key from your vault.`,
        400
      );
    }

    if (nextApiKey && vaultKeyId !== "ALL_KEYS") {
      const keyShapeError = validateProviderKeyShape(nextProvider, nextApiKey);
      if (keyShapeError) {
        return apiError(keyShapeError.message, 400, {
          failureType: keyShapeError.failureType,
          provider: keyShapeError.provider,
        });
      }
    }

    // Auto-save new API key to vault when switching providers or providing a fresh key
    if (providedApiKey && (isProviderSwitch || !instance!.api_key_encrypted)) {
      const keyPreview = formatStoredProviderSecretPreview(nextProvider, providedApiKey);
      const keyName = `${nextProvider.charAt(0).toUpperCase() + nextProvider.slice(1)} API Key`;
      const { data: existingVaultKey } = await supabaseAdmin!
        .from("user_api_keys")
        .select("id")
        .eq("user_id", userId)
        .eq("provider", nextProvider)
        .eq("key_preview", keyPreview)
        .maybeSingle();

      if (!existingVaultKey) {
        const { data: insertedKey, error: vaultError } = await supabaseAdmin!
          .from("user_api_keys")
          .insert({
            user_id: userId,
            name: keyName,
            provider: nextProvider,
            encrypted_key: encryptApiKey(providedApiKey),
            key_preview: keyPreview,
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (!vaultError && insertedKey) {
          savedVaultKeyId = insertedKey.id;
        }
      } else {
        savedVaultKeyId = existingVaultKey.id;
      }
    }

    const nextModel = normalizeModelValue(
      model?.trim() || (isProviderSwitch && nextProvider === "codex" ? CODEX_DEFAULT_MODEL : undefined) || "",
      nextProvider
    ) || undefined;

    // Note 2026-05-02: instance PATCH used to call reconcileModelForProvider
    // here to "snap" any model the static catalog didn't recognise for the
    // selected provider. That silent rewrite was the foundation of the
    // model-switching bug class — every aggregator provider (CometAPI,
    // OpenRouter, Crof) and every user-typed model id whose entry hadn't
    // been added to PROVIDERS yet got clobbered to the provider's fallback
    // on save, then again on load. The dashboard now trusts the user's
    // selection and lets the agent runtime validate; if the upstream
    // rejects, the apperror normalizer surfaces a model-switching tip
    // instead of mutating state behind the user's back.

    if (cpuLimit || ramLimit) {
      if (!instance!.host_id)
        return apiError("Legacy single-node instances cannot be resized.", 400);

      const { data: host } = await supabaseAdmin!
        .from("hermes_hosts")
        .select("*")
        .eq("id", instance!.host_id)
        .eq("user_id", userId)
        .single<HermesHostRow>();
      if (!host) return apiError("Host not found", 404);

      const { data: siblings } = await supabaseAdmin!
        .from("hermes_instances")
        .select("id, cpu_limit, ram_limit")
        .eq("host_id", instance!.host_id);

      const targetCpu = cpuLimit ?? instance!.cpu_limit ?? 1;
      const targetRam = ramLimit ?? instance!.ram_limit ?? 2048;
      const siblingCpu = (siblings ?? [])
        .filter((s) => s.id !== instance!.id)
        .reduce((acc, row) => acc + (row.cpu_limit ?? 0), 0);
      const siblingRam = (siblings ?? [])
        .filter((s) => s.id !== instance!.id)
        .reduce((acc, row) => acc + (row.ram_limit ?? 0), 0);

      if (siblingCpu + targetCpu > host.total_cpu || siblingRam + targetRam > host.total_ram) {
        return apiError(
          `Insufficient Host capacity. Host has ${host.total_cpu} CPU / ${host.total_ram}MB RAM total. Try stopping/shrinking other agents first.`,
          400
        );
      }

      // ── Plan-cap re-check (F058) ──────────────────────────────────────────
      // The create path (instance-service.createInstance) enforces the user's
      // plan per-agent caps and total budget; PATCH historically validated only
      // host-physical capacity, so a small-plan user could raise cpu/ram up to
      // the schema ceiling (8/16384) as long as the host had room — an
      // entitlement gap. Mirror the create path's plan.maxCpuPerAgent /
      // total_*_budget here.
      //
      // GRANDFATHERING: only REJECT a resize that pushes a dimension ABOVE the
      // cap. A resize that stays within the cap, or that shrinks/holds a
      // dimension (target <= current), is always allowed — including an
      // already-over-cap agent resizing DOWN. We therefore enforce caps only on
      // dimensions that are INCREASING relative to the current row.
      const currentCpu = instance!.cpu_limit ?? targetCpu;
      const currentRam = instance!.ram_limit ?? targetRam;
      const cpuIncreasing = targetCpu > currentCpu;
      const ramIncreasing = targetRam > currentRam;

      if (cpuIncreasing || ramIncreasing) {
        const sub = await resolveEffectiveSubscription(userId);
        // No resolvable entitlement → don't introduce a new hard block on an
        // existing instance the user already owns; fall through (host capacity
        // already gated this). Only paid/token subs carry meaningful caps.
        if (sub) {
          const plan = getPlan(sub.plan);

          if (cpuIncreasing && targetCpu > plan.maxCpuPerAgent) {
            return apiError(
              `CPU request exceeds your ${plan.name} plan's per-agent cap of ${plan.maxCpuPerAgent} vCPU. Upgrade your plan to grow this agent further.`,
              403
            );
          }
          if (ramIncreasing && targetRam > plan.maxRamPerAgent) {
            const reqGb = (targetRam / 1024).toFixed(1);
            const capGb = (plan.maxRamPerAgent / 1024).toFixed(1);
            return apiError(
              `RAM request (${reqGb}GB) exceeds your ${plan.name} plan's per-agent cap of ${capGb}GB. Upgrade your plan to grow this agent further.`,
              403
            );
          }

          // Plan budget re-check, scoped to this product surface like the
          // create path. Only blocks when the INCREASE would push total usage
          // over budget — a same-or-shrinking dimension can never trip it.
          const productSurface =
            (instance! as { product_surface?: string | null }).product_surface ?? "hermesos";
          const { data: surfaceInstances } = await supabaseAdmin!
            .from("hermes_instances")
            .select("id, cpu_limit, ram_limit")
            .eq("user_id", userId)
            .eq("product_surface", productSurface)
            .not("status", "in", '("deleted")');

          const otherCpu = (surfaceInstances ?? [])
            .filter((s) => s.id !== instance!.id)
            .reduce((acc, row) => acc + (row.cpu_limit ?? 0), 0);
          const otherRam = (surfaceInstances ?? [])
            .filter((s) => s.id !== instance!.id)
            .reduce((acc, row) => acc + (row.ram_limit ?? 0), 0);

          if (cpuIncreasing && otherCpu + targetCpu > sub.total_cpu_budget) {
            return apiError(
              `Insufficient CPU budget. Your ${plan.name} plan has ${sub.total_cpu_budget} vCPU total; this resize would exceed it. Shrink another agent or upgrade your plan.`,
              403
            );
          }
          if (ramIncreasing && otherRam + targetRam > sub.total_ram_budget) {
            const totalGb = (sub.total_ram_budget / 1024).toFixed(1);
            return apiError(
              `Insufficient RAM budget. Your ${plan.name} plan has ${totalGb}GB total; this resize would exceed it. Shrink another agent or upgrade your plan.`,
              403
            );
          }
        }
      }
    }

    let nextSubagentApiKey = agentSettings?.subagentApiKey;
    if (agentSettings?.subagentVaultKeyId) {
      const { data: vk } = await supabaseAdmin!
        .from("user_api_keys")
        .select("*")
        .eq("id", agentSettings.subagentVaultKeyId)
        .eq("user_id", userId)
        .single();
      if (!vk) return apiError("Subagent API Key not found in Vault", 404);
      const vkEncrypted = vk.encrypted_key || vk.key_encrypted;
      if (vkEncrypted) {
        nextSubagentApiKey = decryptApiKey(vkEncrypted) || nextSubagentApiKey;
      }
    }

    let nextConfig = buildAdvancedInstanceConfigPayload(instance!.config, {
      model: nextModel,
      honcho,
      agentSettings: {
        ...agentSettings,
        subagentApiKey: nextSubagentApiKey,
      },
      autoUpdate,
      a2a,
      memorySystem,
      configMode,
      heartbeatModel,
    });

    const hadManagedVeniceConfig =
      isManagedVeniceConfig(instance!.config) || isManagedVeniceConfig(nextConfig);
    if (isRealVeniceByokKey(nextProvider, nextApiKey) && hadManagedVeniceConfig) {
      nextConfig = buildVeniceByokStoredInstanceConfig(nextConfig, {
        model:
          nextModel ||
          readConfigModel(nextConfig) ||
          readConfigModel(instance!.config) ||
          resolveProviderFallbackModel("venice"),
      });
      log.warn("stripped managed Venice proxy config after BYOK key save", {
        source: "instances",
        route: "/api/instances/[id]",
        method: "PATCH",
        instanceId: id,
        userId,
        failureType: "managed_venice_byok_patch_stripped_proxy_config",
        provider: nextProvider,
        hadManagedVeniceConfig,
        appliedImmediately: Boolean(apply),
      });
    }

    const updates: Record<string, unknown> = {
      provider: nextProvider,
      config: nextConfig,
      updated_at: new Date().toISOString(),
    };

    if (cpuLimit !== undefined) updates.cpu_limit = cpuLimit;
    if (ramLimit !== undefined) updates.ram_limit = ramLimit;

    // Wave 1.2: persist the launch personalization the welcome flow captured to
    // the dedicated columns (Phase 0 added goal/first_task/context). Only touch
    // a column when the field was present in THIS request, so an unrelated PATCH
    // (resource resize, key rotation) never nulls a previously-captured value.
    // The companion systemPrompt this PATCH carries stays the runtime source of
    // truth; these columns exist so the lifecycle sweep can read the raw goal.
    if (goal !== undefined || firstTask !== undefined || context !== undefined) {
      const capture = normalizeWelcomeLaunchCapture({ goal, firstTask, context });
      if (goal !== undefined) updates.goal = capture.goal;
      if (firstTask !== undefined) updates.first_task = capture.firstTask;
      if (context !== undefined) updates.context = capture.context;
    }

    if (nextApiKey) {
      updates.api_key_encrypted = encryptApiKey(nextApiKey);
      updates.api_key_preview = vaultKeyId === 'ALL_KEYS'
        ? 'ALL KEYS (Rotate)'
        : formatStoredProviderSecretPreview(nextProvider, nextApiKey);
    } else if (isProviderSwitch && supportsHermesAuthProvider(nextProvider)) {
      updates.api_key_encrypted = encryptApiKey("");
      updates.api_key_preview = formatStoredProviderSecretPreview(nextProvider, "");
    }

    if (honchoVaultKeyId) {
      const { data: hk } = await supabaseAdmin!
        .from("user_api_keys")
        .select("*")
        .eq("id", honchoVaultKeyId)
        .eq("user_id", userId)
        .single();
      if (!hk) return apiError("Honcho API Key not found in Vault", 404);
      const hkEncrypted = hk.encrypted_key || hk.key_encrypted;
      if (hkEncrypted) updates.honcho_api_key_encrypted = hkEncrypted;
    } else if (honcho?.clearApiKey) {
      updates.honcho_api_key_encrypted = null;
    } else if (honcho?.apiKey?.trim()) {
      updates.honcho_api_key_encrypted = encryptApiKey(honcho.apiKey.trim());
    }

    if (memorySystem?.provider === "honcho" && Object.prototype.hasOwnProperty.call(memorySystem, "honchoApiKey")) {
      const honchoApiKeyValue = typeof memorySystem.honchoApiKey === "string"
        ? memorySystem.honchoApiKey.trim()
        : "";
      updates.honcho_api_key_encrypted = honchoApiKeyValue
        ? encryptApiKey(honchoApiKeyValue)
        : null;
    }

    const { data: updated, error: updateError } = await supabaseAdmin!
      .from("hermes_instances")
      .update(updates)
      .eq("id", id)
      .eq("user_id", userId)
      .select("*")
      .single<HermesInstanceRow>();

    if (updateError || !updated) {
      return apiError("Failed to save settings", 500, updateError);
    }

    if (backupsEnabled !== undefined) {
      let serverIdToBackup = updated.hetzner_server_id;
      if (updated.host_id) {
         const { data: host } = await supabaseAdmin!.from("hermes_hosts").select("hetzner_server_id").eq("id", updated.host_id).eq("user_id", userId).single();
         if (host?.hetzner_server_id) serverIdToBackup = host.hetzner_server_id;
      }
      if (serverIdToBackup) {
          try {
              if (backupsEnabled) {
                  const { enableServerBackup } = await import("@/lib/hetzner/client");
                  await enableServerBackup(serverIdToBackup);
              } else {
                  const { disableServerBackup } = await import("@/lib/hetzner/client");
                  await disableServerBackup(serverIdToBackup);
              }
          } catch (error) {
             log.error("failed to toggle backups on Hetzner", error, {
               source: "instances",
               route: "/api/instances/[id]",
               method: "PATCH",
               instanceId: id,
               failureType: "backup_toggle_failed",
               hetznerServerId: serverIdToBackup,
               backupsEnabled,
             });
             return apiError("Failed to toggle backups on Hetzner", 500, {
               failureType: "backup_toggle_failed",
             });
          }
      }
    }

    let applied = false;
    let applyError: string | null = null;
    let autoUpdateApplied = false;
    let autoUpdateError: string | null = null;
    let redeployRequired = false;
    
    const oldAgentSettings = (instance!.config as {
      agentSettings?: {
        browserProvider?: string;
        browserSidecarEnabled?: boolean;
      };
    })?.agentSettings;
    const newAgentSettings = (nextConfig as {
      agentSettings?: {
        browserProvider?: string;
        browserSidecarEnabled?: boolean;
      };
    })?.agentSettings;
    const oldBrowserProvider = oldAgentSettings?.browserProvider || "local";
    const newBrowserProvider = newAgentSettings?.browserProvider || "local";
    // Default-on semantics: unset and `true` both mean "want sidecar"; only an
    // explicit `false` opts out. Compare on that so an opt-out (unset/true → false)
    // correctly triggers a redeploy to drop the sidecar.
    const oldBrowserSidecarEnabled = oldAgentSettings?.browserSidecarEnabled !== false;
    const newBrowserSidecarEnabled = newAgentSettings?.browserSidecarEnabled !== false;

    // Trigger full redeployment if sidecars need updates
    if (
      oldBrowserProvider !== newBrowserProvider ||
      oldBrowserSidecarEnabled !== newBrowserSidecarEnabled
    ) {
      redeployRequired = true;
    }

    if (autoUpdate && !apply) {
      const syncResult = await syncAutoUpdateSchedule({ instance: updated });
      autoUpdateApplied = syncResult.applied;
      autoUpdateError = syncResult.error;
    }

    if (isWebfreeBackend(updated.backend)) {
      const shouldApplyWebUI =
        updated.status === "running" &&
        (apply || Boolean(provider) || Boolean(model) || Boolean(nextApiKey));

      // Webui-free instances expose NO live-apply HTTP surface. The agent image
      // does not serve the legacy setProviderKey/setDefaultModel endpoints — a
      // bearer call 404s "No such API endpoint" — so the old live push always
      // failed while the route still reported success (a provider key the box
      // never received). The DB row is the source of truth: the saved
      // provider/model/key is reconciled onto the box at its next config
      // redeploy. So we persist (done above) and never attempt a live push here;
      // `applied` stays false because nothing lands on the box until that
      // redeploy. See the endpoint-contract guard for why the push is gone.
      if (shouldApplyWebUI && vaultKeyId === "ALL_KEYS") {
        applyError =
          "Live all-key rotation is not supported. Select one saved key for this instance.";
      } else if (!shouldApplyWebUI && apply) {
        applyError =
          "Settings were saved, but the agent runtime is not running so they were not applied yet.";
      }
    } else if (apply && updated.status === "running") {
      const globalSettings = await loadGlobalHermesSettingsForUser(userId, {
        instanceId: id,
      });
      const ipv4 = await resolveInstanceIpv4(updated, supabaseAdmin!);
      // The owner pressed Save & apply: recreate now (no in-flight deferral).
      const result = await applyLiveUpdate(updated, ipv4, globalSettings, supabaseAdmin!, {
        initiator: USER_LIVE_UPDATE,
      });
      applied = result.applied;
      if (result.applied) {
        applyError = null;
      } else {
        applyError =
          normalizeRetryableInstanceActionError(result.error) ??
          "Settings were saved, but the live update failed. Check the instance logs and try again.";
      }
    } else if (apply) {
      applyError =
        "Settings were saved, but the instance is not running so they were not applied yet.";
    }

    if (autoUpdate && apply) {
      autoUpdateApplied = applied;
      autoUpdateError = applied ? null : applyError;
    }

    void recordInstanceUserActivity({
      instanceId: id,
      userId,
      source: "instance_settings_update",
    });

    return apiSuccess({
      instance: {
        ...updated,
        config: getPublicInstanceConfig(updated.config),
        api_server_key_encrypted: undefined,
        honcho_api_key_encrypted: undefined,
        has_honcho_api_key: Boolean(updated.honcho_api_key_encrypted),
      },
      applied,
      applyError,
      autoUpdateApplied,
      autoUpdateError,
      redeployRequired,
      savedVaultKeyId: savedVaultKeyId || null,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const { instance, err } = await getInstanceOrError(id, userId);
    if (err) return err;

    const deletePayload = await readDeleteInstanceConfirmation(req);
    // The reason is purely informational and must NEVER gate the delete — only
    // the typed-id confirmation can. Capture it for the ops event regardless of
    // whether the user picked one.
    const deleteReason = deletePayload?.deleteReason ?? null;
    const deleteReasonNote = deletePayload?.deleteReasonNote ?? null;
    if (deletePayload?.confirmation !== id) {
      return apiError(
        "Type the instance id to confirm deletion.",
        400,
        { failureType: "instance_delete_confirmation_required" },
        undefined,
        {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          failureType: "instance_delete_confirmation_required",
        }
      );
    }

    // Resolve from config first, then DB columns. This catches legacy rows
    // whose `config.infrastructure` was never populated but whose `proxmox_vmid`
    // / `gateway_url` columns are. Without the column fallback the previous
    // shape silently fell through to the DB-mark-deleted block, leaving the
    // VM running on the host (zombie). See lib/services/proxmox-instance-service
    // for the resolver.
    const proxmoxInfrastructure = resolveProxmoxLifecycleTarget(instance!);
    const proxmoxBacked = isProxmoxBackedInstanceRow(instance!);
    const proxmoxReleased = getReleasedProxmoxInfrastructure(instance!.config);
    const proxmoxReleaseSafeForDbOnlyDelete =
      isProxmoxReleaseSafeForDbOnlyDelete(proxmoxReleased);

    // Idempotent terminal cleanup is allowed for non-Proxmox rows, or when an
    // authoritative release receipt proves provider teardown. Lifecycle words
    // alone never prove a VM is gone.
    const alreadyTerminal =
      (instance!.lifecycle_state === "deleted" ||
        instance!.lifecycle_state === "failed") &&
      !instance!.proxmox_vmid &&
      !instance!.host_id &&
      !instance!.hetzner_server_id &&
      (!proxmoxBacked || proxmoxReleaseSafeForDbOnlyDelete);
    if (alreadyTerminal) {
      log.info(
        "instance already terminal with no live infra; short-circuiting to idempotent delete",
        {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          lifecycleState: instance!.lifecycle_state ?? null,
          previousStatus: instance!.status ?? null,
        },
      );
      const now = new Date().toISOString();
      await supabaseAdmin!
        .from("hermes_instances")
        .update({
          status: "deleted",
          lifecycle_state: "deleted",
          deleted_at: instance!.deleted_at ?? now,
          updated_at: now,
        })
        .eq("id", id);
      return apiSuccess({ deleted: true });
    }

    if (proxmoxBacked && !proxmoxInfrastructure && !proxmoxReleaseSafeForDbOnlyDelete) {
      log.error(
        "proxmox-backed row missing an authoritative teardown receipt; refusing to mark deleted",
        new Error("proxmox lifecycle target unresolved"),
        {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          failureType: "instance_delete_proxmox_target_unresolved",
          failureOwner: "control-plane",
          failurePhase: "delete",
          recoveryAction: "recover_runtime_routing",
          releaseReason: proxmoxReleased?.reason ?? null,
          proxmoxNode: instance!.proxmox_node ?? null,
          proxmoxVmid: instance!.proxmox_vmid ?? null,
          gatewayUrl: instance!.gateway_url ?? null,
        },
      );
      return apiError(
        "This runtime could not be verified as removed. Its record was preserved while routing recovery runs.",
        502,
        { failureType: "instance_delete_proxmox_target_unresolved" },
      );
    }

    if (proxmoxBacked && !proxmoxInfrastructure && proxmoxReleaseSafeForDbOnlyDelete) {
      // The handle was deliberately stripped after authoritative teardown or
      // fleet-wide absence. There is no VM for THIS row to teardown — proceed with
      // DB-only cleanup. Without this branch the row would be undeletable
      // for the user, because `infrastructure_provider='proxmox'` still
      // makes `isProxmoxBackedInstanceRow` return true.
      // Benign, fully-handled teardown outcome — the handle was already
      // confirmed gone, so there is nothing to teardown and the DB-only delete
      // succeeds. Log at info, not warn, so it doesn't pollute warn-level ops
      // monitoring (canary issue #146).
      log.info(
        "proxmox handle previously released; proceeding with DB-only delete (no provider teardown needed)",
        {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          releaseReason: proxmoxReleased?.reason ?? null,
          releaseAt: proxmoxReleased?.at ?? null,
        },
      );
    }

    if (proxmoxInfrastructure) {
      try {
          const proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfrastructure, { host_id: instance!.host_id ?? null });
          const result = await deleteProxmoxInstance(proxmoxInfrastructure, {
            hostConfig: proxmoxHostConfig,
            expectedInstanceId: id,
          });
          const stdoutLines = (result.stdout || "").split(/\r?\n/);
          const vmMissingOnRoutedHost = stdoutLines.some((line) =>
            /^HERMES_PROXMOX_DELETE_VM_MISSING \d+$/.test(line.trim()),
          );

          if (vmMissingOnRoutedHost) {
            const recovery = await recoverProxmoxInstanceAcrossFleet(instance!);
            if (recovery.status !== "gone") {
              return apiError(
                recovery.status === "recovered"
                  ? "The runtime was found on another host and its routing was repaired. Retry deletion if you still want to remove it."
                  : "The runtime could not be verified as removed. Its record was preserved while routing recovery runs.",
                recovery.status === "recovered" ? 409 : 502,
                {
                  failureType:
                    recovery.status === "recovered"
                      ? "instance_delete_proxmox_routing_recovered"
                      : "instance_delete_proxmox_recovery_pending",
                  retryable: true,
                },
              );
            }
          }

          if (!result.ok) {
            const stdoutText = result.stdout || "";

            const vmConfirmedRemovedInStdout =
              stdoutText.includes("HERMES_PROXMOX_DELETE_VM_DESTROYED") ||
              stdoutText.includes("HERMES_PROXMOX_DELETE_VM_MISSING_AFTER_DESTROY") ||
              vmMissingOnRoutedHost;

            if (vmConfirmedRemovedInStdout) {
              // Only the identity-locked host script or a conclusive fleet scan
              // can prove removal. Transport failures never authorize DB cleanup.
              log.info("proxmox delete reported failure after VM was already gone; marking row deleted", {
                source: "instances",
                route: "/api/instances/[id]",
                method: "DELETE",
                instanceId: id,
                userId,
                failureType: "instance_delete_proxmox_vm_missing_after_failure",
                failureOwner: "cleanup",
                failurePhase: "delete",
                recoveryAction: "mark_deleted_release_claim",
                proxmoxVmid: proxmoxInfrastructure.vmid,
                redactedError: redactSensitiveCommandOutput(result.error || "proxmox delete returned not-ok", 600),
                redactedStderr: redactSensitiveCommandOutput(result.stderr || "", 600),
                redactedStdout: redactSensitiveCommandOutput(result.stdout || "", 600),
              });
            } else {
              log.error("proxmox delete failed; refusing to mark instance deleted", new Error(result.error || "proxmox delete returned not-ok"), {
                source: "instances",
                route: "/api/instances/[id]",
                method: "DELETE",
                instanceId: id,
                userId,
                failureType: "instance_delete_proxmox_failed",
                failureOwner: "hypervisor",
                failurePhase: "delete",
                recoveryAction: "contact_support",
                proxmoxVmid: proxmoxInfrastructure.vmid,
                errorName: result.error ? "HostScriptError" : "Unknown",
              });
              return apiError(
                "Proxmox delete failed. Please retry — the instance has not been removed.",
                502,
                { failureType: "instance_delete_proxmox_failed" },
                undefined,
                {
                  source: "instances",
                  route: "/api/instances/[id]",
                  method: "DELETE",
                  instanceId: id,
                  userId,
                  metadata: {
                    failureOwner: "hypervisor",
                    failurePhase: "delete",
                    failureType: "instance_delete_proxmox_failed",
                    recoveryAction: "contact_support",
                    proxmoxVmid: proxmoxInfrastructure.vmid,
                  },
                }
              );
            }
          }
      } catch (e) {
            log.error("proxmox delete threw; refusing to mark instance deleted", e, {
              source: "instances",
              route: "/api/instances/[id]",
              method: "DELETE",
              instanceId: id,
              userId,
              failureType: "instance_delete_proxmox_failed",
              failureOwner: "hypervisor",
              failurePhase: "delete",
              recoveryAction: "contact_support",
              proxmoxVmid: proxmoxInfrastructure.vmid,
            });
            return apiError(
              "Proxmox delete failed. Please retry — the instance has not been removed.",
              502,
              { failureType: "instance_delete_proxmox_failed" },
              undefined,
              {
                source: "instances",
                route: "/api/instances/[id]",
                method: "DELETE",
                instanceId: id,
                userId,
                metadata: {
                  failureOwner: "hypervisor",
                  failurePhase: "delete",
                  failureType: "instance_delete_proxmox_failed",
                  recoveryAction: "contact_support",
                  proxmoxVmid: proxmoxInfrastructure.vmid,
                },
              }
            );
      }
    } else if (instance!.hetzner_server_id) {
      // Try Hetzner delete and only mark the row deleted if it succeeds
      // (or if the server is already gone — 404). Previously, any
      // transient Hetzner error left the DB row marked deleted while
      // the VM kept billing forever — silent recurring cost.
      try {
        await deleteHetznerServer(instance!.hetzner_server_id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const alreadyGone = msg.includes("→ 404");
        if (!alreadyGone) {
          log.error("hetzner delete failed; refusing to mark instance deleted (avoid orphan billable VM)", e, {
            source: "instances",
            route: "/api/instances/[id]",
            method: "DELETE",
            instanceId: id,
            userId,
            failureType: "instance_delete_hetzner_failed",
            failureOwner: "provider",
            failurePhase: "delete",
            recoveryAction: "contact_support",
            hetznerServerId: instance!.hetzner_server_id,
          });
          return apiError(
            "Hetzner delete failed. Please retry — the instance has not been removed.",
            502,
            { failureType: "instance_delete_hetzner_failed" },
            undefined,
            {
              source: "instances",
              route: "/api/instances/[id]",
              method: "DELETE",
              instanceId: id,
              userId,
              metadata: {
                failureOwner: "provider",
                failurePhase: "delete",
                failureType: "instance_delete_hetzner_failed",
                recoveryAction: "contact_support",
                hetznerServerId: instance!.hetzner_server_id,
              },
            }
          );
        }
        // Server already gone (404) — the delete still succeeds, so this is a
        // benign teardown outcome; log at info to keep warn-level monitoring
        // clean (canary issue #146). The non-404 failure path above stays error.
        log.info("hetzner server already gone (404) — proceeding with DB delete", {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          hetznerServerId: instance!.hetzner_server_id,
        });
      }
    }

    const persistedDnsDomain = deriveDnsDomainFromGatewayUrl(
      instance!.gateway_url,
      instance!.subdomain,
    );
    const dnsCleanupContext = {
      source: "instances",
      route: "/api/instances/[id]",
      instanceId: id,
      userId,
    };
    if (persistedDnsDomain) {
      await removeInstanceDnsBestEffort(
        instance!.subdomain,
        dnsCleanupContext,
        { dnsDomain: persistedDnsDomain },
      );
    } else {
      await removeInstanceDnsBestEffort(instance!.subdomain, dnsCleanupContext);
    }

    // Mark the instance as deleted, AND release any proxmox_vmid claim
    // so the next provision can reuse the slot. The unique index
    // is partial on (proxmox_node, proxmox_vmid) while
    // `lifecycle_state <> 'deleted' AND proxmox_vmid IS NOT NULL`. If we
    // only flipped `status='deleted'` (the dashboard's user-facing flag)
    // without also nulling proxmox_vmid + flipping lifecycle_state, the
    // deleted row would keep claiming the VMID slot on that host, and the
    // next provision that picks the same VMID off `qm list` would 23505-fail
    // at post-provision update.
    await supabaseAdmin!
      .from("hermes_instances")
      .update({
        status: "deleted",
        lifecycle_state: "deleted",
        proxmox_vmid: null,
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    // If it was linked to a host, mark the host as deleted too since we
    // just deleted the Hetzner Server. ONLY do so when no other live
    // instances reference this host — on shared hosts (multiple users
    // / multiple instances per Hetzner server), one user deleting their
    // instance must not flip the host away from everyone else.
    if (instance!.host_id && instance!.hetzner_server_id) {
      const { count: liveInstancesOnHost } = await supabaseAdmin!
        .from("hermes_instances")
        .select("id", { count: "exact", head: true })
        .eq("host_id", instance!.host_id)
        .neq("id", id)
        .neq("status", "deleted");

      if ((liveInstancesOnHost ?? 0) === 0) {
        await supabaseAdmin!
          .from("hermes_hosts")
          .update({ status: "deleted" })
          .eq("id", instance!.host_id);
      } else {
        log.info("host kept alive — other instances still reference it", {
          source: "instances",
          route: "/api/instances/[id]",
          method: "DELETE",
          instanceId: id,
          userId,
          hostId: instance!.host_id,
          remainingInstances: liveInstancesOnHost,
        });
      }
    }

    await reportOpsEvent({
      source: "instances.delete",
      severity: "warn",
      title: "User instance delete",
      message: `User ${userId} deleted instance ${id}`,
      route: "/api/instances/[id]",
      userId: instance!.user_id,
      instanceId: id,
      metadata: {
        actor_user_id: userId,
        instance_id: id,
        previous_status: instance!.status || null,
        previous_lifecycle_state: instance!.lifecycle_state || null,
        infrastructure_provider: proxmoxInfrastructure
          ? "proxmox"
          : instance!.hetzner_server_id
            ? "hetzner"
            : null,
        proxmox_node: proxmoxInfrastructure?.node || null,
        proxmox_vmid: proxmoxInfrastructure?.vmid || null,
        host_id: instance!.host_id || null,
        hetzner_server_id: instance!.hetzner_server_id || null,
        // Optional one-click churn reason from the delete modal. Null when the
        // user skipped it — it never blocks the delete.
        delete_reason: deleteReason,
        delete_reason_note: deleteReasonNote,
      },
    });

    return apiSuccess({ deleted: true });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let instanceIdForOps: string | null = null;
  let actionForOps: string | null = null;
  let hostIpForOps: string | null = null;

  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    instanceIdForOps = id;
    const { instance, err } = await getInstanceOrError(id, userId);
    if (err) return err;

    const body = await req.json();
    const action = body.action as string;
    actionForOps = action;
    const safeSshActionFailure = {
      failureType: "ssh_exec_failed",
      retryable: false,
    } as const;
    const safeRetryableSshActionFailure = {
      failureType: "ssh_exec_failed",
      retryable: true,
    } as const;
    const safeLiveUpdateFailure = {
      failureType: "live_update_failed",
    } as const;
    const buildSshActionFailureDetails = (res: {
      stdout?: string;
      stderr?: string;
      error?: string;
    }, retryable: boolean) => ({
      failureType: "ssh_exec_failed",
      retryable,
      ...(res.stdout?.trim()
        ? { stdout: redactSensitiveCommandOutput(res.stdout.trim()) }
        : {}),
      ...(res.stderr?.trim()
        ? { stderr: redactSensitiveCommandOutput(res.stderr.trim()) }
        : {}),
      ...(res.error?.trim()
        ? { error: redactSensitiveCommandOutput(res.error.trim()) }
        : {}),
    });

    // Cold-storage restore path (Phase 3 of docs/cold-storage-orchestration.md).
    // When the row is `cold_archived` or `pending_deletion` (data lives on
    // the Hetzner Storage Box, no Proxmox routing fields), the Start action
    // must restore the archive to a fresh VM and flip the row back to
    // `active`. The orchestrator picks a host via the existing capacity
    // allocator, derives a free VMID+IP, calls restoreInstance(). Synchronous
    // — typical restore is ~70-90s on Hetzner Helsinki internal network,
    // well within Vercel's serverless ceiling.
    //
    // Gated behind COLD_STORAGE_RESTORE_ON_START_ENABLED so the route stays
    // safe-by-default until ops flips the flag.
    // Also treat `failed` rows that still carry a complete archive as
    // restorable — these are agents whose last user-driven Start landed in
    // a half-broken state (e.g. the original 2026-05-18 incident where a
    // cold_archived row got flipped to `failed` by an upstream code path,
    // then Start kept falling through to startProxmoxInstance with the
    // stale pre-archive VMID and SSH-timing-out against a host that no
    // longer has the VM). When archive_uri + sha256 are intact the data
    // is recoverable; routing this through cold-restore is the only safe
    // path because the original VM is gone and any other start action
    // would target a recycled VMID.
    const isColdLifecycleRow =
      instance!.lifecycle_state === "cold_archived" ||
      instance!.lifecycle_state === "pending_deletion" ||
      (instance!.lifecycle_state === "failed" &&
        !!instance!.archive_uri &&
        !!instance!.archive_sha256 &&
        instance!.proxmox_vmid == null);
    if (action === "start" && isColdLifecycleRow) {
      const restoreEnabled =
        (process.env.COLD_STORAGE_RESTORE_ON_START_ENABLED ?? "").toLowerCase() === "true";
      void recordInstanceUserActivity({
        instanceId: id,
        userId,
        source: "instance_lifecycle_action",
      });

      if (!restoreEnabled) {
        return apiError(
          "This instance is in cold storage. Automated restore is not yet enabled — please contact support.",
          409,
          {
            failureType: "instance_cold_archived_restore_disabled",
            retryable: false,
          },
          undefined,
          {
            source: "instance-actions",
            route: "/api/instances/[id]",
            instanceId: id,
            metadata: {
              action,
              failureOwner: "hermes",
              failurePhase: "cold_restore_disabled",
              failureType: "instance_cold_archived_restore_disabled",
              recoveryAction: "enable_cold_restore_flag",
            },
          }
        );
      }

      if (!supabaseAdmin) {
        return apiError("Database not configured", 500);
      }

      log.info("cold-restore on Start: dispatching to orchestrator", {
        source: "instance-actions",
        route: "/api/instances/[id]",
        instanceId: id,
        userId,
        lifecycleState: instance!.lifecycle_state,
      });

      const restoreResult = await orchestrateColdRestore(supabaseAdmin, {
        instance: {
          id,
          user_id: userId,
          resource_tier: instance!.resource_tier ?? null,
          cpu_limit: instance!.cpu_limit ?? null,
          ram_limit: instance!.ram_limit ?? null,
          disk_size_gb: instance!.disk_size_gb ?? null,
          proxmox_node: instance!.proxmox_node ?? null,
          gateway_host: (() => {
            try {
              return instance!.gateway_url ? new URL(instance!.gateway_url).hostname : null;
            } catch {
              return null;
            }
          })(),
        },
      });

      // health_pending is NOT a failure: the VM is live and the row is parked
      // (lifecycle_substate='restore_health_pending') for the
      // recover-stuck-restoring sweep to promote once the gateway answers
      // /health. Surface it as a 202-style "finalizing" success so the client
      // shows a warming-up state and keeps polling instead of an error toast.
      if (!restoreResult.ok && restoreResult.reason === "health_pending") {
        log.info("cold-restore finalizing (health_pending)", {
          source: "instance-actions",
          route: "/api/instances/[id]",
          instanceId: id,
          newVmid: restoreResult.newVmid,
          newPveHost: restoreResult.newPveHost,
          newIpv4: restoreResult.newIpv4,
        });
        return apiSuccess({
          ok: true,
          action: "cold_restore",
          status: "finalizing",
          instanceId: id,
          newVmid: restoreResult.newVmid,
          newPveHost: restoreResult.newPveHost,
          newIpv4: restoreResult.newIpv4,
          message:
            "Your agent is restored and starting up. It will be ready in a moment.",
        });
      }

      if (!restoreResult.ok) {
        log.warn("cold-restore failed", {
          source: "instance-actions",
          route: "/api/instances/[id]",
          instanceId: id,
          failureType: "cold_restore_failed",
          reason: restoreResult.reason,
          message: restoreResult.message,
        });
        const httpStatus = restoreResult.reason === "no_capacity" ? 503 : 500;
        return apiError(
          `Could not restore your agent from cold storage: ${restoreResult.message}`,
          httpStatus,
          {
            failureType: "cold_restore_failed",
            reason: restoreResult.reason,
            retryable: restoreResult.retryable,
          }
        );
      }

      log.info("cold-restore on Start succeeded", {
        source: "instance-actions",
        route: "/api/instances/[id]",
        instanceId: id,
        newVmid: restoreResult.newVmid,
        newPveHost: restoreResult.newPveHost,
        newIpv4: restoreResult.newIpv4,
      });

      return apiSuccess({
        ok: true,
        action: "cold_restore",
        instanceId: id,
        newVmid: restoreResult.newVmid,
        newPveHost: restoreResult.newPveHost,
        newIpv4: restoreResult.newIpv4,
        restoredAt: restoreResult.restoredAt,
      });
    }

    // Legacy "dormant_reclaimed" path — pre-cold-storage archive system.
    // Kept for any rows from the old dormant-reclaim flow that pre-date
    // Phase 1's lifecycle_state migration.
    if (action === "start" && instance!.paused_reason === "dormant_reclaimed") {
      void recordInstanceUserActivity({
        instanceId: id,
        userId,
        source: "instance_lifecycle_action",
      });
      return apiError(
        "This instance has been archived to dormant storage. It needs to be restored from its archive before it can be started.",
        409,
        {
          failureType: "instance_dormant_reclaimed",
          retryable: false,
        },
        undefined,
        {
          source: "instance-actions",
          route: "/api/instances/[id]",
          instanceId: id,
          metadata: {
            action,
            failureOwner: "hermes",
            failurePhase: "dormant_restore",
            failureType: "instance_dormant_reclaimed",
            recoveryAction: "restore_dormant_archive",
          },
        }
      );
    }

    if (
      ENTITLEMENT_GATED_INSTANCE_ACTIONS.has(action) &&
      instance!.entitlement_state === "suspended"
    ) {
      if (instance!.entitlement_reason === LEGACY_CREDIT_SUSPENSION_REASON) {
        const clearErr = await clearLegacyCreditSuspensionBeforeAction(instance!, userId, action);
        if (clearErr) return clearErr;
      } else {
        log.warn("blocked instance action while entitlement is suspended", {
          source: "instances",
          route: "/api/instances/[id]",
          method: "POST",
          instanceId: id,
          userId,
          action,
          failureType: "instance_entitlement_suspended",
          entitlementReason: instance!.entitlement_reason ?? null,
          entitlementSuspendedAt: instance!.entitlement_suspended_at ?? null,
        });
        return apiError(
          "Compute is suspended until billing or token eligibility is restored.",
          402,
          {
            failureType: "instance_entitlement_suspended",
            retryable: false,
            entitlementReason: instance!.entitlement_reason ?? null,
            entitlementSuspendedAt: instance!.entitlement_suspended_at ?? null,
          },
          undefined,
          {
            source: "instance-actions",
            route: "/api/instances/[id]",
            instanceId: id,
            metadata: {
              action,
              failureOwner: "billing",
              failurePhase: "entitlement",
              failureType: "instance_entitlement_suspended",
              recoveryAction: "open_billing",
            },
          }
        );
      }
    }

    // Detect Proxmox-backed instances early so power/lifecycle actions can
    // route to the Proxmox host instead of the Hetzner API.
    const configProxmoxInfra = getProxmoxInfrastructure(instance!.config);
    const storedProxmoxTarget = configProxmoxInfra
      ? null
      : readStoredProxmoxActionTarget(instance!);
    let proxmoxInfra = configProxmoxInfra ?? storedProxmoxTarget;
    let proxmoxHostConfig = proxmoxInfra
      ? getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, {
          host_id: instance!.host_id ?? null,
        })
      : null;

    if (storedProxmoxTarget) {
      log.warn("using stored Proxmox VM metadata because config infrastructure is missing", {
        source: "instances",
        route: "/api/instances/[id]",
        method: "POST",
        instanceId: id,
        userId,
        action,
        failureType: "proxmox_config_infrastructure_missing",
        proxmoxNode: storedProxmoxTarget.node ?? null,
        proxmoxVmid: storedProxmoxTarget.vmid,
        hostId: instance!.host_id ?? null,
        infrastructureProvider: instance!.infrastructure_provider ?? null,
      });
    }

    const releasedProxmoxInfra = getReleasedProxmoxInfrastructure(instance!.config);
    const hasProxmoxRecoverySignal =
      isProxmoxBackedInstanceRow(instance!) ||
      Boolean(instance!.proxmox_node?.trim()) ||
      Boolean(releasedProxmoxInfra);

    if (action === "start" && !proxmoxInfra && hasProxmoxRecoverySignal) {
      const recovery = await recoverProxmoxInstanceAcrossFleet(
        toProxmoxRecoveryCandidate(instance!),
        { allowStopped: true },
      );
      if (recovery.status === "recovered") {
        proxmoxInfra = recovery.infrastructure;
        proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
          recovery.infrastructure,
          { host_id: instance!.host_id ?? null },
        );
      } else {
        const failure = {
          failureType:
            recovery.status === "gone"
              ? "instance_host_missing_across_fleet"
              : "instance_host_recovery_pending",
          retryable: recovery.status !== "gone",
        };
        return apiError(
          recovery.status === "gone"
            ? "The runtime was not found across the fleet. This agent was preserved; contact support so its runtime can be repaired."
            : "The runtime host could not be verified yet. The instance was preserved and recovery will retry automatically.",
          recovery.status === "gone" ? 409 : 503,
          failure,
          failure,
        );
      }
    }

    // Resolve the Hetzner server ID and a live server record.
    // In the multi-agent model, stop/start/reboot affect the HOST server, not
    // individual agents. For container-level ops (update, redeploy) we SSH in.
    let serverId: number | null = instance!.hetzner_server_id ?? null;
    let hostRow: HermesHostRow | null = null;

    if (!proxmoxInfra && instance!.host_id) {
      const { data: h } = await supabaseAdmin!
        .from("hermes_hosts")
        .select("*")
        .eq("id", instance!.host_id)
        .eq("user_id", userId)
        .single<HermesHostRow>();
      hostRow = h;
      if (hostRow?.hetzner_server_id) serverId = hostRow.hetzner_server_id;
    }

    // Some legacy rows lost every provider discriminator while their VM still
    // exists. A plain "No server attached" used to make the client tell owners
    // to delete the instance without checking the fleet. Start is non-
    // destructive, so search all configured Proxmox hosts and repair routing
    // before returning an error.
    if (action === "start" && !proxmoxInfra && !serverId) {
      const recovery = await recoverProxmoxInstanceAcrossFleet(
        toProxmoxRecoveryCandidate(instance!),
        { allowStopped: true },
      );
      if (recovery.status === "recovered") {
        proxmoxInfra = recovery.infrastructure;
        proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
          recovery.infrastructure,
          { host_id: instance!.host_id ?? null },
        );
      } else {
        const failure = {
          failureType:
            recovery.status === "gone"
              ? "instance_host_missing_across_fleet"
              : "instance_host_recovery_pending",
          retryable: recovery.status !== "gone",
        };
        return apiError(
          recovery.status === "gone"
            ? "No runtime target is attached and no matching VM was found. This agent was preserved; contact support for repair."
            : "The runtime routing could not be verified yet. This agent was preserved and recovery can be retried.",
          recovery.status === "gone" ? 409 : 503,
          failure,
          failure,
        );
      }
    }

    if (!proxmoxInfra && !serverId && !hostRow) {
      const failure = {
        failureType: "instance_runtime_target_unresolved",
        retryable: false,
      };
      return apiError(
        "The runtime target is unresolved. This agent was preserved; contact support for repair.",
        409,
        failure,
        failure,
      );
    }

    // Fetch live server details when we have a server ID.
    let server: HetznerServer | null = null;
    if (!proxmoxInfra && serverId) {
      const res = await getServer(serverId);
      server = res.server;
    }

    const serverIp = server?.public_net?.ipv4?.ip ?? null;
    hostIpForOps = serverIp;
    const buildActionErrorOptions = (hostIp?: string | null) => ({
      source: 'instance-actions',
      route: '/api/instances/[id]',
      instanceId: id,
      metadata: {
        action,
        failureOwner: "runtime",
        failurePhase: "runtime",
        failureType: "instance_action_failed",
        recoveryAction: "open_console",
        ...(hostIp ? { hostIp } : {}),
      },
    } as const);

    switch (action) {
      case "start":
        if (proxmoxInfra) {
          // ── Gateway auto-wake Phase 1 ────────────────────────────────────
          // Every Hermes-lane start is a "wake" (the VM is off or parked), so
          // it goes through the host-side admission guard: a per-host
          // concurrent-wake cap + free-RAM gate claimed in one SSH round-trip
          // (see @/lib/proxmox/wake-admission). Without this, a reactivation
          // stampede of bare `qm start`s can OOM a host. Deferred wakes get a
          // retryable 429 — the wake page auto-retries; the dashboard Start
          // button surfaces the message. The guard FAILS OPEN on probe errors
          // so a flaky host check can never block a legitimate start.
          const wakeSource: WakeTelemetrySource =
            body.wakeSource === "wake_page" ? "wake_page" : "dashboard";
          const wakeId =
            typeof body.wakeId === "string" && body.wakeId.trim()
              ? body.wakeId.trim().slice(0, 64)
              : null;
          const wakeHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(
            proxmoxInfra,
            { host_id: instance!.host_id ?? null }
          );
          captureWakeEvent("wake_requested", {
            userId,
            instanceId: id,
            wakeId,
            source: wakeSource,
            properties: {
              proxmox_node: proxmoxInfra.node ?? null,
              instance_status: instance!.status ?? null,
            },
          });
          const admission = await acquireHostWakeSlot(proxmoxInfra, {
            instanceId: id,
            neededRamMb: normalizeWakeRamMb(instance!.ram_limit),
            hostConfig: wakeHostConfig,
          });
          if (!admission.admitted) {
            captureWakeEvent("wake_admission_deferred", {
              userId,
              instanceId: id,
              wakeId,
              source: wakeSource,
              properties: {
                reason: admission.reason,
                free_mb: admission.freeMb,
                active_wakes: admission.activeWakes,
                cap: admission.cap,
                proxmox_node: proxmoxInfra.node ?? null,
              },
            });
            const deferResponse = apiError(
              "The host is busy waking other agents. Yours is queued — retry in about 30 seconds.",
              429,
              {
                failureType: "wake_admission_deferred",
                retryable: true,
                reason: admission.reason,
              },
              {
                // In the response body (not just server logs) so the client's
                // describeAgentStartFailure classifies this as a clean
                // wake_admission_deferred instead of the generic bucket, and
                // the wake page knows when to retry.
                failureType: "wake_admission_deferred",
                retryable: true,
                retryAfterSeconds: admission.retryAfterSeconds,
              },
              {
                source: "instance-actions",
                route: "/api/instances/[id]",
                instanceId: id,
                failureType: "wake_admission_deferred",
                logLevel: "warn",
                metadata: {
                  action,
                  wakeSource,
                  reason: admission.reason,
                  freeMb: admission.freeMb,
                  activeWakes: admission.activeWakes,
                  cap: admission.cap,
                },
              }
            );
            deferResponse.headers.set(
              "Retry-After",
              String(admission.retryAfterSeconds)
            );
            return deferResponse;
          }
          const result = await startProxmoxInstance(proxmoxInfra, {
            expectedInstanceId: instance!.id,
            hostConfig: wakeHostConfig,
            // Restore onboot so a resumed agent survives host reboots while
            // active — the inverse of the inactivity-pause onboot:0. Without
            // this, a VM paused (onboot cleared) then resumed would silently
            // fail to come back after a host reboot. Best-effort.
            setOnboot: 1,
          });
          if (isProxmoxVmMissingResult(result)) {
            // VM was destroyed (e.g. by Phase 2 bootstrap cleanup after a
            // transient apt-lock failure) but the row was left at
            // status='stopped' with proxmox_vmid still populated, which made
            // the UI offer "start" — and qm start on a missing VM exits 255.
            // Free the wake slot early — this start is dead, don't queue
            // other wakes behind it for the rest of the slot TTL. Search the
            // whole fleet before changing the row so reconciliation keeps its
            // updated_at compare-and-swap guard against concurrent settings
            // writes.
            void releaseHostWakeSlot(proxmoxInfra, {
              instanceId: id,
              hostConfig: wakeHostConfig,
            });
            const recovery = await recoverProxmoxInstanceAcrossFleet(
              toProxmoxRecoveryCandidate(instance!),
              { allowStopped: true },
            );
            // Do not write lifecycle state after the scan. A concurrent
            // repair, settings save, or deletion may have won its revision
            // check; an unguarded error write here would undo that protection.
            const failureType =
              recovery.status === "recovered"
                ? "instance_host_routing_recovered"
                : recovery.status === "gone"
                  ? "instance_host_missing_across_fleet"
                  : "instance_host_recovery_pending";
            const retryable = recovery.status !== "gone";
            return apiError(
              recovery.status === "recovered"
                ? "The runtime was found on another host and its routing was repaired. Please retry Start."
                : recovery.status === "gone"
                  ? "The runtime was not found across the fleet. This agent was preserved; contact support so its runtime can be repaired."
                  : "The runtime was not found on its routed host. The instance was preserved and fleet recovery will continue automatically.",
              409,
              {
                failureType,
                retryable,
              },
              {
                failureType,
                retryable,
              },
              missingInstanceHostErrorOptions(action)
            );
          }
          if (!result.ok) {
            // Same early slot release: the wake failed outright, so an
            // immediate user retry shouldn't be 429'd by its own corpse.
            void releaseHostWakeSlot(proxmoxInfra, {
              instanceId: id,
              hostConfig: wakeHostConfig,
            });
            return apiError(
              result.error || result.stderr || "Proxmox start failed",
              500
            );
          }
          await updateInstanceAndHostStatus({
            instanceId: id,
            instanceStatus: "running",
          });
          break;
        }
        if (!serverId) return apiError("No server attached", 400);
        await powerOnServer(serverId);
        await updateInstanceAndHostStatus({
          instanceId: id,
          instanceStatus: "provisioning",
          hostId: instance!.host_id,
          hostStatus: "provisioning",
        });
        break;

      case "stop":
        if (proxmoxInfra) {
          const result = await shutdownProxmoxInstance(proxmoxInfra, {
            expectedInstanceId: instance!.id,
            hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, { host_id: instance!.host_id ?? null }),
          });
          if (!result.ok) {
            return apiError(
              result.error || result.stderr || "Proxmox shutdown failed",
              500
            );
          }
          await updateInstanceAndHostStatus({
            instanceId: id,
            instanceStatus: "stopped",
          });
          break;
        }
        if (!serverId) return apiError("No server attached", 400);
        await shutdownServer(serverId);
        await updateInstanceAndHostStatus({
          instanceId: id,
          instanceStatus: "stopped",
          hostId: instance!.host_id,
          hostStatus: "stopped",
        });
        break;

      case "reboot":
        if (proxmoxInfra) {
          const result = await rebootProxmoxInstance(proxmoxInfra, {
            expectedInstanceId: instance!.id,
            hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfra, { host_id: instance!.host_id ?? null }),
          });
          if (!result.ok) {
            return apiError(
              result.error || result.stderr || "Proxmox reboot failed",
              500
            );
          }
          await updateInstanceAndHostStatus({
            instanceId: id,
            instanceStatus: "running",
          });
          break;
        }
        if (!serverId) return apiError("No server attached", 400);
        const { rebootServer } = await import("@/lib/hetzner/client");
        await rebootServer(serverId);
        await updateInstanceAndHostStatus({
          instanceId: id,
          instanceStatus: "provisioning",
          hostId: instance!.host_id,
          hostStatus: "provisioning",
        });
        break;

      case "update": {
        const globalSettings = await loadGlobalHermesSettingsForUser(userId, {
          instanceId: id,
        });
        const ipv4 = await resolveInstanceIpv4(instance!, supabaseAdmin!);
        hostIpForOps = ipv4;
        const result = await applyLiveUpdate(instance!, ipv4, globalSettings, supabaseAdmin!, {
          initiator: USER_LIVE_UPDATE,
        });
        if (!result.applied) {
          const retryableSshMessage = normalizeRetryableInstanceActionError(result.error);
          if (retryableSshMessage) {
            return apiError(
              retryableSshMessage,
              409,
              safeLiveUpdateFailure,
              undefined,
              buildActionErrorOptions(ipv4)
            );
          }
          return apiError(
            INSTANCE_UPDATE_FAILURE_MESSAGE,
            500,
            safeLiveUpdateFailure,
            undefined,
            buildActionErrorOptions(ipv4)
          );
        }
        break;
      }
      
      case "restart": {
        const ipv4 = await resolveInstanceIpv4(instance!, supabaseAdmin!);
        if (!ipv4) return apiError("No IPv4 address", 400);
        hostIpForOps = ipv4;
        
        await supabaseAdmin!
          .from("hermes_instances")
          .update(buildInstanceLifecyclePatch("provisioning"))
          .eq("id", id);
        
        log.info("restarting docker container", {
          source: "instances",
          route: "/api/instances/[id]",
          method: "POST",
          instanceId: id,
          userId,
          action: "restart",
          containerName: `agent-${id}`,
          hostIp: ipv4,
        });
        const restartScript = [
            "set -e",
            buildHostTimeSyncRepairScript(),
            // webfree runs -gateway/-official-dashboard, not a bare agent-<id>.
            // Resolve and restart the live runtime container so a plain restart
            // doesn't fail with "No such container" (which would wrongly flip a
            // healthy webfree instance to "error").
            buildResolveAgentContainerScript(`agent-${id}`, { varName: "AGENT_CONTAINER" }),
            `if [ -z "$AGENT_CONTAINER" ]; then echo "no running agent container for agent-${id}" >&2; exit 1; fi`,
            `docker restart "$AGENT_CONTAINER"`,
        ].join("\n");
        const guestTarget = guestSshTargetFor(proxmoxInfra, proxmoxHostConfig, id);
        const res = guestTarget
          ? await sshExec(ipv4, restartScript, { proxmoxHostConfig: guestTarget })
          : await sshExec(ipv4, restartScript);

        if (!res.ok) {
           const detail = res.stderr?.trim() || res.error?.trim() || "";
           const retryableActionMessage = normalizeRetryableInstanceActionError(detail);
           if (retryableActionMessage) {
             return apiError(
               retryableActionMessage,
               409,
               safeRetryableSshActionFailure,
               undefined,
               buildActionErrorOptions(ipv4)
             );
           }

           await supabaseAdmin!
             .from("hermes_instances")
             .update(buildInstanceLifecyclePatch("error"))
             .eq("id", id);
           return apiError(
             formatSshActionFailure("Restart failed"),
             500,
             safeSshActionFailure,
             undefined,
             buildActionErrorOptions(ipv4)
           );
        }
        
        await supabaseAdmin!
          .from("hermes_instances")
          .update(buildInstanceLifecyclePatch("running"))
          .eq("id", id);
        break;
      }

      case "restart_gateway": {
        const ipv4 = await resolveInstanceIpv4(instance!, supabaseAdmin!);
        if (!ipv4) return apiError("No IPv4 address", 400);
        hostIpForOps = ipv4;
        const isWebUIBackend = isWebfreeBackend(instance!.backend);
        const containerName = isWebUIBackend
          ? `agent-${id}`
          : proxmoxHostConfig
            ? await discoverContainerName(ipv4, id, proxmoxHostConfig)
            : await discoverContainerName(ipv4, id);

        await supabaseAdmin!
          .from("hermes_instances")
          .update(buildInstanceLifecyclePatch("provisioning"))
          .eq("id", id);

        log.info("restarting Hermes gateway inside container", {
          source: "instances",
          route: "/api/instances/[id]",
          method: "POST",
          instanceId: id,
          userId,
          action: "restart_gateway",
          containerName,
          hostIp: ipv4,
          backend: instance!.backend ?? "gateway",
        });
        const restartCommand = isWebUIBackend
          ? buildWebUIRuntimeRestartCommand(id, instance!.backend)
          : buildGatewayRestartCommand(containerName, instance!.config);
        const guestTarget = guestSshTargetFor(proxmoxInfra, proxmoxHostConfig, id);
        const res = isWebUIBackend
          ? await sshExec(ipv4, restartCommand, {
              timeoutMs: GATEWAY_RESTART_SSH_TIMEOUT_MS,
              ...(guestTarget ? { proxmoxHostConfig: guestTarget } : {}),
            })
          : guestTarget
            ? await sshExec(ipv4, restartCommand, { proxmoxHostConfig: guestTarget })
            : await sshExec(ipv4, restartCommand);

        if (!res.ok) {
          const detail = res.stderr?.trim() || res.error?.trim() || res.stdout?.trim() || "";
          if (isMissingInstanceHostError(detail)) {
            await supabaseAdmin!
              .from("hermes_instances")
              .update(buildInstanceLifecyclePatch("error"))
              .eq("id", id);
            return apiError(
              "This instance's VM is unreachable or no longer exists on the host. Runtime repair and gateway restart cannot fix a missing VM; please contact support so Hermes can clean up the stale record and recreate the agent.",
              409,
              buildSshActionFailureDetails(res, false),
              undefined,
              missingInstanceHostErrorOptions(action, ipv4)
            );
          }
          const retryableActionMessage = normalizeRetryableInstanceActionError(detail);
          if (retryableActionMessage) {
            return apiError(
              retryableActionMessage,
              409,
              buildSshActionFailureDetails(res, true),
              undefined,
              buildActionErrorOptions(ipv4)
            );
          }

          await supabaseAdmin!
            .from("hermes_instances")
            .update(buildInstanceLifecyclePatch("error"))
            .eq("id", id);
          const configRecord = readPlainRecord(instance?.config);
          const isUpdateFailed = configRecord?.lastUpdateReportStatus === "failed";
          const failureMessage = isUpdateFailed
            ? "Gateway restart failed because the previous update reported a host-side failure. Please use 'Repair Runtime' to recreate the container stack."
            : formatSshActionFailure("Gateway restart failed");
          return apiError(
            failureMessage,
            500,
            buildSshActionFailureDetails(res, false),
            undefined,
            buildActionErrorOptions(ipv4)
          );
        }

        await supabaseAdmin!
          .from("hermes_instances")
          .update(buildInstanceLifecyclePatch("running"))
          .eq("id", id);
        break;
      }

      case "redeploy":
      case "repair_runtime":
      case "rebuild_runtime": {
        if (isWebfreeBackend(instance!.backend)) {
          const ipv4 = await resolveInstanceIpv4(instance!, supabaseAdmin!);
          if (!ipv4) return apiError("No IPv4 address", 400);
          hostIpForOps = ipv4;
          const globalSettings = await loadGlobalHermesSettingsForUser(userId, {
            instanceId: id,
          });
          // Only a terminal/access settings apply may replace the native
          // backend. Routine redeploys and repairs preserve owner edits. The
          // owner asked for this restart, so it recreates now.
          const result = await applyLiveUpdate(instance!, ipv4, globalSettings, supabaseAdmin!, {
            initiator: USER_LIVE_UPDATE,
            ...(action === "redeploy" && body.applyTerminalBackend === true
              ? { applyTerminalBackend: true }
              : {}),
          });
          if (!result.applied) {
            if (isMissingInstanceHostError(result.error)) {
              await supabaseAdmin!
                .from("hermes_instances")
                .update(buildInstanceLifecyclePatch("error"))
                .eq("id", id);
              return apiError(
                "This instance's VM is unreachable or no longer exists on the host. Runtime repair cannot fix a missing VM; please contact support so Hermes can clean up the stale record and recreate the agent.",
                409,
                safeLiveUpdateFailure,
                undefined,
                missingInstanceHostErrorOptions(action, ipv4)
              );
            }
            const retryableSshMessage = normalizeRetryableInstanceActionError(result.error);
            if (retryableSshMessage) {
              return apiError(
                retryableSshMessage,
                409,
                safeLiveUpdateFailure,
                undefined,
                buildActionErrorOptions(ipv4)
              );
            }
            return apiError(
              INSTANCE_UPDATE_FAILURE_MESSAGE,
              500,
              safeLiveUpdateFailure,
              undefined,
              buildActionErrorOptions(ipv4)
            );
          }
          break;
        }

        // Resolve IPv4 from the live Hetzner server record — the most reliable source.
        const ipv4 = server?.public_net?.ipv4?.ip ?? "";
        if (!ipv4) return apiError("No IPv4 address", 400);
        hostIpForOps = ipv4;
        const { gatewayUrl, script } = await buildRuntimeDeployScript({
          instance: instance!,
          instanceId: id,
          ipv4,
          userId,
        });
        const recoveryPreamble = buildRuntimeRecoveryPreamble(id, action as RuntimeRepairAction);
        const agentScript = recoveryPreamble ? `${recoveryPreamble}\n${script}` : script;
        const actionLabel =
          action === "repair_runtime"
            ? "Repair Runtime"
            : action === "rebuild_runtime"
              ? "Rebuild Runtime"
              : "Redeploy";

        log.info(`${actionLabel} on host`, {
          source: "instances",
          route: "/api/instances/[id]",
          method: "POST",
          instanceId: id,
          userId,
          action,
          hostIp: ipv4,
        });
        await supabaseAdmin!
          .from("hermes_instances")
          .update(buildInstanceLifecyclePatch("redeploying"))
          .eq("id", id);

        const result = await sshExec(ipv4, agentScript);

        if (!result.ok) {
          const detail = result.stderr?.trim() || result.error?.trim() || "";
          if (isMissingInstanceHostError(detail)) {
            await supabaseAdmin!
              .from("hermes_instances")
              .update(buildInstanceLifecyclePatch("error"))
              .eq("id", id);
            return apiError(
              "This instance's VM is unreachable or no longer exists on the host. Redeploy cannot fix a missing VM; please contact support so Hermes can clean up the stale record and recreate the agent.",
              409,
              safeSshActionFailure,
              undefined,
              missingInstanceHostErrorOptions(action, ipv4)
            );
          }
          const retryableActionMessage = normalizeRetryableInstanceActionError(detail);
          if (retryableActionMessage) {
            await supabaseAdmin!
              .from("hermes_instances")
              .update(buildInstanceLifecyclePatch("provisioning"))
              .eq("id", id);
            return apiError(
              retryableActionMessage,
              409,
              safeRetryableSshActionFailure,
              undefined,
              buildActionErrorOptions(ipv4)
            );
          }

          await supabaseAdmin!
            .from("hermes_instances")
            .update(buildInstanceLifecyclePatch("error"))
            .eq("id", id);
          return apiError(
            formatSshActionFailure(`${actionLabel} failed`),
            500,
            safeSshActionFailure,
            undefined,
            buildActionErrorOptions(ipv4)
          );
        }

        // The container has just been recreated with the latest
        // cpu_limit/ram_limit from the row, so any pending tier-change
        // is now applied. Clear the flag so the dashboard hides the
        // "Apply your new tier" banner. (Proxmox rows already have
        // tier_change_pending=false from tier-change-service; this
        // covers the Hetzner path that needs an explicit redeploy.)
        await supabaseAdmin!
          .from("hermes_instances")
          .update({
            ...buildInstanceLifecyclePatch("provisioning"),
            gateway_url: gatewayUrl,
            tier_change_pending: false,
          })
          .eq("id", id);
        break;
      }

      default:
        return apiError("Unknown action", 400);
    }

    void recordInstanceUserActivity({
      instanceId: id,
      userId,
      source: "instance_lifecycle_action",
    });

    return apiSuccess({ action });
  } catch (err) {
    return apiError(
      INSTANCE_ACTION_FAILURE_MESSAGE,
      500,
      err instanceof Error
        ? {
            failureType: "unexpected_instance_action_error",
            errorName: err.name,
          }
        : {
            failureType: "unexpected_instance_action_error",
            errorName: typeof err,
          },
      undefined,
      {
        source: 'instance-actions',
        route: '/api/instances/[id]',
        instanceId: instanceIdForOps,
        metadata: {
          failureOwner: "hermes",
          failurePhase: "runtime",
          failureType: "unexpected_instance_action_error",
          recoveryAction: "open_console",
          ...(actionForOps ? { action: actionForOps } : {}),
          ...(hostIpForOps ? { hostIp: hostIpForOps } : {}),
        },
      }
    );
  }
}
