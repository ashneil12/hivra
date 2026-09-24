import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { createHmac, randomBytes } from "crypto";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

// SCRIPTURE_ANCHOR: instance-builder | Psalm 127:1 | Verse: Unless Yahweh builds the house, they labor in vain who build it.
import { supabaseAdmin } from "@/lib/supabase";
import {
  countActiveFreeInstances,
  enqueueWaitlist,
  isAutoInviteEnabled,
  markReservationOnboardedByEmail,
  maxFreeInstances,
} from "@/lib/reservations/promote-next";
import { encryptApiKey, decryptApiKey } from "@/lib/crypto";
import {
  CODEX_DEFAULT_MODEL,
  type CodexVaultBundle,
  formatStoredProviderSecretPreview,
} from "@/lib/codex-oauth";
import type { NousVaultBundle } from "@/lib/nous-oauth";
import {
  resolveDeploymentApiKey,
  resolveProviderDeploymentSecret,
  supportsHermesAuthProvider,
  isCodexAuthProvider,
  isNousAuthProvider,
} from "@/lib/provider-deployment-auth";
import {
  provisionHetznerInstance,
  getServerSpecs,
  getHetznerInstanceStatus,
} from "@/lib/services/hetzner-instance-service";
import type { InstanceBackend } from "@/lib/services/hetzner-instance-service";
import { deleteHetznerServer } from "@/lib/services/hetzner-instance-service";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import { isClearableStaleProxmoxMetadataRow } from "@/lib/proxmox-metadata-row";
import {
  DEFAULT_PROXMOX_VM_DISK_GB,
  isProxmoxProvisioningConfigured,
  deleteProxmoxInstance,
  getProxmoxTemplateAvailability,
  getProxmoxVmidAvailability,
  provisionProxmoxInstance,
  resolveProxmoxHostEnv,
  resolveProxmoxMaxTenantInstances,
  resolveProxmoxTargetCandidateIds,
  resolveProxmoxTargetConfiguration,
  resolveProxmoxVmDiskGb,
  type ProxmoxInfrastructure,
  type ProxmoxHostRoutingConfig,
  type ProxmoxProvisionResult,
} from "@/lib/services/proxmox-instance-service";
import {
  guardProxmoxHostPlacementReadiness,
  reportCorrelatedProxmoxHostFailure,
  reportProxmoxHostRegistryUnavailable,
  reportProxmoxVmidRangeUtilization,
  type ProxmoxHostLocalFailureClass,
} from "@/lib/services/proxmox-host-guards";
import { stripProxmoxInfrastructure } from "@/lib/services/proxmox-infrastructure";
import { HIVRA_AGENT_VM_DISK_GB } from "@/lib/infrastructure/portable-provisioner-contract";
import { buildInstanceInsertPayload } from "@/lib/instance-record";
import {
  SLOT_FREEING_LIFECYCLE_STATES,
  SLOT_FREEING_LIFECYCLE_IN_LIST,
} from "@/lib/instance-lifecycle";
import { buildStoredInstanceConfig, extractGlobalHermesSettings, getAutoUpdateConfig } from "@/lib/instance-settings";
import { getPlan } from "@/lib/subscription";
import { isPaidTier, VENICE_BOOST_CPU, VENICE_BOOST_RAM_MB } from "@/lib/services/tier-boost";
import { isVeniceBoostEligible } from "@/lib/billing/venice-compute-boost";
import {
  resolveEffectiveSubscription,
  resolveWorkspaceCloudEntitlement,
} from "@/lib/billing/instance-entitlement";
import { normalizeModelValue } from "@/lib/models";
import { validateProviderKeyShape } from "@/lib/provider-key-shape";
import { reconcileModelForProvider } from "@/lib/services/provider-config";
import { validateProviderApiKey } from "@/lib/services/provider-validation";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import {
  SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES,
  freeResourceTierForStorage,
  isFreeResourceTier,
  isSingleInstanceBaseResourceTier,
} from "@/lib/resource-tiers";
import {
  markBankrSuiteSeeded,
  type InstanceBankrAgentConfig,
} from "@/lib/billing/bankr-instance-wallets";
import { createManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import {
  isManagedVeniceProxyBaseUrl,
  isRealVeniceByokKey,
  isVeniceProvider,
  stripManagedVeniceProxyBaseUrl,
} from "@/lib/venice/byok-classification";
import { agentWebApi, type AgentWebApiClient } from "@/lib/agent-web-api";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { extractHermesSessionToken } from "@/lib/hermes-web";
import { CURATED_SKILLS } from "@/data/curated-skills";

const LOG_SOURCE = "instance-service";
const LIVE_CREATE_VALIDATION_PROVIDERS = new Set(["gemini"]);

// box_created is the server-side activation event the signup→box→use→paid
// funnel is assembled from. Issue #353: it over-fired ~24x per instance and
// collapsed onto a handful of PostHog persons, making the funnel unusable.
// PostHog's $insert_id only collapses duplicates inside a short ingestion
// window, so the same instance.id re-emitting across retries / re-renders /
// re-calls (anything that re-reaches the emit for an already-created box)
// escaped the collapse. This process-lifetime guard makes the emit fire at
// most once per instance.id within a warm process — the realistic re-emit
// vector — and $insert_id continues to collapse the cross-process tail inside
// PostHog's window. The two together give effective exactly-once semantics
// without a schema migration.
const emittedBoxCreatedInstanceIds = new Set<string>();

/**
 * Emit the `box_created` activation event exactly once per instance.id.
 *
 * Idempotent: a second call for the same instanceId is a no-op (returns false),
 * so retries / React re-renders / duplicate POSTs that re-reach this path do not
 * re-emit. `distinctId` is the Clerk user id — the SAME identifier the client
 * uses for `identifyUserClient(user.id, …)` — so the server event merges onto the
 * real signed-in user's PostHog person instead of scattering across anonymous
 * ids. `$set_once` reinforces that merge; `$insert_id` collapses any
 * cross-process duplicates inside PostHog's ingestion window.
 *
 * Best-effort by contract: a telemetry hiccup must never fail instance creation,
 * so all errors are swallowed (logged) by the caller.
 *
 * @returns true if this call emitted the event, false if it was deduped.
 */
function captureBoxCreatedOnce(args: {
  instanceId: string;
  userId: string;
  properties: Record<string, unknown>;
}): boolean {
  const { instanceId, userId, properties } = args;
  if (emittedBoxCreatedInstanceIds.has(instanceId)) {
    return false;
  }
  // Claim before capture so a concurrent/duplicate call in the same process
  // can never slip a second emit through between the check and the capture.
  emittedBoxCreatedInstanceIds.add(instanceId);
  posthogClient.capture({
    distinctId: userId,
    event: "box_created",
    properties: {
      ...properties,
      instance_id: instanceId,
      // Stable dedup key PostHog reads from properties; collapses duplicates
      // that arrive from other processes inside the ingestion window.
      $insert_id: `box_created_${instanceId}`,
      // Reinforce the server→client person merge so this activation event
      // attributes to the real signed-in user rather than a fresh person.
      $set_once: { hermes_user_id: userId },
    },
  });
  return true;
}

function readClerkStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
}

function resolveClerkUserEmail(user: unknown): string | null {
  if (!user || typeof user !== "object") return null;
  const record = user as Record<string, unknown>;
  const primaryEmailAddress = record.primaryEmailAddress;
  const directPrimary = readClerkStringField(primaryEmailAddress, "emailAddress");
  if (directPrimary) return directPrimary;

  const primaryEmailAddressId = readClerkStringField(record, "primaryEmailAddressId");
  const emailAddresses = Array.isArray(record.emailAddresses)
    ? record.emailAddresses
    : [];

  if (primaryEmailAddressId) {
    for (const emailAddress of emailAddresses) {
      if (
        readClerkStringField(emailAddress, "id") === primaryEmailAddressId &&
        readClerkStringField(emailAddress, "emailAddress")
      ) {
        return readClerkStringField(emailAddress, "emailAddress");
      }
    }
  }

  for (const emailAddress of emailAddresses) {
    const email = readClerkStringField(emailAddress, "emailAddress");
    if (email) return email;
  }

  return null;
}

function buildSignedAgentHeaders(params: {
  apiServerKey: string;
  body?: string;
  extraHeaders?: Record<string, string>;
  sessionToken?: string;
}) {
  const timestamp = Date.now().toString();
  const signedPayload = params.body ? `${timestamp}.${params.body}` : timestamp;
  const signature = createHmac("sha256", params.apiServerKey)
    .update(signedPayload)
    .digest("hex");

  return {
    Accept: "application/json",
    Connection: "close",
    ...(params.sessionToken ? { Authorization: `Bearer ${params.sessionToken}` } : {}),
    ...(params.extraHeaders || {}),
    "X-Hermes-Timestamp": timestamp,
    "X-Hermes-Signature": signature,
  };
}

async function fetchProvisionSessionToken(params: {
  baseUrl: string;
  apiServerKey: string;
  instanceIpv4?: string | null;
}) {
  const htmlHeaders = buildSignedAgentHeaders({
    apiServerKey: params.apiServerKey,
    extraHeaders: { Accept: "text/html" },
  });
  const { response: htmlResponse } = await fetchFirstReachableGatewayResponse({
    baseUrl: params.baseUrl,
    pathname: "/",
    instanceIpv4: params.instanceIpv4 || undefined,
    method: "GET",
    headers: htmlHeaders,
    timeoutMs: 15_000,
  });

  if (htmlResponse.ok) {
    const token = extractHermesSessionToken(await htmlResponse.text());
    if (token) return token;
  }

  const { response: jsonResponse } = await fetchFirstReachableGatewayResponse({
    baseUrl: params.baseUrl,
    pathname: "/api/auth/session-token",
    instanceIpv4: params.instanceIpv4 || undefined,
    method: "GET",
    headers: buildSignedAgentHeaders({
      apiServerKey: params.apiServerKey,
      extraHeaders: { Accept: "application/json" },
    }),
    timeoutMs: 15_000,
  });

  if (!jsonResponse.ok) {
    throw new Error(`Agent session token request returned ${jsonResponse.status}`);
  }

  const payload = (await jsonResponse.json().catch(() => null)) as { token?: string } | null;
  if (!payload?.token?.trim()) {
    throw new Error("Agent session token not found");
  }

  return payload.token.trim();
}

async function buildProvisionAgentApiClient(params: {
  gatewayUrl: string;
  apiServerKey: string;
  instanceIpv4?: string | null;
}): Promise<AgentWebApiClient> {
  const baseUrl = `${params.gatewayUrl.replace(/\/$/, "")}/web-api`;
  const sessionToken = await fetchProvisionSessionToken({
    baseUrl,
    apiServerKey: params.apiServerKey,
    instanceIpv4: params.instanceIpv4,
  });

  return {
    baseUrl,
    async get() {
      throw new Error("GET is not implemented for the provisioning agent API client");
    },
    async put() {
      throw new Error("PUT is not implemented for the provisioning agent API client");
    },
    async del() {
      throw new Error("DELETE is not implemented for the provisioning agent API client");
    },
    async post(path: string, body?: unknown, options?: { timeout?: number }) {
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const { response } = await fetchFirstReachableGatewayResponse({
        baseUrl,
        pathname: path,
        instanceIpv4: params.instanceIpv4 || undefined,
        method: "POST",
        headers: buildSignedAgentHeaders({
          apiServerKey: params.apiServerKey,
          body: payload,
          sessionToken,
          extraHeaders: { "Content-Type": "application/json" },
        }),
        body: payload,
        timeoutMs: options?.timeout ?? 15_000,
      });
      return response;
    },
  };
}

export async function preinstallBankrSuiteForInstance(params: {
  instanceId: string;
  userId: string;
  api?: AgentWebApiClient;
  gatewayUrl?: string;
  apiServerKey?: string;
  instanceIpv4?: string | null;
}) {
  const bankrSkills = CURATED_SKILLS.filter(
    (skill) => skill.category === "bankr" && typeof skill.content === "string" && skill.content.trim()
  );

  try {
    if (bankrSkills.length === 0) {
      throw new Error("No vendored Bankr skills found");
    }

    const api = params.api ?? (
      params.gatewayUrl && params.apiServerKey
        ? await buildProvisionAgentApiClient({
            gatewayUrl: params.gatewayUrl,
            apiServerKey: params.apiServerKey,
            instanceIpv4: params.instanceIpv4,
          })
        : await agentWebApi(params.instanceId, params.userId)
    );

    for (const skill of bankrSkills) {
      const skillName = skill.identifier.split("/").pop() || skill.id;
      const response = await api.post(
        "/api/skills/save",
        {
          name: skillName,
          category: "bankr",
          content: skill.content,
        },
        { timeout: 15_000 }
      );
      if (!response.ok) {
        throw new Error(`Bankr skill "${skillName}" save returned ${response.status}`);
      }
      await response.text().catch(() => "");
    }

    await markBankrSuiteSeeded({
      instanceId: params.instanceId,
      seeded: true,
    });

    return {
      seeded: true,
      count: bankrSkills.length,
    };
  } catch (err) {
    await markBankrSuiteSeeded({
      instanceId: params.instanceId,
      seeded: false,
      error: err,
    }).catch(() => {});
    throw err;
  }
}

function envListIncludes(value: string | undefined, expected: string): boolean {
  if (!value?.trim()) return false;
  const normalizedExpected = expected.trim().toLowerCase();

  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalizedExpected);
}

function optionalPositiveEnvInt(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeProxmoxCapacityScopeId(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || null;
}

function resolveDefaultProxmoxHostConfig(env: NodeJS.ProcessEnv = process.env): ProxmoxHostRoutingConfig | null {
  const hostId = env.HERMES_PROXMOX_DEFAULT_HOST_ID?.trim() || null;
  const hostSlug = env.HERMES_PROXMOX_DEFAULT_HOST_SLUG?.trim() || null;
  const envPrefix = env.HERMES_PROXMOX_DEFAULT_ENV_PREFIX?.trim() || null;

  if (!hostId && !hostSlug && !envPrefix) return null;

  return {
    hostId,
    hostSlug,
    envPrefix,
    failClosed: true,
  };
}

type ResolvedInstanceHost = {
  id: string;
  name?: string | null;
  hetzner_server_id?: number | null;
  total_cpu: number;
  total_ram: number;
  infrastructure_provider?: string | null;
  proxmox_host_slug?: string | null;
  proxmox_env_prefix?: string | null;
  host_slug?: string | null;
  env_prefix?: string | null;
  slug?: string | null;
};

type ProxmoxProvisionTargetCandidate = {
  targetId: string | null;
  env: NodeJS.ProcessEnv;
  diskSizeGb: number;
  // Populated when the candidate came from the proxmox_hosts registry;
  // null when we fell through to the legacy env-order path because the
  // table is empty.
  maxTenantInstancesOverride?: number | null;
  // Set on legacy env-order candidates: no registry row vouches for this host,
  // so an inconclusive readiness probe must fail CLOSED rather than open. See
  // `guardProxmoxHostPlacementReadiness`.
  requireConclusiveReadiness?: boolean;
};

// buildProxmoxProvisionTargetCandidates must be able to say "refuse to place"
// distinctly from "no candidate passed the filters" — an unreadable registry is
// a hard stop, not an empty candidate list to fail over through.
type ProxmoxProvisionTargetCandidateSet =
  | { ok: true; candidates: ProxmoxProvisionTargetCandidate[] }
  | {
      ok: false;
      status: number;
      message: string;
      error: Record<string, unknown>;
    };

type ProxmoxProvisionTargetSelection =
  | {
      ok: true;
      targetId: string | null;
      env: NodeJS.ProcessEnv;
      diskSizeGb: number;
    }
  | {
      ok: false;
      status: number;
      message: string;
      error?: Record<string, unknown>;
    };

type ProxmoxProvisionTargetReadinessCheck = (candidate: {
  targetId: string | null;
  env: NodeJS.ProcessEnv;
}) => Promise<
  | { ok: true }
  | {
      ok: false;
      status?: number;
      message: string;
      error?: Record<string, unknown>;
    }
>;

function isProxmoxVmidExhaustionResult(
  result: ProxmoxProvisionResult
): result is Extract<ProxmoxProvisionResult, { ok: false }> & {
  failureType: "proxmox_vmid_range_exhausted";
} {
  return !result.ok && result.failureType === "proxmox_vmid_range_exhausted";
}

// User-facing message for "no Proxmox host can take a new VM right now".
// Shared by the pre-flight selection gate, the tenant-capacity error, and the
// post-provision VMID-exhaustion surface so users always see this friendly
// pause message instead of the raw allocator error ("No free Proxmox VMID in
// range X-Y") — which read like a crash in the welcome flow (prod PostHog,
// 2026-06, the bulk of activation_failed events).
export const PROXMOX_CAPACITY_PAUSED_MESSAGE =
  "Temporary Proxmox capacity reached. New agents are paused until more capacity is available.";

// Upper bound on provision→re-place hops after a target's VMID range turns
// out exhausted at provision time (pre-flight passed but the script-time
// picker found nothing, e.g. a concurrent-provision race). Re-selection
// already excludes every previously exhausted target, so this cap only bites
// when result/candidate target ids fail to line up — it exists to make the
// failover loop provably finite.
const MAX_PROXMOX_VMID_EXHAUSTION_FAILOVERS = 3;

// Client-facing stand-in for any host-local provision failure. The raw host
// script stderr (cert paths, bridge names, qm output) stays in server logs
// only — see PROVISION_HOST_FAILURE_TYPE consumers in createInstance.
const PROVISION_HOST_FAILURE_TYPE = "provision_host_failure";
export const PROVISION_HOST_FAILURE_MESSAGE =
  "Our capacity system hit a snag provisioning your agent — we've been alerted. Please try again in a few minutes.";

// Canonical home is proxmox-host-guards (the correlated-failure guard keys off
// it); re-exported here so existing importers keep their import site.
export type { ProxmoxHostLocalFailureClass };

// Allowlist of host-local provision failure signatures, matched against the
// redacted host-script output that provisionProxmoxInstance surfaces as
// `error`. Host-local means the HOST is misconfigured/unhealthy — not the
// user's request — so placement should fail over to another host. Anything
// unmatched is treated as non-retryable so user-input failures (bad API key,
// entitlement, oversized settings) never burn placement failovers.
const PROXMOX_HOST_LOCAL_FAILURE_PATTERNS: Array<{
  failureClass: ProxmoxHostLocalFailureClass;
  pattern: RegExp;
}> = [
  // fixturenodea incident 2026-06-09: a never-seeded host registered status='active'
  // with 0 tenants won every free-capacity placement, every provision died
  // ~100s in at this cert gate, and onboarding was black-holed for ~19h.
  { failureClass: "host_cert_seed_missing", pattern: /missing cloudflare origin ca cert\/key/i },
  // Phase-1 bridge preflight ("host X is missing private bridge vmbr1") plus
  // the raw `qm start` error when the preflight is bypassed.
  { failureClass: "host_bridge_missing", pattern: /missing private bridge|bridge 'vmbr\d+' does not exist/i },
  // `qm clone`/template failures: linked-clone refusal, missing template
  // config ("Configuration file ... does not exist").
  { failureClass: "host_template_clone_failed", pattern: /clone failed|unable to clone|configuration file '[^']*' does not exist/i },
  { failureClass: "host_caddy_invalid", pattern: /invalid caddyfile/i },
  { failureClass: "host_provision_lock_timeout", pattern: /timed out waiting for hermes-proxmox provision lock/i },
  // ssh2 transport failures from runProxmoxHostScript — the host itself is
  // unreachable from the orchestrator.
  { failureClass: "host_unreachable", pattern: /ssh connection failed|ssh exec failed|ssh connect threw|proxmox ssh operation timed out/i },
  // Opaque non-zero exit with empty stderr. Phase 1 scripts are entirely
  // platform-authored (user payloads only run in detached Phase 2), so an
  // unexplained exit is host-side, not user input.
  { failureClass: "host_script_failure", pattern: /remote bash exited with code/i },
];

export function classifyProxmoxHostLocalProvisionFailure(
  errorMessage: string
): ProxmoxHostLocalFailureClass | null {
  for (const { failureClass, pattern } of PROXMOX_HOST_LOCAL_FAILURE_PATTERNS) {
    if (pattern.test(errorMessage)) return failureClass;
  }
  return null;
}

// Cap placement failovers per createInstance call: the Vercel function budget
// (300s) realistically fits the original attempt plus two ~100s host-local
// failures before the lambda is at risk of dying mid-provision.
const MAX_PROXMOX_HOST_LOCAL_FAILOVERS = 2;

type ProxmoxHostRegistryRow = {
  id: string;
  // Selected, not filtered on. The registry is read whole and partitioned in
  // memory so the ids of the hosts an operator DRAINED are in scope — see
  // loadProxmoxHostRegistry.
  status: string;
  env_prefix: string | null;
  total_cpu: number;
  total_ram_mb: number;
  reserved_cpu: number;
  reserved_ram_mb: number;
  wake_headroom_ram_mb: number;
  max_tenant_instances: number | null;
  thinpool_size_gb: number | null;
  thinpool_overcommit_ratio: number | null;
};

// The one `proxmox_hosts.status` value that means "in rotation". Everything
// else (`maintenance`, `draining`, …) is a host an operator deliberately
// pulled, and must never win placement — on either the registry path or the
// legacy env-order fallback.
const PROXMOX_HOST_STATUS_ACTIVE = "active";

// Lifecycle states that consume host RAM/CPU right now. Stopped (paused/
// suspended), pending-but-not-yet-provisioned, deleting, deleted, and
// failed rows do not — that's what enables aggressive packing once the
// inactivity-shutdown cron lands.
const PROXMOX_HOST_ALLOCATION_STATES = ["provisioning", "active"] as const;
const DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO = 5;

function resolveProxmoxCpuOvercommitRatio(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  const raw = env.HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO?.trim();
  if (!raw) return DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO;

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 1
    ? parsed
    : DEFAULT_PROXMOX_CPU_OVERCOMMIT_RATIO;
}

/**
 * What the registry read actually told us. The distinction between `empty` and
 * `query_failed` is the whole point of this type:
 *
 *   - `loaded`       at least one active host; use the registry path.
 *   - `empty`        the query SUCCEEDED and the registry has no active hosts.
 *                    `registryHasAnyRows` then says whether that means "not yet
 *                    adopted" (legacy fallback is legitimate) or "every host
 *                    deliberately drained" (fallback is refused).
 *   - `query_failed` the query FAILED. We know nothing. Falling back here
 *                    would route onto hosts an operator drained, or onto the
 *                    12 decommissioned hosts still named in
 *                    HERMES_PROXMOX_TARGETS whose IPs Hetzner recycled.
 *
 * Until 2026-07 all three collapsed into `registryHasAnyRows: false`, so a
 * failed query was indistinguishable from an unadopted registry and placement
 * fell through silently. Prod `ops_events` recorded 71 such failures across
 * 2026-05-10..14 — 70 of them a code/DB schema skew
 * (`column proxmox_hosts.thinpool_size_gb does not exist`), i.e. a plain
 * deploy-ordering mistake, not an outage. It was harmless only because the
 * registry had no rows yet. It would not be harmless today.
 */
type ProxmoxHostRegistryLoadOutcome = "loaded" | "empty" | "query_failed";

type ProxmoxHostRegistrySnapshot = {
  // Rows with `status = 'active'`. The only hosts the registry path may rank.
  active: ProxmoxHostRegistryRow[];
  // Normalized ids of every row that is NOT active — the hosts an operator
  // drained. Reading the registry whole (rather than filtering `status` in the
  // query) is what puts these in scope: the legacy env-order fallback can only
  // refuse to place onto a drained host if it knows which hosts those are.
  // HERMES_PROXMOX_TARGETS still names fixturenodea and fixturenodea, both `maintenance` since
  // 2026-07-04, and either is healthy enough to pass the readiness probe.
  nonActiveHostIds: string[];
  // True when proxmox_hosts has at least one row (active or not). Only
  // meaningful when `outcome === "empty"`. Used by the caller to distinguish
  // "registry not yet seeded" (env-order fallback is safe) from "all hosts
  // deliberately marked draining/maintenance" (env-order fallback would route
  // onto the hosts the operator just took out of rotation — gotcha #4 in
  // reference_proxmox_vm_migration.md).
  registryHasAnyRows: boolean;
  outcome: ProxmoxHostRegistryLoadOutcome;
  // Driver error text, only when `outcome === "query_failed"`.
  failureDetail?: string;
};

// One retry. The registry read is a single indexed select against a ten-row
// table, so a second attempt is genuinely cheap and rescues the transient
// class (socket reset, PostgREST schema-cache reload mid-deploy). It cannot
// rescue the sticky class (schema skew) — which is exactly the class that must
// halt provisioning rather than fall through.
const PROXMOX_REGISTRY_QUERY_ATTEMPTS = 2;

type RegistryQueryResult<T> = {
  data: T | null;
  error: { message: string } | null;
};

/**
 * `run` must build a FRESH query per attempt — Supabase query builders are
 * one-shot thenables and cannot be awaited twice.
 */
async function runProxmoxRegistryQueryWithRetry<T>(
  run: () => PromiseLike<RegistryQueryResult<T>>
): Promise<
  | { ok: true; data: T | null }
  | { ok: false; detail: string; attempts: number }
> {
  let detail = "unknown proxmox_hosts registry query failure";

  for (let attempt = 1; attempt <= PROXMOX_REGISTRY_QUERY_ATTEMPTS; attempt++) {
    try {
      const result = await run();
      if (result && !result.error) {
        return { ok: true, data: result.data ?? null };
      }
      detail = result?.error?.message ?? detail;
    } catch (err) {
      // A throw (db disconnect, schema not applied) is the same signal as an
      // `error` field: we could not read the registry.
      detail = err instanceof Error ? err.message : String(err);
    }
  }

  return { ok: false, detail, attempts: PROXMOX_REGISTRY_QUERY_ATTEMPTS };
}

/**
 * Read `proxmox_hosts` WHOLE and partition it in memory.
 *
 * Until 2026-07 this filtered `.eq("status", "active")` in the query, which cost
 * two round trips and — worse — put the drained hosts permanently out of scope:
 *   - a second `head`-only count probe was needed just to tell "registry not yet
 *     adopted" from "every host drained", adding a failure stage of its own; and
 *   - the ids of the non-active hosts, the exact thing the legacy env-order
 *     fallback must refuse to place onto, were never fetched.
 *
 * The table holds ten rows. Fetching all of them is free, collapses the two
 * queries into one, and hands the caller the drained ids it needs.
 */
async function loadProxmoxHostRegistry(
  supabase: NonNullable<typeof supabaseAdmin>
): Promise<ProxmoxHostRegistrySnapshot> {
  const registryResult = await runProxmoxRegistryQueryWithRetry<ProxmoxHostRegistryRow[]>(() =>
    supabase
      .from("proxmox_hosts")
      .select(
        "id, status, env_prefix, total_cpu, total_ram_mb, reserved_cpu, reserved_ram_mb, wake_headroom_ram_mb, max_tenant_instances, thinpool_size_gb, thinpool_overcommit_ratio"
      )
  );

  if (!registryResult.ok) {
    log.error(
      "failed to load proxmox_hosts registry",
      new Error(registryResult.detail),
      {
        source: LOG_SOURCE,
        failureType: "proxmox_hosts_registry_query_failed",
        attempts: registryResult.attempts,
        // The caller raises a single deduped FATAL. The generic error mirror
        // fingerprints on the driver's error text AND the user id, so it can
        // never fold an incident into one page — in 2026-05 it produced two
        // rows across 71 occurrences and paged nobody.
        reportOpsEvent: false,
      }
    );
    return {
      active: [],
      nonActiveHostIds: [],
      registryHasAnyRows: false,
      outcome: "query_failed",
      failureDetail: registryResult.detail,
    };
  }

  const rows = (registryResult.data ?? []) as ProxmoxHostRegistryRow[];
  const active = rows.filter((row) => row.status === PROXMOX_HOST_STATUS_ACTIVE);
  const nonActiveHostIds = rows
    .filter((row) => row.status !== PROXMOX_HOST_STATUS_ACTIVE)
    .map((row) => normalizeProxmoxCapacityScopeId(row.id))
    .filter((id): id is string => Boolean(id));

  if (active.length > 0) {
    return { active, nonActiveHostIds, registryHasAnyRows: true, outcome: "loaded" };
  }

  const registryHasAnyRows = rows.length > 0;
  log.warn("proxmox_hosts registry returned no active hosts", {
    source: LOG_SOURCE,
    failureType: "proxmox_hosts_registry_empty",
    registryHasAnyRows,
    totalRowCount: rows.length,
  });
  return { active: [], nonActiveHostIds, registryHasAnyRows, outcome: "empty" };
}

type RankedProxmoxHost = {
  host: ProxmoxHostRegistryRow;
  freeCpu: number;
  freeRamMb: number;
  freeDiskGb: number | null;
  diskSizeGb: number;
};

async function rankProxmoxHostsForPlacement(params: {
  supabase: NonNullable<typeof supabaseAdmin>;
  env: NodeJS.ProcessEnv;
  hosts: ProxmoxHostRegistryRow[];
  neededCpu: number;
  neededRamMb: number;
  neededDiskGb: number;
}): Promise<RankedProxmoxHost[]> {
  const hostIds = params.hosts.map((h) => h.id);
  if (hostIds.length === 0) return [];

  const { data: rows, error } = await params.supabase
    .from("hermes_instances")
    .select("proxmox_node, cpu_limit, ram_limit, disk_size_gb, lifecycle_state")
    .in("proxmox_node", hostIds)
    .in("lifecycle_state", Array.from(PROXMOX_HOST_ALLOCATION_STATES));
  const { data: hivraRows, error: hivraError } = await params.supabase
    .from("hivra_agents")
    .select("proxmox_host, cpu, ram, status")
    .in("proxmox_host", hostIds)
    .in("status", ["provisioning", "running"]);

  if (error || hivraError) {
    const allocationError = error ?? hivraError;
    log.error(
      "failed to compute proxmox host allocations",
      new Error(allocationError?.message ?? "unknown allocation query error"),
      {
        source: LOG_SOURCE,
        failureType: "proxmox_host_allocation_query_failed",
        hostIds,
        legacyError: error?.message ?? null,
        hivraError: hivraError?.message ?? null,
      }
    );
    return [];
  }

  const allocByHost = new Map<string, { cpu: number; ram: number; disk: number }>();
  for (const row of rows ?? []) {
    const node = (row as { proxmox_node?: string | null }).proxmox_node;
    if (!node) continue;
    const acc = allocByHost.get(node) ?? { cpu: 0, ram: 0, disk: 0 };
    acc.cpu += Number((row as { cpu_limit?: number | null }).cpu_limit ?? 0);
    acc.ram += Number((row as { ram_limit?: number | null }).ram_limit ?? 0);
    // disk_size_gb can be NULL on legacy rows that were inserted before
    // we tracked per-instance disk. Fall back to the template default so
    // those rows still count toward the host's thin-pool budget — the
    // VMs really are consuming that disk, the column was just not yet
    // populated. Better to slightly over-account than ignore them.
    const diskRaw = (row as { disk_size_gb?: number | null }).disk_size_gb;
    acc.disk += Number.isFinite(diskRaw) && diskRaw !== null
      ? Number(diskRaw)
      : DEFAULT_PROXMOX_VM_DISK_GB;
    allocByHost.set(node, acc);
  }
  for (const row of hivraRows ?? []) {
    const node = (row as { proxmox_host?: string | null }).proxmox_host;
    if (!node) continue;
    const acc = allocByHost.get(node) ?? { cpu: 0, ram: 0, disk: 0 };
    acc.cpu += Number((row as { cpu?: number | null }).cpu ?? 0);
    acc.ram += Number((row as { ram?: number | null }).ram ?? 0) * 1024;
    acc.disk += HIVRA_AGENT_VM_DISK_GB;
    allocByHost.set(node, acc);
  }

  const cpuOvercommitRatio = resolveProxmoxCpuOvercommitRatio(params.env);
  const ranked: RankedProxmoxHost[] = [];
  const placementDiagnostics: Array<Record<string, unknown>> = [];
  for (const host of params.hosts) {
    const target = resolveProxmoxTargetConfiguration(params.env, host.id);
    const diskSizeGb = Math.max(
      params.neededDiskGb,
      resolveProxmoxVmDiskGb(target.env)
    );
    const alloc = allocByHost.get(host.id) ?? { cpu: 0, ram: 0, disk: 0 };
    const cpuBudget = (host.total_cpu - host.reserved_cpu) * cpuOvercommitRatio;
    const freeCpu = cpuBudget - alloc.cpu;
    const freeRamMb =
      host.total_ram_mb -
      host.reserved_ram_mb -
      host.wake_headroom_ram_mb -
      alloc.ram;
    // Disk filter is opt-in per host: skip it when thinpool_size_gb is
    // NULL (unmeasured host — better to let placement proceed than to
    // block the host entirely). Hosts with a known thinpool size are
    // gated on (thinpool_size_gb * overcommit) − sum(disk_size_gb).
    const thinpoolSizeGb = host.thinpool_size_gb;
    const overcommitRatio = host.thinpool_overcommit_ratio ?? 1.5;
    const diskBudgetGb =
      thinpoolSizeGb !== null && thinpoolSizeGb !== undefined
        ? thinpoolSizeGb * overcommitRatio
        : null;
    const freeDiskGb = diskBudgetGb !== null ? diskBudgetGb - alloc.disk : null;

    placementDiagnostics.push({
      hostId: host.id,
      cpuOvercommitRatio,
      cpuBudget,
      allocatedCpu: alloc.cpu,
      freeCpu,
      neededCpu: params.neededCpu,
      allocatedRamMb: alloc.ram,
      freeRamMb,
      neededRamMb: params.neededRamMb,
      totalCpu: host.total_cpu,
      reservedCpu: host.reserved_cpu,
      totalRamMb: host.total_ram_mb,
      reservedRamMb: host.reserved_ram_mb,
      wakeHeadroomRamMb: host.wake_headroom_ram_mb,
      thinpoolSizeGb,
      thinpoolOvercommitRatio: overcommitRatio,
      diskBudgetGb,
      allocatedDiskGb: alloc.disk,
      freeDiskGb,
      neededDiskGb: diskSizeGb,
    });

    if (freeCpu < params.neededCpu) continue;
    if (freeRamMb < params.neededRamMb) continue;
    if (freeDiskGb !== null && freeDiskGb < diskSizeGb) continue;

    ranked.push({ host, freeCpu, freeRamMb, freeDiskGb, diskSizeGb });
  }

  if (ranked.length === 0) {
    log.warn("no Proxmox host has enough placement capacity", {
      source: LOG_SOURCE,
      failureType: "proxmox_no_placement_target",
      hostCount: params.hosts.length,
      neededCpu: params.neededCpu,
      neededRamMb: params.neededRamMb,
      neededDiskGb: params.neededDiskGb,
      cpuOvercommitRatio,
      placementDiagnostics,
    });
  }

  // Worst-fit on the bottleneck resource: the host with the most free
  // RAM wins. RAM is the scarce resource on Hermes hosts (CPU is
  // fractional and bursts are short, so CPU gets an overcommit budget).
  // Tie-break on free disk so two hosts with identical RAM but
  // different thin-pool headroom prefer the disk-emptier one; then on
  // free CPU so a host that's RAM-and-disk-equal but CPU-fuller drops
  // behind. freeDiskGb=null (unmeasured) sorts as +Infinity so
  // measured-but-tight hosts lose to unmeasured ones only when RAM ties
  // — which matches the safe default (we'd rather pack a measured host
  // we know fits than guess at an unmeasured one).
  ranked.sort((a, b) => {
    if (b.freeRamMb !== a.freeRamMb) return b.freeRamMb - a.freeRamMb;
    const aDisk = a.freeDiskGb ?? Number.POSITIVE_INFINITY;
    const bDisk = b.freeDiskGb ?? Number.POSITIVE_INFINITY;
    if (bDisk !== aDisk) return bDisk - aDisk;
    return b.freeCpu - a.freeCpu;
  });

  return ranked;
}

/**
 * Declared rotation: the ONLY host ids the legacy env-order fallback may ever
 * pick from. `resolveProxmoxTargetCandidateIds` already prefers this list, but
 * it silently degrades to the singular target and then to an id-less ambient
 * pick. Recomputing the allowlist here makes the invariant explicit and keeps
 * it true if that resolver's precedence ever changes again (it changed once
 * already, on 2026-05-12).
 */
function resolveDeclaredProxmoxTargetIdSet(env: NodeJS.ProcessEnv): Set<string> {
  const declared =
    env.HERMES_PROXMOX_TARGETS?.trim() || env.PROXMOX_TARGETS?.trim() || "";
  return new Set(
    declared
      .split(/[,\s]+/)
      .map((id) => normalizeProxmoxCapacityScopeId(id))
      .filter((id): id is string => Boolean(id))
  );
}

/**
 * Build candidates for the legacy env-order path.
 *
 * Three rules, and none existed before 2026-07:
 *
 *  1. When the operator has DECLARED a rotation (HERMES_PROXMOX_TARGETS /
 *     PROXMOX_TARGETS — prod and canary both do), the fallback may pick only
 *     from that list. If nothing resolves out of it we return zero candidates
 *     rather than degrade to the singular target or to the id-less ambient
 *     pick, both of which name a host nobody declared.
 *
 *     A deployment that declares no rotation at all is a single-host install:
 *     the ambient config IS the whole fleet, so picking it is not an unvetted
 *     choice between hosts.
 *
 *  2. A host the registry says is NOT active is never a candidate, whatever the
 *     env list says. `drainedTargetIds` carries those ids. This is the rule the
 *     probe cannot supply: fixturenodea and fixturenodea are `maintenance` since 2026-07-04 and
 *     both answer ssh, so a readiness probe passes them happily. Only the
 *     registry knows an operator pulled them.
 *
 *  3. Candidates drawn from a DECLARED rotation are flagged
 *     `requireConclusiveReadiness`. Production placement now requires the same
 *     conclusive pass for registry and single-host candidates too: a temporary
 *     503 is safer than routing a customer to an unverified gateway host.
 *
 * Rules 2 and 3 are complementary, and neither subsumes the other: rule 2 drops
 * hosts the registry KNOWS are out of rotation; rule 3 drops hosts the registry
 * has never heard of and that cannot prove they are alive.
 */
function buildLegacyEnvOrderFallbackCandidates(params: {
  env: NodeJS.ProcessEnv;
  reason: string;
  neededCpu: number;
  neededRamMb: number;
  neededDiskGb: number;
  // Normalized ids of registry rows whose status is not 'active'.
  drainedTargetIds?: readonly string[];
}): ProxmoxProvisionTargetCandidate[] {
  const declaredTargetIds = resolveDeclaredProxmoxTargetIdSet(params.env);
  const drainedTargetIds = new Set(params.drainedTargetIds ?? []);
  const resolvedTargetIds = resolveProxmoxTargetCandidateIds(params.env);

  const isDrained = (targetId: string) =>
    drainedTargetIds.has(normalizeProxmoxCapacityScopeId(targetId) ?? "");

  const drainedEnvTargetIds = resolvedTargetIds.filter(isDrained);
  const targetIds = resolvedTargetIds.filter(
    (targetId) =>
      !isDrained(targetId) &&
      (declaredTargetIds.size === 0 ||
        declaredTargetIds.has(normalizeProxmoxCapacityScopeId(targetId) ?? ""))
  );

  log.warn("proxmox placement falling back to env-order path", {
    source: LOG_SOURCE,
    failureType: "proxmox_placement_env_order_fallback",
    reason: params.reason,
    targetIds,
    declaredTargetIds: [...declaredTargetIds],
    drainedEnvTargetIds,
    neededCpu: params.neededCpu,
    neededRamMb: params.neededRamMb,
    neededDiskGb: params.neededDiskGb,
  });

  if (targetIds.length === 0) {
    if (declaredTargetIds.size > 0) {
      // A rotation is declared and none of it survived. Never reach past the
      // declared list for a host — the caller surfaces PROXMOX_NO_PLACEMENT_TARGET.
      log.error(
        "proxmox placement: declared env-order rotation resolved to no targets",
        new Error("declared Proxmox target list resolved empty"),
        {
          source: LOG_SOURCE,
          failureType: "proxmox_placement_declared_targets_unresolvable",
          reason: params.reason,
          declaredTargetIds: [...declaredTargetIds],
          // Non-empty means the rotation resolved fine and we dropped it on
          // purpose: every declared host is drained in the registry. That is a
          // stale HERMES_PROXMOX_TARGETS, not missing per-host env.
          drainedEnvTargetIds,
          recoveryAction: "fix_hermes_proxmox_targets_or_per_host_env",
        }
      );
      return [];
    }

    // Single-host install: no rotation declared anywhere in env. `drainedTargetIds`
    // is provably empty on this branch — the only caller that passes a non-empty
    // set (`registry_no_configured_targets`) requires a declared rotation, and the
    // other (`registry_empty`) reached the fallback precisely because the registry
    // holds zero rows. So the ambient target cannot be a drained host.
    const target = resolveProxmoxTargetConfiguration(params.env);
    return [
      {
        targetId: target.id,
        env: target.env as NodeJS.ProcessEnv,
        diskSizeGb: Math.max(params.neededDiskGb, resolveProxmoxVmDiskGb(target.env)),
      },
    ];
  }

  return targetIds.map((targetId) => {
    const target = resolveProxmoxTargetConfiguration(params.env, targetId);
    return {
      targetId: target.id,
      env: target.env as NodeJS.ProcessEnv,
      diskSizeGb: Math.max(params.neededDiskGb, resolveProxmoxVmDiskGb(target.env)),
      requireConclusiveReadiness: declaredTargetIds.size > 0,
    };
  });
}

async function buildProxmoxProvisionTargetCandidates(params: {
  supabase: NonNullable<typeof supabaseAdmin>;
  env: NodeJS.ProcessEnv;
  hostConfig: ProxmoxHostRoutingConfig | null;
  neededCpu: number;
  neededRamMb: number;
  neededDiskGb: number;
  forceTargetId?: string | null;
}): Promise<ProxmoxProvisionTargetCandidateSet> {
  // Forced single-host placement (Workspace Cloud lane). Resolve the host's
  // per-host env directly and return exactly one candidate, bypassing the
  // active-status registry filter so a deliberately non-'active' lane host
  // (e.g. wrk1 kept out of Hivra rotation) is still targetable. Capacity
  // and template-availability checks still run on this single candidate.
  if (params.forceTargetId) {
    const target = resolveProxmoxTargetConfiguration(params.env, params.forceTargetId);
    return {
      ok: true,
      candidates: [
        {
          targetId: target.id,
          env: target.env as NodeJS.ProcessEnv,
          diskSizeGb: Math.max(params.neededDiskGb, resolveProxmoxVmDiskGb(target.env)),
        },
      ],
    };
  }

  if (params.hostConfig) {
    return {
      ok: true,
      candidates: [
        {
          targetId: normalizeProxmoxCapacityScopeId(params.env.PROXMOX_NODE),
          env: params.env,
          diskSizeGb: Math.max(params.neededDiskGb, resolveProxmoxVmDiskGb(params.env)),
        },
      ],
    };
  }

  const {
    active: registry,
    nonActiveHostIds,
    registryHasAnyRows,
    outcome,
    failureDetail,
  } = await loadProxmoxHostRegistry(params.supabase);

  if (outcome === "query_failed") {
    // THE GATE. An unreadable registry is not evidence of an empty registry.
    // Falling through here is how a plain schema skew (2026-05-12/14, 70
    // occurrences) turns into "unvetted host wins placement": env order names
    // fixturenodea and fixturenodea, which ops drained on 2026-07-04, plus 12 hosts that no
    // longer exist. Halt instead, behind the same friendly capacity-pause
    // surface users already see, and page.
    log.error(
      "proxmox placement refusing env-order fallback after registry query failure",
      new Error(failureDetail ?? "proxmox_hosts registry unreadable"),
      {
        source: LOG_SOURCE,
        failureType: "proxmox_registry_unavailable_placement_halted",
        neededCpu: params.neededCpu,
        neededRamMb: params.neededRamMb,
        neededDiskGb: params.neededDiskGb,
        recoveryAction: "restore_proxmox_hosts_registry_query",
        // The deduped FATAL below is the page; this line is for correlation.
        reportOpsEvent: false,
      }
    );

    // Alerting can never break a provision — and here the provision is already
    // being refused, so a throw from ops_events must not mask the 503.
    try {
      await reportProxmoxHostRegistryUnavailable({
        detail: failureDetail ?? "proxmox_hosts registry unreadable",
        attempts: PROXMOX_REGISTRY_QUERY_ATTEMPTS,
      });
    } catch {
      // swallowed: reportOpsEvent is best-effort
    }

    return {
      ok: false,
      status: 503,
      message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
      error: {
        code: "PROXMOX_HOST_REGISTRY_UNAVAILABLE",
        recoveryAction: "restore_proxmox_hosts_registry_query",
      },
    };
  }

  if (registry.length > 0) {
    const configuredTargetIdSet = resolveDeclaredProxmoxTargetIdSet(params.env);
    const configuredTargetIds = [...configuredTargetIdSet];
    const registryForPlacement =
      configuredTargetIdSet.size > 0
        ? registry.filter((host) =>
            configuredTargetIdSet.has(normalizeProxmoxCapacityScopeId(host.id) ?? "")
          )
        : registry;

    if (configuredTargetIdSet.size > 0 && registryForPlacement.length === 0) {
      log.warn(
        "proxmox registry has no active hosts matching configured target list; falling back to explicit env targets",
        {
          source: LOG_SOURCE,
          failureType: "proxmox_registry_no_configured_targets",
          configuredTargetIds,
          registryHostIds: registry.map((host) => host.id),
          // The declared list names none of the ACTIVE hosts. It may well name a
          // drained one — fixturenodea/fixturenodea are `maintenance` and answer ssh, so the
          // readiness probe would wave either straight through. These ids are the
          // only reason it cannot.
          nonActiveRegistryHostIds: nonActiveHostIds,
        }
      );

      return {
        ok: true,
        candidates: buildLegacyEnvOrderFallbackCandidates({
          env: params.env,
          reason: "registry_no_configured_targets",
          neededCpu: params.neededCpu,
          neededRamMb: params.neededRamMb,
          neededDiskGb: params.neededDiskGb,
          drainedTargetIds: nonActiveHostIds,
        }),
      };
    }

    const ranked = await rankProxmoxHostsForPlacement({
      supabase: params.supabase,
      env: params.env,
      hosts: registryForPlacement,
      neededCpu: params.neededCpu,
      neededRamMb: params.neededRamMb,
      neededDiskGb: params.neededDiskGb,
    });

    log.info("proxmox placement using registry path", {
      source: LOG_SOURCE,
      registryHostCount: registryForPlacement.length,
      configuredTargetIds,
      rankedHostIds: ranked.map((r) => r.host.id),
      neededCpu: params.neededCpu,
      neededRamMb: params.neededRamMb,
      neededDiskGb: params.neededDiskGb,
    });

    return {
      ok: true,
      candidates: ranked.map(({ host, diskSizeGb }) => {
        const target = resolveProxmoxTargetConfiguration(params.env, host.id);
        return {
          targetId: target.id,
          env: target.env as NodeJS.ProcessEnv,
          diskSizeGb,
          maxTenantInstancesOverride: host.max_tenant_instances,
        };
      }),
    };
  }

  if (registryHasAnyRows) {
    // Registry is seeded but every host is non-active (draining /
    // maintenance). The env-order fallback below does NOT honor status,
    // so falling through would route placement onto the hosts the
    // operator just took out of rotation. Return zero candidates so the
    // caller surfaces PROXMOX_NO_PLACEMENT_TARGET.
    log.warn(
      "proxmox placement: registry seeded but no active hosts; refusing env-order fallback",
      {
        source: LOG_SOURCE,
        failureType: "proxmox_no_active_hosts",
        neededCpu: params.neededCpu,
        neededRamMb: params.neededRamMb,
        neededDiskGb: params.neededDiskGb,
      }
    );
    return { ok: true, candidates: [] };
  }

  // Fallback: the query SUCCEEDED and the registry is genuinely empty
  // (migration not yet applied or seed cleared). Preserves the legacy
  // env-order behavior so a missed migration step doesn't take provisioning
  // offline — but only over declared, conclusively-probed hosts. Zero rows means
  // zero drained ids; passed anyway so the invariant reads the same at both sites.
  return {
    ok: true,
    candidates: buildLegacyEnvOrderFallbackCandidates({
      env: params.env,
      reason: "registry_empty",
      neededCpu: params.neededCpu,
      neededRamMb: params.neededRamMb,
      neededDiskGb: params.neededDiskGb,
      drainedTargetIds: nonActiveHostIds,
    }),
  };
}

export async function selectAvailableProxmoxProvisionTarget(params: {
  supabase: typeof supabaseAdmin;
  env: NodeJS.ProcessEnv;
  hostConfig: ProxmoxHostRoutingConfig | null;
  userId: string;
  neededCpu: number;
  neededRamMb: number;
  neededDiskGb: number;
  forceTargetId?: string | null;
  excludeTargetIds?: string[];
  skipTemplateAvailabilityCheck?: boolean;
  readinessCheck?: ProxmoxProvisionTargetReadinessCheck;
}): Promise<ProxmoxProvisionTargetSelection> {
  if (!params.supabase) {
    return {
      ok: false,
      status: 500,
      message: "Database not configured",
    };
  }
  const candidateSet = await buildProxmoxProvisionTargetCandidates({
    supabase: params.supabase,
    env: params.env,
    hostConfig: params.hostConfig,
    neededCpu: params.neededCpu,
    neededRamMb: params.neededRamMb,
    neededDiskGb: params.neededDiskGb,
    forceTargetId: params.forceTargetId,
  });

  // Hard stop: the host registry could not be read, so no host is vetted.
  // Never fall through to per-candidate failover here — there is nothing safe
  // to fail over to.
  if (!candidateSet.ok) {
    return {
      ok: false,
      status: candidateSet.status,
      message: candidateSet.message,
      error: candidateSet.error,
    };
  }

  const candidates = candidateSet.candidates;
  const excludedTargetIds = new Set(
    (params.excludeTargetIds ?? [])
      .map((targetId) => normalizeProxmoxCapacityScopeId(targetId))
      .filter((targetId): targetId is string => Boolean(targetId))
  );
  let lastCapacityError:
    | { error: ProxmoxTenantCapacityError; targetId: string | null }
    | null = null;
  const unconfiguredTargetIds: string[] = [];
  let lastVmidExhaustion: {
    targetId: string | null;
    vmidStart: number;
    vmidEnd: number;
    occupiedCount: number;
    maxInstances: number;
  } | null = null;
  let lastUnavailable:
    | {
        status: number;
        message: string;
        error?: Record<string, unknown>;
      }
    | null = null;

  for (const candidate of candidates) {
    const normalizedCandidateTargetId = normalizeProxmoxCapacityScopeId(candidate.targetId);
    if (normalizedCandidateTargetId && excludedTargetIds.has(normalizedCandidateTargetId)) {
      log.warn("skipping excluded Proxmox provisioning target", {
        source: LOG_SOURCE,
        failureType: "proxmox_target_excluded_after_vmid_exhaustion",
        userId: params.userId,
        targetId: candidate.targetId,
      });
      continue;
    }

    if (!isProxmoxProvisioningConfigured(candidate.env)) {
      lastUnavailable = {
        status: 503,
        message: candidate.targetId
          ? `Proxmox deployment target "${candidate.targetId}" is not configured.`
          : "Proxmox deployment not configured",
      };
      if (candidate.targetId && !unconfiguredTargetIds.includes(candidate.targetId)) {
        unconfiguredTargetIds.push(candidate.targetId);
      }
      log.warn("skipping unconfigured Proxmox provisioning target", {
        source: LOG_SOURCE,
        failureType: "proxmox_target_not_configured",
        userId: params.userId,
        targetId: candidate.targetId,
      });
      continue;
    }

    try {
      await assertProxmoxTenantCapacityAvailable({
        supabase: params.supabase,
        env: candidate.env,
        hostConfig: params.hostConfig,
        targetId: candidate.targetId,
        maxInstancesOverride: candidate.maxTenantInstancesOverride ?? null,
      });
    } catch (err) {
      if (err instanceof ProxmoxTenantCapacityError) {
        lastCapacityError = { error: err, targetId: candidate.targetId };
        log.warn("skipping full Proxmox provisioning target", {
          source: LOG_SOURCE,
          failureType: "proxmox_target_capacity_reached",
          userId: params.userId,
          targetId: candidate.targetId,
          currentInstances: err.currentInstances,
          maxInstances: err.maxInstances,
        });
        continue;
      }

      return {
        ok: false,
        status: 500,
        message:
          err instanceof Error
            ? err.message
            : "Failed to verify Proxmox capacity",
      };
    }

    if (params.skipTemplateAvailabilityCheck) {
      log.info("skipping generic Proxmox template availability check", {
        source: LOG_SOURCE,
        failureType: "proxmox_template_availability_check_skipped",
        userId: params.userId,
        targetId: candidate.targetId,
        hostId: params.hostConfig?.hostId ?? null,
        reason: "specialized_provisioner_owns_template_readiness",
      });
    } else {
      const templateAvailability = await getProxmoxTemplateAvailability({
        env: candidate.env,
        hostConfig: params.hostConfig,
      });
      if (!templateAvailability.ok) {
        log.error(
          "failed to verify live Proxmox template availability",
          new Error(templateAvailability.error),
          {
            source: LOG_SOURCE,
            failureType: "proxmox_template_availability_check_failed",
            userId: params.userId,
            targetId: templateAvailability.targetId,
            hostId: params.hostConfig?.hostId ?? null,
            templateId: templateAvailability.templateId,
            reason: templateAvailability.reason,
            templateError: templateAvailability.error,
          }
        );
        lastUnavailable = {
          status: 503,
          message:
            "Deployment target is temporarily unavailable while the VM template is being prepared. Please try again shortly.",
          error: {
            code: "PROXMOX_TEMPLATE_UNAVAILABLE",
            templateId: templateAvailability.templateId,
            reason: templateAvailability.reason,
          },
        };
        continue;
      }
    }

    const vmidAvailability = await getProxmoxVmidAvailability({
      env: candidate.env,
      hostConfig: params.hostConfig,
    });
    if (!vmidAvailability.ok) {
      log.error(
        "failed to verify live Proxmox VMID availability",
        new Error(vmidAvailability.error),
        {
          source: LOG_SOURCE,
          failureType: "proxmox_vmid_availability_check_failed",
          userId: params.userId,
          targetId: vmidAvailability.targetId,
          hostId: params.hostConfig?.hostId ?? null,
          vmidStart: vmidAvailability.vmidStart,
          vmidEnd: vmidAvailability.vmidEnd,
        }
      );
      lastUnavailable = {
        status: 500,
        message: `Failed to verify Proxmox VMID capacity: ${vmidAvailability.error}`,
      };
      continue;
    }

    // GUARD 2: VMID-range utilization. Warns above 80% consumed and fires a
    // FATAL on exhaustion, so a filling range is visible long before it turns
    // into "No free Proxmox VMID in range 1300-1349" 500s (2026-06-08). No-op
    // (and zero DB traffic) while the host is below the warn ratio.
    await reportProxmoxVmidRangeUtilization({
      targetId: vmidAvailability.targetId,
      vmidStart: vmidAvailability.vmidStart,
      vmidEnd: vmidAvailability.vmidEnd,
      occupiedCount: vmidAvailability.occupiedVmids.length,
      freeCount: vmidAvailability.freeVmids.length,
      env: candidate.env,
      userId: params.userId,
    });

    if (vmidAvailability.freeVmids.length === 0) {
      const maxInstances = vmidAvailability.vmidEnd - vmidAvailability.vmidStart + 1;
      lastVmidExhaustion = {
        targetId: vmidAvailability.targetId,
        vmidStart: vmidAvailability.vmidStart,
        vmidEnd: vmidAvailability.vmidEnd,
        occupiedCount: vmidAvailability.occupiedVmids.length,
        maxInstances,
      };
      log.warn("skipping exhausted Proxmox VMID target", {
        source: LOG_SOURCE,
        failureType: "proxmox_vmid_range_exhausted",
        userId: params.userId,
        targetId: vmidAvailability.targetId,
        hostId: params.hostConfig?.hostId ?? null,
        vmidStart: vmidAvailability.vmidStart,
        vmidEnd: vmidAvailability.vmidEnd,
        occupiedCount: vmidAvailability.occupiedVmids.length,
        maxInstances,
      });
      continue;
    }

    // GUARD 1: host-registration preflight. A host stays out of placement until
    // it passes the same gates the Phase-1 provisioner hits ~100s in (Origin CA
    // cert/key, `caddy validate`, vmbr1). Registry `status='active'` alone is
    // not evidence a host was ever seeded — that assumption black-holed
    // onboarding for ~19h on 2026-06-09/10. An inconclusive probe now fails
    // closed for every candidate: the loop can try another host, while blind
    // placement can recreate a customer-facing gateway outage.
    const preflight = await guardProxmoxHostPlacementReadiness({
      targetId: candidate.targetId,
      env: candidate.env,
      userId: params.userId,
      // Never place a tenant on a host whose Caddy readiness could not be
      // verified. The candidate loop can try another host; provisioning blind
      // recreates the gateway-unreachable incident on the customer path.
      requireConclusivePass: true,
    });
    if (preflight.skip) {
      lastUnavailable = {
        status: preflight.status,
        message: preflight.message,
        error: preflight.error,
      };
      continue;
    }

    if (params.readinessCheck) {
      const readiness = await params.readinessCheck({
        targetId: candidate.targetId,
        env: candidate.env,
      });
      if (!readiness.ok) {
        lastUnavailable = {
          status: readiness.status ?? 503,
          message: readiness.message,
          error: readiness.error,
        };
        log.warn("skipping Proxmox provisioning target that failed live readiness", {
          source: LOG_SOURCE,
          failureType: "proxmox_target_readiness_check_failed",
          userId: params.userId,
          targetId: candidate.targetId,
          readinessMessage: readiness.message,
          readinessError: readiness.error ?? null,
        });
        continue;
      }
    }

    return {
      ok: true,
      targetId: candidate.targetId,
      env: candidate.env,
      diskSizeGb: candidate.diskSizeGb,
    };
  }

  if (lastVmidExhaustion) {
    return {
      ok: false,
      status: 503,
      message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
      error: {
        code: "PROXMOX_TENANT_CAPACITY_REACHED",
        currentInstances: lastVmidExhaustion.occupiedCount,
        maxInstances: lastVmidExhaustion.maxInstances,
        vmidStart: lastVmidExhaustion.vmidStart,
        vmidEnd: lastVmidExhaustion.vmidEnd,
      },
    };
  }

  if (lastCapacityError) {
    if (unconfiguredTargetIds.length > 0) {
      const err = new Error(
        "Active Proxmox capacity hosts are missing runtime configuration"
      );
      log.error(
        "proxmox placement capacity masked by unconfigured target",
        err,
        {
          source: LOG_SOURCE,
          failureType: "proxmox_capacity_masked_by_unconfigured_target",
          userId: params.userId,
          unconfiguredTargetIds,
          cappedTargetId: lastCapacityError.targetId,
          currentInstances: lastCapacityError.error.currentInstances,
          maxInstances: lastCapacityError.error.maxInstances,
          recoveryAction: "configure_target_env_or_mark_host_draining",
        }
      );
      return {
        ok: false,
        status: 503,
        message:
          "Proxmox capacity exists, but an active capacity host is missing runtime configuration. New agents are paused until ops reconnects the host.",
        error: {
          code: "PROXMOX_TARGET_CONFIGURATION_MISSING",
          unconfiguredTargetIds,
          cappedTargetId: lastCapacityError.targetId,
          currentInstances: lastCapacityError.error.currentInstances,
          maxInstances: lastCapacityError.error.maxInstances,
          recoveryAction: "configure_target_env_or_mark_host_draining",
        },
      };
    }

    return {
      ok: false,
      status: lastCapacityError.error.status,
      message: lastCapacityError.error.message,
      error: {
        code: lastCapacityError.error.code,
        currentInstances: lastCapacityError.error.currentInstances,
        maxInstances: lastCapacityError.error.maxInstances,
      },
    };
  }

  if (lastUnavailable) {
    return { ok: false, ...lastUnavailable };
  }

  return {
    ok: false,
    status: 503,
    message:
      "All Proxmox hosts are at capacity. New agents are paused until more capacity is available.",
    error: { code: "PROXMOX_NO_PLACEMENT_TARGET" },
  };
}

function firstTrimmedString(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function resolveProxmoxHostConfigForProvisioning(host: ResolvedInstanceHost | null): ProxmoxHostRoutingConfig | null {
  if (!host) return resolveDefaultProxmoxHostConfig();

  return {
    hostId: host.id,
    hostSlug: firstTrimmedString(host as unknown as Record<string, unknown>, [
      "proxmox_host_slug",
      "host_slug",
      "slug",
    ]),
    envPrefix: firstTrimmedString(host as unknown as Record<string, unknown>, [
      "proxmox_env_prefix",
      "env_prefix",
    ]),
    failClosed: true,
  };
}

function resolveInfrastructureProviderForUser(userId: string): "hetzner" | "proxmox" {
  // HERMES_INFRA_PROVIDER=proxmox in production env exposes the Proxmox
  // pool to ALL customers by default — they pick a tier in the dashboard
  // and the dashboard provisions on Proxmox according to their plan's
  // CPU/RAM caps (enforced below in createInstance via plan.maxCpuPerAgent
  // / sub.total_cpu_budget). New customers from 2026-04-30 onward go to
  // Proxmox; existing Hetzner customers keep their VMs (instances are
  // pinned to whichever infra they were provisioned on, no
  // cross-infra migration).
  //
  // Two opt-out paths:
  //   1. HERMES_PROXMOX_DISABLED_USER_IDS — emergency allowlist that
  //      forces a specific user back onto Hetzner if Proxmox provisioning
  //      breaks for them. Use this if a customer reports failures and we
  //      want to keep them unblocked while we fix Proxmox.
  //   2. HERMES_PROXMOX_ENABLED_USER_IDS still works as a *legacy*
  //      whitelist when the environment is in transition: if it's set,
  //      ONLY listed users get Proxmox (matches the old behaviour for
  //      gradual rollout). Once you're ready for full self-serve, unset
  //      that env var and the whole pool goes Proxmox.
  const proxmoxAvailable =
    process.env.HERMES_INFRA_PROVIDER?.trim().toLowerCase() === "proxmox";
  if (!proxmoxAvailable) {
    return "hetzner";
  }

  const proxmoxDisabledForUser = envListIncludes(
    process.env.HERMES_PROXMOX_DISABLED_USER_IDS,
    userId
  );
  if (proxmoxDisabledForUser) {
    return "hetzner";
  }

  // Transitional: when HERMES_PROXMOX_ENABLED_USER_IDS is set, treat it
  // as a whitelist (old behaviour). Unset → everyone gets Proxmox.
  const enabledList = process.env.HERMES_PROXMOX_ENABLED_USER_IDS?.trim();
  if (enabledList) {
    return envListIncludes(enabledList, userId) ? "proxmox" : "hetzner";
  }

  return "proxmox";
}

export const CreateInstanceSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(50)
    // Names flow into env files and shell heredocs on the agent VM. Newlines
    // and NULs would let a crafted name break out of the heredoc or split env
    // lines; the only legitimate display name never needs them.
    .refine((value) => !/[\n\r\0]/.test(value), {
      message: "Name must not contain newlines or null bytes",
    }),
  provider: z.string().default("openrouter"),
  apiKey: z.string().optional().default(""),
  vaultKeyId: z.string().optional(),
  honchoVaultKeyId: z.string().optional(),
  model: z.string().optional().default(""),
  migrationPath: z.string().optional(),
  hostId: z.string().optional(), // If provided, deploy on existing host
  // Product lane. 'workspace_cloud' pins placement to the dedicated wrk1 lane
  // (separate from Hivra auto-placement) and tags the row so the two
  // products stay cleanly partitioned. Defaults to the main Hivra surface.
  productSurface: z.enum(["hermesos", "workspace_cloud"]).optional().default("hermesos"),
  cpuLimit: z.number().min(0.5).optional().default(2),
  ramLimit: z.number().min(1024).optional().default(4096),
  honcho: z
    .object({
      enabled: z.boolean().optional().default(true),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      peerName: z.string().optional(),
      aiPeer: z.string().optional(),
      memoryMode: z.enum(["hybrid", "honcho"]).optional().default("hybrid"),
      recallMode: z
        .enum(["hybrid", "context", "tools"])
        .optional()
        .default("hybrid"),
    })
    .optional(),
  agentSettings: z
    .object({
      runtimeMode: z.enum(["managed", "developer"]).optional().default("managed"),
      maxIterations: z.number().optional().default(60),
      toolProgressMode: z.string().optional().default("all"),
      compressionThreshold: z.number().optional().default(0.85),
      sessionResetMode: z.string().optional().default("both"),
      fastMode: z.boolean().optional().default(false),
      gatewayTimeoutMins: z.number().optional().default(15),
      showInterimAssistantMessages: z.boolean().optional().default(true),
      autoApproveToolCalls: z.boolean().optional().default(false),
      systemPrompt: z.string().optional(),
      browserProvider: z.string().optional().default("local"),
      browserbaseApiKey: z.string().optional(),
      browserbaseProjectId: z.string().optional(),
      browserUseApiKey: z.string().optional(),
      tavilyApiKey: z.string().optional(),
      exaApiKey: z.string().optional(),
      webUseGateway: z.boolean().optional(),
      imageGenUseGateway: z.boolean().optional(),
      ttsUseGateway: z.boolean().optional(),
      browserUseGateway: z.boolean().optional(),
      fallbackModels: z.string().optional(),
      subagentModel: z.string().optional(),
      subagentApiKey: z.string().optional(),
      mountPersistentSource: z.boolean().optional().default(false),
      enableRootAccess: z.boolean().optional().default(false),
      customLlmBaseUrl: z.string().optional(),
    })
    .default({}),
  managedVenice: z
    .object({
      enabled: z.boolean().optional().default(false),
      walletType: z.enum(["hermesos", "card"]).optional().default("hermesos"),
    })
    .optional(),
  // Deploy-card "Managed (Venice)? = OFF" — clean-slate BYOK. When true the box
  // deploys with NO inference provider, NO key, and NO model seeded (provider/
  // model/apiKey are omitted by the deploy card). The agent boots unconfigured
  // so its native onboarding overlay fires and the user connects a provider /
  // pastes a key after the box is up — killing the keyless-provider init brick.
  // Effective only when NOT a managed-Venice deploy (see createInstance).
  unconfigured: z.boolean().optional().default(false),
  // Only the public standard runtime is accepted for new instances. Operator OS
  // launches remain disabled until that first-party runtime's
  // source, license, and portable build are inside the public release boundary.
  agentFlavor: z.literal("vanilla").optional().default("vanilla"),
});

type CreateInstanceParams = z.infer<typeof CreateInstanceSchema>;

type ServiceResponse<T> =
  | { success: true; data: T }
  | {
      success: false;
      status: number;
      message: string;
      error?: unknown;
      // Machine-readable failure code surfaced to the client (route handlers
      // include it in the response body) so the frontend can distinguish
      // transient infra failures from permanent user-input rejections.
      failureType?: string;
    };

/**
 * Lifecycle/legacy-status values that mark an instance as fully gone — those
 * rows do NOT count against the free-tier limit. Anything else (provisioning,
 * active, paused, suspended, redeploying, error, etc.) is treated as
 * "still occupies the user's free slot" so users can't dodge the guard by
 * letting an instance go into a transient broken state.
 */
const TERMINAL_LIFECYCLE_STATES = ["deleted", "failed"] as const;
const PROXMOX_CAPACITY_EXCLUDED_STATUSES = ["deleted", "error", "failed"] as const;

type ProxmoxCapacityRow = {
  id?: string | null;
  status?: string | null;
  lifecycle_state?: string | null;
  proxmox_vmid?: number | null;
};

type PostProvisionMetadataPayload = {
  hetzner_server_id: number | null;
  host_id: string | null | undefined;
  gateway_url: string;
  api_server_key_encrypted: string;
  ipv4_address: string;
  ssh_host_fingerprint_sha256: string | null;
  infrastructure_provider: "hetzner" | "proxmox";
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  proxmox_template_vmid: number | null;
  disk_size_gb: number | null;
  config: Record<string, unknown>;
  status: "provisioning";
  updated_at: string;
};

function proxmoxRowOccupiesCapacity(row: ProxmoxCapacityRow): boolean {
  if (row.lifecycle_state === "deleted" || row.status === "deleted") return false;

  // A row with a VMID still occupies a real Proxmox slot even if the app
  // currently marks it error/failed. Count it until cleanup clears the VMID.
  if (typeof row.proxmox_vmid === "number") return true;

  if (row.lifecycle_state === "failed") return false;
  if (row.status === "error" || row.status === "failed") return false;

  return true;
}

function isDuplicateProxmoxMetadataError(error: unknown): boolean {
  const raw = error as { code?: unknown; message?: unknown; details?: unknown } | null | undefined;
  if (raw?.code === "23505") return true;

  const text = [raw?.message, raw?.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return Boolean(text && text.includes("proxmox") && text.includes("vmid"));
}

async function recoverStaleProxmoxMetadataConflict(params: {
  updatePayload: PostProvisionMetadataPayload;
  updateInstanceId: string;
  userId: string;
}): Promise<{ recovered: boolean; retryError?: unknown }> {
  const { updatePayload, updateInstanceId, userId } = params;
  const supabase = supabaseAdmin;
  if (!supabase) {
    log.error("database not configured while recovering stale Proxmox metadata conflict", new Error("Database not configured"), {
      source: LOG_SOURCE,
      failureType: "post_provision_proxmox_metadata_conflict_database_missing",
      userId,
      instanceId: updateInstanceId,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
    });
    return { recovered: false };
  }

  if (
    updatePayload.infrastructure_provider !== "proxmox" ||
    !updatePayload.proxmox_node ||
    typeof updatePayload.proxmox_vmid !== "number"
  ) {
    return { recovered: false };
  }

  const infrastructure = updatePayload.config.infrastructure as ProxmoxInfrastructure | undefined;
  const { data: conflicts, error: conflictLookupError } = await supabase
    .from("hermes_instances")
    .select("id,status,lifecycle_state,config,proxmox_node,proxmox_vmid")
    .eq("proxmox_node", updatePayload.proxmox_node)
    .eq("proxmox_vmid", updatePayload.proxmox_vmid)
    .neq("id", updateInstanceId)
    .limit(5);

  if (conflictLookupError) {
    log.error("failed to inspect stale Proxmox metadata conflict", conflictLookupError, {
      source: LOG_SOURCE,
      failureType: "post_provision_proxmox_metadata_conflict_lookup_failed",
      userId,
      instanceId: updateInstanceId,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
    });
    return { recovered: false };
  }

  const staleConflict = (conflicts ?? []).find(isClearableStaleProxmoxMetadataRow);
  if (!staleConflict?.id) {
    log.error(
      "post-provision Proxmox metadata conflict is not clearable",
      new Error("Active or unknown row already owns Proxmox VMID"),
      {
        source: LOG_SOURCE,
        failureType: "post_provision_proxmox_metadata_conflict_active",
        userId,
        instanceId: updateInstanceId,
        proxmoxNode: updatePayload.proxmox_node,
        proxmoxVmid: updatePayload.proxmox_vmid,
        conflictCount: conflicts?.length ?? 0,
        conflictStates: (conflicts ?? []).map((row) => ({
          id: row.id ?? null,
          status: row.status ?? null,
          lifecycleState: row.lifecycle_state ?? null,
        })),
      }
    );
    return { recovered: false };
  }

  const clearedConfig = stripProxmoxInfrastructure(
    staleConflict.config,
    "post_provision_stale_conflict",
  );
  const now = new Date().toISOString();
  const { error: clearError } = await supabase
    .from("hermes_instances")
    .update({
      gateway_url: null,
      ipv4_address: null,
      proxmox_node: null,
      proxmox_vmid: null,
      proxmox_template_vmid: null,
      config: clearedConfig,
      updated_at: now,
    })
    .eq("id", staleConflict.id)
    .eq("proxmox_node", updatePayload.proxmox_node)
    .eq("proxmox_vmid", updatePayload.proxmox_vmid);

  if (clearError) {
    log.error("failed to clear stale Proxmox metadata conflict", clearError, {
      source: LOG_SOURCE,
      failureType: "post_provision_stale_proxmox_metadata_clear_failed",
      userId,
      instanceId: updateInstanceId,
      staleInstanceId: staleConflict.id,
      proxmoxNode: updatePayload.proxmox_node,
      proxmoxVmid: updatePayload.proxmox_vmid,
    });
    return { recovered: false };
  }

  log.warn("cleared stale Proxmox metadata conflict after successful VM provision", {
    source: LOG_SOURCE,
    failureType: "post_provision_stale_proxmox_metadata_cleared",
    userId,
    instanceId: updateInstanceId,
    staleInstanceId: staleConflict.id,
    proxmoxNode: updatePayload.proxmox_node,
    proxmoxVmid: updatePayload.proxmox_vmid,
    gatewayHost: infrastructure?.gatewayHost ?? null,
  });

  const { error: retryError } = await supabase
    .from("hermes_instances")
    .update({ ...updatePayload, updated_at: new Date().toISOString() })
    .eq("id", updateInstanceId);

  return { recovered: true, retryError };
}

export function isFreeTierKey(tier: string | null | undefined): boolean {
  return isFreeResourceTier(tier);
}

export function isSingleInstanceBaseTierKey(tier: string | null | undefined): boolean {
  return isSingleInstanceBaseResourceTier(tier);
}

export function resolveInstanceResourceTier(plan: string): string {
  return isFreeTierKey(plan) ? freeResourceTierForStorage() : plan;
}

export class FreeInstanceLimitError extends Error {
  readonly code = "FREE_INSTANCE_LIMIT_REACHED";
  readonly status = 403;
  readonly existingInstanceId: string;

  constructor(existingInstanceId: string, message?: string) {
    super(
      message ||
        "You already have one active base-tier agent. Upgrade to deploy more."
    );
    this.name = "FreeInstanceLimitError";
    this.existingInstanceId = existingInstanceId;
  }
}

/**
 * Throws `FreeInstanceLimitError` if the user already owns an active base-tier
 * instance. "Active" = `lifecycle_state` not in (deleted, failed). The
 * `resource_tier` column is the schema-backed source of truth; no migration
 * creates `hermes_instances.tier`, so this guard must not query it.
 *
 * Callers must invoke this BEFORE any backend (Proxmox/Hetzner) call — the
 * whole point is to refuse to spin up a VM for a user who already has one
 * Free/token-base slot. Paid tiers are out of scope here; this guard is a no-op
 * when called for a paid tier (callers should not call it in that case
 * but doing so accidentally is safe).
 */
// SLOT_FREEING_LIFECYCLE_STATES / SLOT_FREEING_LIFECYCLE_IN_LIST now live in
// @/lib/instance-lifecycle (a dependency-free module) so the read-side reporters
// and the Hivra launch gate can share the exact same exclusion without importing
// this heavy module. Re-exported here for back-compat with existing callers.
export { SLOT_FREEING_LIFECYCLE_STATES };

export async function assertFreeInstanceCreatable(
  userId: string,
  deps: { supabase?: typeof supabaseAdmin } = {}
): Promise<void> {
  const supabase = deps.supabase ?? supabaseAdmin;
  if (!supabase) {
    throw new Error("Database not configured");
  }

  // `resource_tier` is the only tier column created by the migrations.
  //
  // Count "still occupies the slot" by `status != 'deleted'` AND
  // `lifecycle_state NOT IN (deleted, cold_archived)`. Status alone is not
  // enough: deleted/cold_archived base instances are routinely left at
  // status='stopped' (status isn't synced on every lifecycle transition), so a
  // status-only guard counted a user's GONE base instance and refused to let
  // them create a new free agent. Excluding the slot-freeing lifecycle states
  // fixes that without a data migration. A transient 'failed' base instance
  // still occupies the slot (it's not in the slot-freeing set), so the guard
  // can't be dodged via a broken state — preserving the F053 alignment with the
  // agent-count guard, which applies the same exclusion.
  const { data, error } = await supabase
    .from("hermes_instances")
    .select("id, lifecycle_state, resource_tier, status")
    .eq("user_id", userId)
    .or(
      Array.from(SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES)
        .map((value) => `resource_tier.eq.${value}`)
        .join(",")
    )
    .neq("status", "deleted")
    .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST)
    .limit(1);

  if (error) {
    const err = new Error(`Failed to verify free-instance limit: ${error.message}`);
    log.error("failed to verify free-instance limit", err, {
      source: LOG_SOURCE,
      failureType: "free_instance_limit_check_failed",
      userId,
      queriedColumns: ["user_id", "resource_tier", "lifecycle_state"],
      baseTierValues: Array.from(SINGLE_INSTANCE_BASE_RESOURCE_TIER_VALUES),
      verboseErrors: true,
    });
    throw err;
  }

  if (data && data.length > 0) {
    throw new FreeInstanceLimitError(data[0].id);
  }
}

export class ProxmoxTenantCapacityError extends Error {
  readonly code = "PROXMOX_TENANT_CAPACITY_REACHED";
  readonly status = 503;
  readonly currentInstances: number;
  readonly maxInstances: number;

  constructor(currentInstances: number, maxInstances: number) {
    super(PROXMOX_CAPACITY_PAUSED_MESSAGE);
    this.name = "ProxmoxTenantCapacityError";
    this.currentInstances = currentInstances;
    this.maxInstances = maxInstances;
  }
}

export async function assertProxmoxTenantCapacityAvailable(
  deps: {
    supabase?: typeof supabaseAdmin;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    hostConfig?: ProxmoxHostRoutingConfig | null;
    targetId?: string | null;
    // Per-host override from the proxmox_hosts registry; when provided
    // it takes precedence over HERMES_PROXMOX_MAX_TENANT_INSTANCES.
    maxInstancesOverride?: number | null;
  } = {}
): Promise<void> {
  const capacityEnv = deps.env ?? process.env;
  const hostId = deps.hostConfig?.hostId?.trim() || null;
  const selectedTargetId = normalizeProxmoxCapacityScopeId(deps.targetId);
  const explicitHost = Boolean(
    hostId || deps.hostConfig?.hostSlug?.trim() || deps.hostConfig?.envPrefix?.trim()
  );
  const target = explicitHost
    ? {
        id: normalizeProxmoxCapacityScopeId(capacityEnv.PROXMOX_NODE),
        env: capacityEnv,
      }
    : selectedTargetId
      ? {
          id: selectedTargetId,
          env: capacityEnv,
        }
    : resolveProxmoxTargetConfiguration(capacityEnv);
  const targetId = target.id;
  const maxInstances =
    deps.maxInstancesOverride ?? resolveProxmoxMaxTenantInstances(target.env);
  if (!maxInstances) return;

  const supabase = deps.supabase ?? supabaseAdmin;
  if (!supabase) {
    throw new Error("Database not configured");
  }

  let query = supabase
    .from("hermes_instances")
    .select("id, status, lifecycle_state, proxmox_vmid")
    .or("infrastructure_provider.eq.proxmox,proxmox_vmid.not.is.null");

  if (hostId) {
    query = query.eq("host_id", hostId);
  } else if (targetId) {
    query = query.eq("proxmox_node", targetId);
  }

  const { data, error } = await query;
  let hivraQuery = supabase
    .from("hivra_agents")
    .select("id, status, vmid, proxmox_host");

  if (targetId) {
    hivraQuery = hivraQuery.eq("proxmox_host", targetId);
  }

  const { data: hivraData, error: hivraError } = await hivraQuery;

  if (error || hivraError) {
    const capacityError = error ?? hivraError;
    const err = new Error(`Failed to verify Proxmox capacity: ${capacityError?.message ?? "unknown query error"}`);
    log.error("failed to verify Proxmox tenant capacity", err, {
      source: LOG_SOURCE,
      failureType: "proxmox_tenant_capacity_check_failed",
      hostId,
      targetId,
      scope: hostId ? "host_id" : targetId ? "proxmox_node" : "global",
      maxInstances,
      legacyError: error?.message ?? null,
      hivraError: hivraError?.message ?? null,
      excludedLifecycleStates: Array.from(TERMINAL_LIFECYCLE_STATES),
      excludedStatuses: Array.from(PROXMOX_CAPACITY_EXCLUDED_STATUSES),
      verboseErrors: true,
    });
    throw err;
  }

  const legacyInstances = (data ?? []).filter(proxmoxRowOccupiesCapacity).length;
  const hivraInstances = (hivraData ?? []).filter((row) =>
    proxmoxRowOccupiesCapacity({
      status: (row as { status?: string | null }).status,
      proxmox_vmid: (row as { vmid?: number | null }).vmid,
    })
  ).length;
  const currentInstances = legacyInstances + hivraInstances;
  if (currentInstances >= maxInstances) {
    log.warn("proxmox tenant capacity reached", {
      source: LOG_SOURCE,
      failureType: "proxmox_tenant_capacity_reached",
      currentInstances,
      maxInstances,
      hostId,
      targetId,
      scope: hostId ? "host_id" : targetId ? "proxmox_node" : "global",
      excludedLifecycleStates: Array.from(TERMINAL_LIFECYCLE_STATES),
      excludedStatuses: Array.from(PROXMOX_CAPACITY_EXCLUDED_STATUSES),
    });
    throw new ProxmoxTenantCapacityError(currentInstances, maxInstances);
  }
}

export function resolveDefaultInstanceBackend(): InstanceBackend {
  // Provision the webfree stack (official-dashboard + gateway agent, served via
  // the per-instance Caddyfile's public /webchat + /dash shells). On Proxmox/
  // Hetzner that stack is built under backend==="webui"; backend==="gateway"
  // falls through to the LEGACY minimal stack with no public dashboard shell,
  // which 404s in the workspace iframe (incident 2026-06-15: the webui-retirement
  // flip to "gateway" shipped before the deploy path was rewired to build webfree
  // for gateway — its Phase-2 sweep). Until that sweep lands, default to the
  // proven webui/webfree path the entire running fleet already uses. workspace_cloud
  // is unaffected: its provisioner sets backend explicitly, never via this default.
  //
  // 2026-06-15 PHASE-2 LANDED: every deploy / redeploy / handoff / readiness /
  // control-plane / cron / feature-gate branch now routes through isWebfreeBackend(),
  // so backend==="gateway" builds + serves the SAME webfree stack as "webui" — they
  // are byte-identical, and there is no longer a no-shell backend to fall to. The
  // default is flipped to "gateway" (the webui-retirement's canonical backend),
  // verified safe by a live canary soak (a gateway box reconciled and served
  // /webchat + /dash = 200).
  return "gateway";
}

export class InstanceService {
  private static classifyProvisioningFailureStatus(errorMessage: string): number {
    const normalized = errorMessage.toLowerCase();

    if (
      normalized.includes("user_data length") &&
      normalized.includes("exceeds 32768 bytes")
    ) {
      return 422;
    }
    if (
      normalized.includes("no free proxmox vmid in range") ||
      normalized.includes("temporary proxmox capacity reached") ||
      normalized.includes("all proxmox hosts are at capacity")
    ) {
      return 503;
    }

    return 500;
  }

  static async createInstance(
    userId: string,
    params: CreateInstanceParams
  ): Promise<ServiceResponse<Record<string, unknown>>> {
    const infraProvider = resolveInfrastructureProviderForUser(userId);

    if (infraProvider === "hetzner" && !process.env.HETZNER_API_TOKEN) {
      return {
        success: false,
        status: 503,
        message: "Hetzner deployment not configured",
      };
    }
    if (!supabaseAdmin) {
      return { success: false, status: 500, message: "Database not configured" };
    }

    const {
      name,
      provider,
      apiKey,
      vaultKeyId,
      honchoVaultKeyId,
      model,
      migrationPath,
      honcho,
      agentSettings,
      managedVenice,
      hostId,
      productSurface,
      unconfigured: requestUnconfigured,
    } = params;
    // Clean-slate BYOK (deploy-card Managed=OFF): only honored when the user did
    // NOT also ask for managed Venice — managed Venice is the fully-configured
    // path and takes precedence. When effective, the box ships with no provider/
    // key/model seeded and the agent's native onboarding overlay fires. This is
    // persisted to config.unconfigured below and threaded into WebUIDeployParams.
    const cleanSlateUnconfigured =
      requestUnconfigured === true && !managedVenice?.enabled;
    let { cpuLimit, ramLimit } = params;
    // Workspace Cloud lane: pin placement to the dedicated host (default wrk1,
    // overridable via env) regardless of its registry status, so Hivra
    // auto-placement never lands here and the lane never spills onto the
    // Hivra fleet. Null for the default Hivra surface (normal placement).
    const forceProxmoxTargetId =
      productSurface === "workspace_cloud"
        ? process.env.WORKSPACE_CLOUD_PROXMOX_NODE?.trim() || "wrk1"
        : null;
    const subdomain = randomBytes(10).toString("hex");
    const backend = resolveDefaultInstanceBackend();
    const isCodexProvider = isCodexAuthProvider(provider);

    // ── Tier Enforcement ─────────────────────────────────────────────────
    // Two equivalent entitlement sources: Stripe subscription, or token-
    // tier qualification ($HERMESOS held in the user's hermesos_lock
    // wallet). resolveEffectiveSubscription checks Stripe first and falls
    // back to token-holding, returning a uniform shape so the rest of
    // this function doesn't have to care which path the user took.
    //
    // The Workspace Cloud lane bills against its own subscription table; its
    // entitlement resolver is fully separate so the two products never share
    // a budget or a Stripe sub.
    let sub =
      productSurface === "workspace_cloud"
        ? await resolveWorkspaceCloudEntitlement(userId)
        : await resolveEffectiveSubscription(userId);

    if (process.env.NODE_ENV === "development" && !sub) {
      sub = {
        plan: "operator", // Mock default plan for dev if missing
        status: "active",
        instance_limit: 100,
        total_cpu_budget: 128,
        total_ram_budget: 256000,
        source: "stripe",
        canChangePlanInPlace: false,
      };
    }

    if (!sub) {
      return {
        success: false,
        status: 403,
        message:
          "Active subscription required. Choose a plan or hold $HERMESOS to qualify for Pro / Power tier.",
      };
    }

    // Stripe trialing subs reach this point because the abuse-gate
    // bypass treats them as entitled, but provisioning was historically
    // gated on active / past_due only — the trial budget rows are often
    // $0 and would fail the budget check below anyway. Reject explicitly
    // so the user sees a clear message instead of a confusing budget
    // error. Token-holding entries are always synthesised as 'active'.
    if (sub.source === "stripe" && !["active", "past_due"].includes(sub.status)) {
      return {
        success: false,
        status: 403,
        message:
          "Active subscription required. Choose a plan to start deploying agents.",
      };
    }

    // Dunning gate: never provision a NEW agent while billing is in a
    // failed/retry state. Existing agents keep running through the grace
    // window (policy: 48h keep-alive), but spinning up a fresh Pro agent on a
    // card that just failed is the exact free-access abuse this closes — a
    // user could let the renewal fail and keep minting Pro agents for the
    // whole ~2-week Stripe retry window. Surfaces as `status === "past_due"`
    // for both Stripe (failed payment) and Apple (grace_period). `active`
    // recovers the moment `handleInvoicePaid` clears the row.
    if (sub.status === "past_due") {
      return {
        success: false,
        status: 402,
        message:
          "Your last payment didn't go through. Update your payment method to deploy new agents — your existing agents keep running during the grace period.",
      };
    }

    // ── One-account-one-base-instance guard ──────────────────────────────
    // When the user is on a Free/token-base tier, refuse to create a second
    // instance. We check BEFORE the existing tier-budget enforcement (and
    // before any backend call below) so the rejection is the cheapest
    // possible failure path. Paid tiers fall through unchanged.
    if (isSingleInstanceBaseTierKey(sub.plan)) {
      // ── Global free-tier cap ──────────────────────────────────────────────
      // Bound total active free instances fleet-wide. When full, turn the
      // signup away to the waitlist (the existing /api/reserve flow) instead of
      // provisioning, so free demand is capped at MAX_FREE_INSTANCES instead of
      // unbounded. Unset/0 disables the cap (default — dark-shippable).
      const maxFree = maxFreeInstances();
      if (maxFree > 0 && supabaseAdmin) {
        let activeFree: number;
        try {
          activeFree = await countActiveFreeInstances();
        } catch (err) {
          log.error("free-capacity check failed", err instanceof Error ? err : new Error(String(err)), {
            source: LOG_SOURCE,
            userId,
            failureType: "free_capacity_check_failed",
          });
          return {
            success: false,
            status: 503,
            message: "Couldn't verify free capacity right now — please try again in a moment.",
            error: { code: "FREE_CAPACITY_CHECK_FAILED" },
          };
        }
        if (activeFree >= maxFree) {
          // Capture the lead: enqueue them on the waitlist (by email) so a
          // capped signup is never lost. Fetch the email on this rare capped
          // path only; failure still turns them away (just without the row).
          let waitlistPosition: number | null = null;
          try {
            const clerk = await clerkClient();
            const cappedUser = await clerk.users.getUser(userId);
            const cappedEmail = resolveClerkUserEmail(cappedUser);
            if (cappedEmail) {
              const queued = await enqueueWaitlist(cappedEmail, userId);
              waitlistPosition = queued.position;
            }
          } catch (capErr) {
            log.warn("waitlist auto-capture failed (still turning signup away)", {
              source: LOG_SOURCE,
              userId,
              error: capErr instanceof Error ? capErr.message : String(capErr),
            });
          }
          log.info("free capacity full — captured signup to waitlist", {
            source: LOG_SOURCE,
            userId,
            activeFree,
            maxFree,
            waitlistPosition,
          });
          return {
            success: false,
            status: 202,
            message:
              waitlistPosition != null
                ? `Free capacity is full right now — you're #${waitlistPosition} on the waitlist. We'll email you the moment a spot opens.`
                : "Free capacity is full right now — join the waitlist and we'll email you the moment a spot opens.",
            error: { code: "FREE_CAPACITY_FULL", waitlistPosition },
          };
        }
      }
      try {
        await assertFreeInstanceCreatable(userId, { supabase: supabaseAdmin });
      } catch (err) {
        if (err instanceof FreeInstanceLimitError) {
          return {
            success: false,
            status: err.status,
            message: err.message,
            error: { code: err.code, existingInstanceId: err.existingInstanceId },
          };
        }
        return {
          success: false,
          status: 500,
          message:
            err instanceof Error
              ? err.message
              : "Failed to verify free-instance limit",
        };
      }
    }

    const plan = getPlan(sub.plan);
    const resourceTier = resolveInstanceResourceTier(sub.plan);

    // Check agent count. Scope to the same product surface so the two lanes
    // (Hivra vs Workspace Cloud) never count against each other's limits —
    // a Hivra user with agents must not be blocked from launching a
    // separately-billed Workspace Cloud agent, and vice versa.
    // Exclude the slot-freeing lifecycle states (deleted/cold_archived) for the
    // same reason as assertFreeInstanceCreatable: a gone/archived agent left at
    // status='stopped' must not count against the plan's agent limit.
    const { count: agentCount } = await supabaseAdmin
      .from("hermes_instances")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("product_surface", productSurface)
      .not("status", "in", '("deleted")')
      .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST);

    if ((agentCount || 0) >= sub.instance_limit) {
      return {
        success: false,
        status: 403,
        message: `Agent limit reached. Your ${plan.name} plan allows ${
          sub.instance_limit
        } agent${
          sub.instance_limit === 1 ? "" : "s"
        }. Upgrade your plan or resize existing agents to free up resources.`,
      };
    }

    // Enforce per-agent caps
    if (cpuLimit > plan.maxCpuPerAgent) {
      cpuLimit = plan.maxCpuPerAgent;
    }
    if (ramLimit > plan.maxRamPerAgent) {
      ramLimit = plan.maxRamPerAgent;
    }

    // ── Venice compute boost ─────────────────────────────────────────────
    // A paid user holding ≥ $199 of VVV gets +1 vCPU / +2 GB on this instance,
    // applied at provision so the VM is born at the boosted size (rather than
    // waiting for the refresh-token-tiers cron). The boost only stacks on paid
    // tiers. Best-effort: a boost-table read hiccup must never block a
    // provision. The boost is bonus capacity beyond the plan budget — it's
    // added on top of the per-agent caps here and EXCLUDED from the
    // plan-budget check below, while the host-core and host-capacity checks
    // still see the real, boosted size.
    let veniceBoost = false;
    if (isPaidTier(sub.plan)) {
      try {
        veniceBoost = await isVeniceBoostEligible(userId);
      } catch {
        veniceBoost = false;
      }
    }
    if (veniceBoost) {
      cpuLimit += VENICE_BOOST_CPU;
      ramLimit += VENICE_BOOST_RAM_MB;
    }

    // If an existing host is selected, resolve it before any Proxmox env/capacity
    // checks. Multi-host Proxmox routing must use the selected host's metadata for
    // host max caps, provisioning, and persisted post-provision fields; resolving
    // env first would let ambient/global PROXMOX_* values target the wrong host.
    let resolvedHost: ResolvedInstanceHost | null = null;
    if (hostId) {
      const { data: host } = await supabaseAdmin
        .from("hermes_hosts")
        .select("*")
        .eq("id", hostId)
        .eq("user_id", userId)
        .single();
      if (!host) {
        return { success: false, status: 404, message: "Selected host not found" };
      }

      resolvedHost = host;
    }

    const proxmoxHostConfig =
      infraProvider === "proxmox" ? resolveProxmoxHostConfigForProvisioning(resolvedHost) : null;
    let proxmoxProvisionEnv: NodeJS.ProcessEnv = process.env;
    let proxmoxProvisionTargetId: string | null = null;
    const proxmoxRequestedDiskGb = DEFAULT_PROXMOX_VM_DISK_GB;
    let proxmoxProvisionedDiskGb = DEFAULT_PROXMOX_VM_DISK_GB;

    if (infraProvider === "proxmox") {
      try {
        proxmoxProvisionEnv = resolveProxmoxHostEnv(proxmoxHostConfig, process.env) as NodeJS.ProcessEnv;
      } catch (err) {
        return {
          success: false,
          status: 503,
          message: err instanceof Error ? err.message : "Proxmox deployment not configured",
        };
      }

      if (!isProxmoxProvisioningConfigured(proxmoxProvisionEnv)) {
        return {
          success: false,
          status: 503,
          message: "Proxmox deployment not configured",
        };
      }

      // PROXMOX_VM_MAX_CORES / PROXMOX_VM_MAX_MEMORY_MB are HOST-physical
      // ceilings, not per-tenant defaults. Proxmox refuses `qm start`
      // with "MAX <N> vcpus allowed per VM on this node" if a VM is
      // configured with more vCPUs than the host has physical cores. So
      // even though Command-plan max-per-agent is 16, on a 12-core host
      // we have to cap to 12. (Earlier these env vars were being read
      // with names PROXMOX_VM_CORES / PROXMOX_VM_MEMORY_MB and acting
      // as a TIER-level cap — wrong layer; renamed for clarity.)
      const proxmoxHostMaxCores = optionalPositiveEnvInt(proxmoxProvisionEnv.PROXMOX_VM_MAX_CORES);
      const proxmoxHostMaxRamMb = optionalPositiveEnvInt(proxmoxProvisionEnv.PROXMOX_VM_MAX_MEMORY_MB);
      if (proxmoxHostMaxCores) cpuLimit = Math.min(cpuLimit, proxmoxHostMaxCores);
      if (proxmoxHostMaxRamMb) ramLimit = Math.min(ramLimit, proxmoxHostMaxRamMb);
    }

    if (resolvedHost) {
      const { data: siblings } = await supabaseAdmin
        .from("hermes_instances")
        .select("cpu_limit, ram_limit")
        .eq("host_id", resolvedHost.id);
      const usedCpu = (siblings || []).reduce(
        (acc, row) => acc + (row.cpu_limit || 0),
        0
      );
      const usedRam = (siblings || []).reduce(
        (acc, row) => acc + (row.ram_limit || 0),
        0
      );

      if (
        usedCpu + cpuLimit > resolvedHost.total_cpu ||
        usedRam + ramLimit > resolvedHost.total_ram
      ) {
        return {
          success: false,
          status: 400,
          message: `Insufficient Host capacity. Host has ${resolvedHost.total_cpu} CPU / ${resolvedHost.total_ram}MB RAM total. Used: ${usedCpu} CPU / ${usedRam}MB RAM.`,
        };
      }

      if (infraProvider === "hetzner" && !resolvedHost.hetzner_server_id) {
        return {
          success: false,
          status: 400,
          message: `Host "${resolvedHost.name}" exists in the database but has no linked Hetzner server ID. The underlying VM may still be provisioning or may have been orphaned. Please wait a few minutes and retry — if it keeps failing, tell us on Discord (discord.gg/tDQZq8479F) or email info@hivra.cloud and we'll fix the host.`,
        };
      }
    }

    // Check total resource budget — also scoped per surface so the lanes keep
    // independent compute budgets. Exclude the slot-freeing lifecycle states
    // (deleted/cold_archived) for the same reason as the agent-count guard: a
    // gone/archived instance left at status='stopped' still carries its old
    // cpu_limit/ram_limit, and counting that phantom compute against the live
    // budget would re-block a user whose only base instance is already gone —
    // exactly the case the free/agent-count guards now allow.
    const { data: existingInstances } = await supabaseAdmin
      .from("hermes_instances")
      .select("cpu_limit, ram_limit")
      .eq("user_id", userId)
      .eq("product_surface", productSurface)
      .not("status", "in", '("deleted")')
      .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST);

    const usedCpuTotal = (existingInstances || []).reduce(
      (acc, i) => acc + (i.cpu_limit || 0),
      0
    );
    const usedRamTotal = (existingInstances || []).reduce(
      (acc, i) => acc + (i.ram_limit || 0),
      0
    );

    // The Venice boost is bonus capacity that does NOT count against the plan
    // budget. Strip it from existing usage (a boost-eligible user has it baked
    // into every instance's cpu_limit/ram_limit) and from the new request, so
    // the gate compares base-vs-budget. usedCpuTotal/usedRamTotal keep their
    // full values for the host-capacity check above.
    const existingInstanceCount = (existingInstances || []).length;
    const boostCpuPerInstance = veniceBoost ? VENICE_BOOST_CPU : 0;
    const boostRamPerInstance = veniceBoost ? VENICE_BOOST_RAM_MB : 0;
    const usedCpuBase = usedCpuTotal - boostCpuPerInstance * existingInstanceCount;
    const usedRamBase = usedRamTotal - boostRamPerInstance * existingInstanceCount;
    const requestedCpuBase = cpuLimit - boostCpuPerInstance;
    const requestedRamBase = ramLimit - boostRamPerInstance;

    if (usedCpuBase + requestedCpuBase > sub.total_cpu_budget) {
      return {
        success: false,
        status: 403,
        message: `Insufficient CPU budget. Your ${plan.name} plan has ${sub.total_cpu_budget} vCPU total. Currently using ${usedCpuBase} vCPU. Requested: ${requestedCpuBase} vCPU. Resize existing agents to free up CPU, or upgrade your plan.`,
      };
    }
    if (usedRamBase + requestedRamBase > sub.total_ram_budget) {
      const usedGb = (usedRamBase / 1024).toFixed(1);
      const totalGb = (sub.total_ram_budget / 1024).toFixed(1);
      const reqGb = (requestedRamBase / 1024).toFixed(1);
      return {
        success: false,
        status: 403,
        message: `Insufficient RAM budget. Your ${plan.name} plan has ${totalGb}GB total. Currently using ${usedGb}GB. Requested: ${reqGb}GB. Resize existing agents to free up RAM, or upgrade your plan.`,
      };
    }
    if (infraProvider === "proxmox") {
      // Per-instance disk sizing is not yet part of CreateInstanceSchema, so
      // the minimum request is the managed-agent default. Candidate placement
      // resolves each target's PROXMOX_VM_DISK_GB override and returns the
      // exact size that provisionProxmoxInstance will apply. Keeping those two
      // values coupled prevents a large runtime override from bypassing the
      // thin-pool admission check.
      const targetSelection = await selectAvailableProxmoxProvisionTarget({
        supabase: supabaseAdmin,
        env: proxmoxProvisionEnv,
        hostConfig: proxmoxHostConfig,
        userId,
        neededCpu: cpuLimit,
        neededRamMb: ramLimit,
        neededDiskGb: proxmoxRequestedDiskGb,
        forceTargetId: forceProxmoxTargetId,
      });
      if (!targetSelection.ok) {
        return {
          success: false,
          status: targetSelection.status,
          message: targetSelection.message,
          ...(targetSelection.error ? { error: targetSelection.error } : {}),
        };
      }

      proxmoxProvisionEnv = targetSelection.env;
      proxmoxProvisionTargetId = targetSelection.targetId;
      proxmoxProvisionedDiskGb = targetSelection.diskSizeGb;
    }
    // ── End Tier Enforcement ─────────────────────────────────────────────

    let finalApiKey = apiKey.trim();
    let finalHonchoKey = honcho?.apiKey?.trim() || undefined;

    if (vaultKeyId) {
      const { data: vk } = await supabaseAdmin
        .from("user_api_keys")
        .select("*")
        .eq("id", vaultKeyId)
        .eq("user_id", userId)
        .single();

      const foundEncryptedKey = vk?.key_encrypted || vk?.encrypted_key;
      if (!vk) {
        return {
          success: false,
          status: 404,
          message: `Provider API Key not found in Vault (id: ${vaultKeyId}). Check that the key exists and belongs to your account.`,
        };
      }

      if (foundEncryptedKey) {
        try {
          finalApiKey = decryptApiKey(foundEncryptedKey);
        } catch (decryptErr) {
          const msg =
            decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
          log.error("vault key decryption failed", decryptErr, {
            source: LOG_SOURCE,
            failureType: "vault_key_decryption_failed",
            userId,
            vaultKeyId,
          });
          return {
            success: false,
            status: 500,
            message: `Failed to decrypt Vault key: ${msg}. Ensure ENCRYPTION_KEY env var is correctly configured.`,
          };
        }
      }
    }

    if (honcho?.enabled && honchoVaultKeyId) {
      const { data: hk } = await supabaseAdmin
        .from("user_api_keys")
        .select("*")
        .eq("id", honchoVaultKeyId)
        .eq("user_id", userId)
        .single();

      const foundHonchoEncryptedKey = hk?.key_encrypted || hk?.encrypted_key;
      if (!hk) {
        return {
          success: false,
          status: 404,
          message: `Honcho API Key not found in Vault (id: ${honchoVaultKeyId}). Check that the key exists and belongs to your account.`,
        };
      }

      if (foundHonchoEncryptedKey) {
        try {
          finalHonchoKey = decryptApiKey(foundHonchoEncryptedKey);
        } catch (decryptErr) {
          const msg =
            decryptErr instanceof Error ? decryptErr.message : String(decryptErr);
          log.error("honcho vault key decryption failed", decryptErr, {
            source: LOG_SOURCE,
            failureType: "honcho_vault_key_decryption_failed",
            userId,
            honchoVaultKeyId,
          });
          return {
            success: false,
            status: 500,
            message: `Failed to decrypt Honcho Vault key: ${msg}. Ensure ENCRYPTION_KEY env var is correctly configured.`,
          };
        }
      }
    }

    const submittedManagedVeniceDeploy =
      isVeniceProvider(provider) && managedVenice?.enabled && !cleanSlateUnconfigured
        ? {
            walletType: managedVenice.walletType ?? "hermesos",
          }
        : null;
    const hasRealVeniceByokKey = isRealVeniceByokKey(provider, finalApiKey);
    const strippedManagedProxyBaseUrl = isManagedVeniceProxyBaseUrl(
      agentSettings.customLlmBaseUrl
    );
    let effectiveAgentSettings = hasRealVeniceByokKey
      ? stripManagedVeniceProxyBaseUrl(agentSettings)
      : agentSettings;
    const managedVeniceDeploy = hasRealVeniceByokKey
      ? null
      : submittedManagedVeniceDeploy;

    if (submittedManagedVeniceDeploy && hasRealVeniceByokKey) {
      log.warn(
        "ignored managed Venice create request because a real Venice BYOK key was provided",
        {
          source: LOG_SOURCE,
          failureType: "managed_venice_create_byok_overrode_managed",
          userId,
          provider,
          walletType: submittedManagedVeniceDeploy.walletType,
          hasVaultKeyId: Boolean(vaultKeyId),
          strippedManagedProxyBaseUrl,
        }
      );
    }
    let managedVeniceConfig:
      | {
          walletType: "hermesos" | "card";
          proxyBaseUrl: string;
          proxyKeyId: string | null;
          keyPrefix: string;
          enabledAt: string;
        }
      | null = null;

    if (managedVeniceDeploy) {
      try {
        const proxyBaseUrl = getManagedVeniceProxyBaseUrl();
        const proxyKey = await createManagedVeniceProxyKey({
          userId,
          name: `${name} managed Venice`,
          defaultWalletType: managedVeniceDeploy.walletType,
          // The deploy card submits 'hermesos' unless the card wallet was ALREADY
          // funded at page load — which it never is on a free user's FIRST deploy,
          // because the starter credit is granted during this very call. Let the
          // mint re-resolve the binding against post-grant balances.
          autoSelectFundedWallet: true,
        });
        finalApiKey = proxyKey.plaintextKey;
        effectiveAgentSettings = {
          ...agentSettings,
          customLlmBaseUrl: proxyBaseUrl,
        };
        managedVeniceConfig = {
          // The EFFECTIVE wallet this key bills — not necessarily the requested
          // one. Recording the request would drift config from billing reality.
          walletType: proxyKey.defaultWalletType,
          proxyBaseUrl,
          proxyKeyId: proxyKey.id,
          keyPrefix: proxyKey.keyPrefix,
          enabledAt: new Date().toISOString(),
        };
      } catch (err) {
        log.error("managed Venice proxy key creation failed during instance deploy", err, {
          source: LOG_SOURCE,
          failureType: "managed_venice_deploy_proxy_key_failed",
          userId,
          provider,
          walletType: managedVeniceDeploy.walletType,
        });
        return {
          success: false,
          status: 503,
          message:
            "Managed Venice is not ready for deployment. Please try again or choose Bring Your Own Venice API key.",
        };
      }
    }

    // Clean-slate BYOK ("Managed? = OFF") deploys intentionally arrive with NO
    // key — the agent boots unconfigured and its native onboarding overlay
    // collects the provider/key after the box is up. So a missing key is valid
    // here; only reject it for normal (configured) provider deploys.
    if (!finalApiKey && !supportsHermesAuthProvider(provider) && !cleanSlateUnconfigured) {
      return {
        success: false,
        status: 400,
        message:
          "Provider API key is required. Provide it manually or select a Vault key that contains an encrypted credential.",
      };
    }

    if (finalApiKey) {
      const keyShapeError = validateProviderKeyShape(provider, finalApiKey);
      if (keyShapeError) {
        log.warn("rejecting invalid provider API key shape for instance create", {
          source: "instance-service",
          operation: "createInstance",
          userId,
          provider: keyShapeError.provider,
          failureType: keyShapeError.failureType,
        });
        return {
          success: false,
          status: 400,
          message: keyShapeError.message,
          error: {
            code: keyShapeError.failureType,
            provider: keyShapeError.provider,
          },
        };
      }

      if (LIVE_CREATE_VALIDATION_PROVIDERS.has(provider)) {
        const validation = await validateProviderApiKey(provider, finalApiKey);
        if (!validation.valid) {
          const safeValidationError = validation.error
            ? redactSensitiveCommandOutput(validation.error, 300)
            : "Unknown validation error";
          const validationDetail = safeValidationError.replace(/[.!?]+$/, "");
          log.warn("rejecting provider API key during instance create", {
            source: LOG_SOURCE,
            operation: "createInstance",
            userId,
            provider,
            failureType: "provider_api_key_validation_failed",
            validationError: safeValidationError,
          });
          return {
            success: false,
            status: 400,
            message:
              provider === "gemini"
                ? `Google AI Studio rejected this Gemini API key: ${validationDetail}. Create a fresh key at aistudio.google.com/app/apikey, make sure the Generative Language API is enabled for that project, then try again.`
                : `Provider rejected this API key: ${validationDetail}`,
            error: {
              code: "provider_api_key_validation_failed",
              provider,
            },
          };
        }
      }
    }

    // Step 1: format normalisation (alias mapping, trim).
    const candidateModel = normalizeModelValue(
      model.trim() || (isCodexProvider ? CODEX_DEFAULT_MODEL : ""),
      provider
    );
    // Step 2: provider-vs-model compatibility check. The create form lets
    // a stale model selection survive a provider switch — eg the user's
    // last session had Venice + deepseek-v4-pro, they switch the
    // provider dropdown to Codex but the model dropdown keeps
    // deepseek-v4-pro. Without this guard the dashboard happily provisions
    // an instance with provider=openai-codex + model=deepseek-v4-pro, the
    // agent boots, the very first /api/chat/start succeeds, but the
    // upstream call to chatgpt.com/backend-api/codex returns
    // "The 'deepseek-v4-pro' model is not supported when using Codex
    // with a ChatGPT account" and the chat dies before any tokens
    // stream — surfaces in the dashboard as "Managed chat stream closed
    // before completion" with no actionable detail. reconcileModelForProvider
    // detects the mismatch and snaps to the first valid model in the
    // provider's catalog (Codex → gpt-5.5, etc) so the instance always
    // boots with a config that can actually answer.
    const reconciliation = reconcileModelForProvider(provider, candidateModel);
    const resolvedModel = reconciliation.model;
    if (reconciliation.corrected) {
      log.warn("auto-corrected mismatched model for provider during create", {
        source: LOG_SOURCE,
        failureType: "model_provider_mismatch_corrected",
        userId,
        provider,
        requestedModel: candidateModel,
        resolvedModel,
      });
    }
    const providerDeploymentSecret = resolveProviderDeploymentSecret(
      provider,
      finalApiKey
    );
    const deployApiKey = resolveDeploymentApiKey(
      finalApiKey,
      providerDeploymentSecret
    );

    if (isCodexProvider && finalApiKey && !providerDeploymentSecret.authBundle) {
      return {
        success: false,
        status: 400,
        message:
          "Codex agents now require a reusable OAuth session from the Vault. Reconnect Codex from the Vault page and select that saved session.",
      };
    }

    const honchoConfig = honcho
      ? {
          enabled: honcho.enabled,
          ...(honcho.baseUrl?.trim() ? { baseUrl: honcho.baseUrl.trim() } : {}),
          ...(honcho.peerName?.trim() ? { peerName: honcho.peerName.trim() } : {}),
          ...(honcho.aiPeer?.trim() ? { aiPeer: honcho.aiPeer.trim() } : {}),
          memoryMode: honcho.memoryMode,
          recallMode: honcho.recallMode,
        }
      : undefined;

    const clerk = await clerkClient();
    const clerkUser = await clerk.users.getUser(userId);
    const globalSettings = extractGlobalHermesSettings(clerkUser.publicMetadata);

    // Create DB record in provisioning state
    const honchoApiKeyEncrypted = finalHonchoKey
      ? encryptApiKey(finalHonchoKey)
      : undefined;
    const storedConfig = buildStoredInstanceConfig(undefined, {
      model: resolvedModel,
      honcho: honchoConfig,
      agentSettings: effectiveAgentSettings,
    });
    const effectiveStoredConfig = {
      ...(managedVeniceConfig
        ? {
            ...storedConfig,
            managedVenice: {
              enabled: true,
              ...managedVeniceConfig,
            },
          }
        : cleanSlateUnconfigured
          ? {
              // Clean-slate BYOK (deploy-card Managed=OFF): persist the intent so
              // a redeploy stays clean-slate (instance-orchestrator reads this).
              // instance.provider stays at its benign default ("openrouter") so
              // PROVIDER_ID_MAP lookups never throw — it is simply unused here.
              ...storedConfig,
              unconfigured: true,
            }
          : storedConfig),
    };

    const { data: instance, error: insertError } = await supabaseAdmin
      .from("hermes_instances")
      .insert(
        buildInstanceInsertPayload({
          userId,
          name,
          subdomain,
          provider,
          encryptedApiKey: encryptApiKey(finalApiKey),
          apiKeyPreview: formatStoredProviderSecretPreview(provider, finalApiKey),
          config: effectiveStoredConfig,
          honchoApiKeyEncrypted,
          hostId,
          cpuLimit,
          ramLimit,
          resourceTier,
          backend,
          infrastructureProvider: infraProvider,
          productSurface,
          diskSizeGb:
            infraProvider === "proxmox" ? proxmoxProvisionedDiskGb : undefined,
        })
      )
      .select()
      .single();

    if (insertError || !instance) {
      const insertFailure = new Error(
        insertError?.message || "Insert returned no instance row"
      );
      log.error("failed to create instance record", insertFailure, {
        source: LOG_SOURCE,
        failureType: "instance_record_insert_failed",
        userId,
        provider,
        backend,
        infrastructureProvider: infraProvider,
        resourceTier,
        cpuLimit,
        ramLimit,
        insertErrorCode:
          typeof insertError?.code === "string" ? insertError.code : undefined,
        insertErrorDetailsPresent: Boolean(insertError?.details),
        insertErrorHintPresent: Boolean(insertError?.hint),
        verboseErrors: true,
      });
      return {
        success: false,
        status: 500,
        message: "Failed to create instance record",
        error: insertError,
      };
    }

    // box_created (server-side funnel event): PostHog otherwise only sees the
    // activation→paid tail (agent_first_message_sent, checkout_payment_completed)
    // — there is no signup or box event, so the signup→box→use→paid funnel can't
    // be assembled in PostHog. Emit box_created keyed on the user so the middle
    // of the funnel becomes visible and sliceable by plan/backend/surface.
    // captureBoxCreatedOnce makes this fire at most once per instance.id (issue
    // #353: it was over-firing ~24x/instance and collapsing onto a few persons).
    // Best-effort: a telemetry hiccup must never fail instance creation.
    try {
      const emitted = captureBoxCreatedOnce({
        instanceId: instance.id,
        userId,
        properties: {
          // Funnel slicer: distinguishes this Hermes-lane emit from the hivra
          // lane's box_created (api/hivra/agents POST) in one unified funnel.
          lane: "hermes",
          plan: sub?.plan ?? null,
          backend,
          resource_tier: resourceTier,
          product_surface: productSurface,
          infrastructure_provider: infraProvider,
          provider,
        },
      });
      if (emitted) {
        await posthogClient.flush();
      }
    } catch (captureErr) {
      log.warn(
        "failed to capture box_created",
        {
          source: LOG_SOURCE,
          failureType: "box_created_capture_failed",
          userId,
          instanceId: instance.id,
        },
        captureErr
      );
    }

    // Bankr instance wallets are now LAZILY provisioned. The user clicks
    // "Create Bankr wallet" on the dashboard (POST /api/instances/[id]/bankr-wallet)
    // when they actually want the agent to have one, which provisions the
    // wallet AND syncs the new config into the running agent via the
    // sidecar. Eager provisioning at instance-creation time previously
    // wasted Bankr partner-key quota (20-key cap per wallet, 1000-wallet
    // total) on agents that may never use it, and tied instance creation
    // success to Bankr API availability. Keeping `bankrAgentConfig=null`
    // here just means the initial agent YAML omits the bankr section —
    // skills are still preinstalled below regardless.
    const bankrAgentConfig: InstanceBankrAgentConfig | null = null;

    // Generate signed URL for Hetzner cloud-init if migration path exists
    let migrationUrl: string | undefined = undefined;
    if (migrationPath) {
      const { data: signData, error: signError } = await supabaseAdmin.storage
        .from("hermes-attachments")
        .createSignedUrl(migrationPath, 60 * 60); // 1 hour expiry
      if (signError) {
        log.error("failed to sign migration URL", signError, {
          source: LOG_SOURCE,
          failureType: "migration_url_sign_failed",
          userId,
          instanceId: instance.id,
          migrationPath,
        });
      } else if (signData) {
        migrationUrl = signData.signedUrl;
      }
    }

    // Provision Hetzner VM or add to existing Host
    let hostHetznerServerId: number | undefined = undefined;
    let hostIp: string | undefined = undefined;

    if (resolvedHost?.hetzner_server_id) {
      hostHetznerServerId = resolvedHost.hetzner_server_id;
      // Fetch current public IP from Hetzner to ensure it hasn't changed
      const hs = await getHetznerInstanceStatus(
        resolvedHost.hetzner_server_id
      );
      if (!hs.ipv4) {
        return {
          success: false,
          status: 503,
          message: `Could not resolve the IP address of existing host (Hetzner server #${resolvedHost.hetzner_server_id}). The server may still be initialising. Please retry in a few minutes.`,
        };
      }
      hostIp = hs.ipv4;
      await supabaseAdmin
        .from("hermes_hosts")
        .update({ ipv4_address: hs.ipv4 })
        .eq("id", resolvedHost.id);
    }

    const provisionParams = {
      userId,
      instanceId: instance.id,
      tier: sub.plan,
      cpuLimit,
      ramLimit,
      name,
      provider,
      apiKey: deployApiKey,
      model: resolvedModel,
      bankr: bankrAgentConfig,
      subdomain,
      migrationUrl,
      codexAuthBundle:
        isCodexProvider
          ? (providerDeploymentSecret.authBundle as CodexVaultBundle | undefined)
          : undefined,
      nousAuthBundle:
        isNousAuthProvider(provider)
          ? (providerDeploymentSecret.authBundle as NousVaultBundle | undefined)
          : undefined,
      honchoSettings: honcho
        ? {
            enabled: honcho.enabled,
            apiKey: finalHonchoKey,
            baseUrl: honcho.baseUrl?.trim() || undefined,
            peerName: honcho.peerName?.trim() || undefined,
            aiPeer: honcho.aiPeer?.trim() || undefined,
            memoryMode: honcho.memoryMode,
            recallMode: honcho.recallMode,
          }
        : undefined,
      agentSettings: effectiveAgentSettings,
      autoUpdate: getAutoUpdateConfig(storedConfig),
      globalSettings,
      // Clean-slate BYOK (deploy-card Managed=OFF): forwarded to the WebUI
      // builders so a FRESH box ships with no provider/model/key seeded and the
      // agent's native onboarding overlay owns provider setup. provider/apiKey/
      // model on this request stay at their benign defaults but go unused.
      unconfigured: cleanSlateUnconfigured,
    };

    let result: Awaited<ReturnType<typeof provisionHetznerInstance>> | ProxmoxProvisionResult;
    // Set when the FINAL provision failure was classified host-local — the
    // client then gets the generic PROVISION_HOST_FAILURE_MESSAGE instead of
    // raw host-script stderr (cert paths, bridge names, qm output).
    let hostLocalProvisionFailureClass: ProxmoxHostLocalFailureClass | null = null;
    if (infraProvider === "proxmox") {
      const proxmoxProvisionRequest = {
        ...provisionParams,
        backend,
      };
      const exhaustedTargetIds: string[] = [];
      let vmidExhaustionFailovers = 0;
      // Per-call placement failure memory: hosts that failed host-locally in
      // THIS createInstance pass are excluded from every subsequent selection
      // round, so one misconfigured host (the fixturenodea incident shape) can't
      // black-hole the whole provision.
      const hostLocalFailedTargetIds: string[] = [];
      let hostLocalFailoverAttempts = 0;

      while (true) {
        const proxmoxResult = await provisionProxmoxInstance(proxmoxProvisionRequest, {
          env: proxmoxProvisionEnv,
          hostConfig: proxmoxHostConfig,
        });
        result = proxmoxResult;
        if (proxmoxResult.ok) break;

        const isVmidExhaustion = isProxmoxVmidExhaustionResult(proxmoxResult);
        const failureClass = isVmidExhaustion
          ? null
          : classifyProxmoxHostLocalProvisionFailure(proxmoxResult.error);
        // Track the classification of the LATEST failure only — a vmid
        // exhaustion after a host-local hop must keep its own messaging.
        hostLocalProvisionFailureClass = failureClass;
        if (!isVmidExhaustion && !failureClass) break;

        const failedTargetId = normalizeProxmoxCapacityScopeId(
          proxmoxResult.targetId ?? proxmoxProvisionTargetId ?? proxmoxProvisionEnv.PROXMOX_NODE
        );
        if (isVmidExhaustion) {
          if (failedTargetId && !exhaustedTargetIds.includes(failedTargetId)) {
            exhaustedTargetIds.push(failedTargetId);
          }

          // Failover is only meaningful when placement is free to pick another
          // host. Three cases must stop here instead of retrying:
          //   1. Pinned host config — provisionProxmoxInstance re-resolves env
          //      through resolveProxmoxHostEnv, which overlays the pinned host's
          //      values over whatever target re-selection returns, so every
          //      retry would replay the same exhausted host (and, because the
          //      pinned host's id may never match a selection candidate id, the
          //      exclusion list can't terminate the loop).
          //   2. Unidentifiable exhausted target — nothing to exclude, so the
          //      next selection would hand the same host straight back.
          //   3. Failover hop cap — belt-and-braces so the loop is provably
          //      finite even if result/candidate target ids fail to line up.
          // In all three cases `result` keeps its exhaustion failureType; the
          // failure surface below maps the raw allocator error to the friendly
          // capacity-paused message.
          if (
            proxmoxHostConfig ||
            !failedTargetId ||
            vmidExhaustionFailovers >= MAX_PROXMOX_VMID_EXHAUSTION_FAILOVERS
          ) {
            log.error(
              "Proxmox VMID range exhausted with no failover available",
              new Error(proxmoxResult.error),
              {
                source: LOG_SOURCE,
                failureType: "proxmox_vmid_exhaustion_failover_unavailable",
                userId,
                instanceId: instance.id,
                targetId: failedTargetId,
                hostPinned: Boolean(proxmoxHostConfig),
                vmidExhaustionFailovers,
                maxFailovers: MAX_PROXMOX_VMID_EXHAUSTION_FAILOVERS,
                vmidStart: proxmoxResult.vmidStart ?? null,
                vmidEnd: proxmoxResult.vmidEnd ?? null,
              }
            );
            break;
          }
          vmidExhaustionFailovers += 1;

          log.warn("Proxmox target exhausted VMID range during provision; retrying placement", {
            source: LOG_SOURCE,
            failureType: "proxmox_vmid_exhausted_after_preflight",
            userId,
            instanceId: instance.id,
            targetId: failedTargetId,
            vmidStart: proxmoxResult.vmidStart ?? null,
            vmidEnd: proxmoxResult.vmidEnd ?? null,
            excludedTargetIds: exhaustedTargetIds,
          });
        } else {
          if (failedTargetId && !hostLocalFailedTargetIds.includes(failedTargetId)) {
            hostLocalFailedTargetIds.push(failedTargetId);
          }

          // GUARD 3: correlated-failure escalation. Per-host failover routes
          // around ONE bad host. When a second distinct host reports the same
          // failureClass inside the hour, every failover candidate is likely
          // affected and the user is about to get the generic
          // PROVISION_HOST_FAILURE_MESSAGE 500 — the 2026-06-25 shape
          // (host_caddy_invalid on fixturenodea/fixturenodea/fixturenodea/fixturenodea at once). Escalate
          // to a FATAL page. Never allowed to break the provision path.
          if (failedTargetId && failureClass) {
            try {
              await reportCorrelatedProxmoxHostFailure({
                supabase: supabaseAdmin,
                failureClass,
                targetId: failedTargetId,
              });
            } catch {
              // Alerting is best-effort; failover continues regardless.
            }
          }

          // Host-local failover stops on the same three cases as the VMID
          // path above: pinned host config (re-selection would replay the
          // same pinned host), unidentifiable failed target (nothing to
          // exclude), and the hop budget (the Vercel function budget — 300s
          // — realistically fits the original attempt plus two ~100s
          // host-local failures). The failure surface below redacts the raw
          // host detail from the client either way.
          if (
            proxmoxHostConfig ||
            !failedTargetId ||
            hostLocalFailoverAttempts >= MAX_PROXMOX_HOST_LOCAL_FAILOVERS
          ) {
            log.error(
              "Proxmox host-local provision failure with no failover available",
              new Error(proxmoxResult.error),
              {
                source: LOG_SOURCE,
                failureType: "proxmox_host_local_failover_unavailable",
                failureClass,
                userId,
                instanceId: instance.id,
                targetId: failedTargetId,
                hostId: proxmoxHostConfig?.hostId ?? null,
                hostPinned: Boolean(proxmoxHostConfig),
                hostLocalFailoverAttempts,
                maxFailovers: MAX_PROXMOX_HOST_LOCAL_FAILOVERS,
                failedTargetIds: hostLocalFailedTargetIds,
              }
            );
            break;
          }
          hostLocalFailoverAttempts += 1;

          // log.error (not warn) so every failover hop mirrors into
          // ops_events — repeated hops off the same targetId are the alert
          // signal that a registered host needs seeding/maintenance.
          log.error(
            "Proxmox host-local provision failure; failing over placement",
            new Error(proxmoxResult.error),
            {
              source: LOG_SOURCE,
              failureType: "proxmox_host_local_provision_failure",
              failureClass,
              userId,
              instanceId: instance.id,
              targetId: failedTargetId,
              // Pinned-host runs terminate above, so hops are never pinned;
              // kept for payload-shape parity with the termination log.
              hostId: null,
              attempt: hostLocalFailoverAttempts,
              maxAttempts: MAX_PROXMOX_HOST_LOCAL_FAILOVERS,
              excludedTargetIds: [...exhaustedTargetIds, ...hostLocalFailedTargetIds],
            }
          );
        }

        const nextTargetSelection = await selectAvailableProxmoxProvisionTarget({
          supabase: supabaseAdmin,
          env: process.env,
          hostConfig: proxmoxHostConfig,
          userId,
          neededCpu: cpuLimit,
          neededRamMb: ramLimit,
          neededDiskGb: proxmoxRequestedDiskGb,
          forceTargetId: forceProxmoxTargetId,
          excludeTargetIds: [...exhaustedTargetIds, ...hostLocalFailedTargetIds],
        });
        if (!nextTargetSelection.ok) {
          log.error(
            isVmidExhaustion
              ? "no alternate Proxmox target available after VMID range exhaustion"
              : "no alternate Proxmox target available after host-local provision failure",
            new Error(proxmoxResult.error),
            {
              source: LOG_SOURCE,
              failureType: isVmidExhaustion
                ? "proxmox_vmid_exhaustion_retry_exhausted"
                : "proxmox_host_local_failover_no_alternate",
              ...(failureClass ? { failureClass } : {}),
              userId,
              instanceId: instance.id,
              exhaustedTargetIds,
              hostLocalFailedTargetIds,
              selectionStatus: nextTargetSelection.status,
              selectionMessage: nextTargetSelection.message,
            }
          );
          if (isVmidExhaustion) {
            result = {
              ok: false,
              error: nextTargetSelection.message,
              failureType: "proxmox_vmid_range_exhausted",
              targetId: proxmoxResult.targetId ?? proxmoxProvisionTargetId,
              vmidStart: proxmoxResult.vmidStart,
              vmidEnd: proxmoxResult.vmidEnd,
            };
          }
          break;
        }

        proxmoxProvisionEnv = nextTargetSelection.env;
        proxmoxProvisionTargetId = nextTargetSelection.targetId;
        proxmoxProvisionedDiskGb = nextTargetSelection.diskSizeGb;
      }
    } else {
      result = await provisionHetznerInstance({
        ...provisionParams,
        hostId,
        hostHetznerServerId,
        hostIp,
        backend,
      });
    }

    if (!result.ok) {
      const isVmidExhaustion =
        infraProvider === "proxmox" &&
        isProxmoxVmidExhaustionResult(result as ProxmoxProvisionResult);
      const failureStatus = isVmidExhaustion
        ? 503
        : InstanceService.classifyProvisioningFailureStatus(result.error);
      // Host-local failures keep the raw host-script detail in server logs
      // only; the client gets a generic message plus a machine-readable
      // failureType so the frontend can treat it as transient.
      const isHostLocalFailure =
        infraProvider === "proxmox" && hostLocalProvisionFailureClass !== null;
      const clientMessage = isHostLocalFailure
        ? PROVISION_HOST_FAILURE_MESSAGE
        : `Deployment failed: ${result.error}`;
      // VMID exhaustion is an ops capacity problem, never the user's fault:
      // keep the raw range detail ("No free Proxmox VMID in range X-Y") in
      // operator logs and surface the same friendly pause message the
      // preflight capacity gate uses, so the welcome flow never renders the
      // raw error as a 500.
      if (isVmidExhaustion) {
        const exhaustion = result as Extract<ProxmoxProvisionResult, { ok: false }>;
        log.error(
          "Proxmox VMID range exhausted at provision time; returning capacity-paused response",
          new Error(exhaustion.error),
          {
            source: LOG_SOURCE,
            failureType: "proxmox_vmid_range_exhausted",
            userId,
            instanceId: instance.id,
            targetId: exhaustion.targetId ?? proxmoxProvisionTargetId ?? null,
            vmidStart: exhaustion.vmidStart ?? null,
            vmidEnd: exhaustion.vmidEnd ?? null,
          }
        );
      } else if (isHostLocalFailure) {
        log.error(
          "provision failed host-locally; returning generic client error",
          new Error(result.error),
          {
            source: LOG_SOURCE,
            failureType: PROVISION_HOST_FAILURE_TYPE,
            failureClass: hostLocalProvisionFailureClass,
            userId,
            instanceId: instance.id,
            targetId: proxmoxProvisionTargetId ?? null,
            hostId: proxmoxHostConfig?.hostId ?? null,
            status: failureStatus,
          }
        );
      }
      // Rollback DB record
      const { error: rollbackError } = await supabaseAdmin.from("hermes_instances").delete().eq("id", instance.id);
      if (isVmidExhaustion) {
        if (rollbackError) {
          log.error(
            "rollback failed to delete the instance record after VMID exhaustion",
            rollbackError,
            {
              source: LOG_SOURCE,
              failureType: "proxmox_vmid_exhaustion_rollback_failed",
              userId,
              instanceId: instance.id,
            }
          );
        }
        return {
          success: false,
          status: 503,
          message: PROXMOX_CAPACITY_PAUSED_MESSAGE,
          error: { code: "PROXMOX_TENANT_CAPACITY_REACHED" },
        };
      }
      if (rollbackError) {
        return {
          success: false,
          status: 500,
          message: isHostLocalFailure
            ? PROVISION_HOST_FAILURE_MESSAGE
            : `Deployment failed: ${result.error}. Rollback failed to delete the instance record.`,
          error: rollbackError,
          ...(isHostLocalFailure ? { failureType: PROVISION_HOST_FAILURE_TYPE } : {}),
        };
      }
      return {
        success: false,
        status: failureStatus,
        message: clientMessage,
        ...(isHostLocalFailure ? { failureType: PROVISION_HOST_FAILURE_TYPE } : {}),
      };
    }

    let finalHostId = hostId;
    if (infraProvider === "proxmox" && "infrastructure" in result && result.infrastructure?.provider === "proxmox") {
      finalHostId = result.infrastructure.hostId ?? finalHostId;
    }
    if (infraProvider === "hetzner" && !finalHostId && result.serverId) {
      const specs = getServerSpecs(result.serverType || "cx23");
      const { data: newHost } = await supabaseAdmin
        .from("hermes_hosts")
        .insert({
          user_id: userId,
          hetzner_server_id: result.serverId,
          name: `Host - ${name}`,
          ipv4_address: result.ipv4,
          ssh_host_fingerprint_sha256: result.sshHostFingerprint ?? null,
          total_cpu: specs.cpu,
          total_ram: specs.ram,
          status: "provisioning",
        })
        .select()
        .single();
      if (newHost) finalHostId = newHost.id;
    }

    const infrastructure =
      "infrastructure" in result ? result.infrastructure : undefined;
    const finalConfig = infrastructure
      ? { ...storedConfig, infrastructure }
      : storedConfig;

    // Update DB with details. We capture the Supabase error response so a
    // silent constraint/RLS rejection doesn't masquerade as a 200 with an
    // orphan row (gateway_url/proxmox_vmid stay null, dashboard polls
    // forever). Earlier orphans were diagnosed wrong as Vercel function
    // timeouts; the actual stuck cases were this update returning an
    // error the call site never read.
    const updatePayload: PostProvisionMetadataPayload = {
      hetzner_server_id: infraProvider === "hetzner" ? result.serverId : null,
      host_id: finalHostId, // Link instance to the new/existing host
      gateway_url: result.gatewayUrl,
      api_server_key_encrypted: encryptApiKey(result.apiServerKey),
      ipv4_address: result.ipv4,
      ssh_host_fingerprint_sha256: result.sshHostFingerprint ?? null,
      infrastructure_provider: infraProvider,
      proxmox_node:
        infraProvider === "proxmox"
          ? (infrastructure?.provider === "proxmox" && infrastructure.node
              ? infrastructure.node
              : proxmoxProvisionEnv.PROXMOX_NODE?.trim() || null)
          : null,
      proxmox_vmid:
        infraProvider === "proxmox" && infrastructure?.provider === "proxmox"
          ? infrastructure.vmid
          : null,
      proxmox_template_vmid:
        infraProvider === "proxmox" &&
        infrastructure?.provider === "proxmox" &&
        typeof infrastructure.templateVmid === "number"
          ? infrastructure.templateVmid
          : null,
      disk_size_gb:
        infraProvider === "proxmox" ? proxmoxProvisionedDiskGb : null,
      config: finalConfig,
      status: "provisioning",
      updated_at: new Date().toISOString(),
    };
    const { error: firstUpdateError } = await supabaseAdmin
      .from("hermes_instances")
      .update(updatePayload)
      .eq("id", instance.id);
    let updateError: unknown = firstUpdateError;

    if (updateError && isDuplicateProxmoxMetadataError(updateError)) {
      const recovery = await recoverStaleProxmoxMetadataConflict({
        updatePayload,
        updateInstanceId: instance.id,
        userId,
      });
      if (recovery.recovered) {
        updateError = recovery.retryError ?? null;
      }
    }

    if (updateError) {
      log.error("failed to persist post-provision metadata", updateError, {
        source: LOG_SOURCE,
        failureType: "post_provision_metadata_persist_failed",
        userId,
        instanceId: instance.id,
        infraProvider,
      });

      // The provider-side VM (Hetzner server / Proxmox VM) was created
      // successfully but we can't persist its identifiers to the row that
      // tracks it. Without rollback, the VM lives on forever billing the
      // platform with no DB record to find it. Best-effort delete the
      // freshly created server here. We only roll back when this provision
      // ALLOCATED a brand-new server (no existing hostHetznerServerId in
      // params); deploying onto an existing host should not delete it.
      const rollbackServerId =
        infraProvider === "hetzner" && !hostHetznerServerId && result.serverId
          ? result.serverId
          : null;
      // Proxmox path: a successful clone gave us a vmid + infrastructure
      // metadata. If we can't persist that to the row, the VM keeps
      // running with no DB row pointing at it, and the
      // recover-orphan-provisioning cron may not pick it up because its
      // gateway_url-IS-NULL signature only matches the in-flight shape,
      // not a row whose update was rejected and stayed in its previous
      // state. Destroy the freshly cloned VMID here so the slot can be
      // reused on the next attempt. Mirrors the Hetzner gate above:
      // only rolls back when THIS provision allocated the VM.
      const rollbackProxmoxInfra =
        infraProvider === "proxmox" &&
        infrastructure?.provider === "proxmox" &&
        typeof infrastructure.vmid === "number"
          ? infrastructure
          : null;
      let rollbackOutcome: "deleted" | "skipped" | "failed" = "skipped";
      if (rollbackServerId) {
        try {
          await deleteHetznerServer(rollbackServerId);
          rollbackOutcome = "deleted";
        } catch (rollbackError) {
          rollbackOutcome = "failed";
          log.error("post-provision rollback failed — orphan server may exist", rollbackError, {
            source: LOG_SOURCE,
            failureType: "post_provision_rollback_failed",
            userId,
            instanceId: instance.id,
            hetznerServerId: rollbackServerId,
          });
        }

        // Double-failure: the metadata UPDATE failed AND the rollback delete
        // failed, so an orphan Hetzner server is still running/billing with no
        // DB pointer while the row is stuck at status='provisioning'. The
        // recover-orphan cron only handles Proxmox, so without this the row is
        // unrecoverable and the server bills forever. Best-effort: record the
        // server id (so the DELETE handler / ops can reap it) and flip the row
        // to a terminal error state so it's visible and user-deletable instead
        // of spinning. If this write also fails (same cause as the original
        // UPDATE) the server id is still in the rollback-failed log above.
        if (rollbackOutcome === "failed") {
          const { error: hetznerMarkerError } = await supabaseAdmin
            .from("hermes_instances")
            .update({
              hetzner_server_id: rollbackServerId,
              infrastructure_provider: "hetzner",
              status: "error",
              // 'failed', NOT 'error'. `error` is a `status` word; lifecycle_state's
              // CHECK permits only the 12 values in INSTANCE_LIFECYCLE_STATES +
              // the cold-storage markers, so 'error' made this whole UPDATE fail
              // with 23514 — and a rejected UPDATE is atomic, so hetzner_server_id
              // went down with it. That is the opposite of this block's purpose:
              // it exists to record the id of a server we FAILED to roll back, so
              // ops can reap it. The mapping was never ambiguous — the lifecycle
              // foundation migration and LEGACY_STATUS_TO_LIFECYCLE both map
              // status 'error' -> lifecycle 'failed'.
              lifecycle_state: "failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", instance.id);
          if (hetznerMarkerError) {
            log.warn(
              "post-provision Hetzner rollback marker write failed; orphan server may need manual cleanup",
              {
                source: LOG_SOURCE,
                failureType: "post_provision_hetzner_rollback_marker_write_failed",
                userId,
                instanceId: instance.id,
                hetznerServerId: rollbackServerId,
                markerError:
                  hetznerMarkerError instanceof Error
                    ? hetznerMarkerError.message
                    : String(hetznerMarkerError),
              },
            );
          }
        }
      } else if (rollbackProxmoxInfra) {
        try {
          const deleteResult = await deleteProxmoxInstance(rollbackProxmoxInfra, {
            hostConfig: proxmoxHostConfig,
            expectedInstanceId: instance.id,
          });
          if (deleteResult.ok) {
            rollbackOutcome = "deleted";
          } else {
            rollbackOutcome = "failed";
            log.error(
              "post-provision Proxmox rollback returned non-ok — orphan VM may exist",
              new Error(deleteResult.error || deleteResult.stderr || "deleteProxmoxInstance not ok"),
              {
                source: LOG_SOURCE,
                failureType: "post_provision_rollback_failed",
                userId,
                instanceId: instance.id,
                proxmoxVmid: rollbackProxmoxInfra.vmid,
                proxmoxNode: rollbackProxmoxInfra.node ?? null,
              },
            );
          }
        } catch (rollbackError) {
          rollbackOutcome = "failed";
          log.error("post-provision Proxmox rollback threw — orphan VM may exist", rollbackError, {
            source: LOG_SOURCE,
            failureType: "post_provision_rollback_failed",
            userId,
            instanceId: instance.id,
            proxmoxVmid: rollbackProxmoxInfra.vmid,
            proxmoxNode: rollbackProxmoxInfra.node ?? null,
          });
        }

        // Best-effort: persist `config.infrastructureReleased = { reason:
        // "post_provision_rollback", at }` so any user-facing DELETE
        // attempt later proceeds via the existing "previously released"
        // branch at /api/instances/[id] route.ts. Without this marker the
        // row keeps `infrastructure_provider='proxmox'` while the VM is
        // verifiably gone, and the DELETE handler refuses the row with
        // "no infrastructure handle. Contact support". Observed
        // 2026-05-17 on 9 production rows with the same shape. We also
        // null the proxmox_* columns so the resolver returns no live
        // handle. Mirrors recoverStaleProxmoxMetadataConflict's strip
        // pattern. If this write fails too (likely if the original
        // update did) the Layer-2 DELETE escape hatch — terminal
        // lifecycle + no infra columns — still lets the user self-clear.
        if (rollbackOutcome === "deleted") {
          const releasedConfig = stripProxmoxInfrastructure(
            storedConfig,
            "post_provision_rollback",
          );
          const { error: markerError } = await supabaseAdmin
            .from("hermes_instances")
            .update({
              config: releasedConfig,
              proxmox_node: null,
              proxmox_vmid: null,
              proxmox_template_vmid: null,
              gateway_url: null,
              ipv4_address: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", instance.id);
          if (markerError) {
            log.warn(
              "post-provision rollback marker write failed; row may be hard-to-delete until backfill",
              {
                source: LOG_SOURCE,
                failureType: "post_provision_rollback_marker_write_failed",
                userId,
                instanceId: instance.id,
                proxmoxVmid: rollbackProxmoxInfra.vmid,
                proxmoxNode: rollbackProxmoxInfra.node ?? null,
                markerError:
                  markerError instanceof Error
                    ? markerError.message
                    : String(markerError),
              },
            );
          }
        }
      }

      // Clean up the DNS A record minted during provisioning. The provision
      // (Hetzner or Proxmox) mints `<subdomain>.<zone>` pointing at the new
      // server, but the metadata UPDATE just failed and we're abandoning this
      // instance — so the record would otherwise dangle, pointing at a deleted
      // (or about-to-be-reaped) server and eating Cloudflare zone quota (see
      // the 2026-05-17 quota-saturation incident). Best-effort + no-ops when no
      // subdomain/record exists.
      await removeInstanceDnsBestEffort(subdomain, {
        source: LOG_SOURCE,
        instanceId: instance.id,
        userId,
      });

      return {
        success: false,
        status: 500,
        message:
          rollbackOutcome === "deleted"
            ? "Provisioning succeeded but the dashboard could not record metadata. The underlying VM was rolled back."
            : "Provisioning succeeded but the dashboard could not record metadata. " +
              "The underlying VM may still be running — check the provider console.",
        error: updateError,
      };
    }

    // Bankr SKILLS are static curated content — independent of whether a real
    // Bankr partner wallet successfully provisioned. Previously this was gated
    // on `bankrAgentConfig` (wallet active + API key present), so any user
    // hitting the Bankr partner's wallet-creation quota (403) lost their
    // skill set even though the skills don't need the wallet at all. Observed
    // 2026-05-12 with user Ash: 5 wallet attempts in a row 403'd → 0 skills
    // installed across all agents. Now install for every agent; the wallet
    // provisioning remains a separate concern that the dashboard surfaces
    // later via the Bankr settings tab.
    //
    // Keep this optional for provisioning success, but let it settle before
    // returning. A detached gateway write can keep running after the request
    // or test has completed, which makes failures hard to see and can lose the
    // skill seed entirely in short-lived runtimes.
    await preinstallBankrSuiteForInstance({
      instanceId: instance.id,
      userId,
      gatewayUrl: result.gatewayUrl,
      apiServerKey: result.apiServerKey,
      instanceIpv4: result.ipv4,
    }).catch((err) => {
      log.warn("bankr suite skill preinstall failed — agent still created", {
        source: LOG_SOURCE,
        failureType: "bankr_suite_preinstall_failed",
        userId,
        instanceId: instance.id,
        walletConfigured: Boolean(bankrAgentConfig),
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Best-effort: if this free deploy claims a waitlist invite, mark the
    // matching reservation onboarded so its held slot stops counting as an
    // outstanding invite. Reuses the clerkUser fetched above; floats so it never
    // blocks the deploy response. No-op when the waitlist feature is off.
    if (isAutoInviteEnabled() && isSingleInstanceBaseTierKey(sub.plan)) {
      const claimedEmail = resolveClerkUserEmail(clerkUser);
      if (claimedEmail) {
        void markReservationOnboardedByEmail(claimedEmail).catch((err) => {
          log.warn("waitlist onboard mark failed (non-fatal)", {
            source: LOG_SOURCE,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }

    return {
      success: true,
      data: {
        id: instance.id,
        name: instance.name,
        subdomain: instance.subdomain,
        status: "provisioning",
        provider,
        backend,
      },
    };
  }
}
